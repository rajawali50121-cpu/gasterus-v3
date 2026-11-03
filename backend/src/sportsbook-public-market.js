import crypto from 'node:crypto';
import { config } from './config.js';

const PROVIDER = 'public-market';
const DEFAULT_MAX_EVENTS = 600;
let cache = { fetchedAt: 0, events: [], warnings: [], lastModified: null, etag: null };
let inFlight = null;
const resultFileCache = new Map();

const DIVISION_INFO = Object.freeze({
  E0: ['Premier League', 'England'], E1: ['Championship', 'England'], E2: ['League One', 'England'], E3: ['League Two', 'England'], EC: ['National League', 'England'],
  SC0: ['Premiership', 'Scotland'], SC1: ['Championship', 'Scotland'], SC2: ['League One', 'Scotland'], SC3: ['League Two', 'Scotland'],
  D1: ['Bundesliga', 'Germany'], D2: ['2. Bundesliga', 'Germany'],
  I1: ['Serie A', 'Italy'], I2: ['Serie B', 'Italy'],
  SP1: ['La Liga', 'Spain'], SP2: ['Segunda Division', 'Spain'],
  F1: ['Ligue 1', 'France'], F2: ['Ligue 2', 'France'],
  N1: ['Eredivisie', 'Netherlands'], B1: ['First Division A', 'Belgium'], P1: ['Primeira Liga', 'Portugal'],
  T1: ['Super Lig', 'Turkey'], G1: ['Super League', 'Greece'],
  ARG: ['Primera Division', 'Argentina'], AUT: ['Bundesliga', 'Austria'], BRA: ['Serie A', 'Brazil'], CHN: ['Super League', 'China'],
  DNK: ['Superliga', 'Denmark'], FIN: ['Veikkausliiga', 'Finland'], IRL: ['Premier Division', 'Ireland'], JPN: ['J-League', 'Japan'],
  MEX: ['Liga MX', 'Mexico'], NOR: ['Eliteserien', 'Norway'], POL: ['Ekstraklasa', 'Poland'], ROU: ['Liga 1', 'Romania'],
  RUS: ['Premier League', 'Russia'], SWE: ['Allsvenskan', 'Sweden'], SWZ: ['Super League', 'Switzerland'], USA: ['MLS', 'USA']
});

const DIVISION_TIME_ZONE = Object.freeze({
  E0: 'Europe/London', E1: 'Europe/London', E2: 'Europe/London', E3: 'Europe/London', EC: 'Europe/London',
  SC0: 'Europe/London', SC1: 'Europe/London', SC2: 'Europe/London', SC3: 'Europe/London',
  D1: 'Europe/Berlin', D2: 'Europe/Berlin', I1: 'Europe/Rome', I2: 'Europe/Rome',
  SP1: 'Europe/Madrid', SP2: 'Europe/Madrid', F1: 'Europe/Paris', F2: 'Europe/Paris',
  N1: 'Europe/Amsterdam', B1: 'Europe/Brussels', P1: 'Europe/Lisbon', T1: 'Europe/Istanbul', G1: 'Europe/Athens',
  ARG: 'America/Argentina/Buenos_Aires', AUT: 'Europe/Vienna', BRA: 'America/Sao_Paulo',
  CHN: 'Asia/Shanghai', DNK: 'Europe/Copenhagen', FIN: 'Europe/Helsinki', IRL: 'Europe/Dublin',
  JPN: 'Asia/Tokyo', MEX: 'America/Mexico_City', NOR: 'Europe/Oslo', POL: 'Europe/Warsaw',
  ROU: 'Europe/Bucharest', RUS: 'Europe/Moscow', SWE: 'Europe/Stockholm', SWZ: 'Europe/Zurich',
  USA: 'America/New_York'
});

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const clean = (v, max = 180) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const num = v => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const safeOdds = v => {
  const n = num(v);
  return n !== null && n > 1.001 && n <= 1000 ? Math.round(n * 10000) / 10000 : null;
};
const slug = v => clean(v).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
const hash = (...parts) => crypto.createHash('sha256').update(parts.map(v => String(v ?? '')).join('|')).digest('hex').slice(0, 28);

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const input = String(text ?? '').replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map(h => clean(h, 80));
  return rows.filter(r => r.some(v => clean(v))).map(values => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ''])));
}

function parseKickoff(dateValue, timeValue, timeZone = 'UTC') {
  const date = clean(dateValue, 20);
  const time = clean(timeValue || '12:00', 10) || '12:00';
  let y, m, d;
  let match = date.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (match) {
    d = Number(match[1]); m = Number(match[2]); y = Number(match[3]);
    if (y < 100) y += y >= 70 ? 1900 : 2000;
  } else {
    const parsed = Date.parse(date);
    if (!Number.isFinite(parsed)) return null;
    const dt = new Date(parsed); y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate();
  }
  const tm = time.match(/^(\d{1,2}):(\d{2})$/);
  const hh = tm ? Number(tm[1]) : 12;
  const mm = tm ? Number(tm[2]) : 0;
  if (!tm && timeValue) return null;
  if (hh > 23 || mm > 59) return null;
  const localAsUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
  const check = new Date(localAsUtc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  let utc = localAsUtc;
  for (let i = 0; i < 4; i += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(utc))
      .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const offset = representedAsUtc - utc;
    const adjusted = localAsUtc - offset;
    if (adjusted === utc) break;
    utc = adjusted;
  }
  const resolved = Object.fromEntries(formatter.formatToParts(new Date(utc))
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  if (resolved.year !== y || resolved.month !== m || resolved.day !== d || resolved.hour !== hh || resolved.minute !== mm) return null;
  return new Date(utc).toISOString();
}

function oddsTriplet(row) {
  const candidates = [
    ['AvgH', 'AvgD', 'AvgA', 'market-average'],
    ['B365H', 'B365D', 'B365A', 'bet365'],
    ['MaxH', 'MaxD', 'MaxA', 'market-max'],
    ['PSH', 'PSD', 'PSA', 'pinnacle']
  ];
  for (const [h, d, a, book] of candidates) {
    const values = [safeOdds(row[h]), safeOdds(row[d]), safeOdds(row[a])];
    if (values.every(Boolean)) return { home: values[0], draw: values[1], away: values[2], book };
  }
  return null;
}
function total25(row) {
  const candidates = [
    ['Avg>2.5', 'Avg<2.5', 'market-average'],
    ['B365>2.5', 'B365<2.5', 'bet365'],
    ['Max>2.5', 'Max<2.5', 'market-max'],
    ['P>2.5', 'P<2.5', 'pinnacle']
  ];
  for (const [over, under, book] of candidates) {
    const o = safeOdds(row[over]), u = safeOdds(row[under]);
    if (o && u) return { over: o, under: u, book };
  }
  return null;
}
function handicap(row) {
  const line = num(row.AHh ?? row.B365AH ?? row.PAH ?? row.BbAHh);
  if (line === null) return null;
  const candidates = [
    ['AvgAHH', 'AvgAHA', 'market-average'],
    ['B365AHH', 'B365AHA', 'bet365'],
    ['MaxAHH', 'MaxAHA', 'market-max'],
    ['PAHH', 'PAHA', 'pinnacle']
  ];
  for (const [home, away, book] of candidates) {
    const h = safeOdds(row[home]), a = safeOdds(row[away]);
    if (h && a) return { line, home: h, away: a, book };
  }
  return null;
}

function normalizeProbabilities(odds) {
  const raw = odds.map(o => 1 / o);
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map(p => p / sum);
}
function poisson(lambda, max = 9) {
  const out = new Array(max + 1).fill(0);
  out[0] = Math.exp(-lambda);
  for (let k = 1; k <= max; k += 1) out[k] = out[k - 1] * lambda / k;
  return out;
}
function over25FromLambda(lambda) {
  return 1 - Math.exp(-lambda) * (1 + lambda + lambda * lambda / 2);
}
function solveTotalLambda(overProbability) {
  if (!Number.isFinite(overProbability)) return 2.55;
  const target = clamp(overProbability, 0.08, 0.92);
  let lo = 0.5, hi = 5.8;
  for (let i = 0; i < 48; i += 1) {
    const mid = (lo + hi) / 2;
    if (over25FromLambda(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
function scoreGrid(lambdaHome, lambdaAway, max = 9) {
  const hp = poisson(lambdaHome, max), ap = poisson(lambdaAway, max);
  const grid = [];
  let mass = 0;
  for (let h = 0; h <= max; h += 1) for (let a = 0; a <= max; a += 1) {
    const p = hp[h] * ap[a]; mass += p; grid.push({ h, a, p });
  }
  return grid.map(x => ({ ...x, p: x.p / mass }));
}
function outcomeProbs(grid) {
  let home = 0, draw = 0, away = 0;
  for (const x of grid) x.h > x.a ? home += x.p : x.h < x.a ? away += x.p : draw += x.p;
  return { home, draw, away };
}
function calibrateLambdas(oneXtwo, ou25) {
  const [pHome, pDraw, pAway] = normalizeProbabilities([oneXtwo.home, oneXtwo.draw, oneXtwo.away]);
  const ouProb = ou25 ? normalizeProbabilities([ou25.over, ou25.under])[0] : null;
  const total = solveTotalLambda(ouProb ?? clamp(0.66 - pDraw * 0.6, 0.32, 0.72));
  let best = null;
  for (let i = 14; i <= 86; i += 2) {
    const share = i / 100;
    const lh = clamp(total * share, 0.15, 4.8), la = clamp(total * (1 - share), 0.15, 4.8);
    const probs = outcomeProbs(scoreGrid(lh, la, 8));
    const err = (probs.home - pHome) ** 2 + (probs.draw - pDraw) ** 2 + (probs.away - pAway) ** 2;
    if (!best || err < best.err) best = { lambdaHome: lh, lambdaAway: la, err };
  }
  return best || { lambdaHome: 1.4, lambdaAway: 1.1, err: 1 };
}

function bookOddsFromProbability(p, margin = 0.045) {
  if (!Number.isFinite(p) || p <= 0) return null;
  return clamp(Math.round((1 / (p * (1 + margin))) * 1000) / 1000, 1.01, 100);
}
function twoWayBook(pA, pB, margin = 0.045) {
  const sum = pA + pB;
  if (!(sum > 0)) return [null, null];
  return [bookOddsFromProbability(pA / sum, margin), bookOddsFromProbability(pB / sum, margin)];
}
function pushAdjustedOdds(win, push, margin = 0.045) {
  if (!(win > 0) || win + push > 1.000001) return null;
  const fair = (1 - push) / win;
  return clamp(Math.round((fair / (1 + margin)) * 1000) / 1000, 1.01, 100);
}
function asianComponent(scoreDiff, line) {
  const adjusted = scoreDiff + line;
  return adjusted > 1e-9 ? 'W' : adjusted < -1e-9 ? 'L' : 'P';
}
function splitQuarter(line) {
  const q = Math.round(line * 4);
  return Math.abs(q) % 2 === 1 ? [line - 0.25, line + 0.25] : [line];
}
function asianFairCoefficients(grid, line, side = 'HOME', total = false, over = true) {
  let A = 0, B = 0;
  const components = splitQuarter(line);
  for (const x of grid) {
    const outcomes = components.map(component => {
      if (total) {
        const goals = x.h + x.a;
        const diff = over ? goals - component : component - goals;
        return diff > 1e-9 ? 'W' : diff < -1e-9 ? 'L' : 'P';
      }
      const diff = side === 'HOME' ? x.h - x.a : x.a - x.h;
      return asianComponent(diff, component);
    });
    let a = 0, b = 0;
    for (const o of outcomes) {
      if (o === 'W') a += 1 / outcomes.length;
      else if (o === 'P') b += 1 / outcomes.length;
    }
    A += x.p * a; B += x.p * b;
  }
  return { A, B };
}
function asianOdds(grid, line, side, margin) {
  const { A, B } = asianFairCoefficients(grid, line, side, false, true);
  if (!(A > 0)) return null;
  return clamp(Math.round((((1 - B) / A) / (1 + margin)) * 1000) / 1000, 1.01, 250);
}
function totalOdds(grid, line, over, margin) {
  const { A, B } = asianFairCoefficients(grid, line, 'HOME', true, over);
  if (!(A > 0)) return null;
  return clamp(Math.round((((1 - B) / A) / (1 + margin)) * 1000) / 1000, 1.01, 250);
}

function market(eventId, type, period, line, label, selections, updatedAt, meta = {}) {
  const marketKey = `${type}:${period}:${line ?? ''}:${slug(label)}`;
  return {
    id: hash('public-market', eventId, marketKey), key: marketKey, type, label, period, line: line ?? null,
    suspended: false, updatedAt, source: PROVIDER, sourceMarketId: meta.sourceMarketId || null, mainLine: meta.mainLine ?? null,
    selections: selections.filter(Boolean).map(s => ({
      key: hash('public-selection', eventId, marketKey, s.label, s.line ?? line ?? ''),
      label: s.label, odds: s.odds, line: s.line ?? line ?? null, suspended: false, source: PROVIDER,
      sourceSelectionId: s.sourceSelectionId || `${meta.book || 'model'}:${slug(s.label)}:${s.line ?? line ?? ''}`,
      updatedAt, anchorUpdatedAt: updatedAt, priceVersion: hash('public-price', eventId, marketKey, s.label, s.line ?? line ?? '', s.odds, updatedAt)
    }))
  };
}

function buildDerivedMarkets(eventId, anchor, updatedAt) {
  const margin = clamp(Number(config.publicMarketDerivedMarginBps || 450) / 10000, 0.01, 0.12);
  const { lambdaHome, lambdaAway } = calibrateLambdas(anchor.oneXtwo, anchor.total25);
  const full = scoreGrid(lambdaHome, lambdaAway, 9);
  const half = scoreGrid(lambdaHome * 0.46, lambdaAway * 0.46, 7);
  const output = [];

  const totals = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];
  for (const line of totals) {
    if (line === 2.5 && anchor.total25) continue;
    output.push(market(eventId, 'TOTALS', 'FT', line, 'Over / Under', [
      { label: `Over ${line}`, odds: totalOdds(full, line, true, margin) },
      { label: `Under ${line}`, odds: totalOdds(full, line, false, margin) }
    ], updatedAt, { book: 'gasterus-model' }));
  }
  for (const line of [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2]) {
    if (anchor.handicap && Math.abs(anchor.handicap.line - line) < 1e-8) continue;
    output.push(market(eventId, 'HANDICAP', 'FT', line, 'Asian Handicap', [
      { label: 'Home', odds: asianOdds(full, line, 'HOME', margin), line },
      { label: 'Away', odds: asianOdds(full, -line, 'AWAY', margin), line: -line }
    ], updatedAt, { book: 'gasterus-model' }));
  }

  let bttsYes = 0, odd = 0, homeWin = 0, draw = 0, awayWin = 0;
  const exact = [];
  for (const x of full) {
    if (x.h > 0 && x.a > 0) bttsYes += x.p;
    if ((x.h + x.a) % 2 === 1) odd += x.p;
    if (x.h > x.a) homeWin += x.p; else if (x.h < x.a) awayWin += x.p; else draw += x.p;
    if (x.h <= 4 && x.a <= 4) exact.push({ label: `${x.h}-${x.a}`, p: x.p });
  }
  const [bttsY, bttsN] = twoWayBook(bttsYes, 1 - bttsYes, margin);
  output.push(market(eventId, 'BTTS', 'FT', null, 'Both Teams To Score', [{ label: 'Yes', odds: bttsY }, { label: 'No', odds: bttsN }], updatedAt, { book: 'gasterus-model' }));
  output.push(market(eventId, 'DOUBLE_CHANCE', 'FT', null, 'Double Chance', [
    { label: '1X', odds: bookOddsFromProbability(homeWin + draw, margin) },
    { label: '12', odds: bookOddsFromProbability(homeWin + awayWin, margin) },
    { label: 'X2', odds: bookOddsFromProbability(draw + awayWin, margin) }
  ], updatedAt, { book: 'gasterus-model' }));
  output.push(market(eventId, 'DRAW_NO_BET', 'FT', null, 'Draw No Bet', [
    { label: 'Home', odds: pushAdjustedOdds(homeWin, draw, margin) },
    { label: 'Away', odds: pushAdjustedOdds(awayWin, draw, margin) }
  ], updatedAt, { book: 'gasterus-model' }));
  const [oddOdds, evenOdds] = twoWayBook(odd, 1 - odd, margin);
  output.push(market(eventId, 'ODD_EVEN', 'FT', null, 'Odd / Even', [{ label: 'Odd', odds: oddOdds }, { label: 'Even', odds: evenOdds }], updatedAt, { book: 'gasterus-model' }));
  output.push(market(eventId, 'CORRECT_SCORE', 'FT', null, 'Correct Score', exact.sort((a,b)=>b.p-a.p).slice(0, 14).map(x => ({ label: x.label, odds: bookOddsFromProbability(x.p, margin) })), updatedAt, { book: 'gasterus-model' }));

  for (const team of ['Home', 'Away']) {
    const isHome = team === 'Home';
    for (const line of [0.5, 1.5, 2.5]) {
      let over = 0, under = 0;
      for (const x of full) ((isHome ? x.h : x.a) > line ? over += x.p : under += x.p);
      const [o, u] = twoWayBook(over, under, margin);
      output.push(market(eventId, 'TEAM_TOTAL', 'FT', line, `${team} Team Total`, [{ label: `${team} Over ${line}`, odds: o }, { label: `${team} Under ${line}`, odds: u }], updatedAt, { book: 'gasterus-model' }));
    }
  }

  const halfProbs = outcomeProbs(half);
  const secondHalf = scoreGrid(lambdaHome * 0.54, lambdaAway * 0.54, 7);
  const htft = new Map();
  const resultSide = (h, a) => h > a ? 'Home' : h < a ? 'Away' : 'Draw';
  for (const first of half) for (const second of secondHalf) {
    const key = `${resultSide(first.h, first.a)} / ${resultSide(first.h + second.h, first.a + second.a)}`;
    htft.set(key, (htft.get(key) || 0) + first.p * second.p);
  }
  output.push(market(eventId, 'HT_FT', 'FT', null, 'Half Time / Full Time', [...htft.entries()].map(([label, p]) => ({ label, odds: bookOddsFromProbability(p, margin) })), updatedAt, { book: 'gasterus-model' }));
  output.push(market(eventId, '1X2', '1H', null, '1st Half 1X2', [
    { label: 'Home', odds: bookOddsFromProbability(halfProbs.home, margin) },
    { label: 'Draw', odds: bookOddsFromProbability(halfProbs.draw, margin) },
    { label: 'Away', odds: bookOddsFromProbability(halfProbs.away, margin) }
  ], updatedAt, { book: 'gasterus-model' }));
  for (const line of [0.5, 1.5, 2.5]) output.push(market(eventId, 'TOTALS', '1H', line, '1st Half Over / Under', [
    { label: `Over ${line}`, odds: totalOdds(half, line, true, margin) },
    { label: `Under ${line}`, odds: totalOdds(half, line, false, margin) }
  ], updatedAt, { book: 'gasterus-model' }));
  for (const line of [-1, -0.5, 0, 0.5, 1]) output.push(market(eventId, 'HANDICAP', '1H', line, '1st Half Asian Handicap', [
    { label: 'Home', odds: asianOdds(half, line, 'HOME', margin), line },
    { label: 'Away', odds: asianOdds(half, -line, 'AWAY', margin), line: -line }
  ], updatedAt, { book: 'gasterus-model' }));

  return output.filter(m => m && m.selections.length >= 2 && m.selections.every(s => Number.isFinite(s.odds) && s.odds > 1));
}

export function normalizeFootballDataFixture(row, { updatedAt = new Date().toISOString() } = {}) {
  const home = clean(row.HomeTeam, 120), away = clean(row.AwayTeam, 120);
  const div = clean(row.Div, 24);
  const startTime = parseKickoff(row.Date, row.Time, DIVISION_TIME_ZONE[div] || 'UTC');
  const oneXtwo = oddsTriplet(row);
  if (!home || !away || !startTime || !oneXtwo) return null;
  const [league, country] = DIVISION_INFO[div] || [clean(row.League || div || 'Football', 120), clean(row.Country || '', 80) || null];
  const eventId = hash('public-event', slug(home), slug(away), startTime);
  const total = total25(row), ah = handicap(row);
  const markets = [];
  markets.push(market(eventId, '1X2', 'FT', null, '1X2', [
    { label: 'Home', odds: oneXtwo.home }, { label: 'Draw', odds: oneXtwo.draw }, { label: 'Away', odds: oneXtwo.away }
  ], updatedAt, { book: oneXtwo.book, sourceMarketId: `football-data:${div}:1x2`, mainLine: true }));
  if (total) markets.push(market(eventId, 'TOTALS', 'FT', 2.5, 'Over / Under', [
    { label: 'Over 2.5', odds: total.over }, { label: 'Under 2.5', odds: total.under }
  ], updatedAt, { book: total.book, sourceMarketId: `football-data:${div}:ou25`, mainLine: true }));
  if (ah) markets.push(market(eventId, 'HANDICAP', 'FT', ah.line, 'Asian Handicap', [
    { label: 'Home', odds: ah.home, line: ah.line }, { label: 'Away', odds: ah.away, line: -ah.line }
  ], updatedAt, { book: ah.book, sourceMarketId: `football-data:${div}:ah`, mainLine: true }));
  return {
    id: eventId, sport: 'Football', league, country, startTime, status: 'SCHEDULED', providerStatus: 'NS', live: false, clock: null,
    home: { name: home, score: null, logo: null }, away: { name: away, score: null, logo: null }, leagueLogo: null, venue: null, periodScores: {},
    availableMarketCount: markets.length, detailFetchedAt: updatedAt, markets,
    _refs: { [PROVIDER]: `${div}:${home}:${away}:${startTime}` }, _sources: [PROVIDER],
    _settlementReadySources: [PROVIDER, 'manual-ops'], _settlementMode: 'PUBLIC_DATA_AUTO_WITH_MANUAL_FALLBACK',
    _publicMarketAnchor: { oneXtwo, total25: total, handicap: ah }, _publicMarketDiv: div, _publicMarketOrigin: 'football-data'
  };
}


export function normalizeOpenFootballFixture(item) {
  const match = item?.match || {};
  const comp = item?.competition || {};
  const home = clean(match.home, 120), away = clean(match.away, 120), startTime = match.startTime;
  const updatedAt = item?.updatedAt || new Date().toISOString();
  if (!home || !away || !startTime) return null;
  const eventId = hash('public-event', slug(home), slug(away), startTime);
  const finished = Array.isArray(match.ft) && match.ft.length === 2;
  const periodScores = Array.isArray(match.ht) && match.ht.length === 2 ? { '1H': { home:match.ht[0], away:match.ht[1] } } : {};
  return {
    id:eventId, sport:'Football', league:clean(comp.league || 'Football',120), country:clean(comp.country || '',80) || null,
    startTime, status:finished ? 'FINISHED' : 'SCHEDULED', providerStatus:finished ? 'FT' : 'NS', live:false, clock:null,
    home:{name:home,score:finished?match.ft[0]:null,logo:null}, away:{name:away,score:finished?match.ft[1]:null,logo:null}, leagueLogo:null, venue:null,
    periodScores, availableMarketCount:0, detailFetchedAt:updatedAt, markets:[],
    _refs:{'openfootball-cc0':`openfootball:${comp.code || 'league'}:${home}:${away}:${startTime}`}, _sources:['openfootball-cc0'],
    _publicMarketDiv:comp.code || '', _publicMarketOrigin:'openfootball-cc0',
    ...(finished ? {_publicResultProvenance:{source:'openfootball-cc0',date:startTime}} : {})
  };
}

function resultKey(home, away) { return `${slug(home)}|${slug(away)}`; }
function parseResultDate(value) {
  const raw = clean(value, 20);
  const m = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    const ms = Date.UTC(year, Number(m[2]) - 1, Number(m[1]), 12, 0, 0);
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
function normalizeResultRow(row) {
  const home = clean(row.HomeTeam, 120), away = clean(row.AwayTeam, 120);
  const hg = num(row.FTHG), ag = num(row.FTAG);
  if (!home || !away || hg === null || ag === null) return null;
  const hh = num(row.HTHG), ha = num(row.HTAG);
  return { key: resultKey(home, away), date: clean(row.Date, 20), dateMs: parseResultDate(row.Date), home, away, homeScore: hg, awayScore: ag, halfHome: hh, halfAway: ha };
}
function seasonCodeForKickoff(startTime) {
  const d = new Date(startTime);
  if (!Number.isFinite(d.getTime())) return null;
  const year = d.getUTCFullYear(), month = d.getUTCMonth() + 1;
  const start = month >= 7 ? year : year - 1;
  const end = start + 1;
  return `${String(start).slice(-2)}${String(end).slice(-2)}`;
}
function resultFileUrl(div, startTime) {
  if (!DIVISION_INFO[div]) return null;
  const season = seasonCodeForKickoff(startTime);
  return season ? `https://www.football-data.co.uk/mmz4281/${season}/${encodeURIComponent(div)}.csv` : null;
}
// Prune-by-season-generation: kunci URL memuat season code (mis. mmz4281/2526/E0.csv).
// Setelah season berganti, entri season lama tidak akan pernah diakses lagi, jadi dibuang
// di refresh berikutnya alih-alih menumpuk sampai restart. Pola prune-bounded yang sama
// sudah dipakai providerRequestCache (sportsbook-providers.js:218) dan sourceHealth
// (toto-collector.js:50).
const RESULT_SEASON_PATTERN = /\/mmz4281\/(\d{4})\//;
function resultFileUrlSeason(url) {
  const match = RESULT_SEASON_PATTERN.exec(String(url || ''));
  return match ? match[1] : null;
}
function pruneStaleResultSeasons(liveSeasons) {
  for (const key of [...resultFileCache.keys()]) {
    const season = resultFileUrlSeason(key);
    if (season && !liveSeasons.has(season)) resultFileCache.delete(key);
  }
}
async function cachedResultFile(url) {
  const now = Date.now();
  const prior = resultFileCache.get(url);
  if (prior && now - prior.fetchedAt < 10 * 60 * 1000) return prior.rows;
  const response = await requestText(url);
  const rows = parseCsv(response.text || '').map(normalizeResultRow).filter(Boolean);
  resultFileCache.set(url, { rows, fetchedAt: now });
  return rows;
}
async function loadResultRowsForEvents(events) {
  const recentOrStarted = events.filter(event => {
    const t = Date.parse(event.startTime || '');
    return Number.isFinite(t) && t <= Date.now() + 2 * 60 * 60 * 1000 && t >= Date.now() - 7 * 24 * 60 * 60 * 1000;
  });
  const urls = [...new Set(recentOrStarted.map(event => resultFileUrl(event._publicMarketDiv, event.startTime)).filter(Boolean))].slice(0, 18);
  // Season generation yang masih hidup = season yang di-request pada refresh ini.
  // Entri season lain (musim sebelumnya) tidak akan pernah dibaca lagi → dibuang.
  pruneStaleResultSeasons(new Set(urls.map(resultFileUrlSeason).filter(Boolean)));
  const settled = await Promise.allSettled(urls.map(url => cachedResultFile(url)));
  return settled.flatMap(item => item.status === 'fulfilled' ? item.value : []);
}

function mergeResults(events, resultRows) {
  const byKey = new Map();
  for (const row of resultRows.filter(Boolean)) {
    if (!byKey.has(row.key)) byKey.set(row.key, []);
    byKey.get(row.key).push(row);
  }
  return events.map(event => {
    const kickoff = Date.parse(event.startTime || '');
    if (!Number.isFinite(kickoff) || kickoff > Date.now() + 3 * 60 * 60 * 1000) return event;
    const candidates = byKey.get(resultKey(event.home.name, event.away.name)) || [];
    const r = candidates
      .filter(item => Number.isFinite(item.dateMs) && Math.abs(item.dateMs - kickoff) <= 36 * 60 * 60 * 1000)
      .sort((a, b) => Math.abs(a.dateMs - kickoff) - Math.abs(b.dateMs - kickoff))[0];
    if (!r) return event;
    return {
      ...event, status: 'FINISHED', providerStatus: 'FT', live: false,
      home: { ...event.home, score: r.homeScore }, away: { ...event.away, score: r.awayScore },
      periodScores: r.halfHome !== null && r.halfAway !== null ? { ...(event.periodScores || {}), '1H': { home: r.halfHome, away: r.halfAway } } : event.periodScores,
      _settlementReadySources: [...new Set([...(event._settlementReadySources || []), PROVIDER])],
      _publicResultProvenance: { source: 'football-data', date: r.date }
    };
  });
}

async function requestText(url, { etag = null, lastModified = null } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.publicMarketRequestTimeoutMs);
  try {
    const headers = { accept: 'text/csv,text/plain,text/html;q=0.9,*/*;q=0.1', 'user-agent': 'Gasterus-Public-Market-Collector/1.0' };
    if (etag) headers['if-none-match'] = etag;
    if (lastModified) headers['if-modified-since'] = lastModified;
    const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
    if (response.status === 304) return { notModified: true, text: null, etag, lastModified };
    if (!response.ok) throw new Error(`Public market source returned HTTP ${response.status}`);
    const finalUrl = new URL(response.url || url);
    if (!['www.football-data.co.uk', 'football-data.co.uk'].includes(finalUrl.hostname.toLowerCase())) throw new Error('Public market source redirected to unapproved host');
    const text = await response.text();
    if (text.length > 8 * 1024 * 1024) throw new Error('Public market CSV exceeds size limit');
    return { notModified: false, text, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), finalUrl: finalUrl.toString() };
  } finally { clearTimeout(timeout); }
}

function sourceTimestamp(lastModified, fallbackMs = Date.now()) {
  const parsed = Date.parse(lastModified || '');
  return new Date(Number.isFinite(parsed) ? parsed : fallbackMs).toISOString();
}
function discoverCsvUrl(pageText, pageUrl) {
  const links = [];
  const re = /<a\b[^>]*href=["']([^"']+\.csv(?:\?[^"']*)?)["'][^>]*>/ig;
  for (const match of String(pageText || '').matchAll(re)) {
    try {
      const url = new URL(match[1], pageUrl);
      if (['www.football-data.co.uk', 'football-data.co.uk'].includes(url.hostname.toLowerCase())) links.push(url.toString());
    } catch {}
  }
  return links.sort((a, b) => Number(/fixture/i.test(b)) - Number(/fixture/i.test(a)))[0] || null;
}
async function loadExtraFixtureRows() {
  if (!config.publicMarketExtraFixturesPageUrl) return { rows: [], warning: null, sourceUpdatedAt: null };
  try {
    const page = await requestText(config.publicMarketExtraFixturesPageUrl);
    const csvUrl = discoverCsvUrl(page.text, page.finalUrl || config.publicMarketExtraFixturesPageUrl);
    if (!csvUrl) return { rows: [], warning: 'Extra-league fixtures CSV link not found.', sourceUpdatedAt: null };
    const csv = await requestText(csvUrl);
    return { rows: parseCsv(csv.text || ''), warning: null, sourceUpdatedAt: sourceTimestamp(csv.lastModified) };
  } catch (error) {
    return { rows: [], warning: `Extra-league fixtures unavailable: ${error.message}`, sourceUpdatedAt: null };
  }
}

async function loadFresh() {
  const fetchedAt = Date.now();
  const warnings = [];
  const normalized = [];
  let nextEtag = cache.etag, nextLastModified = cache.lastModified;

  // Source A: public bookmaker/market anchors when reachable. This is enrichment,
  // not a single point of failure for the Gasterus-owned feed.
  try {
    const fixtureResponse = await requestText(config.publicMarketFixturesUrl, { etag: cache.etag, lastModified: cache.lastModified });
    if (fixtureResponse.notModified) {
      normalized.push(...cache.events.filter(event => event._publicMarketOrigin === 'football-data'));
    } else {
      const mainUpdatedAt = sourceTimestamp(fixtureResponse.lastModified, fetchedAt);
      const mainRows = parseCsv(fixtureResponse.text || '');
      const extra = await loadExtraFixtureRows();
      normalized.push(
        ...mainRows.map(row => normalizeFootballDataFixture(row, { updatedAt: mainUpdatedAt })).filter(Boolean),
        ...extra.rows.map(row => normalizeFootballDataFixture(row, { updatedAt: extra.sourceUpdatedAt || mainUpdatedAt })).filter(Boolean)
      );
      if (extra.warning) warnings.push(extra.warning);
      nextEtag = fixtureResponse.etag;
      nextLastModified = fixtureResponse.lastModified;
    }
  } catch (error) {
    warnings.push(`Football-Data anchor unavailable: ${error.message}`);
    normalized.push(...cache.events.filter(event => event._publicMarketOrigin === 'football-data'));
  }

  if (!normalized.length) throw new Error(`All Gasterus public-market sources unavailable: ${warnings.join(' | ') || 'no events'}`);

  const deduped = new Map();
  for (const event of normalized) {
    const existing = deduped.get(event.id);
    if (!existing) { deduped.set(event.id, event); continue; }
  }
  const earliest = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let events = [...deduped.values()]
    .filter(event => { const t=Date.parse(event.startTime||''); return Number.isFinite(t) && t >= earliest; })
    .sort((a,b)=>Date.parse(a.startTime)-Date.parse(b.startTime))
    .slice(0, config.publicMarketMaxEvents || DEFAULT_MAX_EVENTS);

  // Football-Data result files enrich matching priced events when available.
  try {
    const resultResponse = await requestText(config.publicMarketLatestResultsUrl);
    const results = parseCsv(resultResponse.text || '').map(normalizeResultRow).filter(Boolean);
    const mainResults = await loadResultRowsForEvents(events.filter(e => e._publicMarketOrigin === 'football-data'));
    events = mergeResults(events, [...results, ...mainResults]);
  } catch (error) { warnings.push(`Football-Data result enrichment unavailable: ${error.message}`); }

  cache = { fetchedAt, events, warnings:[...new Set(warnings)], etag:nextEtag, lastModified:nextLastModified };
  return cache;
}

export async function fetchPublicMarketFeed() {
  if (!config.publicMarketEnabled) return { provider: PROVIDER, enabled: false, events: [] };
  const ageMs = Date.now() - Number(cache.fetchedAt || 0);
  if (cache.events.length && ageMs < config.publicMarketRefreshSeconds * 1000) {
    return { provider: PROVIDER, enabled: true, events: structuredClone(cache.events), errors: cache.warnings, stale: false, transportOk: true };
  }
  if (!inFlight) inFlight = loadFresh().finally(() => { inFlight = null; });
  try {
    const loaded = await inFlight;
    return { provider: PROVIDER, enabled: true, events: structuredClone(loaded.events), errors: loaded.warnings, stale: false, transportOk: true };
  } catch (error) {
    const maxStaleMs = config.publicMarketMaxStaleSeconds * 1000;
    if (cache.events.length && ageMs <= maxStaleMs) {
      // The owned public-market feed explicitly permits bounded stale-cache use.
      // Keep the provider tradable while the cache is inside its configured safety
      // window; surface the upstream transport incident as telemetry instead of
      // tripping the pricing circuit breaker every 8 seconds.
      return { provider: PROVIDER, enabled: true, events: structuredClone(cache.events), errors: [`Refresh failed; serving cached public odds: ${error.message}`], stale: false, transportOk: true, cachedFallback: true };
    }
    return { provider: PROVIDER, enabled: true, events: [], errors: [error.message], stale: true, transportOk: false };
  }
}

export const __publicMarket = {
  parseKickoff, oddsTriplet, total25, handicap, normalizeProbabilities, solveTotalLambda, calibrateLambdas,
  scoreGrid, buildDerivedMarkets, normalizeOpenFootballFixture, normalizeResultRow, mergeResults, seasonCodeForKickoff, resultFileUrl, asianOdds, totalOdds, parseResultDate, discoverCsvUrl, sourceTimestamp, resultFileUrlSeason, pruneStaleResultSeasons, resultFileCache
};
