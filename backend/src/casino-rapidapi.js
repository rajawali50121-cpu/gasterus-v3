import { config } from './config.js';
import { logger } from './logger.js';
import { AppError } from './errors.js';
import { betnexWalletStatus, betnexProvidersForCurrency, betnexGamesForCurrency, launchBetnexGame } from './casino-wallet.js';

// RapidAPI casino aggregator. Key HANYA dari env backend.
// Frontend TIDAK PERNAH menerima key — semua lewat proxy ini.
const HOST = 'live-casino-slots-evolution-jili-and-50-plus-provider.p.rapidapi.com';

// Allowlist path agar proxy tidak bisa dipakai SSRF ke endpoint lain.
// Path diverifikasi dari respons provider asli:
// - /casino/getallproviders -> daftar provider (games:[...])
// - /casino/getallgamesandprovider?provider=SPRIBE -> daftar game (games:[{name,id,img,type,provider}])
const ALLOWED_PATHS = new Set([
  '/casino/getallproviders',
  '/casino/getallgamesandprovider',
  '/casino/getgames',
  '/casino/getgameurl',
  '/casino/getbalance',
  '/casino/launch',
  '/casino/login',
]);

const DIAG_PATHS = new Set([...ALLOWED_PATHS]);

const cache = new Map();
const inFlight = new Map();
const failureCache = new Map();
const FAILURE_CACHE_MAX_ENTRIES = 100;

function pruneFailureCache(now = Date.now(), addingKey = null) {
  for (const [key, entry] of failureCache) {
    if (entry.retryAt <= now) failureCache.delete(key);
  }
  while (failureCache.size >= FAILURE_CACHE_MAX_ENTRIES && addingKey && !failureCache.has(addingKey)) {
    let oldestKey = null;
    let oldestRetryAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of failureCache) {
      if (entry.retryAt < oldestRetryAt) {
        oldestKey = key;
        oldestRetryAt = entry.retryAt;
      }
    }
    if (oldestKey === null) break;
    failureCache.delete(oldestKey);
  }
}

function recordFailure(cacheKey, entry, now) {
  if (!cacheKey) return;
  pruneFailureCache(now, cacheKey);
  failureCache.set(cacheKey, entry);
}

function rapidApiKey() {
  return String(
    process.env.RAPIDAPI_CASINO_KEY || process.env.RAPIDAPI_KEY || config.rapidApiKey || ''
  ).trim();
}

export function casinoRapidApiStatus() {
  const key = rapidApiKey();
  return {
    configured: Boolean(key),
    enabled: Boolean(config.rapidApiCasinoEnabled) && Boolean(key),
    host: HOST,
    allowedPaths: [...ALLOWED_PATHS],
    cacheTtlSeconds: config.rapidApiCasinoCacheSeconds,
    wallet: betnexWalletStatus(),
  };
}

function clean(value, max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function guessCategory(code) {
  const c = String(code || '').toUpperCase();
  if (/SPORT|BETBY|PRONET|CMD|SBO|SABA|BTI|IAE|LUCKY|KOOL|TOPBET/.test(c)) return 'SPORTSBOOK';
  if (/LIVE|EVO|EZUGI|VIVO|DREAM|SAGAMING|WM|SEXY|CREED|ATMOS|ASTAR/.test(c)) return 'LIVE_CASINO';
  if (/AVIATOR|AVIATRIX|SMARTSOFT|SPRIBE|TURBO|INOUT|GALAXYS/.test(c)) return 'CRASH_ARCADE';
  if (/JILI|PGSOFT|PRAGMATIC|JOKER|HABANERO|SPADE|CQ9|JDB|KA|NEXTSPIN|FASTSPIN|FACHAI|TADA|BNG|PLAYNGO|PLAYTECH|MICRO|NETENT|REDTIGER|RELAX|NOLIMIT|HACKSAW|BIGTIME|GAMEART|PLAYSON|BETSOFT|BOOMING|ENDORPHINA|FUNKEY|EPICWIN|WINGAMING|RICHPARAD/.test(c)) return 'SLOTS';
  return 'OTHER';
}

export function normalizeProviders(payload) {
  const rawList = Array.isArray(payload?.games)
    ? payload.games
    : Array.isArray(payload?.providers)
      ? payload.providers
      : Array.isArray(payload?.data)
        ? payload.data
        : [];
  const seen = new Set();
  const providers = [];
  for (const item of rawList) {
    const code = clean(typeof item === 'string' ? item : item?.code || item?.provider || item?.name, 60).toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const name = clean(typeof item === 'string' ? item : item?.name || item?.title || code, 120) || code;
    providers.push({ code, name, category: guessCategory(code) });
  }
  providers.sort((a, b) => a.code.localeCompare(b.code));
  return providers;
}
export function normalizeGames(payload, providerCode = '') {
  // Bentuk sukses: { success:true, provider:'SPRIBE', totalGames:16,
  //   games:[{name:'Aviator',id,img,type:'crash',provider:'SPRIBE'}] }
  // Bentuk PG: { success:true, data:[{game_uid,game_name,game_type,...}] }
  const rawList = Array.isArray(payload?.games)
    ? payload.games
    : Array.isArray(payload?.data)
      ? payload.data
      : [];
  const games = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const name = clean(item.name || item.game_name || item.title || item.game, 80);
    if (!name) continue;
    games.push({
      name,
      id: clean(item.id || item.game_uid || item.uid || '', 80) || null,
      img: clean(item.img || item.image || item.thumbnail || '', 300) || null,
      type: clean(item.type || item.game_type || '', 30) || null,
      provider: clean(item.provider || providerCode, 40) || null,
    });
  }
  return games;
}
async function rapidFetch(path, params = {}, options = {}) {
  const key = rapidApiKey();
  if (!config.rapidApiCasinoEnabled) {
    throw new AppError(503, 'Layanan casino belum diaktifkan.', 'CASINO_DISABLED');
  }
  if (!key) {
    throw new AppError(503, 'Kunci RapidAPI casino belum dikonfigurasi.', 'CASINO_NOT_CONFIGURED');
  }
  if (!ALLOWED_PATHS.has(path)) {
    throw new AppError(400, 'Endpoint casino tidak diizinkan.', 'CASINO_PATH_NOT_ALLOWED');
  }
  const url = new URL('https://' + HOST + path);
  for (const entry of Object.entries(params || {})) {
    if (entry[1] === undefined || entry[1] === null || entry[1] === '') continue;
    url.searchParams.set(entry[0], String(entry[1]));
  }
  const method = String(options.method || 'GET').toUpperCase();
  const cacheKey = method === 'GET' ? path + '?' + url.searchParams.toString() : null;
  const now = Date.now();
  pruneFailureCache(now);
  const failed = cacheKey ? failureCache.get(cacheKey) : null;
  if (failed && now < failed.retryAt) {
    throw new AppError(502, 'Provider casino sibuk. Coba lagi nanti.', 'CASINO_UPSTREAM_COOLDOWN');
  }
  const ttlMs = Math.max(15, Number(config.rapidApiCasinoCacheSeconds) || 300) * 1000;
  const cached = cacheKey ? cache.get(cacheKey) : null;
  if (cached && now - cached.fetchedAt < ttlMs) return cached.value;
  if (cacheKey && inFlight.get(cacheKey)) return inFlight.get(cacheKey);
  const task = (async () => {
    const controller = new AbortController();
    const timeoutMs = Math.max(3000, Number(config.rapidApiCasinoTimeoutMs) || 12000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          'x-rapidapi-host': HOST,
          'x-rapidapi-key': key,
          accept: 'application/json',
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {})
        },
        ...(method === 'POST' ? { body: JSON.stringify(options.body || {}) } : {}),
        signal: controller.signal,
      });
      const text = await res.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: String(text || '').slice(0, 2000) }; }
      if (!res.ok) {
        const upstreamStatus = Number(res.status) || 502;
        const upstreamMessage = clean(payload?.message || payload?.error || payload?.raw, 180) || ('upstream ' + upstreamStatus);
        logger.error('Casino RapidAPI upstream error', { path, status: upstreamStatus, message: upstreamMessage });
        recordFailure(cacheKey, { message: upstreamMessage, retryAt: now + 60 * 1000 }, now);
        if (upstreamStatus === 429) throw new AppError(429, 'Provider casino sibuk (batas request). Coba lagi nanti.', 'CASINO_RATE_LIMITED', { upstreamStatus });
        if (upstreamStatus >= 400 && upstreamStatus < 500) throw new AppError(upstreamStatus, 'Provider casino menolak permintaan (' + upstreamStatus + '): ' + upstreamMessage, 'CASINO_UPSTREAM_REJECTED', { upstreamStatus, upstreamMessage });
        throw new AppError(502, 'Provider casino gagal.', 'CASINO_UPSTREAM_ERROR');
      }
      if (cacheKey && cache.size > 200) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
        for (const entry of oldest.slice(0, 40)) cache.delete(entry[0]);
      }
      if (cacheKey) {
        cache.set(cacheKey, { value: payload, fetchedAt: Date.now() });
        failureCache.delete(cacheKey);
      }
      return payload;
    } catch (error) {
      if (error instanceof AppError) {
        recordFailure(cacheKey, { message: error.message, retryAt: now + 60 * 1000 }, now);
        throw error;
      }
      recordFailure(cacheKey, { message: 'fetch-failed', retryAt: now + 60 * 1000 }, now);
      logger.error('Casino RapidAPI request failed', { path });
      throw new AppError(502, 'Provider casino tidak dapat dihubungi.', 'CASINO_UPSTREAM_ERROR');
    } finally {
      clearTimeout(timeout);
      if (cacheKey) inFlight.delete(cacheKey);
    }
  })();
  if (cacheKey) inFlight.set(cacheKey, task);
  return task;
}

export async function casinoProviders() {
  const payload = config.betnexRealMoneyEnabled
    ? { data: await betnexProvidersForCurrency('IDR') }
    : await rapidFetch('/casino/getallproviders');
  const providers = normalizeProviders(payload);
  return {
    providers,
    total: providers.length,
    categories: [...new Set(providers.map((p) => p.category))].sort(),
    fetchedAt: new Date().toISOString(),
  };
}

async function probeUpstream(path, params) {
  const key = rapidApiKey();
  const url = new URL('https://' + HOST + path);
  for (const entry of Object.entries(params || {})) {
    if (entry[1] === undefined || entry[1] === null || entry[1] === '') continue;
    url.searchParams.set(entry[0], String(entry[1]));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'x-rapidapi-host': HOST, 'x-rapidapi-key': key, accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await res.text();
    let shape = 'empty';
    try {
      const payload = text ? JSON.parse(text) : null;
      shape = Array.isArray(payload) ? 'array:' + payload.length
        : payload && typeof payload === 'object' ? 'keys:' + Object.keys(payload).slice(0, 8).join(',') : 'scalar';
    } catch { shape = 'non-json:' + String(text || '').slice(0, 80); }
    // TIDAK pernah mengembalikan key / body penuh — hanya status + bentuk.
    return { path, params, status: res.status, ok: res.ok, shape };
  } catch (error) {
    return { path, params, status: 0, ok: false, shape: 'fetch-failed:' + clean(error?.message, 60) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function diagnoseCasinoUpstream(provider) {
  if (!config.rapidApiCasinoEnabled) throw new AppError(503, 'Layanan casino belum diaktifkan.', 'CASINO_DISABLED');
  if (!rapidApiKey()) throw new AppError(503, 'Kunci RapidAPI casino belum dikonfigurasi.', 'CASINO_NOT_CONFIGURED');
  const code = clean(provider, 40) || 'PGSOFT';
  const candidates = [
    ['/casino/getgames', { provider: code }],
    ['/casino/getgames', { provider: code.toLowerCase() }],
    ['/casino/getgames', { gameProvider: code }],
    ['/casino/games', { provider: code }],
    ['/casino/provider-games', { provider: code }],
    ['/v0/games', { provider: code }],
  ].filter(([path]) => DIAG_PATHS.has(path));
  const results = [];
  for (const [path, params] of candidates) results.push(await probeUpstream(path, params));
  return { provider: code, host: HOST, results, fetchedAt: new Date().toISOString() };
}

export async function casinoGames(provider) {
  const code = clean(provider, 40).toUpperCase();
  if (!code) throw new AppError(400, 'Provider wajib dipilih.', 'CASINO_PROVIDER_REQUIRED');
  if (config.betnexRealMoneyEnabled) {
    const games = normalizeGames({ data: await betnexGamesForCurrency(code, 'IDR') }, code);
    return { provider: code, total: games.length, games, fetchedAt: new Date().toISOString(), currency: 'IDR' };
  }
  const payload = await rapidFetch('/casino/getallgamesandprovider', { provider: code });
  const games = normalizeGames(payload, code);
  return {
    provider: payload?.provider || code,
    total: Number(payload?.totalGames) || games.length,
    games,
    fetchedAt: new Date().toISOString(),
  };
}

export function buildCasinoDemoRequest(memberId, input = {}) {
  const gameId = clean(input.gameId, 80);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(gameId)) {
    throw new AppError(400, 'Game tidak valid.', 'CASINO_GAME_INVALID');
  }
  const platform = Number(input.platform || 1);
  if (![1, 2].includes(platform)) {
    throw new AppError(400, 'Platform tidak valid.', 'CASINO_PLATFORM_INVALID');
  }
  const memberKey = String(memberId || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (memberKey.length < 4) throw new AppError(400, 'Sesi member tidak valid.', 'CASINO_MEMBER_INVALID');
  return {
    username: `g${memberKey.slice(0, 31)}`,
    gameId,
    lang: 'en',
    money: 0,
    home_url: 'https://gasterus.fun',
    platform,
    currency: 'IDR'
  };
}

export function normalizeCasinoDemoLaunch(payload) {
  if (payload?.code !== undefined && Number(payload.code) !== 0) {
    throw new AppError(502, clean(payload.msg, 180) || 'Provider menolak sesi demo.', 'CASINO_LAUNCH_REJECTED');
  }
  const gameUrl = clean(payload?.payload?.game_launch_url || payload?.game_launch_url, 2000);
  let parsed;
  try { parsed = new URL(gameUrl); } catch {}
  if (!parsed || parsed.protocol !== 'https:') {
    throw new AppError(502, 'Provider tidak mengembalikan URL game HTTPS yang valid.', 'CASINO_LAUNCH_URL_INVALID');
  }
  const expiry = Number(payload?.payload?.expires_in);
  return { gameUrl: parsed.toString(), mode: 'DEMO', expiresIn: Number.isFinite(expiry) && expiry > 0 ? expiry : null };
}

export async function launchCasinoDemo(memberId, input = {}) {
  const request = buildCasinoDemoRequest(memberId, input);
  const payload = await rapidFetch('/casino/getgameurl', {}, { method: 'POST', body: request });
  return normalizeCasinoDemoLaunch(payload);
}

export async function launchCasinoGame(member, input = {}) {
  if (config.betnexRealMoneyEnabled) return launchBetnexGame(member, input);
  const result = await launchCasinoDemo(member?.id, input);
  return { ...result, mode: 'DEMO' };
}

export async function casinoPassthrough(path, params = {}) {
  return rapidFetch(path, params);
}

export const __casinoRapidApi = { failureCache, pruneFailureCache };
