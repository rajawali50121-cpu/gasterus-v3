import { config } from './config.js';
import { AppError } from './errors.js';
import { casinoGames, casinoProviders } from './casino-rapidapi.js';

const PROVIDER_API_BASE = 'https://apiv2.gitslotpark.com';
const GAME_CATALOG_CACHE_MS = 5 * 60 * 1000;
const clean = (value, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
let gameCatalogCache = null;

export async function rapidApiProviderCatalog() {
  return casinoProviders();
}

export async function rapidApiGamesForProvider(providerCode) {
  return casinoGames(providerCode);
}

function requireLauncherConfig() {
  if (!config.slotWalletEnabled) {
    throw new AppError(503, 'Integrasi slot provider belum diaktifkan.', 'SLOT_PROVIDER_DISABLED');
  }
  if (!config.slotProviderAgentId) {
    throw new AppError(503, 'Integrasi slot provider belum dikonfigurasi.', 'SLOT_PROVIDER_NOT_CONFIGURED');
  }
  if (!config.slotProviderToken) {
    throw new AppError(503, 'Token Seamless API belum dikonfigurasi; katalog RapidAPI tetap tersedia.', 'SLOT_PROVIDER_TOKEN_MISSING');
  }
}

async function providerRequest(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  requireLauncherConfig();
  if (!['/gamelist', '/userAuth'].includes(path)) {
    throw new AppError(400, 'Endpoint slot provider tidak diizinkan.', 'SLOT_PROVIDER_PATH_INVALID');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.slotProviderTimeoutMs);
  try {
    const response = await fetchImpl(`${PROVIDER_API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.slotProviderToken}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new AppError(502, 'Respons slot provider bukan JSON yang valid.', 'SLOT_PROVIDER_RESPONSE_INVALID');
    }
    if (!response.ok) {
      throw new AppError(502, 'Slot provider menolak permintaan.', 'SLOT_PROVIDER_UPSTREAM_ERROR', { upstreamStatus: response.status });
    }
    if (Number(payload?.code) !== 0) {
      throw new AppError(502, clean(payload?.message, 180) || 'Slot provider menolak permintaan.', 'SLOT_PROVIDER_UPSTREAM_ERROR');
    }
    return payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'Slot provider tidak dapat dihubungi.', 'SLOT_PROVIDER_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}

async function gameCatalog(fetchImpl = fetch) {
  if (gameCatalogCache && Date.now() - gameCatalogCache.fetchedAt < GAME_CATALOG_CACHE_MS) {
    return gameCatalogCache.games;
  }
  const payload = await providerRequest('/gamelist', { fetchImpl });
  if (!Array.isArray(payload.data)) {
    throw new AppError(502, 'Katalog game slot provider tidak valid.', 'SLOT_PROVIDER_CATALOG_INVALID');
  }
  const games = payload.data.filter(game => game && Number.isSafeInteger(Number(game.gameid)) && Number(game.gameid) > 0);
  gameCatalogCache = { games, fetchedAt: Date.now() };
  return games;
}

export async function slotGameCatalog(providerCode = '', fetchImpl = fetch) {
  const requestedProvider = clean(providerCode, 80).toLowerCase();
  if (config.slotWalletEnabled && config.slotProviderToken && config.slotProviderAgentId) {
    const games = await gameCatalog(fetchImpl);
    const filtered = requestedProvider
      ? games.filter(game => clean(game.vendorid, 80).toLowerCase() === requestedProvider)
      : games;
    return filtered.map(game => ({
      providerCode: clean(game.vendorid, 80),
      gameCode: String(game.gameid),
      name: clean(game.name, 120),
      symbol: clean(game.symbol, 120) || null,
      iconUrl: clean(game.iconurl1 || game.iconurl2 || game.iconurl3, 1000) || null,
      minBet: Number.isFinite(Number(game.miniBet)) ? Number(game.miniBet) : null
    }));
  }
  if (!requestedProvider) return [];
  const { games = [] } = await rapidApiGamesForProvider(providerCode);
  return games.map(game => ({
    providerCode: clean(game.provider || providerCode, 80),
    gameCode: clean(game.id, 80),
    name: clean(game.name, 120),
    symbol: clean(game.id, 120) || null,
    iconUrl: clean(game.img, 1000) || null,
    minBet: null
  }));
}

export async function slotProviderCatalog(fetchImpl = fetch) {
  if (config.slotWalletEnabled && config.slotProviderToken && config.slotProviderAgentId) {
    const games = await gameCatalog(fetchImpl);
    const providers = new Map();
    for (const game of games) {
      const providerCode = clean(game.vendorid, 80);
      if (providerCode) providers.set(providerCode.toLowerCase(), providerCode);
    }
    return [...providers.values()].sort((a, b) => a.localeCompare(b));
  }
  const { providers = [] } = await rapidApiProviderCatalog();
  return providers.map(provider => ({
    code: clean(provider.code, 80),
    name: clean(provider.name, 120),
    category: clean(provider.category, 40)
  }));
}

function providerUserId(userId, username) {
  const cleanUsername = clean(username, 48);
  if (/^[A-Za-z0-9]{4,48}$/.test(cleanUsername)) return cleanUsername;
  const compactId = String(userId ?? '').replace(/-/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compactId)) {
    throw new AppError(400, 'Identitas member tidak valid.', 'SLOT_MEMBER_INVALID');
  }
  return `g${compactId}`;
}

export function buildSlotLaunchRequest({ userId, username, currency, providerCode, gameCode }) {
  requireLauncherConfig();
  const compactId = String(userId ?? '').replace(/-/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compactId)) {
    throw new AppError(400, 'Identitas member tidak valid.', 'SLOT_MEMBER_INVALID');
  }
  const normalizedCurrency = clean(currency, 3).toUpperCase();
  if (normalizedCurrency !== 'IDR') {
    throw new AppError(400, 'Slot provider hanya mendukung saldo IDR.', 'SLOT_CURRENCY_UNSUPPORTED');
  }
  const provider = clean(providerCode, 80);
  if (!/^[A-Za-z0-9 _.-]{1,80}$/.test(provider)) {
    throw new AppError(400, 'Provider game tidak valid.', 'SLOT_PROVIDER_INVALID');
  }
  const gameCodeText = clean(gameCode, 10);
  if (!/^[1-9]\d{0,9}$/.test(gameCodeText)) {
    throw new AppError(400, 'Kode game tidak valid.', 'SLOT_GAME_INVALID');
  }
  const gameId = Number(gameCodeText);
  return {
    agentID: config.slotProviderAgentId,
    userID: providerUserId(userId, username),
    lang: 'id',
    gameid: gameId,
    isaffiliate: false,
    lobbyUrl: 'https://gasterus.fun'
  };
}

export async function launchGame(input, fetchImpl = fetch) {
  const request = buildSlotLaunchRequest(input);
  const games = await gameCatalog(fetchImpl);
  const requestedProvider = clean(input.providerCode, 80).toLowerCase();
  const matchingGame = games.find(game =>
    Number(game.gameid) === request.gameid &&
    clean(game.vendorid, 80).toLowerCase() === requestedProvider
  );
  if (!matchingGame) {
    throw new AppError(404, 'Game tidak ditemukan pada provider yang dipilih.', 'SLOT_GAME_NOT_FOUND');
  }

  const payload = await providerRequest('/userAuth', { method: 'POST', body: request, fetchImpl });
  let gameUrl;
  try {
    gameUrl = new URL(payload.url);
  } catch {
    throw new AppError(502, 'Slot provider tidak mengembalikan URL sesi game.', 'SLOT_LAUNCH_URL_INVALID');
  }
  if (gameUrl.protocol !== 'https:') {
    throw new AppError(502, 'URL sesi game harus menggunakan HTTPS.', 'SLOT_LAUNCH_URL_INVALID');
  }
  return { gameUrl: gameUrl.toString(), mode: 'REAL' };
}

export const __slotProviderClient = {
  clearGameCatalogCache() {
    gameCatalogCache = null;
  }
};
