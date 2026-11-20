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
const feedState = { events: new Map(), sports: [], lastFullSyncAt: 0, lastChangeLogAt: 0 };
const CHANGE_LOG_WINDOW_MS = 5 * 60 * 1000;
const FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
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
  return Math.min(30000, 2000 * (attempt + 1));
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
        lastError = new Error('Sportradar rate limited (HTTP 429).');
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
      if (attempt < maxRetries && error?.message !== 'Sportradar rate limited (HTTP 429).') {
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
  // Unknown provider statuses must fail closed as suspended, not invalidate the entire snapshot.
  return 'SUSPENDED';
}
function periodScoresFromStatus(status) {
  const rawRows = status?.period_scores?.period_score ?? status?.period_scores ?? [];
  const rows = Array.isArray(rawRows) ? rawRows : (rawRows && typeof rawRows === 'object' ? [rawRows] : []);
  const firstHalf = rows.find(row => {
    const type = clean(row?.type || row?.period_name || row?.name, 80).toLowerCase();
    return Number(row?.number) === 1 || /first.?half|1st.?half|half.?time/.test(type);
  });
  if (!firstHalf) return {};
  const home = number(firstHalf.home_score ?? firstHalf.home);
  const away = number(firstHalf.away_score ?? firstHalf.away);
  return home === null || away === null ? {} : { '1H': { home, away } };
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
  const resultStatus = raw.sport_event_status || item?.sport_event_status || null;
  const periodScores = periodScoresFromStatus(resultStatus);
  const homeScore = number(resultStatus?.home_score);
  const awayScore = number(resultStatus?.away_score);
  return {
    reason: null,
    event: {
      provider: PROVIDER, providerId: id, id,
      sport: clean(sport?.name || sport?.id || 'Unknown sport', 40),
      sportId: sport?.id || null,
      league: leagueName(raw, item), country, startTime,
      state: mappedStatus, status: mappedStatus, live: mappedStatus === 'LIVE',
      providerStatus: status, replacedBy: raw.replaced_by || null,
      startTimeConfirmed: raw.start_time_confirmed ?? null,
      resumeTime: iso(raw.resume_time),
      sourceData: { sportEvent: raw, sportEventStatus: resultStatus, sportEventContext: context, sport, generatedAt, scheduleItem },
      clock: null,
      home: { name: home, score: homeScore, logo: null },
      away: { name: away, score: awayScore, logo: null },
      homeScore, awayScore, periodScores, markets: [],
      _refs: { [PROVIDER]: id }, _sources: [PROVIDER]
    }
  };
}
function marketType(name) {
  const value = clean(name, 120).toLowerCase();
  // HT/FT is a single combination market, not ordinary 1X2.
  if (/\bhalf.?time.*full.?time|first.?half.*full.?time|1st.?half.*full.?time|\bht\s*[/\-]?\s*ft\b/.test(value)) return 'HT_FT';
  if (/1x2|money.?line|match.?winner|match.?result|three.?way|first.?half.*result|1st.?half.*result|half.?time.*result/.test(value)) return '1X2';
  if (/handicap|spread/.test(value)) return 'HANDICAP';
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
function periodFromMarket(name, metadata = {}) {
  const value = clean(name, 240).toLowerCase();
  const isHtFt = /\bhalf.?time.*full.?time|first.?half.*full.?time|1st.?half.*full.?time|\bht\s*[\/\-]?\s*ft\b/;
  if (isHtFt.test(value)) return 'HT_FT';

  // Prefer an explicit, recognizable provider period. Generic metadata such
  // as "match" must not erase a first-half period encoded in the market name.
  const candidates = [
    metadata.period, metadata.period_name, metadata.periodName,
    metadata.match_period, metadata.matchPeriod, metadata.period_id,
    metadata.specifiers?.period, metadata.specifiers?.match_period
  ].map(item => clean(item, 80).toLowerCase()).filter(Boolean);
  const classify = candidate => {
    if (isHtFt.test(candidate)) return 'HT_FT';
    if (/second.?half|2nd.?half|\b2h\b|period.?2/.test(candidate)) return '2H';
    if (/first.?half|1st.?half|half.?time|\b1h\b|period.?1/.test(candidate)) return '1H';
    if (/full.?time|\bft\b|match.?time|regular.?time/.test(candidate)) return 'FT';
    return null;
  };
  for (const candidate of candidates) {
    const period = classify(candidate);
    if (period) return period;
  }
  return classify(value) || 'FT';
}
function selectionLabel(outcome, event, type) {
  const raw = clean(outcome?.name || outcome?.label, 120);
  if (raw) return raw;
  const value = String(outcome?.type || '').toLowerCase();
  if (type === '1X2') {
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
    outcomesWithoutDecimalOddsRetained: 0
  };
  const markets = [];
  for (const market of (Array.isArray(raw?.markets) ? raw.markets : [])) {
    if (!market || typeof market !== 'object') continue;
    diagnostics.marketsSeen += 1;
    const marketName = clean(market.name || market.id || 'Unlabelled market', 240);
    const marketId = String(market.id || marketName);
    const type = marketType(marketName);
    const period = periodFromMarket(marketName, market);
    const books = Array.isArray(market.books) ? market.books : [];
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
        const label = selectionLabel(outcome, event, type);
        const line = number(outcome.handicap ?? outcome.spread ?? outcome.total);
        const sourceSelectionId = String(outcome.id || outcome.external_outcome_id || `${marketId}-${book?.id || 'book'}-${index}`);
        return {
          key: hash('selection', event.id, marketId, marketName, book?.id || '', sourceSelectionId, line ?? ''),
          label, odds, line,
          // is_live describes event context, not suspension.\n          suspended: Boolean(bookRemoved || outcomeRemoved),
          removed: outcomeRemoved,
          outcomeType: outcome.type || null,
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
        id: hash('market', event.id, marketId, marketName, book?.id || bookmaker || ''),
        key: marketId, type, label: marketName, period,
        line: selections[0]?.line ?? null,
        // Odds Comparison uses book.removed / outcome.removed for removal.\n        // market.is_live is informational and must never suspend a market.\n        suspended: Boolean(bookRemoved),
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

export const __sportradarNormalizer = { marketType, periodFromMarket, normalizeOdds, normalizedEventStatus, normalizeScheduleEvent, periodScoresFromStatus };

async function discoverSports() {
  const response = await fetchJson(baseUrl() + '/sports.json');
  const available = Array.isArray(response.data?.sports) ? response.data.sports : [];
  if (!available.length) throw new Error('Sportradar Sports feed returned no sports array; snapshot was not published.');
  const requested = String(config.sportradarSportIds || DEFAULT_SPORT_IDS.join(','))
    .split(',').map(value => value.trim()).filter(Boolean);
  const selected = requested.includes('*')
    ? available
    : available.filter(sport => requested.includes(String(sport.id)));
  const missing = requested.filter(id => id !== '*' && !available.some(sport => String(sport.id) === id));
  if (missing.length) throw new Error('Configured Sportradar sport IDs are absent from the official Sports feed: ' + missing.join(', '));
  if (!selected.length) throw new Error('No configured Sportradar sport IDs were found in the Sports feed.');
  return { available, selected, generatedAt: response.data?.generated_at || null };
}

function buildDailyMarketsUrl(sportId, date, start) {
  const url = new URL(baseUrl() + '/sports/' + encodeURIComponent(sportId) + '/schedules/' + date + '/sport_event_markets.json');
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('start', String(start));
  url.searchParams.set('live', 'false');
  return url;
}

function normalizedProviderEvent(raw, item, sport, generatedAt) {
  const normalized = normalizeScheduleEvent(raw, item, sport, generatedAt);
  if (!normalized.event) return normalized;
  const event = normalized.event;
  const odds = normalizeOdds(event, item);
  event.markets = odds.markets;
  event.sourceData = { ...event.sourceData, marketGeneratedAt: generatedAt || null };
  return { ...normalized, event, oddsDiagnostics: odds.diagnostics };
}

async function fetchFullPrematchSnapshot() {
  const { available, selected, generatedAt } = await discoverSports();
  const dates = requestedDates(Math.max(1, Number(config.sportradarDaysAhead) || 3));
  const events = new Map();
  const diagnostics = {
    mode: 'full-sync',
    sportsDiscovered: available.length,
    sportsFeedGeneratedAt: generatedAt,
    sportsSelected: selected.map(sport => ({ id: sport.id, name: sport.name, type: sport.type })),
    datesRequested: dates.length,
    pagesFetched: 0,
    eventsSeen: 0,
    eventsAccepted: 0,
    eventsSkipped: {},
    odds: { marketsSeen: 0, booksSeen: 0, outcomesSeen: 0, removedBooksRetained: 0, removedOutcomesRetained: 0, outcomesWithoutDecimalOddsRetained: 0 }
  };

  for (const sport of selected) {
    for (const date of dates) {
      let start = 0;
      while (true) {
        const response = await fetchJson(buildDailyMarketsUrl(sport.id, date, start).toString());
        const data = response.data;
        diagnostics.pagesFetched += 1;
        const items = data?.sport_schedule_sport_event_markets;
        if (!Array.isArray(items)) {
          throw new Error('Sportradar Daily Sport Event Markets returned an invalid response for ' + sport.id + '/' + date + '; snapshot was not published.');
        }
        const maxHeader = response.headers?.get?.('x-max-results');
        const maxResults = maxHeader === null || maxHeader === undefined ? null : Number(maxHeader);
        if (!items.length) {
          if (Number.isFinite(maxResults) && start < maxResults) {
            throw new Error('Sportradar returned an empty page at offset ' + start + ' while x-max-results reports ' + maxResults + '; partial data is not published.');
          }
          break;
        }
        diagnostics.eventsSeen += items.length;
        for (const item of items) {
          const normalized = normalizedProviderEvent(item?.sport_event, item, sport, data?.generated_at || null);
          if (!normalized.event) {
            const reason = normalized.reason || 'invalid-documented-event';
            diagnostics.eventsSkipped[reason] = (diagnostics.eventsSkipped[reason] || 0) + 1;
            continue;
          }
          // This adapter is Odds Comparison PREMATCH. In-play events require the separately entitled Live Odds package/UOF producer.
          if (normalized.event.live) {
            diagnostics.eventsSkipped.prematch_package_live_event = (diagnostics.eventsSkipped.prematch_package_live_event || 0) + 1;
            continue;
          }
          if (events.has(normalized.event.id)) {
            diagnostics.eventsSkipped.duplicate_provider_id = (diagnostics.eventsSkipped.duplicate_provider_id || 0) + 1;
            continue;
          }
          events.set(normalized.event.id, normalized.event);
          diagnostics.eventsAccepted += 1;
          for (const key of Object.keys(diagnostics.odds)) diagnostics.odds[key] += normalized.oddsDiagnostics[key] || 0;
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
  return { events, selected, diagnostics };
}

function changeLogEventIds(payload) {
  const changes = payload?.changes ?? payload?.status?.changes;
  if (changes === undefined || changes === null) return [];
  if (!Array.isArray(changes)) throw new Error('Sportradar change log returned a non-array changes field.');
  return [...new Set(changes
    .filter(change => !change?.type || change.type === 'sport_event')
    .map(change => String(change?.id || '').trim())
    .filter(id => /^sr:sport_event:\d+$/.test(id)))];
}

async function refreshOneEvent(eventId, currentEvent, selectedSports) {
  const url = new URL(baseUrl() + '/sport_events/' + encodeURIComponent(eventId) + '/sport_event_markets.json');
  url.searchParams.set('live', 'false');
  const response = await fetchJson(url.toString());
  const data = response.data;
  const rawEvent = data?.sport_event;
  if (!rawEvent || String(rawEvent.id || '') !== eventId) {
    throw new Error('Sportradar event-market response did not match requested event ' + eventId + '.');
  }
  const contextSport = rawEvent?.sport_event_context?.sport;
  const sport = currentEvent
    ? { id: currentEvent.sportId, name: currentEvent.sport }
    : (contextSport?.id
      ? { id: contextSport.id, name: contextSport.name || contextSport.id }
      : selectedSports.length === 1 ? selectedSports[0] : null);
  if (!sport) return null;
  const normalized = normalizedProviderEvent(rawEvent, data, sport, data?.generated_at || null);
  if (!normalized.event) throw new Error('Sportradar returned invalid event data for ' + eventId + ': ' + normalized.reason);
  if (normalized.event.live) return null;
  return normalized.event;
}

async function updatePrematchSnapshot(now = Date.now()) {
  const startedCalls = callState.callsThisHour;
  const fullSync = feedState.events.size === 0 || !feedState.lastFullSyncAt
    || now - feedState.lastFullSyncAt >= FULL_SYNC_INTERVAL_MS;
  let diagnostics;
  if (fullSync) {
    const full = await fetchFullPrematchSnapshot();
    feedState.events = full.events;
    feedState.sports = full.selected;
    feedState.lastFullSyncAt = now;
    diagnostics = full.diagnostics;
  } else {
    const response = await fetchJson(baseUrl() + '/sport_event_markets_changelog.json');
    const ids = changeLogEventIds(response.data);
    const gapExceeded = feedState.lastChangeLogAt > 0
      && now - feedState.lastChangeLogAt > CHANGE_LOG_WINDOW_MS;
    const targets = gapExceeded ? [...feedState.events.keys()] : ids;
    let refreshed = 0;
    let retiredOrMovedLive = 0;
    for (const id of targets) {
      const current = feedState.events.get(id) || null;
      try {
        const updated = await refreshOneEvent(id, current, feedState.sports);
        if (updated) {
          feedState.events.set(id, updated);
          refreshed += 1;
        } else if (current) {
          feedState.events.delete(id);
          retiredOrMovedLive += 1;
        }
      } catch (error) {
        // Sportradar documents 404 as event retirement after the retention window.
        // Keep the last known closing prices; any other error aborts the snapshot.
        if (current && /HTTP 404/.test(error?.message || '')) {
          retiredOrMovedLive += 1;
          continue;
        }
        throw error;
      }
    }
    feedState.lastChangeLogAt = now;
    diagnostics = {
      mode: gapExceeded ? 'gap-reconciliation' : 'change-log',
      changeLogGeneratedAt: response.data?.generated_at || null,
      changeLogWindow: response.data?.status || null,
      changesReported: ids.length,
      eventBoardsRefreshed: refreshed,
      eventsRetiredOrMovedLive: retiredOrMovedLive,
      trackedEvents: feedState.events.size,
      reconciliationRequired: gapExceeded
    };
  }
  return {
    provider: PROVIDER,
    enabled: true,
    events: [...feedState.events.values()].filter(event => event.live !== true),
    errors: [],
    transportOk: true,
    diagnostics: {
      ...diagnostics,
      callsThisCycle: callState.callsThisHour - startedCalls,
      callsThisHour: callState.callsThisHour,
      fullSyncAt: feedState.lastFullSyncAt ? new Date(feedState.lastFullSyncAt).toISOString() : null,
      changeLogPolledAt: feedState.lastChangeLogAt ? new Date(feedState.lastChangeLogAt).toISOString() : null
    }
  };
}

export async function fetchSportradar() {
  if (!config.sportradarEnabled) return { provider: PROVIDER, enabled: false, events: [], errors: ['SPORTRADAR_ENABLED=false'] };
  if (!apiKey()) return { provider: PROVIDER, enabled: false, events: [], errors: ['SPORTRADAR_API_KEY is not configured'] };
  const result = await updatePrematchSnapshot();
  logger.info('Sportradar Odds Comparison Prematch ingestion completed', {
    events: result.events.length,
    mode: result.diagnostics?.mode,
    diagnostics: result.diagnostics
  });
  return result;
}
