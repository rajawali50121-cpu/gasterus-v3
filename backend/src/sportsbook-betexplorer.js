import { config } from './config.js';
import { logger } from './logger.js';
import { normalizedEvent, normalizedMarket, normalizedSelection, safeOdds, number, clean, iso, hash } from './sportsbook-providers.js';

const PROVIDER = 'betexplorer';
const BASE_URL = 'https://www.betexplorer.com';

// Soccer leagues to scrape on betexplorer (slug, display name, country)
const BETEXPLORER_LEAGUES = [
  { slug: 'england/premier-league', name: 'Premier League', country: 'Inggris' },
  { slug: 'england/championship', name: 'Championship', country: 'Inggris' },
  { slug: 'spain/primera-division', name: 'La Liga', country: 'Spanyol' },
  { slug: 'spain/segunda-division', name: 'Segunda Division', country: 'Spanyol' },
  { slug: 'italy/serie-a', name: 'Serie A', country: 'Italia' },
  { slug: 'italy/serie-b', name: 'Serie B', country: 'Italia' },
  { slug: 'germany/bundesliga', name: 'Bundesliga', country: 'Jerman' },
  { slug: 'germany/2-bundesliga', name: '2. Bundesliga', country: 'Jerman' },
  { slug: 'france/ligue-1', name: 'Ligue 1', country: 'Prancis' },
  { slug: 'france/ligue-2', name: 'Ligue 2', country: 'Prancis' },
  { slug: 'europe/champions-league', name: 'UEFA Champions League', country: 'Eropa' },
  { slug: 'europe/europa-league', name: 'UEFA Europa League', country: 'Eropa' },
  { slug: 'europe/europa-conference-league', name: 'UEFA Europa Conference League', country: 'Eropa' },
  { slug: 'netherlands/eredivisie', name: 'Eredivisie', country: 'Belanda' },
  { slug: 'portugal/primeira-liga', name: 'Primeira Liga', country: 'Portugalia' },
  { slug: 'usa/mls', name: 'Major League Soccer', country: 'Amerika Serikat' },
  { slug: 'turkey/super-lig', name: 'Süper Lig', country: 'Turki' },
  { slug: 'denmark/superliga', name: 'Superligaen', country: 'Denmark' },
  { slug: 'belgium/pro-league', name: 'Pro League', country: 'Belgia' },
  { slug: 'scotland/premiership', name: 'Premiership', country: 'Skotlandia' },
];

function isProviderEnabled() {
  return Boolean(config.betexplorerEnabled);
}

function fetchWithTimeout(url, timeoutMs, maxRetries = 2) {
  const attemptFetch = async (attempt) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'text/html',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'accept-language': 'en-US,en;q=0.9',
          referer: 'https://www.betexplorer.com/',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.status === 429 && attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
        return attemptFetch(attempt + 1);
      }
      return response;
    } catch (error) {
      clearTimeout(timeout);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        return attemptFetch(attempt + 1);
      }
      throw error;
    }
  };
  return attemptFetch(0);
}

// Parse betexplorer kickoff string "DD.MM. HH:MM" (WIB) into a Date.
// Assumes WIB timezone; year resolved relative to now.
function parseKickoffWib(dateTimeStr, now) {
  const m = /(\d{1,2})\.(\d{1,2})\.\s*(\d{1,2}):(\d{2})/.exec(dateTimeStr.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const hour = Number(m[3]);
  const minute = Number(m[4]);

  const nowWib = new Date(now.getTime() + 7 * 3600 * 1000);
  const year = nowWib.getFullYear();

  let kickoff = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const diffDays = (kickoff.getTime() - nowWib.getTime()) / (24 * 3600 * 1000);
  if (diffDays < -45) kickoff = new Date(Date.UTC(year + 1, month - 1, day, hour, minute, 0, 0));
  else if (diffDays > 330) kickoff = new Date(Date.UTC(year - 1, month - 1, day, hour, minute, 0, 0));
  return kickoff;
}

// Parse a single betexplorer match row into a normalized event input.
// Row HTML contains: team link with match id, 3x data-odd cells (1/X/2), kickoff cell.
function parseBetexplorerRow(rowHtml, league, country, now) {
  const teamMatch = rowHtml.match(/href="[^"]*\/football\/[^"]*\/([^"/]+)\/"[^>]*class="in-match"[^>]*><span>([^<]+)<\/span>\s*-\s*<span>([^<]+)<\/span>/);
  if (!teamMatch) return null;

  const matchId = clean(teamMatch[1], 80);
  const home = clean(teamMatch[2], 120);
  const away = clean(teamMatch[3], 120);
  if (!matchId || !home || !away) return null;

  const oddMatches = [...rowHtml.matchAll(/data-odd="([\d.]+)"/g)].map(m => Number(m[1]));
  if (oddMatches.length < 3) return null;
  const [homeOdd, drawOdd, awayOdd] = oddMatches;
  if (!homeOdd || homeOdd <= 1 || !drawOdd || drawOdd <= 1 || !awayOdd || awayOdd <= 1) return null;

  const kickoffMatch = rowHtml.match(/(\d{1,2}\.\d{1,2}\.\s*\d{1,2}:\d{2})/);
  const kickoff = kickoffMatch ? parseKickoffWib(kickoffMatch[1], now) : null;
  if (!kickoff) return null;

  const selections = [
    normalizedSelection(null, '1x2', 'HOME', homeOdd, { source: PROVIDER, sourceSelectionId: `${matchId}-home` }),
    normalizedSelection(null, '1x2', 'DRAW', drawOdd, { source: PROVIDER, sourceSelectionId: `${matchId}-draw` }),
    normalizedSelection(null, '1x2', 'AWAY', awayOdd, { source: PROVIDER, sourceSelectionId: `${matchId}-away` }),
  ].filter(Boolean);
  if (selections.length !== 3) return null;

  const market = normalizedMarket(null, {
    key: '1x2',
    name: '1X2',
    type: '1X2',
    period: 'FT',
    selections,
    source: PROVIDER,
    sourceMarketId: matchId,
    bookmaker: 'betexplorer',
    suspended: false,
    updatedAt: iso(new Date()),
    mainLine: null,
  });
  if (!market) return null;

  return {
    provider: PROVIDER,
    providerId: matchId,
    sport: 'soccer',
    league,
    country,
    startTime: iso(kickoff),
    state: 'SCHEDULED',
    providerStatus: 'SCHEDULED',
    home,
    away,
    markets: [market],
    _refs: { [PROVIDER]: matchId },
  };
}

// Parse all match rows from a betexplorer league fixtures page HTML.
function parseBetexplorerPage(html, league, country, now) {
  const events = [];
  // Split into <tr> rows; only process rows that contain both an in-match team link and data-odd cells.
  const rows = html.split(/<tr[^>]*>/i);
  for (const row of rows) {
    if (!row.includes('in-match') || !row.includes('data-odd')) continue;
    const parsed = parseBetexplorerRow(row, league, country, now);
    if (parsed) events.push(parsed);
  }
  return events;
}

export async function fetchBetexplorer({
  maxEvents = config.betexplorerMaxEvents,
  maxPages = config.betexplorerMaxPages,
  daysAhead = config.betexplorerDaysAhead,
} = {}) {
  if (!isProviderEnabled()) {
    return { provider: PROVIDER, enabled: false, events: [], errors: ['Provider disabled: BETEXPLORER_ENABLED=false'] };
  }

  const now = new Date();
  const startWib = new Date(now.getTime() + 7 * 3600 * 1000);
  const endWib = new Date(startWib.getTime() + Math.max(daysAhead || 14, 1) * 24 * 3600 * 1000);

  const maxPagesResolved = Number.isFinite(maxPages) && maxPages > 0 ? maxPages : Infinity;
  const eventLimit = maxEvents !== 0 ? maxEvents : Infinity;

  const allEvents = [];
  const seen = new Set();
  const errors = [];
  let pagesFetched = 0;

  for (const league of BETEXPLORER_LEAGUES) {
    if (allEvents.length >= eventLimit) break;
    if (pagesFetched >= maxPagesResolved) break;

    const url = `${BASE_URL}/football/${league.slug}/`;
    let html;
    try {
      const response = await fetchWithTimeout(url, config.betexplorerRequestTimeoutMs || 15000);
      pagesFetched += 1;
      if (!response.ok) {
        errors.push(`${league.slug}: HTTP ${response.status}`);
        continue;
      }
      html = await response.text();
    } catch (error) {
      errors.push(`${league.slug}: ${error.message}`);
      continue;
    }

    const parsed = parseBetexplorerPage(html, league.name, league.country, now);
    for (const event of parsed) {
      if (allEvents.length >= eventLimit) break;
      const kickoff = new Date(event.startTime);
      if (kickoff < startWib || kickoff > endWib) continue;
      const dedupeKey = `${event.home}|${event.away}|${event.startTime}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const normalized = normalizedEvent({
        provider: PROVIDER,
        providerId: event.providerId,
        sport: event.sport,
        league: event.league,
        country: event.country,
        startTime: event.startTime,
        state: event.state,
        providerStatus: event.providerStatus,
        clock: null,
        home: event.home,
        away: event.away,
        homeScore: null,
        awayScore: null,
        homeLogo: null,
        awayLogo: null,
        leagueLogo: null,
        venue: null,
        periodScores: {},
        markets: event.markets,
      });
      if (normalized) {
        normalized._refs = { [PROVIDER]: event.providerId };
        normalized._sources = [PROVIDER];
        normalized._settlementReadySources = [PROVIDER];
        allEvents.push(normalized);
      }
    }

    // Betexplorer rate limit: be polite between league requests.
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  logger.info('Betexplorer scrape completed', {
    provider: PROVIDER,
    events: allEvents.length,
    leagues: BETEXPLORER_LEAGUES.length,
    pages: pagesFetched,
    errors: errors.length,
  });

  return {
    provider: PROVIDER,
    enabled: true,
    events: allEvents,
    errors,
    transportOk: errors.length < BETEXPLORER_LEAGUES.length,
  };
}
