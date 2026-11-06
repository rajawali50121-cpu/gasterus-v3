import { timingSafeEqual, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { query, tx } from './db.js';
import { AppError } from './errors.js';
import { memberAccount, postTransfer, SYSTEM_ACCOUNTS } from './ledger.js';
import { MONEY_CURRENCY } from './money.js';
import { logger } from './logger.js';

const BETNEX_HOST = 'livecasinoapi.betnex.co';
const PROVIDER_CODE = 'BETNEX';
const BETNEX_DIRECT_PATHS = new Set(['/casino/getgameurl', '/casino/filterproviders', '/casino/filtergames']);
const betnexCatalogCache = new Map();
const clean = (value, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function betnexWalletStatus() {
  const realMoneyReady = Boolean(config.betnexApiKey && config.betnexCallbackKey);
  const launchMode = config.betnexRealMoneyEnabled
    ? (realMoneyReady ? 'REAL' : 'REAL_NOT_CONFIGURED')
    : 'DEMO';
  return {
    launchMode,
    realMoneyEnabled: launchMode === 'REAL',
    directApiConfigured: Boolean(config.betnexApiKey),
    callbackKeyConfigured: Boolean(config.betnexCallbackKey),
    callbackPath: '/api/member/casino/callback',
    currency: MONEY_CURRENCY
  };
}

export function buildBetnexLaunchRequest(member, input = {}) {
  const gameId = clean(input.gameId, 80);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(gameId)) throw new AppError(400, 'Game tidak valid.', 'CASINO_GAME_INVALID');
  const memberId = String(member?.id || '').replace(/-/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(memberId)) throw new AppError(400, 'Sesi member tidak valid.', 'CASINO_MEMBER_INVALID');
  const money = Number(member.balance);
  if (!Number.isSafeInteger(money) || money < 0) throw new AppError(409, 'Saldo member tidak valid untuk sesi game.', 'CASINO_BALANCE_INVALID');
  const platform = Number(input.platform || 1);
  if (![1, 2].includes(platform)) throw new AppError(400, 'Platform tidak valid.', 'CASINO_PLATFORM_INVALID');
  return {
    username: memberId,
    gameId,
    lang: 'en',
    money,
    home_url: 'https://gasterus.fun',
    platform,
    currency: MONEY_CURRENCY
  };
}

async function betnexDirectRequest(path, { params = {}, body = null, fetchImpl = fetch } = {}) {
  if (!BETNEX_DIRECT_PATHS.has(path)) throw new AppError(400, 'Endpoint Betnex tidak diizinkan.', 'BETNEX_PATH_INVALID');
  if (!config.betnexApiKey) throw new AppError(503, 'BETNEX_API_KEY belum dikonfigurasi.', 'BETNEX_API_KEY_MISSING');
  const method = body === null ? 'GET' : 'POST';
  const url = new URL(`https://${BETNEX_HOST}${path}`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  const cacheKey = method === 'GET' ? url.toString() : null;
  const cached = cacheKey ? betnexCatalogCache.get(cacheKey) : null;
  if (cached && Date.now() - cached.at < 86400000) return cached.payload;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(3000, Number(config.rapidApiCasinoTimeoutMs) || 12000));
  try {
    const response = await fetchImpl(url.toString(), {
      method,
      headers: { 'x-betnex-key': config.betnexApiKey, accept: 'application/json', ...(body === null ? {} : { 'content-type': 'application/json' }) },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok || payload?.success === false) {
      logger.error('Betnex direct API error', { path, status: response.status, code: payload?.code || null });
      throw new AppError(502, clean(payload?.message || payload?.msg, 160) || 'Betnex API gagal.', 'BETNEX_UPSTREAM_ERROR');
    }
    if (cacheKey) {
      if (betnexCatalogCache.size > 200) betnexCatalogCache.clear();
      betnexCatalogCache.set(cacheKey, { payload, at: Date.now() });
    }
    return payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Betnex direct request failed', { path, error: error?.message || 'fetch-failed' });
    throw new AppError(502, 'Betnex API tidak dapat dihubungi.', 'BETNEX_UPSTREAM_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}

export async function betnexProvidersForCurrency(currency = MONEY_CURRENCY, fetchImpl = fetch) {
  const payload = await betnexDirectRequest('/casino/filterproviders', { params: { currency }, fetchImpl });
  const providers = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.providers) ? payload.providers : [];
  return providers.filter(item => Number(item?.status) === 1);
}

export async function betnexGamesForCurrency(provider, currency = MONEY_CURRENCY, fetchImpl = fetch) {
  const code = clean(provider, 60).toUpperCase();
  if (!code) throw new AppError(400, 'Provider wajib dipilih.', 'CASINO_PROVIDER_REQUIRED');
  const payload = await betnexDirectRequest('/casino/filtergames', { params: { providercode: code, currency }, fetchImpl });
  const games = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.games) ? payload.games : [];
  return games.filter(item => Number(item?.status) === 1);
}

function normalizeLaunch(payload) {
  if (payload?.success === false || (payload?.code !== undefined && Number(payload.code) !== 0)) {
    throw new AppError(502, clean(payload?.message || payload?.msg, 180) || 'Betnex menolak sesi game.', 'BETNEX_LAUNCH_REJECTED');
  }
  const gameUrl = clean(payload?.payload?.game_launch_url || payload?.game_launch_url, 2000);
  let parsed;
  try { parsed = new URL(gameUrl); } catch {}
  if (!parsed || parsed.protocol !== 'https:') throw new AppError(502, 'Betnex tidak mengembalikan URL game HTTPS yang valid.', 'BETNEX_LAUNCH_URL_INVALID');
  const expiresIn = Number(payload?.payload?.expires_in || payload?.expires_in);
  return { gameUrl: parsed.toString(), mode: 'REAL', expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 60 };
}

export async function launchBetnexGame(member, input = {}, fetchImpl = fetch) {
  if (!config.betnexRealMoneyEnabled) throw new AppError(503, 'Mode saldo nyata casino belum diaktifkan.', 'BETNEX_REAL_MONEY_DISABLED');
  if (!config.betnexApiKey || !config.betnexCallbackKey) throw new AppError(503, 'Kredensial Betnex atau callback belum dikonfigurasi.', 'BETNEX_WALLET_NOT_CONFIGURED');
  const body = buildBetnexLaunchRequest(member, input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(3000, Number(config.rapidApiCasinoTimeoutMs) || 12000));
  try {
      const payload = await betnexDirectRequest('/casino/getgameurl', { body, fetchImpl });
      return normalizeLaunch(payload);
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Betnex direct launch request failed', { error: error?.message || 'fetch-failed' });
    throw new AppError(502, 'Betnex tidak dapat dihubungi.', 'BETNEX_UPSTREAM_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}

function response(status, success, handle, money, message) {
  return { status, body: { success, msg: message, handle, money: Number.isSafeInteger(money) ? money : 0 } };
}
function constantTimeSecretMatch(input, expected) {
  const provided = Buffer.from(String(input ?? ''));
  const stored = Buffer.from(String(expected ?? ''));
  return provided.length > 0 && provided.length === stored.length && timingSafeEqual(provided, stored);
}
function validAmount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export async function processBetnexCallback(payload, { transaction = tx, transfer = postTransfer } = {}) {
  if (!config.betnexRealMoneyEnabled || !config.betnexCallbackKey) {
    return response(200, false, false, 0, 'Betnex wallet callback belum diaktifkan.');
  }
  if (!constantTimeSecretMatch(payload?.api_key, config.betnexCallbackKey)) {
    logger.warn('Betnex callback rejected', { reason: 'invalid-key' });
    return response(200, false, false, 0, 'Callback key tidak valid.');
  }

  const memberAccountCode = clean(payload?.member_account, 32).toLowerCase();
  const serialNumber = clean(payload?.serial_number, 160);
  const gameUid = clean(payload?.game_uid, 100);
  const gameRound = clean(payload?.game_round, 160);
  const currency = clean(payload?.currency_code, 3).toUpperCase();
  const betAmount = payload?.bet_amount;
  const winAmount = payload?.win_amount;
  if (!/^[a-f0-9]{32}$/.test(memberAccountCode) || !serialNumber || !gameUid || !gameRound ||
      !validAmount(betAmount) || !validAmount(winAmount) || currency !== MONEY_CURRENCY) {
    return response(200, false, false, 0, 'Payload callback tidak valid.');
  }

  let resolvedMemberId = null;
  try {
    return await transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${PROVIDER_CODE}:${serialNumber}`]);
      const userResult = await client.query(
        `SELECT id,status FROM users WHERE replace(lower(id::text),'-','')=$1 LIMIT 1`,
        [memberAccountCode]
      );
      const user = userResult.rows[0];
      if (!user || user.status !== 'ACTIVE') return response(200, false, false, 0, 'Akun member tidak ditemukan atau tidak aktif.');
      resolvedMemberId = user.id;
      const account = await memberAccount(client, user.id, true);
      if (account.status !== 'ACTIVE') return response(200, false, false, Number(account.current_balance), 'Akun saldo tidak aktif.');

      const duplicate = await client.query(
        `SELECT member_id FROM casino_callback_events WHERE provider_code=$1 AND serial_number=$2`,
        [PROVIDER_CODE, serialNumber]
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].member_id !== user.id) return response(200, false, false, Number(account.current_balance), 'Serial callback sudah digunakan.');
        return response(200, true, true, Number(account.current_balance), 'Callback duplikat sudah diproses.');
      }

      await client.query(
        `INSERT INTO casino_game_rounds(id,member_id,provider_code,game_uid,game_round,currency_code)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(member_id,provider_code,game_uid,game_round) DO NOTHING`,
        [randomUUID(), user.id, PROVIDER_CODE, gameUid, gameRound, currency]
      );
      const roundResult = await client.query(
        `SELECT id FROM casino_game_rounds WHERE member_id=$1 AND provider_code=$2 AND game_uid=$3 AND game_round=$4 FOR UPDATE`,
        [user.id, PROVIDER_CODE, gameUid, gameRound]
      );
      const round = roundResult.rows[0];
      if (!round) throw new AppError(500, 'Round casino tidak dapat disiapkan.', 'CASINO_ROUND_UNAVAILABLE');

      const sanitizedPayload = { member_account: memberAccountCode, game_uid: gameUid, game_round: gameRound, currency_code: currency, serial_number: serialNumber, bet_amount: betAmount, win_amount: winAmount };
      const eventInsert = await client.query(
        `INSERT INTO casino_callback_events(id,provider_code,serial_number,member_id,game_round_id,bet_amount,win_amount,currency_code,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(provider_code,serial_number) DO NOTHING RETURNING id`,
        [randomUUID(), PROVIDER_CODE, serialNumber, user.id, round.id, betAmount, winAmount, currency, JSON.stringify(sanitizedPayload)]
      );
      if (!eventInsert.rows[0]) {
        const raced = await client.query(`SELECT member_id FROM casino_callback_events WHERE provider_code=$1 AND serial_number=$2`, [PROVIDER_CODE, serialNumber]);
        if (raced.rows[0]?.member_id !== user.id) return response(200, false, false, Number(account.current_balance), 'Serial callback sudah digunakan.');
        return response(200, true, true, Number(account.current_balance), 'Callback duplikat sudah diproses.');
      }

      if (betAmount !== 0) await transfer(client, {
        memberId: user.id, systemCode: SYSTEM_ACCOUNTS.CASINO_HOLD, memberDelta: -betAmount,
        type: 'CASINO_BET', referenceType: 'CASINO_CALLBACK', referenceId: `${serialNumber}:BET`,
        idempotencyKey: `betnex:${serialNumber}:bet`, metadata: { providerCode: PROVIDER_CODE, gameUid, gameRound, serialNumber, amount: betAmount, currency }
      });
      if (winAmount !== 0) await transfer(client, {
        memberId: user.id, systemCode: SYSTEM_ACCOUNTS.CASINO_HOLD, memberDelta: winAmount,
        type: 'CASINO_WIN', referenceType: 'CASINO_CALLBACK', referenceId: `${serialNumber}:WIN`,
        idempotencyKey: `betnex:${serialNumber}:win`, metadata: { providerCode: PROVIDER_CODE, gameUid, gameRound, serialNumber, amount: winAmount, currency }
      });

      await client.query(
        `UPDATE casino_game_rounds SET bet_amount=bet_amount+$1,win_amount=win_amount+$2,updated_at=now() WHERE id=$3`,
        [betAmount, winAmount, round.id]
      );
      const updatedAccount = await memberAccount(client, user.id);
      await client.query(`UPDATE casino_callback_events SET balance_after=$1,processed_at=now() WHERE id=$2`, [Number(updatedAccount.current_balance), eventInsert.rows[0].id]);
      logger.info('Betnex casino callback processed', { memberId: user.id, gameUid, gameRound, serialNumber, betAmount, winAmount, balanceAfter: Number(updatedAccount.current_balance) });
      return response(200, true, true, Number(updatedAccount.current_balance), 'Callback processed successfully.');
    }, { isolation: 'SERIALIZABLE' });
  } catch (error) {
    if (error?.code === 'INSUFFICIENT_BALANCE' && resolvedMemberId) {
      const balance = await query('SELECT current_balance FROM ledger_accounts WHERE owner_user_id=$1', [resolvedMemberId]).catch(() => ({ rows: [] }));
      return response(200, false, false, Number(balance.rows[0]?.current_balance || 0), 'Saldo member tidak mencukupi.');
    }
    logger.error('Betnex casino callback processing failed', { code: error?.code || 'CALLBACK_FAILED', message: error?.message || 'unknown' });
    throw error;
  }
}
