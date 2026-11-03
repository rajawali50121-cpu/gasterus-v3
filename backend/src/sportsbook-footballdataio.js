import crypto from 'node:crypto';
import { config } from './config.js';
import {
  normalizedEvent,
  normalizedMarket,
  normalizedSelection,
  clean,
  iso,
  status
} from './sportsbook-providers.js';

// Gasterus sportsbook provider adapter for footballdata.io.
// Only provider-supplied decimal odds are eligible for the betting feed.
const PROVIDER = 'footballdata-io';
const BASE_HOST = 'footballdata.io';

function hash(...parts) {
  return crypto.createHash('sha256').update(parts.map(v => clean(v, 500)).join('|')).digest('hex').slice(0, 28);
}
function teamKey(value) {
  return clean(value).toLowerCase().normalize('NFKC').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
async function requestJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.sportsFeedRequestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'ASEAN777-Sports-Aggregator/2.0', Authorization: `Bearer ${config.footballDataIoKey}` },
      signal: controller.signal,
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`footballdata.io returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 12 * 1024 * 1024) throw new Error('footballdata.io response exceeds size limit');
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchMatches() {
  const base = config.footballDataIoBaseUrl.replace(/\/$/, '');
  const limit = Number(config.footballDataIoUpcomingLimit || 200);
  const collected = new Map();
  const endpoints = [`${base}/fixtures/today`, `${base}/fixtures/upcoming`];
  for (const path of endpoints) {
    try {
      const payload = await requestJson(path);
      const matches = payload?.data?.matches || [];
      for (const m of matches) {
        if (m && m.match_id) collected.set(String(m.match_id), m);
        if (collected.size >= limit) break;
      }
    } catch (error) {
      // One endpoint failing must not block the other (today vs upcoming).
      if (!collected.size) throw error;
    }
    if (collected.size >= limit) break;
  }
  return [...collected.values()].slice(0, limit);
}

function buildEvent(match) {
  const odds = match.odds || {};
  const [realHome, realDraw, realAway] = [odds.home_win, odds.draw, odds.away_win].map(Number);
  if (![realHome, realDraw, realAway].every(value => Number.isFinite(value) && value > 1)) return null;

  const providerId = String(match.match_id);
  const startTime = iso(match.match_date);
  if (!startTime) return null;
  const homeName = clean(match.home_team?.team_name || match.home_team?.name, 120);
  const awayName = clean(match.away_team?.team_name || match.away_team?.name, 120);
  if (!homeName || !awayName) return null;

  const event = normalizedEvent({
    provider: PROVIDER,
    providerId,
    sport: 'Football',
    league: match.league?.name || match.league?.competition_name || 'Football',
    country: match.league?.country || null,
    startTime,
    state: match.status || 'incomplete',
    providerStatus: match.status || null,
    clock: null,
    home: homeName,
    away: awayName,
    homeScore: match.score?.home ?? null,
    awayScore: match.score?.away ?? null,
    homeLogo: match.home_team?.team_logo || null,
    awayLogo: match.away_team?.team_logo || null,
    leagueLogo: match.league?.image || null,
    venue: match.venue?.stadium_name || null
  });

  const oneXtwo = normalizedMarket(event.id, {
    key: '1X2:FT',
    name: '1X2',
    type: '1X2',
    period: 'FT',
    selections: [
      normalizedSelection(event.id, '1X2:FT', 'Home', realHome, { source: PROVIDER, sourceSelectionId: `fd:home:${providerId}` }),
      normalizedSelection(event.id, '1X2:FT', 'Draw', realDraw, { source: PROVIDER, sourceSelectionId: `fd:draw:${providerId}` }),
      normalizedSelection(event.id, '1X2:FT', 'Away', realAway, { source: PROVIDER, sourceSelectionId: `fd:away:${providerId}` })
    ].filter(Boolean),
    source: PROVIDER,
    sourceMarketId: `fd:1x2:${providerId}`,
    mainLine: true
  });
  if (!oneXtwo) return null;

  event.markets = [oneXtwo];
  event._refs = { [PROVIDER]: providerId };
  event._sources = [PROVIDER];
  event._settlementReadySources = [PROVIDER, 'manual-ops'];
  event._settlementMode = 'FOOTBALLDATA_IO_AUTO_WITH_MANUAL_FALLBACK';
  return event;
}

let cache = { fetchedAt: 0, events: [], warnings: [] };
let inFlight = null;

export async function fetchFootballDataIo() {
  if (!config.footballDataIoEnabled || !config.footballDataIoKey) {
    return { provider: PROVIDER, enabled: false, events: [] };
  }
  const ageMs = Date.now() - Number(cache.fetchedAt || 0);
  if (cache.events.length && ageMs < config.footballDataIoRefreshSeconds * 1000) {
    return { provider: PROVIDER, enabled: true, events: structuredClone(cache.events), errors: cache.warnings, stale: false, transportOk: true };
  }
  if (!inFlight) {
    inFlight = (async () => {
      const matches = await fetchMatches();
      const events = [];
      const warnings = [];
      for (const m of matches) {
        try {
          const ev = buildEvent(m);
          if (ev) events.push(ev);
        } catch (e) {
          warnings.push(`footballdata.io match ${m?.match_id}: ${clean(e.message)}`);
        }
      }
      if (!events.length) throw new Error(`footballdata.io returned no priced events (${warnings.join(' | ') || 'no matches'})`);
      cache = { fetchedAt: Date.now(), events, warnings: [...new Set(warnings)] };
      return cache;
    })().finally(() => { inFlight = null; });
  }
  try {
    const loaded = await inFlight;
    return { provider: PROVIDER, enabled: true, events: structuredClone(loaded.events), errors: loaded.warnings, stale: false, transportOk: true };
  } catch (error) {
    const maxStaleMs = config.footballDataIoRefreshSeconds * 1000 * 2;
    if (cache.events.length && ageMs <= maxStaleMs) {
      return { provider: PROVIDER, enabled: true, events: structuredClone(cache.events), errors: [`Refresh failed; serving cached footballdata.io odds: ${error.message}`], stale: false, transportOk: true, cachedFallback: true };
    }
    return { provider: PROVIDER, enabled: true, events: [], errors: [error.message], stale: true, transportOk: false };
  }
}

export const __footballDataIo = { buildEvent, fetchMatches, teamKey };
