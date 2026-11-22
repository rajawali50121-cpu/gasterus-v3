import { createHash } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';

const PROVIDER = 'sportradar';
const DEFAULT_BASE_URL = 'https://api.sportradar.com/oddscomparison-prematch/production/v2/en';
const PAGE_SIZE = 50;
const DEFAULT_SPORT_IDS = ['sr:sport:1'];

function clean(value, max = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function number(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}
function iso(value) {
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
function hash(...parts) {
  return createHash('sha256').update(parts.map(value => clean(value, 500)).join('|')).digest('hex').slice(0, 28);
}
function apiKey() { return config.sportradarApiKey || ''; }
function baseUrl() { return (config.sportradarBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''); }
function headers() { return { 'x-api-key': apiKey(), accept: 'application/json' }; }

const callState = { lastCallAt: 0, hourStart: 0, callsThisHour: 0 };
function resetHourIfNeeded(now = Date.now()) {
  if (!callState.hourStart || now - callState.hourStart >= 3600000) {
    callState.hourStart = now;
    callState.callsThisHour = 0;
  }
}
function callsRemaining() {
  resetHourIfNeeded();
  const configured = Number(config.sportradarMaxCallsPerHour || 0);
  return configured > 0 ? Math.max(0, configured - callState.callsThisHour) : Infinity;
}
async function throttle() {
  const minInterval = Math.max(0, Number(config.sportradarMinIntervalMs || 1100));
  const wait = minInterval - (Date.now() - callState.lastCallAt);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}
function retryDelay(response, attempt) {
  const value = response.headers?.get?.('retry-after');
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(1000, date - Date.now());
  }
  return Math.min(120000, 5000 * (2 ** attempt));
}
async function fetchJson(url, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (callsRemaining() <= 0) {
      throw new Error('Sportradar configured hourly API-call budget exhausted; current cycle is incomplete and was not published.');
    }
    await throttle();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.sportradarRequestTimeoutMs || 30000);
    try {
      callState.lastCallAt = Date.now();
      callState.callsThisHour += 1;
      const response = await fetch(url, { headers: headers(), signal: controller.signal });
      if (response.status === 429) {
        const retryAfter = response.headers?.get?.('retry-after') || null;
        const rateLimit = {
          limit: response.headers?.get?.('x-ratelimit-limit') || null,
          remaining: response.headers?.get?.('x-ratelimit-remaining') || null,
          reset: response.headers?.get?.('x-ratelimit-reset') || null
        };
        const body = clean(await response.text().catch(() => ''), 180);
        const path = new URL(url).pathname;
        lastError = new Error(
          `Sportradar rate limited (HTTP 429; path=${path}; retryAfter=${retryAfter || 'not-provided'}; rateLimit=${JSON.stringify(rateLimit)}; response=${body || 'empty'}).`
        );
        // "Limit Exceeded" is an account quota response, not a short QPS burst.
        // Retrying it immediately only burns more of the same exhausted quota.
        if (/Limit Exceeded/i.test(body)) {
          lastError.code = 'SPORTRADAR_QUOTA_EXCEEDED';
          throw lastError;
        }
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay(response, attempt)));
          continue;
        }
        throw lastError;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Sportradar responded HTTP ${response.status}: ${body.slice(0, 240)}`);
      }
      return { data: await response.json(), headers: response.headers };
    } catch (error) {
      lastError = error;
      if (error?.code === 'SPORTRADAR_QUOTA_EXCEEDED') throw error;
      if (attempt < maxRetries && !/^Sportradar rate limited \\(HTTP 429/i.test(error?.message || String(error))) {
        await new Promise(resolve => setTimeout(resolve, Math.min(10000, 1000 * (attempt + 1))));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('Sportradar request failed.');
}

function wibDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}
function dateKeyFromUtc(date) { return date.toISOString().slice(0, 10); }
function dateBounds(daysAhead, now = new Date()) {
  const { year, month, day } = wibDateParts(now);
  const start = Date.parse(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00+07:00`);
  const end = start + (Math.max(1, daysAhead) + 1) * 86400000 - 1;
  return { start, end };
}
function requestedDates(daysAhead, now = new Date()) {
  const bounds = dateBounds(daysAhead, now);
  const firstUtcDay = Math.floor(bounds.start / 86400000) * 86400000;
  const lastUtcDay = Math.floor(bounds.end / 86400000) * 86400000;
  const dates = [];
  for (let day = firstUtcDay; day <= lastUtcDay; day += 86400000) {
    dates.push(dateKeyFromUtc(new Date(day)));
  }
  return dates;
}
function competitorName(competitor) {
  return competitor && typeof competitor === 'object'
    ? clean(competitor.name || competitor.display_name, 120) || null
    : null;
}
function leagueName(raw, item = null) {
  const context = raw?.sport_event_context || item?.sport_event_context || {};
  return clean(
    context.competition?.name
      || context.tournament?.name
      || context.stage?.name
      || context.category?.name
      || 'Unclassified competition',
    120
  );
}
function isRemovedFlag(value) {
  return value === true || String(value ?? '').trim().toLowerCase() === 'true';
}
function normalizedEventStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['ended', 'aet', 'finished', 'final'].includes(status)) return 'FINISHED';
  if (['live', 'in_progress', 'inprogress', 'started', '1st_period', '2nd_period', 'period_1', 'period_2', '1st_half', '2nd_half', 'first_half', 'second_half', 'halftime', 'half_time', 'extra_time', 'overtime', 'penalties', 'penalty_shootout', 'break'].includes(status)) return 'LIVE';
  if (['cancelled', 'canceled', 'abandoned', 'postponed', 'suspended', 'interrupted'].includes(status)) return 'SUSPENDED';
  if (['not_started', 'scheduled', 'pre_match', 'prematch', 'fixture', ''].includes(status)) return 'SCHEDULED';
  return 'UNKNOWN';
}
function normalizeScheduleEvent(raw, item = null, sport = null, generatedAt = null) {
  if (!raw || typeof raw !== 'object' || !raw.id) return { event: null, reason: 'missing-documented-event-id' };
  const startTime = iso(raw.start_time);
  if (!startTime) return { event: null, reason: 'missing-or-invalid-documented-start-time' };

  const competitors = Array.isArray(raw.competitors) ? raw.competitors : [];
  let home = null;
  let away = null;
  let country = null;
  for (const competitor of competitors) {
    const name = competitorName(competitor);
    if (!name) continue;
    if (!country && competitor.country) country = clean(competitor.country, 80) || null;
    const qualifier = String(competitor.qualifier || '').toLowerCase();
    if (qualifier === 'home') home = name;
    if (qualifier === 'away') away = name;
  }
  const namedCompetitors = competitors.map(competitorName).filter(Boolean);
  home ||= namedCompetitors[0] || 'TBD';
  away ||= namedCompetitors[1] || 'TBD';
  const id = String(raw.id);
  const context = raw.sport_event_context || item?.sport_event_context || {};
  const scheduleItem = item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).filter(([key]) => !['sport_event', 'sport_event_context', 'markets'].includes(key)))
    : {};
  country = country || clean(context.category?.country || context.competition?.country, 80) || null;
  const status = clean(raw.status, 40) || 'unknown';
  const mappedStatus = normalizedEventStatus(status);
  return {
    reason: null,
    event: {
      provider: PROVIDER, providerId: id, id,
      sport: clean(sport?.name || sport?.id || 'Unknown sport', 40),
      sportId: sport?.id || null,
      league: leagueName(raw, item), country, startTime,
      state: mappedStatus, status: mappedStatus, live: false,
      providerStatus: status, replacedBy: raw.replaced_by || null,
      startTimeConfirmed: raw.start_time_confirmed ?? null,
      resumeTime: iso(raw.resume_time),
      sourceData: { sportEvent: raw, sportEventContext: context, sport, generatedAt, scheduleItem },
      clock: null,
      home: { name: home, score: null, logo: null },
      away: { name: away, score: null, logo: null },
      homeScore: null, awayScore: null, markets: [],
      _refs: { [PROVIDER]: id }, _sources: [PROVIDER]
    }
  };
}
function marketIdNumber(value) {
  const match = String(value ?? '').match(/(?:^|:)market:(\d+)$/);
  return match ? Number(match[1]) : null;
}
const MARKET_TYPE_BY_ID = new Map([
  [1, '1X2'], [10, 'DOUBLE_CHANCE'], [11, 'DRAW_NO_BET'],
  [14, 'EUROPEAN_HANDICAP'], [16, 'HANDICAP'], [18, 'TOTALS'],
  [26, 'OTHER'], [29, 'BTTS'], [45, 'CORRECT_SCORE'],
  [60, '1X2'], [64, 'DRAW_NO_BET'],
  [66, 'HANDICAP'], [68, 'TOTALS'], [69, 'TEAM_TOTAL'], [70, 'TEAM_TOTAL']
]);
const MARKET_PERIOD_BY_ID = new Map([
  [26, 'FT'],
  [60, '1H'], [64, '1H'], [66, '1H'],
  [68, '1H'], [69, '1H'], [70, '1H'],
  [83, '2H'], [231, '2H'], [232, '2H'], [293, '2H'], [294, '2H']
]);
export function marketType(name, outcomeCount = null, hasDrawOutcome = false, marketId = null) {
  const idType = MARKET_TYPE_BY_ID.get(marketIdNumber(marketId));
  if (idType) return idType;
  const value = clean(name, 120).toLowerCase();
  if (/\bhalf.?time.*full.?time|first.?half.*full.?time|1st.?half.*full.?time|\bht\s*[/\-]?\s*ft\b/.test(value)) return 'HT_FT';
  if (/european.?handicap|three.?way.?handicap/.test(value)) return 'EUROPEAN_HANDICAP';
  if (/1x2|money.?line|match.?winner|match.?result|three.?way|first.?half.*result|1st.?half.*result|half.?time.*result/.test(value)) return '1X2';
  if (/asian.?handicap|asian.?spread/.test(value)) return 'HANDICAP';
  if (/handicap|spread/.test(value)) {
    // More than two outcomes can represent multiple Asian lines, not a draw.
    if (hasDrawOutcome) return 'EUROPEAN_HANDICAP';
    return outcomeCount >= 2 ? 'HANDICAP' : 'OTHER';
  }
  if (/team.?total/.test(value)) return 'TEAM_TOTAL';
  if (/total|over.?under|goals/.test(value)) return 'TOTALS';
  if (/both.?teams|btts/.test(value)) return 'BTTS';
  if (/double.?chance/.test(value)) return 'DOUBLE_CHANCE';
  if (/draw.?no.?bet/.test(value)) return 'DRAW_NO_BET';
  if (/correct.?score/.test(value)) return 'CORRECT_SCORE';
  if (/corner/.test(value)) return 'CORNERS';
  if (/card/.test(value)) return 'CARDS';
  if (/player|scorer|assist|shots/.test(value)) return 'PLAYER_PROP';
  return 'OTHER';
}
export function periodFromMarket(name, metadata = {}) {
  const value = clean(name, 240).toLowerCase();
  const candidates = [
    metadata.period, metadata.period_name, metadata.periodName,
    metadata.match_period, metadata.matchPeriod, metadata.period_id,
    metadata.description, metadata.market_name, metadata.marketName,
    metadata.specifiers?.period, metadata.specifiers?.match_period,
    metadata.period?.name, metadata.period?.description, metadata.period?.type,
    metadata.market_period?.name, metadata.market_period?.description
  ].map(item => typeof item === 'object' && item !== null
    ? clean(item.name || item.description || item.type || item.id, 120).toLowerCase()
    : clean(item, 120).toLowerCase()).filter(Boolean);

  const classify = candidate => {
    if (/half.?time.*full.?time|first.?half.*full.?time|1st.?half.*full.?time|\bht\s*[\/-]?\s*ft\b/.test(candidate)) return 'HT_FT';
    if (/second.?half|2nd.?half|second.?period|2nd.?period|\b2h\b|\bht2\b|period\s*2/.test(candidate)) return '2H';
    if (/first.?half|1st.?half|half.?time|first.?period|1st.?period|\b1h\b|\bht\b|period\s*1/.test(candidate)) return '1H';
    if (/full.?time|full.?match|match.?time|regular.?time|\bft\b|\bmatch\b/.test(candidate)) return 'FT';
    return null;
  };

  // A named first-half market always wins over generic metadata such as "match".
  const namedPeriod = classify(value);
  if (namedPeriod) return namedPeriod;
  let genericPeriod = null;
  for (const candidate of candidates) {
    const period = classify(candidate);
    if (period && period !== 'FT') return period;
    if (period === 'FT') genericPeriod = period;
  }
  // A documented first-half market ID is more specific than generic metadata
  // such as period="match"; do not silently downgrade it to full time.
  const idPeriod = MARKET_PERIOD_BY_ID.get(marketIdNumber(metadata.id || metadata.market_id));
  if (idPeriod) return idPeriod;
  if (genericPeriod) return genericPeriod;
  // Sportradar Odds Comparison uses generic names such as "handicap" and
  // "handicap {hcp}". marketType() needs outcome count to classify those,
  // but period detection does not have that context. Without this explicit
  // fallback they become UNCLASSIFIED and the FT feed drops every AH market.
  if (/\bhandicap\b|\bspread\b/.test(value)) return 'FT';
  // The provider's other unqualified core match markets are full-time by convention.
  if (marketType(value) !== 'OTHER') return 'FT';
  return 'UNCLASSIFIED';
}
function sportradarOutcomeType(marketId, outcome) {
  const marketNumber = marketIdNumber(marketId);
  const outcomeId = String(outcome?.id || '').match(/(?:^|:)outcome:(\d+)$/)?.[1] || null;
  const documented = marketNumber === 14
    ? ({ '1711': 'home', '1712': 'draw', '1713': 'away' })[outcomeId]
    : marketNumber === 16
      ? ({ '1714': 'home', '1715': 'away' })[outcomeId]
      : null;
  return documented || null;
}

function handicapSpecifier(market) {
  const specifiers = market?.specifiers;
  const raw = specifiers && typeof specifiers === 'object'
    ? specifiers.hcp
    : typeof specifiers === 'string'
      ? specifiers.match(/(?:^|[,;])\s*hcp=([^,;]+)/i)?.[1]
      : null;
  return raw == null ? null : String(raw).trim() || null;
}

function selectionLabel(outcome, event, type) {
  const value = String(outcome?.type || '').toLowerCase();
  if (type === 'EUROPEAN_HANDICAP' && ['home', 'draw', 'away'].includes(value)) return value.toUpperCase();
  const raw = clean(outcome?.name || outcome?.label, 120);
  if (raw) return raw;
  if (type === '1X2' || type === 'EUROPEAN_HANDICAP') {
    if (value === 'home') return 'HOME';
    if (value === 'draw') return 'DRAW';
    if (value === 'away') return 'AWAY';
  }
  if (value === 'home') return event.home.name;
  if (value === 'away') return event.away.name;
  if (value === 'draw') return 'Draw';
  if (value === 'over') return 'Over';
  if (value === 'under') return 'Under';
  if (value) return clean(value.replace(/[_-]+/g, ' '), 120);
  return clean(outcome?.id || 'Unlabelled outcome', 120);
}
function normalizeOdds(event, raw) {
  const diagnostics = {
    marketsSeen: 0, booksSeen: 0, outcomesSeen: 0,
    removedBooksRetained: 0, removedOutcomesRetained: 0,
    outcomesWithoutDecimalOddsRetained: 0,
    periodCounts: {},
    marketIdCounts: {},
    periodSamples: [],
    outcomeSamples: []
  };
  const markets = [];
  for (const market of (Array.isArray(raw?.markets) ? raw.markets : [])) {
    if (!market || typeof market !== 'object') continue;
    diagnostics.marketsSeen += 1;
    const marketName = clean(market.name || market.id || 'Unlabelled market', 240);
    const marketId = String(market.id || marketName);
    const books = Array.isArray(market.books) ? market.books : [];
    const outcomeCount = books.reduce((maximum, book) =>
      Math.max(maximum, Array.isArray(book?.outcomes) ? book.outcomes.length : 0), 0);
    const hasDrawOutcome = books.some(book => (book?.outcomes || []).some(outcome => {
      const outcomeType = clean(outcome?.type, 40).toLowerCase();
      const outcomeName = clean(outcome?.name || outcome?.label, 80).toLowerCase();
      return outcomeType === 'draw' || outcomeName === 'draw' || outcomeName === 'x';
    }));
    const type = marketType(marketName, outcomeCount, hasDrawOutcome, marketId);
    diagnostics.marketIdCounts[marketId] = (diagnostics.marketIdCounts[marketId] || 0) + 1;
    const period = periodFromMarket(marketName, market);
    diagnostics.periodCounts[period] = (diagnostics.periodCounts[period] || 0) + 1;
    if (diagnostics.periodSamples.length < 12) {
      diagnostics.periodSamples.push({
        marketId,
        marketName,
        normalizedPeriod: period,
        providerPeriod: market.period ?? market.period_name ?? market.period_id ?? null,
        specifiers: market.specifiers ?? null
      });
    }
    // Capture a tiny, sanitized sample for the documented handicap markets only.
    // Never log full provider payloads, credentials, headers, or bookmaker names.
    if ([14, 16].includes(marketIdNumber(marketId)) && diagnostics.outcomeSamples.length < 2 && !diagnostics.outcomeSamples.some(sample => sample.marketId === marketId)) {
      const sampleBook = books.find(candidate => Array.isArray(candidate?.outcomes) && candidate.outcomes.length);
      if (sampleBook) {
        diagnostics.outcomeSamples.push({
          marketId,
          marketName,
          handicapSpecifier: handicapSpecifier(market),
          outcomes: sampleBook.outcomes.slice(0, 5).filter(outcome => outcome && typeof outcome === 'object').map(outcome => ({
            id: clean(outcome.id, 80) || null,
            type: clean(outcome.type, 40) || null,
            field_id: clean(outcome.field_id, 40) || null,
            handicap: outcome.handicap == null ? null : clean(outcome.handicap, 40),
            open_handicap: outcome.open_handicap == null ? null : clean(outcome.open_handicap, 40),
            odds_decimal: outcome.odds_decimal == null ? null : clean(outcome.odds_decimal, 40),
            open_odds_decimal: outcome.open_odds_decimal == null ? null : clean(outcome.open_odds_decimal, 40),
            removed: isRemovedFlag(outcome.removed)
          }))
        });
      }
    }
    const marketSourceData = Object.fromEntries(Object.entries(market).filter(([key]) => key !== 'books'));

    // The API's removed lifecycle is on book/outcome, not a reason to erase history.
    // Preserve a market even when no book currently prices it.
    const bookRows = books.length ? books : [null];
    for (const book of bookRows) {
      if (book) diagnostics.booksSeen += 1;
      const bookRemoved = isRemovedFlag(book?.removed);
      if (bookRemoved) diagnostics.removedBooksRetained += 1;
      const bookSourceData = book
        ? Object.fromEntries(Object.entries(book).filter(([key]) => key !== 'outcomes'))
        : null;
      const outcomes = Array.isArray(book?.outcomes) ? book.outcomes : [];
      const selections = outcomes.map((outcome, index) => {
        if (!outcome || typeof outcome !== 'object') return null;
        diagnostics.outcomesSeen += 1;
        const outcomeRemoved = isRemovedFlag(outcome.removed);
        if (outcomeRemoved) diagnostics.removedOutcomesRetained += 1;
        const odds = number(outcome.odds_decimal);
        if (odds === null) diagnostics.outcomesWithoutDecimalOddsRetained += 1;
        const documentedOutcomeType = sportradarOutcomeType(marketId, outcome);
        const strictDocumentedMarket = [14, 16].includes(marketIdNumber(marketId));
        const normalizedOutcomeType = strictDocumentedMarket
          ? documentedOutcomeType
          : (String(outcome.type || '').toLowerCase() || null);
        const normalizedOutcome = documentedOutcomeType ? { ...outcome, type: documentedOutcomeType } : outcome;
        const label = selectionLabel(normalizedOutcome, event, type);
        const documentedHcp = type === 'EUROPEAN_HANDICAP' ? handicapSpecifier(market) : null;
        const rawLine = outcome.handicap ?? outcome.spread ?? outcome.total ?? documentedHcp;
        const line = number(rawLine);
        const handicapLine = type === 'EUROPEAN_HANDICAP' && rawLine != null ? String(rawLine).trim() : null;
        const sourceSelectionId = String(outcome.id || outcome.external_outcome_id || `${marketId}-${book?.id || 'book'}-${index}`);
        return {
          key: hash('selection', event.id, marketId, marketName, book?.id || '', sourceSelectionId, line ?? handicapLine ?? ''),
          label, odds, line, handicapLine,
          suspended: Boolean(bookRemoved || outcomeRemoved || market.is_live === true || (type === 'EUROPEAN_HANDICAP' && line === null)),
          removed: outcomeRemoved,
          outcomeType: normalizedOutcomeType,
          sourceOutcomeId: outcome.id || null,
          fieldId: outcome.field_id || null,
          source: PROVIDER, sourceSelectionId,
          externalOutcomeId: outcome.external_outcome_id || null,
          oddsAmerican: outcome.odds_american ?? null,
          oddsFraction: outcome.odds_fraction ?? null,
          openOddsDecimal: number(outcome.open_odds_decimal),
          openOddsAmerican: outcome.open_odds_american ?? null,
          openOddsFraction: outcome.open_odds_fraction ?? null,
          handicap: number(outcome.handicap),
          spread: number(outcome.spread),
          total: number(outcome.total),
          openHandicap: number(outcome.open_handicap),
          openTotal: number(outcome.open_total),
          handicap7day: number(outcome.handicap_7day),
          total7day: number(outcome.total_7day),
          odds7dayDecimal: number(outcome.odds_7day_decimal),
          odds7dayAmerican: outcome.odds_7day_american ?? null,
          odds7dayFraction: outcome.odds_7day_fraction ?? null,
          playerId: outcome.player_id || null,
          playerName: outcome.player_name || null,
          updatedAt: iso(outcome.updated_at),
          sourceData: outcome,
          priceVersion: hash('price', event.id, marketId, marketName, book?.id || '', sourceSelectionId, odds)
        };
      }).filter(Boolean);

      const bookmaker = book ? clean(book.name || book.id || 'Unknown bookmaker', 160) : null;
      markets.push({
        id: hash('market', event.id, marketId, marketName, handicapSpecifier(market) || '', book?.id || bookmaker || ''),
        key: marketId, type, label: type === 'EUROPEAN_HANDICAP' ? 'European Handicap (3-Way)' : marketName, period,
        line: selections[0]?.line ?? null,
        suspended: Boolean(bookRemoved || market.is_live === true),
        removed: bookRemoved,
        isLive: market.is_live === true,
        updatedAt: null,
        source: PROVIDER, sourceMarketId: marketId, sourceMarketName: marketName,
        sourceBookId: book?.id || null,
        externalMarketId: book?.external_market_id || null,
        externalSportEventId: book?.external_sport_event_id || null,
        bookmaker, mainLine: null,
        sourceData: { market: marketSourceData, book: bookSourceData },
        selections
      });
    }
  }
  return { markets, diagnostics };
}

export const __sportradarNormalizer = { marketType, periodFromMarket, normalizeOdds, normalizedEventStatus, sportradarOutcomeType, handicapSpecifier };

export async function fetchSportradar({
  maxEvents = 0,
  maxPages = 0,
  daysAhead = config.sportradarDaysAhead
} = {}) {
  if (!config.sportradarEnabled) return { provider: PROVIDER, enabled: false, events: [], errors: ['SPORTRADAR_ENABLED=false'] };
  if (!apiKey()) return { provider: PROVIDER, enabled: false, events: [], errors: ['SPORTRADAR_API_KEY is not configured'] };

  // Discover sport IDs from the official Sports feed; select the configured product scope.
  const sportsResponse = await fetchJson(`${baseUrl()}/sports.json`);
  const availableSports = Array.isArray(sportsResponse.data?.sports) ? sportsResponse.data.sports : [];
  if (!availableSports.length) throw new Error('Sportradar Sports feed returned no sports array; snapshot was not published.');
  const requestedIds = String(config.sportradarSportIds || DEFAULT_SPORT_IDS.join(','))
    .split(',').map(value => value.trim()).filter(Boolean);
  const selectedSports = requestedIds.includes('*')
    ? availableSports
    : availableSports.filter(sport => requestedIds.includes(String(sport.id)));
  const missingSportIds = requestedIds.filter(id => id !== '*' && !availableSports.some(sport => String(sport.id) === id));
  if (missingSportIds.length) {
    throw new Error(`Configured Sportradar sport IDs are absent from the official Sports feed: ${missingSportIds.join(', ')}`);
  }
  if (!selectedSports.length) throw new Error('No configured Sportradar sport IDs were found in the Sports feed.');

  const days = Math.max(1, Number(daysAhead) || 3);
  const dates = requestedDates(days);
  const allEvents = [];
  const seenIds = new Set();
  const diagnostics = {
    sportsDiscovered: availableSports.length,
    sportsFeedGeneratedAt: sportsResponse.data?.generated_at || null,
    accessPipeline: sportsResponse.headers?.get?.('x-origin-id') || 'unknown',
    sportsSelected: selectedSports.map(sport => ({ id: sport.id, name: sport.name, type: sport.type })),
    datesRequested: dates.length, pagesFetched: 0, eventsSeen: 0, eventsAccepted: 0,
    eventsSkipped: {}, odds: {
      marketsSeen: 0, booksSeen: 0, outcomesSeen: 0,
      removedBooksRetained: 0, removedOutcomesRetained: 0,
      outcomesWithoutDecimalOddsRetained: 0,
      periodCounts: {},
      marketIdCounts: {},
      periodSamples: [],
      outcomeSamples: []
    }
  };

  for (const sport of selectedSports) {
    for (const date of dates) {
      let start = 0;
      while (true) {
        const url = new URL(`${baseUrl()}/sports/${encodeURIComponent(sport.id)}/schedules/${date}/sport_event_markets.json`);
        url.searchParams.set('limit', String(PAGE_SIZE));
        url.searchParams.set('start', String(start));
        const { data, headers: responseHeaders } = await fetchJson(url.toString());
        diagnostics.pagesFetched += 1;
        const items = Array.isArray(data?.sport_schedule_sport_event_markets) ? data.sport_schedule_sport_event_markets : [];
        const maxResultsHeader = responseHeaders?.get?.('x-max-results');
        const maxResults = maxResultsHeader === null || maxResultsHeader === undefined ? null : Number(maxResultsHeader);
        if (!items.length) {
          if (Number.isFinite(maxResults) && start < maxResults) {
            throw new Error(`Sportradar returned an empty page at offset ${start} while x-max-results reports ${maxResults}; partial data is not published.`);
          }
          break;
        }
        diagnostics.eventsSeen += items.length;

        for (const item of items) {
          const normalized = normalizeScheduleEvent(item?.sport_event, item, sport, data?.generated_at || null);
          if (!normalized.event) {
            const reason = normalized.reason || 'invalid-documented-event';
            diagnostics.eventsSkipped[reason] = (diagnostics.eventsSkipped[reason] || 0) + 1;
            continue;
          }
          const event = normalized.event;
          if (seenIds.has(event.id)) {
            diagnostics.eventsSkipped.duplicate_provider_id = (diagnostics.eventsSkipped.duplicate_provider_id || 0) + 1;
            continue;
          }
          seenIds.add(event.id);
          const odds = normalizeOdds(event, item);
          event.markets = odds.markets;
          for (const key of Object.keys(diagnostics.odds)) {
            if (key === 'marketIdCounts') {
              for (const [marketId, count] of Object.entries(odds.diagnostics.marketIdCounts || {})) {
                diagnostics.odds.marketIdCounts[marketId] = (diagnostics.odds.marketIdCounts[marketId] || 0) + count;
              }
            } else if (key === 'periodCounts') {
              for (const [period, count] of Object.entries(odds.diagnostics.periodCounts || {})) {
                diagnostics.odds.periodCounts[period] = (diagnostics.odds.periodCounts[period] || 0) + count;
              }
            } else if (key === 'periodSamples') {
              diagnostics.odds.periodSamples.push(...(odds.diagnostics.periodSamples || []).slice(0, Math.max(0, 20 - diagnostics.odds.periodSamples.length)));
            } else if (key === 'outcomeSamples') {
              diagnostics.odds.outcomeSamples.push(...(odds.diagnostics.outcomeSamples || []).slice(0, Math.max(0, 24 - diagnostics.odds.outcomeSamples.length)));
            } else {
              diagnostics.odds[key] += odds.diagnostics[key] || 0;
            }
          }
          allEvents.push(event);
          diagnostics.eventsAccepted += 1;
        }

        start += items.length;
        if (Number.isFinite(maxResults)) {
          if (start >= maxResults) break;
        } else if (items.length < PAGE_SIZE) {
          break;
        }
      }
    }
  }

  const result = {
    provider: PROVIDER, enabled: true, events: allEvents, errors: [], transportOk: true,
    diagnostics: { ...diagnostics, calls: diagnostics.pagesFetched + 1 }
  };
  logger.info('Sportradar prematch ingestion completed', {
    events: diagnostics.eventsAccepted, sports: diagnostics.sportsSelected.length,
    pages: diagnostics.pagesFetched, diagnostics
  });
  return result;
}
