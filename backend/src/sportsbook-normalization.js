import crypto from 'node:crypto';

// ---------------------------------------------------------
// DICTIONARY MAPPING
// ---------------------------------------------------------

// Normalize strings for matching
export function slugify(text) {
  if (typeof text !== 'string') return '';
  return text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
}

// Common aliases for teams
const TEAM_ALIASES = {
  'man utd': 'Manchester United',
  'mufc': 'Manchester United',
  'man united': 'Manchester United',
  'man city': 'Manchester City',
  'mcfc': 'Manchester City',
  'spurs': 'Tottenham Hotspur',
  'tottenham': 'Tottenham Hotspur',
  'arsenal fc': 'Arsenal',
  'chelsea fc': 'Chelsea',
  'liverpool fc': 'Liverpool',
  'psg': 'Paris Saint-Germain',
  'paris sg': 'Paris Saint-Germain',
  'bayern': 'Bayern Munich',
  'bayern munchen': 'Bayern Munich',
  'juve': 'Juventus',
  'barca': 'FC Barcelona',
  'barcelona': 'FC Barcelona',
  'real': 'Real Madrid',
  'madrid': 'Real Madrid',
  'atleti': 'Atletico Madrid',
  'ac milan': 'AC Milan',
  'milan': 'AC Milan',
  'inter': 'Inter Milan',
  'inter milan': 'Inter Milan',
  'bvb': 'Borussia Dortmund',
  'dortmund': 'Borussia Dortmund'
};

export function normalizeTeamName(rawName) {
  if (!rawName) return 'Unknown Team';
  const cleanName = rawName.trim();
  const lower = cleanName.toLowerCase();
  
  if (TEAM_ALIASES[lower]) {
    return TEAM_ALIASES[lower];
  }
  
  // Remove common suffixes that cause mismatches
  return cleanName
    .replace(/\b(FC|CF|SC|AFC|Club)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || 'Unknown Team';
}

const LEAGUE_ALIASES = {
  'epl': 'Premier League',
  'english premier league': 'Premier League',
  'la liga': 'La Liga',
  'primera division': 'La Liga',
  'bundesliga': 'Bundesliga',
  'serie a': 'Serie A',
  'ligue 1': 'Ligue 1',
  'champions league': 'UEFA Champions League',
  'uefa champions league': 'UEFA Champions League',
  'ucl': 'UEFA Champions League',
  'europa league': 'UEFA Europa League',
  'uel': 'UEFA Europa League',
  'nba': 'NBA'
};

export function normalizeLeagueName(rawName) {
  if (!rawName) return 'Other';
  const cleanName = rawName.trim();
  const lower = cleanName.toLowerCase();
  
  if (LEAGUE_ALIASES[lower]) {
    return LEAGUE_ALIASES[lower];
  }
  
  return cleanName;
}

export function normalizeSport(rawName) {
  const raw = (rawName || '').trim().toLowerCase();
  if (/basket/.test(raw)) return 'Basketball';
  if (/tennis/.test(raw)) return 'Tennis';
  if (/esport|e-sport|dota|counter|valorant|league of legends/.test(raw)) return 'Esports';
  if (/hockey/.test(raw)) return 'Ice Hockey';
  if (/baseball/.test(raw)) return 'Baseball';
  if (/american football|nfl/.test(raw)) return 'American Football';
  return /soccer|football|bola/.test(raw) ? 'Football' : 'Football';
}

// ---------------------------------------------------------
// DATA NORMALIZATION
// ---------------------------------------------------------

export function normalizeTime(rawTime) {
  if (!rawTime) return null;
  const timestamp = Date.parse(rawTime);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function normalizeStatus(rawStatus, isLiveHint = false) {
  const raw = String(rawStatus || '').toUpperCase().trim();
  if (isLiveHint || /^(1H|2H|HT|ET|BT|P|Q[1-4]|IN\d+|LIVE|INT|BREAK)$/.test(raw) || /LIVE|PLAY|HALF|QUARTER|PERIOD/.test(raw)) return 'LIVE';
  if (/FT|AET|PEN|FINISH|ENDED|FINAL/.test(raw)) return 'FINISHED';
  if (/CANC|PST|SUSP|ABD|INTERRUPT/.test(raw)) return 'SUSPENDED';
  return 'SCHEDULED';
}

export function safeOdds(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(',', '.').replace(/[^0-9.+-]/g, ''));
  return (Number.isFinite(parsed) && parsed > 1 && parsed <= 10000) ? Math.round(parsed * 10000) / 10000 : null;
}

export function generateEventId(sport, home, away, startTimeIso) {
  const components = [
    normalizeSport(sport),
    slugify(normalizeTeamName(home)),
    slugify(normalizeTeamName(away)),
    startTimeIso ? startTimeIso.slice(0, 10) : '' // Bind to the day to allow for minor time changes
  ];
  return crypto.createHash('sha256').update(components.join('|')).digest('hex').slice(0, 24);
}

// Core normalizer function (Phase 5 Pipeline)
export function normalizeEvent(rawEvent, providerCode) {
  const sport = normalizeSport(rawEvent.sport);
  const homeTeam = normalizeTeamName(rawEvent.home?.name || rawEvent.homeTeam || rawEvent.home);
  const awayTeam = normalizeTeamName(rawEvent.away?.name || rawEvent.awayTeam || rawEvent.away);
  const startTime = normalizeTime(rawEvent.startTime || rawEvent.start_time || rawEvent.kickoff);
  const status = normalizeStatus(rawEvent.status, rawEvent.live);
  
  const eventId = generateEventId(sport, homeTeam, awayTeam, startTime);
  
  return {
    id: eventId,
    sourceId: rawEvent.id || rawEvent.sourceId || eventId,
    provider: providerCode,
    sport,
    league: normalizeLeagueName(rawEvent.league),
    country: rawEvent.country || null,
    startTime,
    status,
    live: status === 'LIVE',
    home: { name: homeTeam, score: rawEvent.home?.score ?? null },
    away: { name: awayTeam, score: rawEvent.away?.score ?? null },
    markets: rawEvent.markets || [] // Will be normalized in the next step
  };
}
