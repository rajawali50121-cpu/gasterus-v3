import { config } from './config.js';

const cache = new Map();
let windowStartedAt = 0;
let lookupsThisWindow = 0;
// Batas jumlah entri: nilai entri kecil (4 field string), tapi key berasal dari nama tim
// dari provider yang terus berubah, jadi tanpa batas ini Map tumbuh seumur proses.
// Pola prune-by-oldest ini sama dengan sourceHealth (toto-collector.js:50).
const MAX_CACHE_ENTRIES = 500;
function rememberEntry(cacheKey, value, ttlMs, now) {
  cache.set(cacheKey, { value, expiresAt: now + ttlMs, lastSeenAt: now });
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  // Buang entri basi lebih dulu (gratis), lalu entri yang paling lama tidak terlihat.
  const now2 = Date.now();
  for (const [key_, entry] of [...cache]) {
    if (entry.expiresAt <= now2) cache.delete(key_);
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => (a[1].lastSeenAt || 0) - (b[1].lastSeenAt || 0))[0];
    if (!oldest) break;
    cache.delete(oldest[0]);
  }
}

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function key(value) {
  return clean(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|sc|afc|club|the)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function resetWindow(now = Date.now()) {
  if (!windowStartedAt || now - windowStartedAt >= 60_000) { windowStartedAt = now; lookupsThisWindow = 0; }
}
function mayLookup() {
  resetWindow();
  if (lookupsThisWindow >= config.sportsbookArtworkMaxLookupsPerMinute) return false;
  lookupsThisWindow += 1;
  return true;
}
function bestTeam(teams, name) {
  const wanted = key(name);
  const soccer = (Array.isArray(teams) ? teams : []).filter(team => !team?.strSport || /soccer|football/i.test(team.strSport));
  return soccer.find(team => key(team.strTeam) === wanted)
    || soccer.find(team => key(team.strTeamAlternate || '').split(' ').filter(Boolean).join(' ') === wanted)
    || soccer.find(team => key(team.strTeam).includes(wanted) || wanted.includes(key(team.strTeam)))
    || null;
}
async function lookupTeam(name) {
  const cacheKey = key(name);
  if (!cacheKey) return null;
  const now = Date.now();
  const prior = cache.get(cacheKey);
  if (prior && prior.expiresAt > now) return prior.value;
  if (!mayLookup()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.sportsbookArtworkTimeoutMs);
  try {
    const base = config.sportsbookArtworkBaseUrl.replace(/\/$/, '');
    const url = new URL(`${base}/${encodeURIComponent(config.sportsbookArtworkApiKey)}/searchteams.php`);
    url.searchParams.set('t', name);
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Gasterus-Team-Artwork/6.9.0.14' }, signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`artwork HTTP ${response.status}`);
    const payload = await response.json();
    const team = bestTeam(payload?.teams, name);
    const value = team ? {
      logo: team.strBadge || team.strLogo || team.strTeamBadge || null,
      country: team.strCountry || null,
      providerTeamId: team.idTeam || null,
      source: 'thesportsdb'
    } : null;
    rememberEntry(cacheKey, value, (value ? config.sportsbookArtworkCacheSeconds : config.sportsbookArtworkNegativeCacheSeconds) * 1000, now);
    return value;
  } catch {
    rememberEntry(cacheKey, null, config.sportsbookArtworkNegativeCacheSeconds * 1000, now);
    return null;
  } finally { clearTimeout(timer); }
}

export async function enrichTeamArtwork(events = []) {
  if (!config.sportsbookArtworkEnabled || !config.sportsbookArtworkApiKey || !Array.isArray(events) || !events.length) return events;
  const missing = [];
  const seen = new Set();
  for (const event of events) {
    for (const side of ['home', 'away']) {
      const team = event?.[side];
      if (!team?.name || team.logo) continue;
      const k = key(team.name);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      missing.push(team.name);
      if (missing.length >= config.sportsbookArtworkMaxLookupsPerRefresh) break;
    }
    if (missing.length >= config.sportsbookArtworkMaxLookupsPerRefresh) break;
  }
  const resolved = new Map();
  await Promise.all(missing.map(async name => resolved.set(key(name), await lookupTeam(name))));
  return events.map(event => {
    const copy = structuredClone(event);
    for (const side of ['home', 'away']) {
      const team = copy?.[side];
      if (!team?.name || team.logo) continue;
      const artwork = resolved.get(key(team.name)) || cache.get(key(team.name))?.value || null;
      if (artwork?.logo) team.logo = artwork.logo;
      if (!copy.country && artwork?.country) copy.country = artwork.country;
      if (artwork?.providerTeamId) {
        copy._refs ||= {};
        copy._refs[`thesportsdb:${side}`] = artwork.providerTeamId;
      }
    }
    return copy;
  });
}

export const __teamArtwork = { key, bestTeam, lookupTeam, cache, rememberEntry, MAX_CACHE_ENTRIES };
