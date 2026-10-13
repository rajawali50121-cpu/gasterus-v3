import crypto from 'node:crypto';
import { config } from './config.js';
import { AppError } from './errors.js';
import { redis } from './redis.js';
import { logger } from './logger.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fetchSharpApi, fetchApiSports, fetchTheOddsApi, fetchSportmonks, mergeProviderEvents, publicEvent, suspendStaleLiveMarkets } from './sportsbook-providers.js';
import { isValidSportsbookDecimalOdds } from './sportsbook-odds-validation.js';
import { fetchPublicMarketFeed } from './sportsbook-public-market.js';
import { fetchFootballDataIo } from './sportsbook-footballdataio.js';
import { advanceProviderLifecycle, publicProviderLifecycle, shouldProbeProvider, transitionProviderLifecycle } from './sportsbook-provider-lifecycle.js';
import { recordSportsbookMarketTransitions, recordSportsbookProviderTransitions, sportsbookPricingExposureSnapshot } from './sportsbook-operations.js';
import { applySportsbookRiskRepricing } from './sportsbook-risk-pricing.js';
import { reconcileSportsbookMarketLifecycle } from './sportsbook-market-lifecycle.js';
import { priceVersionChangeCount } from './sportsbook-live-observability.js';
import { applySportsbookTradingControls, listActiveSportsbookTradingControls, resolveSportsbookTradingPolicy } from './sportsbook-trading-controls.js';
import { eventSettlementAuthority, settlementAuthoritySummary } from './sportsbook-settlement-authority.js';
import { enrichTeamArtwork } from './sportsbook-team-artwork.js';
import { projectMemberMarkets } from './sportsbook-member-projection.js';

const MIN_1X2_OVERROUND = 1.00;
const MAX_1X2_OVERROUND = 1.25;
function hasValidQuarterLine(line) {
  if (line === null || line === undefined || line === '') return true;
  const value = Number(line);
  return Number.isFinite(value) && Math.abs(value * 4 - Math.round(value * 4)) <= 1e-8;
}

/**
 * Quarantine invalid markets in place so the large feed is not cloned.
 * Valid market objects and events are retained unchanged.
 */
export function validateAllHandicapOdds(events = []) {
  const quarantined = Object.create(null);
  let totalQuarantined = 0;

  for (const event of events) {
    const markets = event.markets || [];
    let writeIndex = 0;

    for (let readIndex = 0; readIndex < markets.length; readIndex += 1) {
      const market = markets[readIndex];
      const selections = market.selections || [];
      let reason = null;

      if (market.type === 'HANDICAP' || market.type === 'TOTALS') {
        if (!hasValidQuarterLine(market.line)) reason = 'INVALID_LINE';
      }

      let activeSelectionCount = 0;
      let activeOverround = 0;
      let activeHandicapOverround = 0;
      let minOdds = Number.POSITIVE_INFINITY;
      let maxOdds = 0;
      let legacyOddsCount = 0;

      for (const selection of selections) {
        if ((market.type === 'HANDICAP' || market.type === 'TOTALS')
          && !hasValidQuarterLine(selection.line)) reason = 'INVALID_LINE';
        const odds = Number(selection.odds);
        if (odds > 1) {
          legacyOddsCount += 1;
          minOdds = Math.min(minOdds, odds);
          maxOdds = Math.max(maxOdds, odds);
        }

        if (market.suspended || selection.suspended) continue;
        if (!isValidSportsbookDecimalOdds(odds)) {
          reason ||= 'ODDS_RANGE';
          continue;
        }
        activeSelectionCount += 1;
        if (market.type === '1X2') activeOverround += 1 / odds;
        if (market.type === 'HANDICAP') activeHandicapOverround += 1 / odds;
      }

      if (!reason && market.type === '1X2' && activeSelectionCount === 3
        && (activeOverround < MIN_1X2_OVERROUND || activeOverround > MAX_1X2_OVERROUND)) {
        reason = 'OVERROUND_1X2';
      }
      if (!reason && market.type === 'HANDICAP' && activeSelectionCount === 2
        && (activeHandicapOverround < MIN_1X2_OVERROUND || activeHandicapOverround > MAX_1X2_OVERROUND)) {
        reason = 'OVERROUND_HANDICAP';
      }
      if (!reason && market.type === 'HANDICAP' && activeSelectionCount > 0 && activeSelectionCount !== 2) {
        reason = 'INCOMPLETE_HANDICAP';
      }
      if (!reason && market.type === 'HANDICAP' && activeSelectionCount === 2 && maxOdds / minOdds > 3) {
        reason = 'ABNORMAL_HANDICAP_ODDS';
      }

      // Preserve the existing pick'em handicap safeguard.
      if (!reason && market.type === 'HANDICAP'
        && (market.line === 0 || market.line === null || market.line === '')
        && legacyOddsCount >= 2
        && minOdds < 1.50) {
        reason = 'ABNORMAL_HANDICAP_ODDS';
      }

      if (reason) {
        quarantined[reason] = (quarantined[reason] || 0) + 1;
        totalQuarantined += 1;
      } else {
        markets[writeIndex] = market;
        writeIndex += 1;
      }
    }

    markets.length = writeIndex;
  }

  logger.info('Sportsbook market validation quarantine summary', {
    total: totalQuarantined,
    reasons: quarantined
  });

  return events;
}

const LIFECYCLE_GENERATION = 'r6917';
const CACHE_KEY = 'sportsbook:aggregated-feed:v16';
const LIFECYCLE_KEY = 'sportsbook:provider-lifecycle:v6';
const MARKET_LIFECYCLE_KEY = 'sportsbook:market-lifecycle:v6';
const REFRESH_MS = config.sportsFeedRefreshSeconds * 1000;
const STALE_MS = config.sportsFeedStaleSeconds * 1000;
// Cross-process single-flight (worker & core are SEPARATE Node processes; the module-level
// `inFlight` promise only coalesces callers inside ONE process). One SET NX + TTL lock makes
// sure at most one provider fan-out runs across the whole deployment at any time.
const REFRESH_LOCK_KEY = 'sportsbook:feed-refresh-lock:v1';
const REFRESH_LOCK_TTL_MS = Math.max(180000, REFRESH_MS);
// Keep request-triggered refresh contention well below the 30s proxy timeout.
const REFRESH_LOCK_WAIT_MS = 5000;
const REFRESH_LOCK_RENEW_MS = 60000;
const REFRESH_LOCK_POLL_MS = 400;

let memory = { lifecycleGeneration: LIFECYCLE_GENERATION, events: [], providers: [], providerLifecycle: {}, marketLifecycleStats: { active: 0, suspended: 0, reopening: 0, closed: 0 }, revision: null, fetchedAt: 0, expiresAt: 0, error: null };
let marketLifecycleMemory = {};
let inFlight = null;
// Guard in-process untuk background poll. `inFlight` di atas hanya dipakai
// currentFeed() (request-triggered), sehingga poll dari feed-worker dan request
// dari core bisa saling tumpang tindih — terutama saat Redis down dan
// cross-process lock tidak tersedia. Siklus yang sudah jalan di-skip, bukan antre.
let backgroundPollInFlight = false;
const HERE = dirname(fileURLToPath(import.meta.url));
let suppliedSnapshot = null;
function loadSuppliedSnapshot() {
  if (suppliedSnapshot) return suppliedSnapshot;
  try {
    suppliedSnapshot = JSON.parse(readFileSync(resolve(HERE, '../data/sportsbook-supplied-snapshot.json'), 'utf8'));
  } catch {
    suppliedSnapshot = { capturedAt: null, events: [] };
  }
  return suppliedSnapshot;
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

const CLOSED_EVENT_STATUSES = new Set(['FINISHED', 'CANCELLED', 'CANCELED', 'ABANDONED', 'POSTPONED', 'VOID']);
const TOP_LEAGUE_PATTERNS = [
  /\bpremier league\b/i, /\bepl\b/i, /\bla liga\b/i, /\bserie a\b/i,
  /\bbundesliga\b/i, /\bligue 1\b/i, /\bchampions league\b/i, /\beuropa league\b/i,
  /\bconference league\b/i, /\beredivisie\b/i, /\bprimeira liga\b/i,
  /\bmajor league soccer\b/i, /\bmls\b/i, /\bchampionship\b/i
];
const MAX_FEED_EVENTS = config.sportsFeedMaxEvents;
const MAX_CACHE_BYTES = config.sportsFeedMaxCacheBytes;
let lastCacheLimitWarningAt = 0;
const WIB_DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jakarta',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const SUMMARY_MARKET_TYPES = new Set(['1X2', 'HANDICAP', 'TOTALS']);
const DEFAULT_SNAPSHOT_PAGE_SIZE = 30;
const MAX_SNAPSHOT_PAGE_SIZE = 100;

function isSoccerEvent(event) {
  const sport = clean(event?.sport).toLowerCase();
  return sport === 'football' || sport === 'soccer' || sport === 'association football';
}

function eventBucket(event, now = Date.now()) {
  if (event?.live || ['LIVE', 'IN_PLAY', 'IN-PLAY'].includes(clean(event?.status).toUpperCase())) return 'live';
  const kickoff = Date.parse(event?.startTime || '');
  if (!Number.isFinite(kickoff)) return 'early';
  return WIB_DAY_FORMATTER.format(new Date(kickoff)) === WIB_DAY_FORMATTER.format(new Date(now))
    ? 'today'
    : kickoff > now ? 'early' : '';
}

function boundedEvents(events = []) {
  if (!Array.isArray(events)) return [];
  const now = Date.now();
  return events
    .filter(isSoccerEvent)
    .filter(event => {
      const status = clean(event?.status).toUpperCase();
      const kickoff = Date.parse(event?.startTime || '');
      const live = Boolean(event?.live) || ['LIVE', 'IN_PLAY', 'IN-PLAY'].includes(status);
      if (CLOSED_EVENT_STATUSES.has(status)) {
        return Number.isFinite(kickoff)
          && now - kickoff <= config.sportsbookFinishedEventRetentionSeconds * 1000;
      }
      if (!live && Number.isFinite(kickoff) && kickoff < now - config.sportsbookPrematchCloseGraceSeconds * 1000) return false;
      return memberVisibleEvent(event, now);
    })
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const aLive = Boolean(a.event?.live);
      const bLive = Boolean(b.event?.live);
      if (aLive !== bLive) return Number(bLive) - Number(aLive);
      const aStart = Date.parse(a.event?.startTime || '') || Number.MAX_SAFE_INTEGER;
      const bStart = Date.parse(b.event?.startTime || '') || Number.MAX_SAFE_INTEGER;
      const aToday = aStart >= now && aStart < now + 86400000;
      const bToday = bStart >= now && bStart < now + 86400000;
      if (aToday !== bToday) return Number(bToday) - Number(aToday);
      const aTop = TOP_LEAGUE_PATTERNS.some(pattern => pattern.test(`${a.event?.country || ''} ${a.event?.league || ''}`));
      const bTop = TOP_LEAGUE_PATTERNS.some(pattern => pattern.test(`${b.event?.country || ''} ${b.event?.league || ''}`));
      if (aTop !== bTop) return Number(bTop) - Number(aTop);
      return aStart - bStart || a.index - b.index;
    })
    .slice(0, MAX_FEED_EVENTS)
    .map(({ event }) => event);
}

function cacheWithinLimit(value) {
  const bounded = { ...value, events: boundedEvents(value?.events) };
  const byteLength = candidate => Buffer.byteLength(JSON.stringify(candidate), 'utf8');
  if (byteLength(bounded) <= MAX_CACHE_BYTES) return bounded;

  let low = 0;
  let high = bounded.events.length - 1;
  let best = { ...bounded, events: [] };
  let bestCount = 0;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = { ...bounded, events: bounded.events.slice(0, count) };
    if (byteLength(candidate) <= MAX_CACHE_BYTES) {
      best = candidate;
      bestCount = count;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }

  const now = Date.now();
  if (now - lastCacheLimitWarningAt >= 60000) {
    logger.warn('Sportsbook Redis cache event list reduced to fit byte limit', {
      originalEvents: bounded.events.length,
      cachedEvents: bestCount,
      maxBytes: MAX_CACHE_BYTES
    });
    lastCacheLimitWarningAt = now;
  }
  return best;
}

function eventBettingOpen(event, now = Date.now()) {
  const status = clean(event?.status).toUpperCase();
  if (CLOSED_EVENT_STATUSES.has(status) || status === 'SUSPENDED') return false;
  if (event?.live || ['LIVE', 'IN_PLAY', 'IN-PLAY'].includes(status)) return true;
  const kickoff = Date.parse(event?.startTime || '');
  if (status === 'SCHEDULED' && Number.isFinite(kickoff)) {
    return now <= kickoff + Number(config.sportsbookPrematchCloseGraceSeconds || 0) * 1000;
  }
  return true;
}
function enforceEventBettingWindow(events = [], now = Date.now()) {
  return events.map(event => {
    if (eventBettingOpen(event, now)) return event;
    return {
      ...event,
      markets: (event.markets || []).map(market => ({
        ...market,
        suspended: true,
        selections: (market.selections || []).map(selection => ({ ...selection, suspended: true }))
      }))
    };
  });
}
function memberVisibleEvent(event, now = Date.now()) {
  const status = clean(event?.status).toUpperCase();
  if (CLOSED_EVENT_STATUSES.has(status)) return false;
  if (event?.live || ['LIVE', 'IN_PLAY', 'IN-PLAY'].includes(status)) return true;
  const kickoff = Date.parse(event?.startTime || '');
  if (!Number.isFinite(kickoff)) return true;
  const horizonMs = Number(config.sportsbookMemberHorizonDays || 14) * 86400000;
  const graceMs = Number(config.sportsbookPrematchCloseGraceSeconds || 0) * 1000;
  return kickoff >= now - graceMs && kickoff <= now + horizonMs;
}

function stablePriceVersion(event, market, selection) {
  return crypto.createHash('sha256').update([
    event?.id || '', market?.id || market?.key || '', selection?.key || '', selection?.source || market?.source || '',
    selection?.sourceSelectionId || '', selection?.line ?? market?.line ?? '', selection?.odds ?? ''
  ].map(value => String(value ?? '')).join('|')).digest('hex').slice(0, 28);
}
function stampPriceVersions(events = [], fetchedAt = Date.now()) {
  const fallbackUpdatedAt = new Date(fetchedAt).toISOString();
  return events.map(event => ({
    ...event,
    markets: (event.markets || []).map(market => ({
      ...market,
      updatedAt: market.updatedAt || fallbackUpdatedAt,
      selections: (market.selections || []).map(selection => {
        const updatedAt = selection.updatedAt || market.updatedAt || fallbackUpdatedAt;
        return {
          ...selection,
          source: selection.source || market.source || 'unknown',
          updatedAt,
          priceVersion: selection.priceVersion || stablePriceVersion(event, market, selection)
        };
      })
    }))
  }));
}
function stableFeedRevision(events = [], providerLifecycle = {}) {
  const hash = crypto.createHash('sha256');
  for (const event of [...events].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    hash.update(`E|${event.id}|${event.status}|${event.live ? 1 : 0}
`);
    for (const market of [...(event.markets || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      hash.update(`M|${market.id}|${market.source || ''}|${market.suspended ? 1 : 0}
`);
      for (const selection of [...(market.selections || [])].sort((a, b) => String(a.key).localeCompare(String(b.key)))) {
        hash.update(`S|${selection.key}|${selection.odds ?? ''}|${selection.priceVersion || ''}|${selection.suspended ? 1 : 0}
`);
      }
    }
  }
  for (const code of Object.keys(providerLifecycle).sort()) {
    const state = providerLifecycle[code] || {};
    hash.update(`P|${code}|${state.state || ''}|${state.bettingAllowed ? 1 : 0}|${state.pricingReady ? 1 : 0}
`);
  }
  return hash.digest('hex').slice(0, 32);
}
function lifecycleOptions() {
  return {
    failureThreshold: config.sportsbookProviderFailureThreshold,
    recoverySuccesses: config.sportsbookProviderRecoverySuccesses,
    cooldownSeconds: config.sportsbookProviderCooldownSeconds
  };
}
function assertSelectionFresh(event, market, selection, feedFetchedAt) {
  const now = Date.now();
  const feedAge = now - Number(feedFetchedAt || 0);
  if (!Number.isFinite(feedAge) || feedAge < 0 || feedAge > STALE_MS) {
    throw new AppError(409, 'Feed odds sudah kedaluwarsa. Tunggu pembaruan berikutnya.', 'SPORTS_FEED_STALE_AT_ACCEPTANCE');
  }
  const source = String(selection?.source || market?.source || '');
  // public-market freshness is governed by its bounded collector cache. A successful
  // aggregate observation is therefore the acceptance freshness clock; source file
  // Last-Modified may legitimately be older without making the deterministic quote stale.
  const freshnessTimestamp = source === 'public-market' ? new Date(Number(feedFetchedAt || 0)).toISOString() : (selection?.updatedAt || market?.updatedAt);
  const updatedMs = Date.parse(freshnessTimestamp || '');
  if (!Number.isFinite(updatedMs)) return;
  const maxAgeSeconds = source === 'public-market'
    ? config.publicMarketPriceMaxAgeSeconds
    : event?.live ? config.sportsbookMaxLivePriceAgeSeconds : config.sportsbookMaxPrematchPriceAgeSeconds;
  if (now - updatedMs > maxAgeSeconds * 1000) {
    throw new AppError(409, 'Harga odds terlalu lama untuk diterima. Market ditahan sampai provider mengirim harga baru.', 'SPORTS_PRICE_STALE', {
      eventId: event?.id || null,
      marketId: market?.id || null,
      selectionId: selection?.key || null,
      priceUpdatedAt: selection?.updatedAt || market?.updatedAt || null,
      maxAgeSeconds
    });
  }
}
function pricedMarketCount(events = []) {
  return events.reduce((total, event) => total + (event.markets || []).filter(market =>
    (market.selections || []).some(selection => Number.isFinite(Number(selection.odds)) && Number(selection.odds) > 1)
  ).length, 0);
}
function bettableMarketCount(events = []) {
  const now = Date.now();
  return events.reduce((total, event) => {
    if (!eventBettingOpen(event, now)) return total;
    return total + (event.markets || []).filter(market =>
      !market.suspended && (market.selections || []).some(selection => !selection.suspended && Number.isFinite(Number(selection.odds)) && Number(selection.odds) > 1)
    ).length;
  }, 0);
}
function providerHasPricedMarkets(result) {
  return Boolean(result?.enabled && !result?.stale && pricedMarketCount(result.events || []) > 0);
}
function enabledProviders() {
  return [
    { name: 'Gasterus Public Market Feed', code: 'public-market', enabled: Boolean(config.publicMarketEnabled) },
    { name: 'SharpAPI', code: 'sharpapi', enabled: config.sharpApiEnabled && Boolean(config.sharpApiKey) },
    { name: 'API-Sports', code: 'api-sports', enabled: config.apiSportsEnabled && Boolean(config.apiSportsKey) },
    { name: 'The Odds API', code: 'the-odds-api', enabled: config.theOddsApiEnabled && Boolean(config.theOddsApiKey) },
    { name: 'TheSportsDB', code: 'thesportsdb', enabled: config.theSportsDbEnabled && Boolean(config.theSportsDbKey) },
    { name: 'FootballData.io', code: 'footballdata-io', enabled: config.footballDataIoEnabled && Boolean(config.footballDataIoKey) }
  ];
}
async function readRedisCache() {
  if (!redis.isOpen) return null;
  try {
    const raw = await redis.get(CACHE_KEY);
    if (!raw) return null;
    if (Buffer.byteLength(raw, 'utf8') > MAX_CACHE_BYTES) {
      logger.warn('Sportsbook Redis cache exceeds byte cap; ignoring cache', { maxBytes: MAX_CACHE_BYTES });
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.events) || !Array.isArray(parsed.providers)) return null;
    if (parsed.events.length > MAX_FEED_EVENTS) {
      logger.warn('Sportsbook Redis cache exceeds event cap; ignoring cache', { events: parsed.events.length, maxEvents: MAX_FEED_EVENTS });
      return null;
    }
    if (parsed.lifecycleGeneration !== LIFECYCLE_GENERATION) return null;
    return parsed;
  } catch (error) {
    logger.warn('Sportsbook Redis cache read failed', { error: error.message });
    return null;
  }
}
async function writeRedisCache(value) {
  if (!redis.isOpen) return;
  try {
    const bounded = cacheWithinLimit(value);
    await redis.set(CACHE_KEY, JSON.stringify(bounded), { EX: Math.max(config.sportsFeedStaleSeconds * 2, 300) });
  } catch (error) {
    logger.warn('Sportsbook Redis cache write failed', { error: error.message });
  }
}
async function readProviderLifecycle() {
  if (memory.lifecycleGeneration === LIFECYCLE_GENERATION && memory.providerLifecycle && Object.keys(memory.providerLifecycle).length) return memory.providerLifecycle;
  if (!redis.isOpen) return {};
  try {
    const raw = await redis.get(LIFECYCLE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    logger.warn('Sportsbook provider lifecycle cache read failed', { error: error.message });
    return {};
  }
}
async function writeProviderLifecycle(value) {
  if (!redis.isOpen) return;
  try {
    await redis.set(LIFECYCLE_KEY, JSON.stringify(value), { EX: Math.max(config.sportsFeedStaleSeconds * 10, 3600) });
  } catch (error) {
    logger.warn('Sportsbook provider lifecycle cache write failed', { error: error.message });
  }
}
async function readMarketLifecycle() {
  if (marketLifecycleMemory && Object.keys(marketLifecycleMemory).length) return marketLifecycleMemory;
  if (!redis.isOpen) return marketLifecycleMemory || {};
  try {
    const raw = await redis.get(MARKET_LIFECYCLE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    marketLifecycleMemory = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    return marketLifecycleMemory;
  } catch (error) {
    logger.warn('Sportsbook market lifecycle cache read failed', { error: error.message });
    return marketLifecycleMemory || {};
  }
}
async function writeMarketLifecycle(value) {
  marketLifecycleMemory = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (!redis.isOpen) return;
  try {
    await redis.set(MARKET_LIFECYCLE_KEY, JSON.stringify(marketLifecycleMemory), { EX: Math.max(config.sportsbookMarketLifecycleRetentionSeconds, 3600) });
  } catch (error) {
    logger.warn('Sportsbook market lifecycle cache write failed', { error: error.message });
  }
}
function providerSummary(result, elapsedMs) {
  const events = result.events || [];
  const pricedMarkets = pricedMarketCount(events);
  const bettableMarkets = bettableMarketCount(events);
  const transportHealthy = Boolean(result.enabled && result.transportOk !== false && !result.stale && !result.skipped);
  return {
    code: result.provider,
    enabled: Boolean(result.enabled),
    healthy: providerHasPricedMarkets(result),
    transportHealthy,
    pricingReady: Boolean(result.enabled && !result.stale && pricedMarkets > 0),
    metadataHealthy: Boolean(result.enabled && !result.stale && events.length > 0),
    events: events.length,
    pricedMarkets,
    bettableMarkets,
    warnings: (result.errors || []).slice(0, 3),
    latencyMs: elapsedMs,
    skipped: Boolean(result.skipped)
  };
}
async function timed(provider, fetcher) {
  const started = performance.now();
  try {
    const result = await fetcher();
    return { result: { ...result, transportOk: result.transportOk !== false }, elapsedMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      result: { provider, enabled: true, events: [], errors: [clean(error.message || 'Provider failed')], transportOk: false },
      elapsedMs: Math.round(performance.now() - started)
    };
  }
}
function applyProviderLifecycleResult(result, lifecycle) {
  const settlementReady = Boolean(lifecycle?.state === 'HEALTHY' && lifecycle?.transportHealthy);
  const events = (result.events || []).map(event => ({
    ...event,
    _settlementReadySources: settlementReady ? [result.provider] : [],
    markets: lifecycle?.bettingAllowed
      ? (event.markets || [])
      : (event.markets || []).map(market => ({
          ...market,
          suspended: true,
          selections: (market.selections || []).map(selection => ({ ...selection, suspended: true }))
        }))
  }));
  return { ...result, events };
}
function bridgeEvent(event, { suspended = false, source = 'supplied-snapshot' } = {}) {
  const markets = (event.markets || []).map(market => {
    const marketSuspended = Boolean(suspended);
    return {
    id: market.id,
    key: market.id,
    type: market.type || 'OTHER',
    label: market.label || market.type || 'Market',
    period: market.period || 'FT',
    line: market.line ?? null,
    mainLine: market.mainLine ?? null,
    suspended: marketSuspended,
    updatedAt: null,
    source,
    selections: (market.selections || []).map(selection => ({
      key: selection.key,
      label: selection.label,
      odds: Number(selection.odds),
      line: selection.handicap ?? selection.line ?? null,
      suspended: marketSuspended,
      source,
      sourceSelectionId: selection.key
    })).filter(selection => Number.isFinite(selection.odds) && selection.odds > 1)
  }; }).filter(market => market.selections.length);
  return {
    id: event.id,
    sport: event.sport || 'Football',
    league: event.league || 'Other',
    country: event.country || null,
    startTime: event.startTime || null,
    status: event.status || (event.live ? 'LIVE' : 'SCHEDULED'),
    live: Boolean(event.live),
    clock: event.clock || null,
    home: { name: event.home?.name || 'Home', score: event.home?.score ?? null, logo: event.home?.logo || null },
    away: { name: event.away?.name || 'Away', score: event.away?.score ?? null, logo: event.away?.logo || null },
    leagueLogo: event.leagueLogo || null,
    venue: event.venue || null,
    periodScores: event.periodScores || {},
    availableMarketCount: Math.max(Number(event.availableMarketCount || 0), markets.length) || markets.length,
    detailFetchedAt: event.detailFetchedAt || null,
    markets,
    _refs: { [source]: event.sourceId || event.id },
    _sources: [source]
  };
}
function suppliedSnapshotResult() {
  const snapshot = loadSuppliedSnapshot();
  return {
    provider: 'supplied-snapshot', enabled: true,
    events: (snapshot.events || []).map(event => bridgeEvent(event, { suspended: true, source: 'supplied-snapshot' })),
    errors: ['Live source unavailable; showing the last supplied source snapshot with betting disabled.'],
    capturedAt: snapshot.capturedAt || null
  };
}
async function performRefresh({ reason = 'scheduled' } = {}) {
  const configured = enabledProviders();
  if (!configured.some(provider => provider.enabled)) {
    throw new AppError(503, 'Belum ada sumber sportsbook yang dikonfigurasi pada core service.', 'SPORTS_PROVIDERS_NOT_CONFIGURED');
  }
  const previousLifecycle = await readProviderLifecycle();
  // Gunakan public-market (gratis) sebagai sumber utama, dengan fallback ke provider berbayar jika dikonfigurasi
  const descriptors = [
    { code: 'public-market', enabled: Boolean(config.publicMarketEnabled), fetcher: fetchPublicMarketFeed },
    { code: 'sharpapi', enabled: config.sharpApiEnabled && Boolean(config.sharpApiKey), fetcher: fetchSharpApi },
    { code: 'api-sports', enabled: config.apiSportsEnabled && Boolean(config.apiSportsKey), fetcher: fetchApiSports },
    { code: 'the-odds-api', enabled: config.theOddsApiEnabled && Boolean(config.theOddsApiKey), fetcher: fetchTheOddsApi },
    { code: 'sportmonks', enabled: config.sportmonksEnabled && Boolean(config.sportmonksKey), fetcher: fetchSportmonks },
    { code: 'footballdata-io', enabled: config.footballDataIoEnabled && Boolean(config.footballDataIoKey), fetcher: fetchFootballDataIo }
  ].filter(d => d.enabled);
  const settled = await Promise.all(descriptors.map(descriptor => {
    const lifecycle = previousLifecycle[descriptor.code];
    if (descriptor.enabled && lifecycle?.state === 'OPEN_CIRCUIT' && !shouldProbeProvider(lifecycle)) {
      return Promise.resolve({
        result: {
          provider: descriptor.code,
          enabled: true,
          events: [],
          errors: ['Provider circuit breaker cooldown active.'],
          transportOk: false,
          skipped: true
        },
        elapsedMs: 0
      });
    }
    return timed(descriptor.code, descriptor.fetcher);
  }));

  let results = settled.map(item => item.result);
  const rawProviderStatus = settled.map(item => providerSummary(item.result, item.elapsedMs));
  const nextLifecycle = {};
  const transitions = [];
  let providerStatus = rawProviderStatus.map(status => {
    const { next, transition } = transitionProviderLifecycle(previousLifecycle[status.code], {
      code: status.code,
      enabled: status.enabled,
      transportHealthy: status.transportHealthy,
      pricingReady: status.pricingReady,
      skipped: status.skipped,
      error: status.warnings[0] || null
    }, lifecycleOptions());
    nextLifecycle[status.code] = next;
    if (transition) transitions.push(transition);
    return {
      ...status,
      state: next.state,
      failureStreak: next.failureStreak,
      successStreak: next.successStreak,
      nextProbeAt: next.nextProbeAt || null,
      bettingAllowed: next.bettingAllowed,
      healthy: next.bettingAllowed
    };
  });

  results = results.map(result => {
    const lifecycle = nextLifecycle[result.provider];
    return applyProviderLifecycleResult(result, lifecycle);
  });

  let events = mergeProviderEvents(results);
  try {
    const exposures = await sportsbookPricingExposureSnapshot({ limit: 5000 });
    events = applySportsbookRiskRepricing(events, exposures);
  } catch (error) {
    logger.warn('Sportsbook risk repricing snapshot unavailable; base prices preserved', { error: error.message });
  }
  // Batasi jumlah event sebelum disimpan ke lifecycle/cache. Ini mencegah lonjakan
  // dari satu sumber provider mengembang tanpa batas di heap proses feed atau payload Redis.
  events = boundedEvents(events);
  // Artwork enrichment dimatikan default (SPORTSBOOK_ARTWORK_ENABLED=false): logo tim
  // adalah metadata-only, tetapi enrichTeamArtwork() melakukan structuredClone SELURUH
  // events + 16 fetch logo per siklus refresh. Odds/settlement tidak membutuhkannya.
  // File team-artwork.js tetap ada (test tetap hijau); panggilannya yang di-skip.
  if (config.sportsbookArtworkEnabled) {
    // Artwork enrichment is metadata-only. A badge provider failure can never suspend odds.
    events = await enrichTeamArtwork(events);
  }
  // Feed-level safety: a finished/suspended event or a prematch event whose kickoff
  // has passed without confirmed live state must not remain counted or rendered as bettable.
  events = enforceEventBettingWindow(events, Date.now());
  // Fail-closed LIVE: market live dengan harga provider basi/tanpa timestamp ditahan
  // (suspended) — tetap terlihat di papan, tetapi tidak bisa dipasang taruhan sampai
  // harga segar datang. Ini kunci keselamatan live betting pada provider free-tier
  // yang refresh-nya jauh lebih lambat dari detik; market otomatis terbuka lagi di
  // siklus berikutnya begitu fetch provider baru mengirim harga segar.
  events = suspendStaleLiveMarkets(events, Date.now());
  // Validasi odds handicap untuk mencegah odds tidak normal (misal: 1.068 vs 9.196)
  events = validateAllHandicapOdds(events);
  let snapshotFallback = false;
  let snapshotCapturedAt = null;
  if (!events.length) {
    const fallback = suppliedSnapshotResult();
    if (fallback.events.length) {
      results = [...results, fallback];
      providerStatus = [...providerStatus, {
        code: 'supplied-snapshot', enabled: true, healthy: false, transportHealthy: true, pricingReady: false,
        metadataHealthy: true, bettingAllowed: false, state: 'READ_ONLY', events: fallback.events.length,
        pricedMarkets: pricedMarketCount(fallback.events), bettableMarkets: 0, warnings: fallback.errors, latencyMs: 0
      }];
      events = boundedEvents(fallback.events);
      snapshotFallback = true;
      snapshotCapturedAt = fallback.capturedAt;
    }
  }
  await writeProviderLifecycle(nextLifecycle);
  if (!events.length) {
    await recordSportsbookProviderTransitions(transitions, { reason, pricedMarkets: 0, bettableMarkets: 0 });
    const warnings = providerStatus.flatMap(item => item.warnings || []);
    throw new AppError(503, warnings[0] || 'Sumber aktif tetapi belum mengembalikan pertandingan.', 'SPORTS_FEED_EMPTY');
  }
  const fetchedAt = Date.now();
  const previousMarketLifecycle = await readMarketLifecycle();
  const marketLifecycle = reconcileSportsbookMarketLifecycle(previousMarketLifecycle, events, {
    reopenSuccesses: config.sportsbookMarketReopenSuccesses,
    reopenObservationSeconds: config.sportsbookMarketReopenObservationSeconds,
    retentionSeconds: config.sportsbookMarketLifecycleRetentionSeconds,
    now: fetchedAt
  });
  events = stampPriceVersions(marketLifecycle.events, fetchedAt);
  await writeMarketLifecycle(marketLifecycle.state);
  const mergedPricedMarkets = pricedMarketCount(events);
  const mergedBettableMarkets = bettableMarketCount(events);
  const pricingProviders = providerStatus
    .filter(provider => provider.enabled && provider.bettingAllowed && provider.pricedMarkets > 0)
    .sort((a, b) => b.bettableMarkets - a.bettableMarkets || b.pricedMarkets - a.pricedMarkets || a.latencyMs - b.latencyMs);
  const primaryPricingProvider = pricingProviders[0]?.code || null;
  const readOnlySource = Boolean(snapshotFallback || mergedBettableMarkets < 1);
  const revision = stableFeedRevision(events, nextLifecycle);
  const priceChanges = priceVersionChangeCount(memory.events || [], events);
  memory = {
    lifecycleGeneration: LIFECYCLE_GENERATION,
    events,
    providers: providerStatus,
    providerLifecycle: nextLifecycle,
    marketLifecycleStats: marketLifecycle.stats,
    revision,
    fetchedAt,
    expiresAt: fetchedAt + REFRESH_MS,
    error: snapshotFallback
      ? { code: 'SPORTS_SNAPSHOT_FALLBACK', message: 'Live source unavailable; supplied source snapshot is read-only.' }
      : readOnlySource && mergedPricedMarkets > 0
        ? { code: 'SPORTS_PRICED_READ_ONLY', message: 'Priced odds tersedia, tetapi provider belum melewati settlement/recovery gate untuk menerima taruhan.' }
        : readOnlySource
          ? { code: 'SPORTS_SOURCE_STALE', message: 'Live priced source belum tersedia; sportsbook tetap read-only.' }
          : null,
    snapshotFallback,
    snapshotCapturedAt,
    readOnlySource,
    pricedMarkets: mergedPricedMarkets,
    bettableMarkets: mergedBettableMarkets,
    primaryPricingProvider,
    lastPriceChanges: priceChanges,
    lastMarketLifecycleTransitionCount: marketLifecycle.transitions.length
  };
  await writeRedisCache(memory);
  await recordSportsbookProviderTransitions(transitions, { reason, feedRevision: revision, pricedMarkets: mergedPricedMarkets, bettableMarkets: mergedBettableMarkets });
  await recordSportsbookMarketTransitions(marketLifecycle.transitions, { reason, feedRevision: revision, pricedMarkets: mergedPricedMarkets, bettableMarkets: mergedBettableMarkets });
  if (marketLifecycle.transitions.length) {
    logger.info('Sportsbook market lifecycle transitions', {
      reason, feedRevision: revision, count: marketLifecycle.transitions.length,
      actions: marketLifecycle.transitions.reduce((acc, item) => { acc[item.action] = (acc[item.action] || 0) + 1; return acc; }, {})
    });
  }
  return memory;
}
function suspendedEvents(events = []) {
  return events.map(event => ({
    ...event,
    status: event.status === 'FINISHED' ? 'FINISHED' : event.status,
    markets: (event.markets || []).map(market => ({
      ...market,
      suspended: true,
      selections: (market.selections || []).map(selection => ({ ...selection, suspended: true }))
    }))
  }));
}

async function markCachedFeedReadOnly(error, { reason = 'refresh-failed' } = {}) {
  if (!memory.events.length) return null;
  const now = Date.now();
  const readOnlyEvents = suspendedEvents(memory.events);
  const forcedSuspended = readOnlyEvents;
  const previousMarketLifecycle = await readMarketLifecycle();
  const marketLifecycle = reconcileSportsbookMarketLifecycle(previousMarketLifecycle, forcedSuspended, {
    reopenSuccesses: config.sportsbookMarketReopenSuccesses,
    reopenObservationSeconds: config.sportsbookMarketReopenObservationSeconds,
    retentionSeconds: config.sportsbookMarketLifecycleRetentionSeconds,
    now
  });
  readOnlyEvents.splice(0, readOnlyEvents.length, ...marketLifecycle.events);
  await writeMarketLifecycle(marketLifecycle.state);
  const revision = stableFeedRevision(readOnlyEvents, memory.providerLifecycle || {});
  memory = {
    ...memory,
    events: readOnlyEvents,
    marketLifecycleStats: marketLifecycle.stats,
    revision,
    providers: (memory.providers || []).map(provider => provider.enabled ? { ...provider, healthy: false, bettingAllowed: false, bettableMarkets: 0 } : provider),
    expiresAt: now + REFRESH_MS,
    readOnlySource: true,
    pricedMarkets: pricedMarketCount(readOnlyEvents),
    bettableMarkets: 0,
    error: { code: error?.code || 'SPORTS_REFRESH_FAILED', message: error?.message || 'Sportsbook live source refresh failed.' }
  };
  await writeRedisCache(memory);
  await recordSportsbookMarketTransitions(marketLifecycle.transitions, { reason, feedRevision: revision, pricedMarkets: memory.pricedMarkets, bettableMarkets: 0 });
  if (marketLifecycle.transitions.length) {
    logger.warn('Sportsbook market lifecycle transitions', {
      reason, feedRevision: revision, count: marketLifecycle.transitions.length,
      actions: marketLifecycle.transitions.reduce((acc, item) => { acc[item.action] = (acc[item.action] || 0) + 1; return acc; }, {})
    });
  }
  logger.warn('Sportsbook cached feed switched to read-only', {
    reason,
    events: memory.events.length,
    code: memory.error.code,
    error: memory.error.message
  });
  return memory;
}

async function acquireRefreshLock(token) {
  // Redis down: JANGAN lolos tanpa proteksi. Return null supaya performWithRefreshLock
  // jatuh ke in-process guard (performWithInProcessGuard) sebagai pengaman minimum.
  if (!redis.isOpen) return null;
  try {
    return String(await redis.set(REFRESH_LOCK_KEY, token, { NX: true, PX: REFRESH_LOCK_TTL_MS })) === 'OK';
  } catch (error) {
    logger.warn('Sportsbook refresh lock unavailable; falling back to in-process guard', { error: error.message });
    return null;
  }
}
async function renewRefreshLock(token) {
  if (!redis.isOpen) return;
  try {
    await redis.eval(
      "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) else return 0 end",
      { keys: [REFRESH_LOCK_KEY], arguments: [token, String(REFRESH_LOCK_TTL_MS)] }
    );
  } catch (error) {
    logger.warn('Sportsbook refresh lock renewal failed; TTL will continue counting down', { error: error.message });
  }
}
async function releaseRefreshLock(token) {
  if (!redis.isOpen) return;
  try {
    await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", { keys: [REFRESH_LOCK_KEY], arguments: [token] });
  } catch (error) {
    logger.warn('Sportsbook refresh lock release failed; TTL will expire it', { error: error.message });
  }
}
function sleep(ms) { return new Promise(resolvePromise => setTimeout(resolvePromise, ms)); }
// Fallback in-process guard: dipakai hanya ketika cross-process Redis lock tidak
// tersedia (Redis down / error). Tetap relay single-flight per proses, tidak menumpuk.
let refreshInFlight = null;
async function performWithInProcessGuard(reason) {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh({ reason }).finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}
async function performWithRefreshLock(reason) {
  if (!redis.isOpen) return performWithInProcessGuard(reason);
  const token = crypto.randomUUID();
  const startedAt = Date.now();
  let held = await acquireRefreshLock(token);
  if (!held) {
    if (held === null) return performWithInProcessGuard(reason);
    const deadline = startedAt + REFRESH_LOCK_WAIT_MS;
    while (Date.now() < deadline && !held) {
      await sleep(REFRESH_LOCK_POLL_MS);
      const cached = await readRedisCache();
      if (cached?.events?.length && Number(cached.fetchedAt || 0) > startedAt) {
        memory = cached;
        return memory;
      }
      held = await acquireRefreshLock(token);
    }
    if (!held) {
      const cached = await readRedisCache();
      if (cached?.events?.length && Number(cached.fetchedAt || 0) >= startedAt) {
        memory = cached;
        return memory;
      }
      throw new AppError(503, 'Sportsbook feed sedang direfresh oleh proses lain; silakan coba kembali.', 'SPORTS_REFRESH_IN_PROGRESS');
    }
  }
  const renewal = setInterval(() => {
    renewRefreshLock(token).catch(error => logger.warn('Sportsbook refresh lock renewal failed', { error: error.message }));
  }, REFRESH_LOCK_RENEW_MS);
  renewal.unref();
  try {
    return await performRefresh({ reason });
  } finally {
    clearInterval(renewal);
    await releaseRefreshLock(token);
  }
}

export async function refreshSportsbookFeed({ reason = 'scheduled' } = {}) {
  try {
    const refreshed = await performWithRefreshLock(reason);
    const allPricedMarkets = refreshed.events.flatMap(event => event.markets || []).filter(market =>
      (market.selections || []).some(selection => Number.isFinite(Number(selection.odds)) && Number(selection.odds) > 1)
    );
    const activeMarkets = allPricedMarkets.filter(market => !market.suspended && (market.selections || []).some(selection => !selection.suspended));
    const bettableEvents = refreshed.events.filter(event => eventBettingOpen(event) && (event.markets || []).some(market => !market.suspended && (market.selections || []).some(selection => !selection.suspended && Number(selection.odds) > 1))).length;
    const memberVisibleEvents = refreshed.events.filter(event => memberVisibleEvent(event)).length;
    const marketCount = (type, period) => activeMarkets.filter(market => market.type === type && market.period === period).length;
    const settlementAuthority = settlementAuthoritySummary(refreshed.events);
    logger.info('Sportsbook live feed refreshed', {
      reason,
      deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
      feedRevision: refreshed.revision || null,
      priceChanges: Number(refreshed.lastPriceChanges || 0),
      marketLifecycleTransitions: Number(refreshed.lastMarketLifecycleTransitionCount || 0),
      events: refreshed.events.length,
      healthyProviders: refreshed.providers.filter(provider => provider.enabled && provider.healthy).length,
      pricedProviders: refreshed.providers.filter(provider => provider.enabled && provider.pricedMarkets > 0).length,
      primaryPricingProvider: refreshed.primaryPricingProvider || null,
      pricedMarkets: allPricedMarkets.length,
      bettableMarkets: activeMarkets.length,
      bettableEvents,
      memberVisibleEvents,
      cashBettingLedger: true,
      cashLedgerMode: 'MEMBER_LEDGER',
      sportsbookHoldAccount: 'SYSTEM:SPORTSBOOK_HOLD',
      readOnly: Boolean(refreshed.readOnlySource),
      snapshotFallback: Boolean(refreshed.snapshotFallback),
      ftMarkets: activeMarkets.filter(market => market.period === 'FT').length,
      htMarkets: activeMarkets.filter(market => market.period === '1H').length,
      ft1x2: marketCount('1X2', 'FT'),
      ht1x2: marketCount('1X2', '1H'),
      ftHandicap: marketCount('HANDICAP', 'FT'),
      htHandicap: marketCount('HANDICAP', '1H'),
      ftTotals: marketCount('TOTALS', 'FT'),
      htTotals: marketCount('TOTALS', '1H'),
      settlementFtEvents: settlementAuthority.ftEvents,
      settlementHtEvents: settlementAuthority.htEvents,
      settlementAutomaticFtEvents: settlementAuthority.automaticFtEvents,
      settlementManualFtEvents: settlementAuthority.manualFtEvents,
      settlementModes: settlementAuthority.modes,
      settlementSources: settlementAuthority.sources,
      lifecycleActive: Number(refreshed.marketLifecycleStats?.active || 0),
      lifecycleSuspended: Number(refreshed.marketLifecycleStats?.suspended || 0),
      lifecycleReopening: Number(refreshed.marketLifecycleStats?.reopening || 0),
      lifecycleClosed: Number(refreshed.marketLifecycleStats?.closed || 0)
    });
    return refreshed;
  } catch (error) {
    if (error?.code === 'SPORTS_REFRESH_IN_PROGRESS') throw error;
    const stale = await markCachedFeedReadOnly(error, { reason });
    if (stale) return stale;
    throw error;
  }
}
// Dipakai worker/feed-worker untuk background poll. Kalau siklus sebelumnya masih
// berjalan, siklus ini di-SKIP (tidak antre) supaya performRefresh() tidak menumpuk
// di heap yang sama.
export async function refreshSportsbookFeedFromPoll({ reason = 'background-poll' } = {}) {
  if (backgroundPollInFlight) {
    logger.info('Sportsbook background poll skipped; previous cycle still running', { reason });
    return memory;
  }
  backgroundPollInFlight = true;
  try {
    return await refreshSportsbookFeed({ reason });
  } finally {
    backgroundPollInFlight = false;
  }
}

async function currentFeed({ force = false } = {}) {
  const now = Date.now();
  if (!force) {
    const cached = await readRedisCache();
    if (cached?.events?.length && Number(cached.fetchedAt || 0) >= Number(memory.fetchedAt || 0)) memory = cached;
    if (memory.events.length && memory.expiresAt > now) return memory;
  }
  if (!inFlight) {
    inFlight = refreshSportsbookFeed({ reason: force ? 'forced-request' : 'request-expired-cache' }).catch(async error => {
      if (error?.code === 'SPORTS_REFRESH_IN_PROGRESS') throw error;
      const stale = await markCachedFeedReadOnly(error, { reason: 'request-refresh-failed' });
      if (stale && now - stale.fetchedAt <= STALE_MS) return stale;
      throw error;
    }).finally(() => { inFlight = null; });
  }
  return inFlight;
}
function normalizedSport(value) {
  const raw = clean(value).toLowerCase();
  if (/basket/.test(raw)) return 'Basketball';
  if (/tennis/.test(raw)) return 'Tennis';
  if (/esport/.test(raw)) return 'Esports';
  if (/hockey/.test(raw)) return 'Ice Hockey';
  if (/baseball/.test(raw)) return 'Baseball';
  return raw ? 'Football' : '';
}
function filterEvents(events, { sport, live, q, league, country, tab, leagues } = {}) {
  const requestedSport = normalizedSport(sport);
  const query = clean(q).toLowerCase();
  const requestedLeague = clean(league).toLowerCase();
  const requestedCountry = clean(country).toLowerCase();
  const requestedTab = clean(tab).toLowerCase();
  const requestedLeagues = leagues === null || leagues === undefined
    ? null
    : new Set(String(leagues).split(',').map(value => clean(value).toLowerCase()).filter(Boolean));
  return events.filter(event => {
    if (!isSoccerEvent(event)) return false;
    if (requestedSport && event.sport !== requestedSport) return false;
    if (String(live).toLowerCase() === 'true' && !event.live) return false;
    if (requestedLeague && clean(event.league).toLowerCase() !== requestedLeague) return false;
    if (requestedLeagues && (!requestedLeagues.size || !requestedLeagues.has(clean(event.league).toLowerCase()))) return false;
    if (requestedCountry && clean(event.country).toLowerCase() !== requestedCountry) return false;
    if (requestedTab && requestedTab !== 'all' && requestedTab !== 'fav') {
      const bucket = eventBucket(event);
      if (bucket !== requestedTab && !(requestedTab === 'today' && bucket === 'live')) return false;
    }
    if (query && !`${event.league} ${event.home.name} ${event.away.name}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

function leagueFacets(events = []) {
  const leagues = new Map();
  for (const event of events) {
    const country = clean(event.country) || 'Internasional';
    const league = clean(event.league) || 'Liga Internasional';
    const key = `${country}|${league}`;
    const entry = leagues.get(key) || { country, league, count: 0, liveCount: 0 };
    entry.count += 1;
    if (eventBucket(event) === 'live') entry.liveCount += 1;
    leagues.set(key, entry);
  }
  return [...leagues.values()].sort((a, b) => {
    const aTop = TOP_LEAGUE_PATTERNS.some(pattern => pattern.test(`${a.country} ${a.league}`));
    const bTop = TOP_LEAGUE_PATTERNS.some(pattern => pattern.test(`${b.country} ${b.league}`));
    return Number(bTop) - Number(aTop) || a.country.localeCompare(b.country) || a.league.localeCompare(b.league);
  });
}

function memberEventShape(item, markets) {
  return {
    id: item.id,
    sport: item.sport,
    league: item.league,
    country: item.country,
    startTime: item.startTime,
    status: item.status,
    live: item.live,
    clock: item.clock,
    home: item.home,
    away: item.away,
    leagueLogo: item.leagueLogo,
    venue: item.venue,
    availableMarketCount: item.availableMarketCount,
    detailLoaded: item.detailLoaded,
    markets: projectMemberMarkets(markets)
  };
}
function memberPublicEvent(event) {
  const item = publicEvent(event);
  const markets = (item.markets || []).filter(market =>
    SUMMARY_MARKET_TYPES.has(String(market.type || '').toUpperCase())
    && String(market.period || 'FT').toUpperCase() === 'FT'
  );
  return memberEventShape(item, markets);
}
function memberPublicEventDetail(event) {
  const item = publicEvent(event);
  return memberEventShape(item, item.markets || []);
}

function paginateEvents(events = [], { offset, limit } = {}) {
  const pageSize = Math.min(MAX_SNAPSHOT_PAGE_SIZE, Math.max(1, Number(limit) || DEFAULT_SNAPSHOT_PAGE_SIZE));
  const start = Math.max(0, Math.min(events.length, Math.floor(Number(offset) || 0)));
  const page = events.slice(start, start + pageSize);
  return {
    events: page,
    pagination: {
      offset: start,
      limit: pageSize,
      total: events.length,
      hasMore: start + page.length < events.length
    }
  };
}

export async function sportsbookSnapshot(filters = {}, { memberView = true } = {}) {
  const feed = await currentFeed();
  const now = Date.now();
  const stale = Boolean(feed.readOnlySource || feed.snapshotFallback || !feed.fetchedAt || now - Number(feed.fetchedAt) > STALE_MS);
  const controls = await listActiveSportsbookTradingControls();
  const soccerEvents = (feed.events || []).filter(isSoccerEvent).filter(event => memberVisibleEvent(event, now));
  const facets = leagueFacets(soccerEvents);
  const counts = {
    all: soccerEvents.length,
    live: soccerEvents.filter(event => eventBucket(event, now) === 'live').length,
    today: soccerEvents.filter(event => eventBucket(event, now) === 'today' || eventBucket(event, now) === 'live').length,
    early: soccerEvents.filter(event => eventBucket(event, now) === 'early').length
  };
  let sourceEvents = filterEvents(soccerEvents, filters);
  if (memberView) {
    sourceEvents = sourceEvents
      .sort((a, b) => {
        const aStart = Date.parse(a.startTime || '') || Number.POSITIVE_INFINITY;
        const bStart = Date.parse(b.startTime || '') || Number.POSITIVE_INFINITY;
        return aStart - bStart || String(a.id).localeCompare(String(b.id));
      })
      .slice(0, Number(config.sportsbookMemberMaxEvents || MAX_FEED_EVENTS));
  }
  const page = paginateEvents(sourceEvents, filters);
  sourceEvents = page.events;
  const projected = memberView ? sourceEvents.map(memberPublicEvent) : sourceEvents.map(publicEvent);
  const events = applySportsbookTradingControls(projected, controls);
  const visiblePricedMarkets = pricedMarketCount(events);
  const visibleBettableMarkets = bettableMarketCount(events);
  const memberHealthy = !stale && !feed.readOnlySource && Number(feed.bettableMarkets || 0) > 0;
  return {
    events,
    leagues: facets,
    counts,
    pagination: page.pagination,
    stale,
    degraded: !memberHealthy,
    source: {
      name: 'Gasterus Sportsbook Feed',
      mode: feed.snapshotFallback
        ? 'READ_ONLY_SNAPSHOT'
        : feed.readOnlySource && Number(feed.pricedMarkets || 0) > 0
          ? 'READ_ONLY_PRICED_NO_SETTLEMENT_AUTHORITY'
          : feed.readOnlySource
            ? 'READ_ONLY_STALE_SOURCE'
            : 'LIVE_SOURCE_AGGREGATOR',
      status: feed.readOnlySource ? (visiblePricedMarkets > 0 ? 'PRICED_READ_ONLY' : 'STALE') : memberHealthy ? 'ONLINE' : 'DEGRADED',
      fetchedAt: new Date(feed.fetchedAt).toISOString(),
      capturedAt: feed.snapshotCapturedAt || null,
      refreshSeconds: config.sportsFeedRefreshSeconds,
      pricedMarkets: visiblePricedMarkets,
      bettableMarkets: visibleBettableMarkets,
      feedRevision: feed.revision || null
    },
    capabilities: {
      betBuilderPricedMarkets: events.some(event => event.markets?.some(market => market.type === 'BET_BUILDER' && !market.suspended)),
      ftMarkets: events.some(event => event.markets?.some(market => market.period === 'FT' && !market.suspended)),
      htMarkets: events.some(event => event.markets?.some(market => market.period === '1H' && !market.suspended)),
      ftHtCoreMarkets: events.some(event => {
        const core = new Set((event.markets || []).filter(market => !market.suspended).map(market => `${market.type}:${market.period}`));
        return ['1X2:FT','1X2:1H','HANDICAP:FT','HANDICAP:1H','TOTALS:FT','TOTALS:1H'].every(key => core.has(key));
      }),
      cashOut: Boolean(config.sportsbookCashoutEnabled),
      realtime: Boolean(config.sportsbookRealtimeEnabled),
      liveStatistics: false
    },
    betting: {
      minStake: config.sportsbookMinStake,
      maxStake: config.sportsbookMaxStake,
      maxPayout: config.sportsbookMaxPayout,
      maxLegs: config.sportsbookMaxLegs,
      quoteRequired: config.sportsbookQuoteRequired,
      quoteTtlSeconds: config.sportsbookQuoteTtlSeconds,
      types: ['SINGLE', 'PARLAY', 'SYSTEM']
    }
  };
}

export async function sportsbookEventSnapshot(eventId) {
  const requested = clean(eventId);
  if (!requested) throw new AppError(400, 'ID pertandingan wajib diisi.', 'SPORTS_EVENT_ID_REQUIRED');
  const feed = await currentFeed();
  let current = feed.events.find(item => item.id === requested);
  if (!current) throw new AppError(404, 'Pertandingan tidak ditemukan.', 'SPORTS_EVENT_UNAVAILABLE');
  const controls = await listActiveSportsbookTradingControls({ eventId: current.id });
  return {
    event: applySportsbookTradingControls([memberPublicEventDetail(current)], controls)[0],
    detailLimited: false,
    source: {
      mode: feed.readOnlySource ? 'READ_ONLY_STALE_SOURCE' : 'LIVE',
      fetchedAt: new Date(feed.fetchedAt).toISOString(),
      feedRevision: feed.revision || null
    }
  };
}


export async function sportsbookSettlementSnapshot() {
  const feed = await currentFeed({ force: true });
  if (feed.readOnlySource || feed.snapshotFallback) {
    throw new AppError(503, 'Sumber sportsbook read-only/stale tidak boleh dipakai untuk settlement.', 'SPORTS_SETTLEMENT_SOURCE_STALE');
  }
  const authorities = feed.events.map(event => eventSettlementAuthority(event));
  const settlementSources = [...new Set(authorities.flatMap(authority => authority.sources))];
  return {
    fetchedAt: feed.fetchedAt,
    feedRevision: feed.revision || null,
    sourceName: settlementSources.length ? `GASTERUS_AUTHORITY:${settlementSources.join('+')}` : 'GASTERUS_AUTHORITY:UNAVAILABLE',
    settlementSources,
    events: feed.events.map((event, index) => ({
      ...publicEvent(event),
      settlementAuthority: authorities[index]
    }))
  };
}

export function sportsbookSourceStatus() {
  const enabledCount = enabledProviders().filter(provider => provider.enabled).length;
  const healthyCount = memory.providers.filter(provider => provider.enabled && provider.bettingAllowed).length;
  return {
    configured: enabledCount > 0,
    healthy: healthyCount > 0 && !memory.readOnlySource && !memory.snapshotFallback,
    cachedEvents: memory.events.length,
    fetchedAt: memory.fetchedAt ? new Date(memory.fetchedAt).toISOString() : null,
    feedRevision: memory.revision || null,
    stale: Boolean(memory.readOnlySource || memory.snapshotFallback || (memory.expiresAt ? Date.now() > memory.expiresAt : true)),
    snapshotFallback: Boolean(memory.snapshotFallback),
    providers: Object.values(memory.providerLifecycle || {}).map(publicProviderLifecycle)
  };
}

export async function sportsbookOperationalStatus() {
  const feed = await currentFeed();
  const controls = await listActiveSportsbookTradingControls();
  const controlledEvents = applySportsbookTradingControls((feed.events || []).map(publicEvent), controls);
  const activeMarkets = controlledEvents.flatMap(event => event.markets || []).filter(market =>
    !market.suspended && (market.selections || []).some(selection => !selection.suspended && Number(selection.odds) > 1)
  );
  const operatorSuspendedMarkets = controlledEvents.flatMap(event => event.markets || []).filter(market => market.trading?.suspendedByOperator).length;
  const count = (type, period) => activeMarkets.filter(market => market.type === type && market.period === period).length;
  return {
    feedRevision: feed.revision || null,
    fetchedAt: feed.fetchedAt ? new Date(feed.fetchedAt).toISOString() : null,
    expiresAt: feed.expiresAt ? new Date(feed.expiresAt).toISOString() : null,
    feedAgeSeconds: feed.fetchedAt ? Math.max(0, Math.floor((Date.now() - feed.fetchedAt) / 1000)) : null,
    lastPriceChanges: Number(feed.lastPriceChanges || 0),
    lastMarketLifecycleTransitionCount: Number(feed.lastMarketLifecycleTransitionCount || 0),
    readOnly: Boolean(feed.readOnlySource),
    snapshotFallback: Boolean(feed.snapshotFallback),
    primaryPricingProvider: feed.primaryPricingProvider || null,
    events: (feed.events || []).length,
    liveEvents: (feed.events || []).filter(event => event.live).length,
    pricedMarkets: Number(feed.pricedMarkets || 0),
    upstreamBettableMarkets: Number(feed.bettableMarkets || 0),
    bettableMarkets: activeMarkets.length,
    tradingControls: {
      active: controls.length,
      suspended: controls.filter(control => control.suspended).length,
      operatorSuspendedMarkets
    },
    marketLifecycle: {
      active: Number(feed.marketLifecycleStats?.active || 0),
      suspended: Number(feed.marketLifecycleStats?.suspended || 0),
      reopening: Number(feed.marketLifecycleStats?.reopening || 0),
      closed: Number(feed.marketLifecycleStats?.closed || 0),
      reopenSuccessesRequired: config.sportsbookMarketReopenSuccesses,
      reopenObservationSeconds: config.sportsbookMarketReopenObservationSeconds
    },
    coverage: {
      ft1x2: count('1X2', 'FT'),
      ht1x2: count('1X2', '1H'),
      ftHandicap: count('HANDICAP', 'FT'),
      htHandicap: count('HANDICAP', '1H'),
      ftTotals: count('TOTALS', 'FT'),
      htTotals: count('TOTALS', '1H')
    },
    lifecyclePolicy: {
      failureThreshold: config.sportsbookProviderFailureThreshold,
      recoverySuccesses: config.sportsbookProviderRecoverySuccesses,
      cooldownSeconds: config.sportsbookProviderCooldownSeconds
    },
    settlementAuthority: settlementAuthoritySummary(feed.events),
    providers: feed.providers.map(provider => ({
      code: provider.code,
      enabled: Boolean(provider.enabled),
      state: provider.state || null,
      transportHealthy: Boolean(provider.transportHealthy),
      pricingReady: Boolean(provider.pricingReady),
      bettingAllowed: Boolean(provider.bettingAllowed),
      failureStreak: Number(provider.failureStreak || 0),
      successStreak: Number(provider.successStreak || 0),
      nextProbeAt: provider.nextProbeAt ? new Date(provider.nextProbeAt).toISOString() : null,
      events: Number(provider.events || 0),
      pricedMarkets: Number(provider.pricedMarkets || 0),
      bettableMarkets: Number(provider.bettableMarkets || 0),
      latencyMs: Number(provider.latencyMs || 0),
      warnings: (provider.warnings || []).slice(0, 3)
    }))
  };
}

export async function sportsbookSelectionSnapshot({ eventId, marketId, selectionId }) {
  let feed = await currentFeed();
  let event = feed.events.find(item => item.id === eventId);
  let market = event?.markets.find(item => item.id === marketId);
  let selection = market?.selections.find(item => item.key === selectionId);
  if (!event || !market || !selection || market.suspended || selection.suspended) {
    feed = await currentFeed({ force: true });
    event = feed.events.find(item => item.id === eventId);
    market = event?.markets.find(item => item.id === marketId);
    selection = market?.selections.find(item => item.key === selectionId);
  }
  if (!event) throw new AppError(409, 'Pertandingan sudah tidak tersedia.', 'SPORTS_EVENT_UNAVAILABLE');
  const scheduledStart = Date.parse(event.startTime || '');
  if (!event.live && event.status === 'SCHEDULED' && Number.isFinite(scheduledStart) && Date.now() > scheduledStart + config.sportsbookPrematchCloseGraceSeconds * 1000) {
    throw new AppError(409, 'Kickoff sudah tercapai tetapi status live belum terkonfirmasi. Market ditahan sampai sumber resmi memperbarui status pertandingan.', 'SPORTS_EVENT_START_STATUS_PENDING');
  }
  if (!market || market.suspended) throw new AppError(409, 'Pasaran sedang ditutup atau tidak tersedia.', 'SPORTS_MARKET_SUSPENDED');
  if (!selection || selection.suspended) throw new AppError(409, 'Pilihan odds sedang ditutup atau tidak tersedia.', 'SPORTS_SELECTION_SUSPENDED');
  if (event.status === 'FINISHED' || event.status === 'SUSPENDED') throw new AppError(409, 'Pertandingan tidak dapat menerima taruhan.', 'SPORTS_EVENT_CLOSED');
  const providerCode = selection.source || market.source || null;
  const providerState = providerCode ? feed.providers.find(provider => provider.code === providerCode) : null;
  if (providerState && !providerState.bettingAllowed) {
    logger.warn('Sportsbook selection temporarily unavailable by provider lifecycle gate', {
      eventId: event.id, marketId: market.id, selectionId: selection.key,
      provider: providerCode, state: providerState.state || null,
      failureStreak: Number(providerState.failureStreak || 0), successStreak: Number(providerState.successStreak || 0)
    });
    throw new AppError(409, 'Pasaran sedang diperbarui. Tunggu pembaruan berikutnya lalu coba kembali.', 'SPORTS_MARKET_TEMPORARILY_UNAVAILABLE');
  }
  assertSelectionFresh(event, market, selection, feed.fetchedAt);
  const tradingPolicy = await resolveSportsbookTradingPolicy({ eventId: event.id, marketId: market.id, selectionId: selection.key });
  if (tradingPolicy.suspended) {
    throw new AppError(409, 'Pasaran ditutup oleh trading desk.', 'SPORTSBOOK_OPERATOR_SUSPENDED', {
      eventId: event.id,
      marketId: market.id,
      selectionId: selection.key,
      controlVersion: tradingPolicy.versionToken
    });
  }
  return {
    event, market, selection, feedFetchedAt: feed.fetchedAt,
    feedRevision: feed.revision || null,
    providerState: providerState?.state || null,
    priceVersion: selection.priceVersion,
    priceUpdatedAt: selection.updatedAt || market.updatedAt || null,
    tradingPolicy
  };
}

export const __sportsbookFeed = { filterEvents, leagueFacets, paginateEvents, isSoccerEvent, eventBucket, normalizedSport, pricedMarketCount, bettableMarketCount, providerHasPricedMarkets, stampPriceVersions, stableFeedRevision, assertSelectionFresh, advanceProviderLifecycle, eventBettingOpen, enforceEventBettingWindow, memberVisibleEvent, boundedEvents, cacheWithinLimit, eventSettlementAuthority, settlementAuthoritySummary, memberPublicEvent, memberPublicEventDetail };
