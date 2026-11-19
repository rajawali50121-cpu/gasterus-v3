import { readFileSync } from 'node:fs';
import { calibratedSchedule, conservativeFallbackSchedule } from './toto-draw-calibrator.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MARKET_MAP = JSON.parse(readFileSync(resolve(HERE, '../data/toto-source-map.json'), 'utf8'));

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function normalizeName(value) {
  return clean(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim();
}
function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}
function stripHtml(fragment) {
  return clean(decodeEntities(String(fragment ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')));
}
export function htmlLines(html) {
  // Result boards frequently render labels and digits through nested spans/buttons.
  // Treat every HTML tag as a text boundary so adjacent DOM nodes never collapse
  // into one token (for example "WELLINGTON4969").  This remains deterministic
  // and does not execute client-side code.
  return decodeEntities(String(html ?? ''))
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '\n')
    .replace(/<[^>]+>/g, '\n')
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean);
}
export function digitsResult(value) {
  const compact = clean(value).replace(/\s+/g, '');
  if (/^\d{3,6}$/.test(compact)) return compact;
  const spaced = clean(value).match(/(?:^|\D)((?:\d\s*){3,6})(?:\D|$)/);
  if (!spaced) return null;
  const digits = spaced[1].replace(/\D/g, '');
  return /^\d{3,6}$/.test(digits) ? digits : null;
}
const MONTHS = Object.freeze({
  januari: '01', january: '01', jan: '01',
  februari: '02', february: '02', feb: '02',
  maret: '03', march: '03', mar: '03',
  april: '04', apr: '04',
  mei: '05', may: '05',
  juni: '06', june: '06', jun: '06',
  juli: '07', july: '07', jul: '07',
  agustus: '08', august: '08', agu: '08', aug: '08',
  september: '09', sep: '09', sept: '09',
  oktober: '10', october: '10', okt: '10', oct: '10',
  november: '11', nov: '11',
  desember: '12', december: '12', des: '12', dec: '12'
});
function validCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function formatValidDate(year, month, day) {
  if (!validCalendarDate(year, month, day)) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function isoDate(value) {
  const raw = clean(value);
  let match = raw.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](20\d{2})\b/);
  if (match) return formatValidDate(Number(match[3]), Number(match[2]), Number(match[1]));
  match = normalizeName(raw).match(/(?:senin|selasa|rabu|kamis|jumat|sabtu|minggu|monday|tuesday|wednesday|thursday|friday|saturday|sunday)?\s*,?\s*(\d{1,2})\s+([a-z]+)\s+(20\d{2})/i);
  if (match && MONTHS[match[2].toLowerCase()]) return formatValidDate(Number(match[3]), Number(MONTHS[match[2].toLowerCase()]), Number(match[1]));
  return null;
}
function drawTime(value) {
  const match = clean(value).match(/\b([01]?\d|2[0-3])[.:]([0-5]\d)\s*(?:WIB)?\b/i);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}:00` : null;
}
function aliasMatch(value, alias) {
  const left = normalizeName(value), right = normalizeName(alias);
  return Boolean(right && (left === right || (left.includes(right) && left.length <= right.length + 24)));
}
function exactAliasMatch(value, alias) {
  const left = normalizeName(value).replace(/^image\s+/, '');
  const right = normalizeName(alias);
  return Boolean(right && left === right);
}
function aliasesOf(value) {
  return (Array.isArray(value) ? value : [value]).map(clean).filter(Boolean);
}
function findDateWindow(lines, start = 0, end = lines.length, maxParts = 4) {
  for (let index = Math.max(0, start); index < Math.min(lines.length, end); index += 1) {
    for (let width = 1; width <= maxParts && index + width <= Math.min(lines.length, end); width += 1) {
      const date = isoDate(lines.slice(index, index + width).join(' '));
      if (date) return { date, startIndex: index, endIndex: index + width - 1 };
    }
  }
  return null;
}
function findNormalizedSequence(lines, phrase, start = 0, end = lines.length, maxParts = 4) {
  const target = normalizeName(phrase);
  for (let index = Math.max(0, start); index < Math.min(lines.length, end); index += 1) {
    for (let width = 1; width <= maxParts && index + width <= Math.min(lines.length, end); width += 1) {
      if (normalizeName(lines.slice(index, index + width).join(' ')).includes(target)) return index;
    }
  }
  return -1;
}
function snapshotAliasVariants(value) {
  const raw = clean(value).replace(/\s+POOL$/i, '').trim();
  if (!raw) return [];
  const normalized = normalizeName(raw)
    .replace(/\bmidday\b/g, 'mid')
    .replace(/\bevening\b/g, 'eve')
    .replace(/\bmorning\b/g, 'mor')
    .replace(/\bnight\b/g, 'ngt')
    .replace(/\blotto\b/g, '')
    .replace(/\bpools?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const variants = new Set([raw, normalized]);
  if (normalized) variants.add(normalized.replace(/\s+/g, ''));

  // Common public-board abbreviations/typos are explicit transforms, while
  // parseSnapshotBoard still requires an exact normalized label match.
  const replacements = [
    [/north carolina/g, 'northcaro'],
    [/washington dc mid/g, 'washingtonmd'],
    [/washington dc eve/g, 'washingtonev'],
    [/washington dc/g, 'washington'],
    [/new jersey/g, 'newjersey'],
    [/new york/g, 'newyork'],
    [/rhode island/g, 'rhode island'],
    [/toto macau/g, 'totomacau'],
    [/macau/g, 'toto macau'],
    [/japan/g, 'jepang']
  ];
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(normalized)) continue;
    const changed = normalized.replace(pattern, replacement).replace(/\s+/g, ' ').trim();
    if (changed) { variants.add(changed); variants.add(changed.replace(/\s+/g, '')); }
  }
  // Two boards currently expose WASHINGTON with a historical spelling typo.
  const compactNormalized = normalized.replace(/\s+/g, '');
  if (/^washington(?:dc)?(?:md|mid|ev|eve)/.test(compactNormalized) || /^washington(?:md|ev)/.test(compactNormalized)) {
    variants.add(compactNormalized.replace(/^washington/, 'washigton').replace('dcmid', 'mid').replace('dceve', 'eve'));
  }
  if (/^washington\s+dc\s+mid$/.test(normalized)) variants.add('washigtonmid');
  if (/^washington\s+dc\s+eve$/.test(normalized)) variants.add('washigtoneve');
  return [...variants].map(clean).filter(Boolean);
}
function canonicalSnapshotAliases(mapping) {
  const variants = new Set();
  const candidates = [mapping?.name, mapping?.slug?.replace(/-pool$/i, '').replace(/-/g, ' ')];
  for (const configured of Object.values(mapping?.sources || {})) candidates.push(...aliasesOf(configured));
  for (const candidate of candidates) for (const alias of snapshotAliasVariants(candidate)) variants.add(alias);
  return [...variants];
}
function expectedSnapshotDigits(alias) {
  return /(?:^|\s)5d(?:\s|$)/.test(normalizeName(alias)) ? 5 : 4;
}
const SNAPSHOT_BOARD_SOURCE_CODES = new Set(['cindototo', 'sumtoto', 'miototo', 'ikontoto', 'kiatoto']);
const SNAPSHOT_BOARD_CACHE = new WeakMap();
function snapshotBoardView(html, source) {
  if (source && typeof source === 'object') {
    const cached = SNAPSHOT_BOARD_CACHE.get(source);
    if (cached && cached.html === html) return cached.view;
  }
  const lines = htmlLines(html);
  const boardIndex = findNormalizedSequence(lines, 'hasil terakhir', 0, lines.length, 3);
  const dateMatch = boardIndex >= 0 ? findDateWindow(lines, boardIndex, Math.min(lines.length, boardIndex + 160), 6) : null;
  const date = dateMatch?.date || null;
  const dateIndex = dateMatch?.endIndex ?? -1;
  const labelIndex = new Map();
  if (dateIndex >= 0) {
    for (let index = dateIndex + 1; index < lines.length; index += 1) {
      const normalized = normalizeName(lines[index]).replace(/^image\s+/, '');
      if (normalized && !labelIndex.has(normalized)) labelIndex.set(normalized, index);
    }
  }
  const view = { lines, boardIndex, date, dateIndex, labelIndex };
  if (source && typeof source === 'object') SNAPSHOT_BOARD_CACHE.set(source, { html, view });
  return view;
}
function observationFromCells(cells, alias, source) {
  const aliasIndex = cells.findIndex(cell => aliasMatch(cell, alias));
  if (aliasIndex < 0) return null;
  const date = cells.map(isoDate).find(Boolean) || null;
  if (!date) return null;
  const candidates = cells.slice(aliasIndex + 1).map((cell, index) => ({ index, value: digitsResult(cell) })).filter(item => item.value);
  if (!candidates.length) return null;
  const result = candidates.at(-1).value;
  return { source: source.code, sourceName: source.name, sourceFamily: source.family || source.code, alias, result, drawDate: date, drawTime: cells.map(drawTime).find(Boolean) || null };
}
function parseTableRows(html, alias, source) {
  for (const rowMatch of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(match => stripHtml(match[1])).filter(Boolean);
    if (!cells.length) continue;
    const found = observationFromCells(cells, alias, source);
    if (found) return found;
  }
  return null;
}
function parseLineWindow(html, alias, source) {
  const lines = htmlLines(html);
  const exactIndexes = [];
  const compatibleIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (exactAliasMatch(lines[index], alias)) exactIndexes.push(index);
    else if (aliasMatch(lines[index], alias)) compatibleIndexes.push(index);
  }
  for (const index of [...exactIndexes, ...compatibleIndexes]) {
    const window = lines.slice(index, Math.min(lines.length, index + 22));
    const dateMatch = findDateWindow(window, 0, window.length, 4);
    if (!dateMatch) continue;
    const date = dateMatch.date;
    const time = window.map(drawTime).find(Boolean) || null;
    const resultCandidates = window.slice(dateMatch.endIndex + 1).map((line, offset) => ({ offset, line, result: digitsResult(line) }))
      .filter(item => item.result && !isoDate(item.line) && !/^\d{1,2}[:.]\d{2}/.test(item.line));
    if (!resultCandidates.length) continue;
    const result = resultCandidates[0].result;
    return { source: source.code, sourceName: source.name, sourceFamily: source.family || source.code, alias, result, drawDate: date, drawTime: time };
  }
  return null;
}
function parseSnapshotBoard(html, alias, source) {
  const { lines, boardIndex, date, dateIndex, labelIndex } = snapshotBoardView(html, source);
  if (boardIndex < 0 || !date || dateIndex < 0) return null;
  const aliasKey = normalizeName(alias);
  const aliasIndex = labelIndex.get(aliasKey);
  if (!Number.isInteger(aliasIndex) || aliasIndex <= dateIndex || !exactAliasMatch(lines[aliasIndex], alias)) return null;
  const requiredDigits = expectedSnapshotDigits(alias);
  const digitParts = [];
  for (let index = aliasIndex + 1; index < Math.min(lines.length, aliasIndex + 14); index += 1) {
    const line = clean(lines[index]);
    if (!line || /^image$/i.test(line)) continue;
    const compact = digitsResult(line);
    if (compact && compact.length === requiredDigits) {
      return { source: source.code, sourceName: source.name, sourceFamily: source.family || source.code, alias, result: compact, drawDate: date, drawTime: null, sourceClass: 'CONSENSUS_INPUT' };
    }
    if (/^\d$/.test(line)) {
      digitParts.push(line);
      if (digitParts.length === requiredDigits) {
        return { source: source.code, sourceName: source.name, sourceFamily: source.family || source.code, alias, result: digitParts.join(''), drawDate: date, drawTime: null, sourceClass: 'CONSENSUS_INPUT' };
      }
      continue;
    }
    if (digitParts.length) break;
  }
  return null;
}
function parseMarketCard(html, alias, source) {
  const lines = htmlLines(html);
  const requiredDigits = expectedSnapshotDigits(alias);
  const exactIndexes = [];
  const compatibleIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = clean(lines[index]).replace(/^Image:\s*/i, '');
    if (exactAliasMatch(line, alias)) exactIndexes.push(index);
    else if (aliasMatch(line, alias)) compatibleIndexes.push(index);
  }
  for (const index of [...exactIndexes, ...compatibleIndexes]) {
    const window = lines.slice(index, Math.min(lines.length, index + 42));
    let result = null;
    let resultIndex = -1;
    for (let offset = 1; offset < Math.min(window.length, 12); offset += 1) {
      const line = clean(window[offset]);
      if (/^result\s*:/i.test(line)) break;
      const candidate = digitsResult(line);
      if (candidate && candidate.length === requiredDigits && !isoDate(line)) {
        result = candidate; resultIndex = offset; break;
      }
    }
    if (!result) continue;
    const dateMatch = findDateWindow(window, Math.max(1, resultIndex), Math.min(window.length, 24), 4);
    if (!dateMatch) continue;
    let closeTime = null;
    let resultTime = null;
    const closeScheduleIndex = window.findIndex(line => /tutup\s+pasaran/i.test(line));
    if (closeScheduleIndex >= 0) closeTime = window.slice(closeScheduleIndex, closeScheduleIndex + 5).map(drawTime).find(Boolean) || null;
    const resultScheduleIndex = window.findIndex(line => /result\s+pasaran/i.test(line));
    if (resultScheduleIndex >= 0) resultTime = window.slice(resultScheduleIndex, resultScheduleIndex + 5).map(drawTime).find(Boolean) || null;
    return { source: source.code, sourceName: source.name, sourceFamily: source.family || source.code, alias, result, drawDate: dateMatch.date, drawTime: resultTime, closeTime, resultTime, scheduleTimezone: (closeTime || resultTime) ? 'Asia/Jakarta' : null, sourceClass: 'CONSENSUS_INPUT' };
  }
  return null;
}
export function parseObservation(html, alias, source) {
  if (source.parser === 'posko-board') return parseTableRows(html, alias, source) || parseLineWindow(html, alias, source) || parsePoskoBoard(html, alias, source);
  if (source.parser === 'pools-draw') return parsePoolDraw(html, alias, source);
  if (source.parser === 'market-card') return parseMarketCard(html, alias, source);
  if (source.parser === 'vegasnet-table') return parseTableRows(html, alias, source);
  if (source.parser === 'snapshot-board' || SNAPSHOT_BOARD_SOURCE_CODES.has(source.code)) return parseSnapshotBoard(html, alias, source);
  return parseTableRows(html, alias, source) || parseLineWindow(html, alias, source);
}
// Official lottery live-draw sites render a recurring history of one pool spread across
// session pages (Belize) or a single homepage carrying every session block in a fixed order
// (Merida). These pages have no market-name column, so the observation is inferred from
// page-alias + the newest draw record on the page.
function poolDrawSession(alias) {
  const n = ` ${normalizeName(alias)} `;
  if (/evening|\beven\b/.test(n)) return 'evening';
  if (/night|\bngt\b/.test(n)) return 'night';
  if (/morning|\bmor\b/.test(n)) return 'morning';
  return 'midday';
}
const SESSION_ORDER = ['midday', 'evening', 'night', 'morning'];
function parsePoolRows(html) {
  const rows = [];
  for (const [, body] of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...body.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => stripHtml(m[1])).filter(Boolean);
    const text = cells.join(' ');
    const date = isoDate(text);
    if (!date) continue;
    const year = (text.match(/(20\d{2})/) || [])[1];
    const dedented = year ? text.replace(year, ' ') : text;
    const result = digitsResult(dedented);
    if (!result || result.length !== 4) continue;
    rows.push({ date, result });
  }
  return rows;
}
function parsePoolDraw(html, alias, source) {
  const rows = parsePoolRows(html);
  if (!rows.length) return null;
  const family = String(source.family || source.code || '').toLowerCase();
  const isMerida = family.includes('merida');
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    const list = byDate.get(row.date);
    if (!list.includes(row.result)) list.push(row.result);
  }
  const latestDate = [...byDate.keys()].sort().at(-1);
  const results = byDate.get(latestDate) || [];
  let result = null;
  if (isMerida) {
    const session = poolDrawSession(alias);
    const index = SESSION_ORDER.indexOf(session);
    result = results[index] || null;
  } else {
    result = results.at(0) || null;
  }
  if (!result) return null;
  return {
    source: source.code,
    sourceName: source.name,
    sourceFamily: source.family || source.code,
    alias,
    result,
    drawDate: latestDate,
    drawTime: null,
    sourceClass: 'CONSENSUS_INPUT'
  };
}
// PoskoPaito board: setiap <tr> memuat dropdown pasaran (label berulang + tautan menu,
// sehingga parser sel generik gagal match alias), lalu tanggal DD/MM/YYYY dan 4 span
// hasil-bola-small. Parser ini melonggarkan pencocokan label ke level baris.
function parsePoskoBoard(html, alias, source) {
  const aliasKey = normalizeName(alias);
  if (!aliasKey) return null;
  for (const rowMatch of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rowMatch[1];
    const text = stripHtml(row);
    const rowKey = normalizeName(text);
    if (!rowKey.includes(aliasKey) || rowKey.length > aliasKey.length + 160) continue;
    const dm = text.match(/\b(\d{2})\/(\d{2})\/(20\d{2})\b/);
    if (!dm) continue;
    const day = Number(dm[1]), month = Number(dm[2]), year = Number(dm[3]);
    if (!validCalendarDate(year, month, day)) continue;
    const drawDate = `${dm[3]}-${dm[2]}-${dm[1]}`; // Posko menulis DD/MM/YYYY (WIB)
    const digits = [...row.matchAll(/hasil-bola-small[^>]*>\s*(\d)\s*</gi)].map(m => m[1]);
    if (digits.length < 4) continue;
    const result = digits.slice(-4).join('');
    return { source: source.code, sourceName: source.name, sourceFamily: source.family || source.code, alias, result, drawDate, drawTime: null, sourceClass: 'CONSENSUS_INPUT' };
  }
  return null;
}
export function observationsForMapping(mapping, sourceResults) {
  const observations = [];
  for (const source of sourceResults) {
    if (!source.ok) continue;
    const configuredAliases = aliasesOf(mapping.sources?.[source.code]);
    const fallbackAliases = source.globalBoard ? canonicalSnapshotAliases(mapping) : [];
    const aliases = [...new Set([...configuredAliases, ...fallbackAliases])];
    if (!aliases.length) continue;
    let observation = null;
    for (const alias of aliases) {
      observation = parseObservation(source.html, alias, source);
      if (observation) break;
    }
    if (observation) {
      // Authority may come from the source definition (official operator sites) or from a
      // per-market override (mapping.authoritySources) — used when an otherwise-unverifiable
      // pool is only reliably published by a specific healthy aggregator board.
      const isAuthority = source.authority || Array.isArray(mapping.authoritySources) && mapping.authoritySources.includes(source.code);
      observations.push(isAuthority ? { ...observation, authority: true } : observation);
    }
  }
  return observations;
}
export function scheduleEvidence(observations = [], { result = null, drawDate = null, mapping = null } = {}) {
  const candidates = (observations || []).filter(item => {
    if (!item?.closeTime && !item?.resultTime) return false;
    if (result && item.result !== result) return false;
    if (drawDate && item.drawDate !== drawDate) return false;
    return true;
  });
  // Vegasnet hanya mengirim nama, tanggal, dan angka — tanpa jam tutup/result.
  // Urutan sumber jam: hasil kalibrasi dari sumber (terukur), lalu jadwal pool
  // sebagai cadangan konservatif supaya pasar menutup lebih awal.
  const fallback = () => {
    const calibrated = calibratedSchedule(mapping?.slug);
    if (calibrated) return calibrated;
    const conservative = conservativeFallbackSchedule(mapping);
    if (conservative) return conservative;
    return null;
  };
  if (!candidates.length) return fallback();
  const groups = new Map();
  for (const item of candidates) {
    const timezone = item.scheduleTimezone || 'Asia/Jakarta';
    const key = `${item.closeTime || ''}|${item.resultTime || ''}|${timezone}`;
    const values = groups.get(key) || [];
    values.push(item);
    groups.set(key, values);
  }
  const familyCount = values => new Set(values.map(item => item.sourceFamily || item.source)).size;
  const ranked = [...groups.values()].sort((a, b) => familyCount(b) - familyCount(a) || b.length - a.length);
  const agreeing = ranked[0] || [];
  const sourceFamilies = [...new Set(agreeing.map(item => item.sourceFamily || item.source))];
  return {
    status: sourceFamilies.length >= 2 ? 'VERIFIED' : 'OBSERVED',
    closeTime: agreeing.map(item => item.closeTime).find(Boolean) || null,
    resultTime: agreeing.map(item => item.resultTime).find(Boolean) || null,
    timezone: agreeing.map(item => item.scheduleTimezone).find(Boolean) || 'Asia/Jakarta',
    sources: [...new Set(agreeing.map(item => item.sourceName))],
    sourceFamilies
  };
}
export function resolveDecision(mapping, sourceResults, overrides = {}) {
  const observations = observationsForMapping(mapping, sourceResults);
  if (!Object.keys(mapping.sources || {}).length) return { slug: mapping.slug, status: 'UNMAPPED', observations: [], allObservations: [], result: null, drawDate: null, drawTime: null, confidence: 0 };
  if (!observations.length) return { slug: mapping.slug, status: 'SOURCE_UNAVAILABLE', observations, allObservations: observations, result: null, drawDate: null, drawTime: null, confidence: 0 };
  const latestDate = observations.map(item => item.drawDate).filter(Boolean).sort().at(-1);
  const latest = observations.filter(item => item.drawDate === latestDate);
  // Operator official draw authority: when the operator's own site publishes the latest
  // draw, that result is authoritative and overrides any differing aggregator observation
  // for the pool (a single healthy authority source is enough to publish VERIFIED).
  const authorityResults = latest.filter(item => item.authority).map(item => item.result);
  const authoritySet = [...new Set(authorityResults)];
  if (authorityResults.length && authoritySet.length === 1) {
    const authorityResult = authoritySet[0];
    const agreeing = latest.filter(item => item.result === authorityResult);
    const agreeingFamilies = [...new Set(agreeing.map(item => item.sourceFamily || item.source))];
    return {
      slug: mapping.slug,
      status: 'VERIFIED',
      observations: latest,
      allObservations: observations,
      result: authorityResult,
      drawDate: latestDate,
      drawTime: agreeing.map(x => x.drawTime).find(Boolean) || null,
      confidence: agreeingFamilies.length >= 2 ? 1 : 0.6,
      sources: [...new Set(agreeing.map(x => x.sourceName))],
      sourceFamilies: agreeingFamilies,
      schedule: scheduleEvidence(agreeing, { result: authorityResult, drawDate: latestDate, mapping }),
      authority: true
    };
  }
  const grouped = new Map();
  for (const item of latest) {
    const values = grouped.get(item.result) || [];
    values.push(item); grouped.set(item.result, values);
  }
  const familyCount = values => new Set(values.map(item => item.sourceFamily || item.source)).size;
  const ranked = [...grouped.entries()].sort((a, b) => familyCount(b[1]) - familyCount(a[1]) || b[1].length - a[1].length);
  if (ranked.length > 1 && familyCount(ranked[0][1]) === familyCount(ranked[1][1])) {
    return { slug: mapping.slug, status: 'CONFLICT', observations: latest, allObservations: observations, result: null, drawDate: latestDate, drawTime: latest.map(x => x.drawTime).find(Boolean) || null, confidence: 0, schedule: scheduleEvidence(latest, { drawDate: latestDate, mapping }) };
  }
  const [result, agreeing] = ranked[0];
  const agreeingFamilies = [...new Set(agreeing.map(item => item.sourceFamily || item.source))];
  const verified = agreeingFamilies.length >= 2 || (agreeingFamilies.length >= 1 && (overrides.singleSourceCanPublishVerified ?? config.totoSingleSourceCanPublishVerified));
  const confidence = verified ? (agreeingFamilies.length >= 2 ? 1 : 0.6) : 0;
  return {
    slug: mapping.slug,
    status: verified ? 'VERIFIED' : 'SINGLE_SOURCE',
    observations: latest,
    allObservations: observations,
    result,
    drawDate: latestDate,
    drawTime: agreeing.map(x => x.drawTime).find(Boolean) || null,
    confidence,
    sources: [...new Set(agreeing.map(x => x.sourceName))],
    sourceFamilies: agreeingFamilies,
    schedule: scheduleEvidence(agreeing, { result, drawDate: latestDate, mapping })
  };
}
export function enforceDecisionFreshness(decision, { now = new Date(), maxAgeDays = 4 } = {}) {
  if (!decision || decision.status !== 'VERIFIED' || !decision.drawDate) return decision;
  const drawAt = Date.parse(`${decision.drawDate}T23:59:59Z`);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(drawAt) || !Number.isFinite(nowMs)) return { ...decision, status: 'STALE_SOURCE', confidence: 0 };
  const maxAgeMs = Math.max(1, Number(maxAgeDays) || 4) * 86400000;
  if (nowMs - drawAt <= maxAgeMs) return decision;
  return { ...decision, status: 'STALE_SOURCE', confidence: 0, staleAgeDays: Math.floor((nowMs - drawAt) / 86400000) };
}
export function observationCountsBySource(decisions) {
  const counts = new Map();
  for (const decision of decisions) {
    for (const observation of decision.observations || []) counts.set(observation.source, (counts.get(observation.source) || 0) + 1);
  }
  return counts;
}
export function rawObservationSummaryBySource(decisions) {
  const summary = new Map();
  for (const decision of decisions) {
    for (const observation of decision.allObservations || decision.observations || []) {
      const current = summary.get(observation.source) || { parsedMarkets: 0, latestDrawDate: null };
      current.parsedMarkets += 1;
      if (observation.drawDate && (!current.latestDrawDate || observation.drawDate > current.latestDrawDate)) current.latestDrawDate = observation.drawDate;
      summary.set(observation.source, current);
    }
  }
  return summary;
}
export function countDecisions(decisions) {
  return {
    verified: decisions.filter(item => item.status === 'VERIFIED').length,
    singleSource: decisions.filter(item => item.status === 'SINGLE_SOURCE').length,
    conflict: decisions.filter(item => item.status === 'CONFLICT').length,
    unmapped: decisions.filter(item => item.status === 'UNMAPPED').length,
    sourceUnavailable: decisions.filter(item => item.status === 'SOURCE_UNAVAILABLE').length,
    staleSource: decisions.filter(item => item.status === 'STALE_SOURCE').length
  };
}

// ============================================================
// HYBRID SCHEDULE-DRIVEN COLLECTOR (OOM / scraping reducer)
// => Draw-window mapping + per-market completion tracking.
// WIB (UTC+7) HH:MM windows; used by worker.js to skip HTTP
// fetching outside a market's ACTIVE DRAW WINDOW and to stop
// scraping a period once it is already COMPLETED for the day.
// ============================================================
const WIB_OFFSET_MIN = 7 * 60;
// Representative WIB draw windows for the official/major pools.
// Any slug not listed below falls back to the broad WINDOW_DEFAULT
// (so live draws are never wrongly skipped when exact per-pool draw
// times are not yet known for that code).
const WINDOW_DEFAULT = Object.freeze(['09:00', '06:00']); // wide overnight-safe default
export const DRAW_SCHEDULE = Object.freeze({
  'king-kong-4d-pool': ['12:00', '20:30'],
  'toto-macau-midnight': ['22:00', '00:00'],
  'toto-macau-siang': ['10:00', '13:00'],
  'toto-macau-sore': ['13:00', '16:00'],
  'toto-macau-malam': ['16:00', '19:00'],
  'toto-macau-night': ['19:00', '22:00'],
  'hongkong-pool': ['15:00', '01:00'],
  'sydney-pool': ['12:00', '20:00'],
  'singapore-pool': ['17:00', '23:00'],
  'china-pool': ['14:30', '22:30'],
  'jepang-pool': ['10:00', '20:00'],
  'taiwan-pool': ['12:00', '23:00'],
  'cambodia-pool': ['08:00', '18:00'],
  'newyork-pool': ['07:00', '16:00'],
  'california-pool': ['09:00', '20:00'],
  'pcso-pool': ['13:00', '00:30'],
  'bullseye-pool': ['12:00', '22:15'],
  'wisconsin-pool': ['12:00', '02:35'],
  'georgia-eve-pool': ['12:00', '04:55'],
  'oregon-1-pool': ['12:00', '04:00'],
  'oregon-2-pool': ['12:00', '07:00'],
  'oregon-3-pool': ['12:00', '10:00'],
  'oregon-4-pool': ['12:00', '13:00'],
  'ohio-mid-pool': ['12:00', '05:35'],
  'ohio-eve-pool': ['12:00', '04:35'],
  'newyork-eve-pool': ['12:00', '04:35'],
  'maryland-eve-pool': ['12:00', '04:35'],
  'michigan-eve-pool': ['12:00', '04:35'],
  'newjersey-mid-pool': ['12:00', '05:35'],
  'kentucky-mid-pool': ['12:00', '05:35'],
  'indiana-mid-pool': ['12:00', '05:35'],
  'tennessee-mid-pool': ['12:00', '05:35'],
  'tennessee-eve-pool': ['12:00', '04:35'],
  'texas-eve-pool': ['12:00', '04:35'],
  'texas-day-pool': ['12:00', '06:35'],
  'texas-night-pool': ['12:00', '08:35'],
  'florida-mid-pool': ['12:00', '05:35'],
  'rhode-island-pool': ['12:00', '04:35'],
  'illinois-mid-pool': ['12:00', '05:35'],
  'missouri-mid-pool': ['12:00', '05:35'],
  'washington-md-pool': ['12:00', '05:35'],
  'washington-ev-pool': ['12:00', '04:35'],
  'delaware-day-pool': ['12:00', '08:35'],
  'delaware-ngt-pool': ['12:00', '06:35'],
  'virginia-day-pool': ['12:00', '08:35']
});
function toMin(t) {
  const [hh = '00', mm = '00'] = String(t || '00:00').split(':');
  return (Number(hh) % 24) * 60 + (Number(mm) % 60);
}
export function drawWindowFor(slug) {
  const key = String(slug || '').trim();
  return DRAW_SCHEDULE[key] || WINDOW_DEFAULT;
}
export function isDrawWindowActive(slug, { now = new Date(), padMin = 15 } = {}) {
  const [openRaw, closeRaw] = drawWindowFor(slug);
  const open = toMin(openRaw), close = toMin(closeRaw);
  const pad = Math.max(0, Number(padMin) || 15);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const wibMs = (nowMs + WIB_OFFSET_MIN * 60 * 1000);
  const mins = ((Math.floor(((wibMs) % 86400000 + 86400000) % 86400000) / 60000));
  const active = open <= close
    ? (mins >= open - pad) && (mins <= close + pad)
    : (mins >= open - pad) || (mins <= close + pad);
  return active;
}
