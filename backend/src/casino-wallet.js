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
const FRACTIONAL_CALLBACK_POLICY = String(process.env.BETNEX_CALLBACK_FRACTIONAL_POLICY || 'reject').trim().toLowerCase();
const clean = (value, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function betnexWalletStatus() {
  const realMoneyReady = Boolean(config.betnexApiKey && config.betnexCallbackKey);
  const launchMode = config.betnexRealMoneyEnabled
    ? (realMoneyReady ? 'REAL' : 'REAL_NOT_CONFIGURED')
    : 'DEMO';
  return {
    launchMode,
    realMoneyEnabled: launchMode === 'REAL',
    protocolVerified: config.betnexProtocolVerified,
    directApiConfigured: Boolean(config.betnexApiKey),
    callbackKeyConfigured: Boolean(config.betnexCallbackKey),
    callbackPath: '/api/member/casino/callback',
    currency: MONEY_CURRENCY
  };
}

export function buildBetnexLaunchRequest(member, input = {}, balance) {
  const gameId = clean(input.gameId, 80);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(gameId)) throw new AppError(400, 'Game tidak valid.', 'CASINO_GAME_INVALID');
  const memberId = String(member?.id || '').replace(/-/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(memberId)) throw new AppError(400, 'Sesi member tidak valid.', 'CASINO_MEMBER_INVALID');
  if (!Number.isSafeInteger(balance) || balance < 0) throw new AppError(409, 'Saldo member tidak valid untuk sesi game.', 'CASINO_BALANCE_INVALID');
  const platform = Number(input.platform || 1);
  if (![1, 2].includes(platform)) throw new AppError(400, 'Platform tidak valid.', 'CASINO_PLATFORM_INVALID');
  return {
    username: memberId,
    gameId,
    money: balance,
    lang: 'en',
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
  const minimumTimeout = path === '/casino/getgameurl' ? 10000 : 3000;
  const timeout = setTimeout(() => controller.abort(), Math.max(minimumTimeout, Number(config.rapidApiCasinoTimeoutMs) || 12000));
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

export function buildBetnexDemoLaunchRequest(member, input = {}) {
  const gameId = clean(input.gameId, 80);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(gameId)) throw new AppError(400, 'Game tidak valid.', 'CASINO_GAME_INVALID');
  const memberId = String(member?.id || '').replace(/-/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(memberId)) throw new AppError(400, 'Sesi member tidak valid.', 'CASINO_MEMBER_INVALID');
  const platform = Number(input.platform || 1);
  if (![1, 2].includes(platform)) throw new AppError(400, 'Platform tidak valid.', 'CASINO_PLATFORM_INVALID');
  const currency = clean(config.betnexDemoCurrency || 'INR', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new AppError(500, 'Mata uang demo Betnex tidak valid.', 'BETNEX_DEMO_CURRENCY_INVALID');
  // Test environment explicitly rejects the money field, including money: 0.
  return { username: memberId, gameId, lang: 'en', home_url: 'https://gasterus.fun', platform, currency };
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

function normalizeLaunch(payload, mode = 'REAL') {
  if (payload?.success === false || payload?.code !== 0) {
    throw new AppError(502, clean(payload?.message || payload?.msg, 180) || 'Betnex menolak sesi game.', 'BETNEX_LAUNCH_REJECTED');
  }
  const gameUrl = clean(payload?.payload?.game_launch_url || payload?.game_launch_url, 2000);
  let parsed;
  try { parsed = new URL(gameUrl); } catch {}
  if (!parsed || parsed.protocol !== 'https:') throw new AppError(502, 'Betnex tidak mengembalikan URL game HTTPS yang valid.', 'BETNEX_LAUNCH_URL_INVALID');
  const expiresIn = Number(payload?.payload?.expires_in || payload?.expires_in);
  return { gameUrl: parsed.toString(), mode, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 60 };
}

export async function launchBetnexDemoGame(member, input = {}, fetchImpl = fetch) {
  if (!config.betnexDemoEnabled) throw new AppError(503, 'Mode demo Betnex belum diaktifkan.', 'BETNEX_DEMO_DISABLED');
  if (config.betnexRealMoneyEnabled) throw new AppError(409, 'Mode demo Betnex tidak dapat berjalan bersamaan dengan saldo nyata.', 'BETNEX_DEMO_REAL_MODE_CONFLICT');
  const body = buildBetnexDemoLaunchRequest(member, input);
  const payload = await betnexDirectRequest('/casino/getgameurl', { body, fetchImpl });
  return normalizeLaunch(payload, 'DEMO');
}

export async function launchBetnexGame(member, input = {}, fetchImpl = fetch, { transaction = tx } = {}) {
  if (!config.betnexRealMoneyEnabled) throw new AppError(503, 'Mode saldo nyata casino belum diaktifkan.', 'BETNEX_REAL_MONEY_DISABLED');
  if (!config.betnexApiKey || !config.betnexCallbackKey) throw new AppError(503, 'Kredensial Betnex atau callback belum dikonfigurasi.', 'BETNEX_WALLET_NOT_CONFIGURED');
  const account = await transaction(client => memberAccount(client, member?.id));
  if (account.status !== 'ACTIVE') throw new AppError(409, 'Akun saldo tidak aktif.', 'LEDGER_ACCOUNT_INACTIVE');
  const body = buildBetnexLaunchRequest(member, input, Number(account.current_balance));
  try {
    const payload = await betnexDirectRequest('/casino/getgameurl', { body, fetchImpl });
    return normalizeLaunch(payload, 'REAL');
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Betnex direct launch request failed', { error: error?.message || 'fetch-failed' });
    throw new AppError(502, 'Betnex tidak dapat dihubungi.', 'BETNEX_UPSTREAM_UNAVAILABLE');
  }
}

function response(status, success, handle, money, message) {
  return { status, body: { success, msg: message, handle, money: Number.isSafeInteger(money) ? money : 0 } };
}
function redactCallbackPayload(value) {
  if (Array.isArray(value)) return value.map(redactCallbackPayload);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, /api[_-]?key|secret|token/i.test(key) ? '[REDACTED]' : redactCallbackPayload(item)]
    ));
  }
  return value;
}
async function insertBetnexCallbackLog(record) {
  await query(
    `INSERT INTO casino_callback_logs
      (id,provider_code,received_at,http_status,outcome,request_payload,response_payload,retain_until)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
    [
      randomUUID(),
      PROVIDER_CODE,
      record.receivedAt,
      record.httpStatus,
      record.outcome,
      JSON.stringify(record.requestPayload),
      JSON.stringify(record.responsePayload),
      record.retainUntil
    ]
  );
}
export function recordBetnexCallbackLog(payload, result, { insert = insertBetnexCallbackLog } = {}) {
  const receivedAt = new Date();
  const responsePayload = result?.body ?? result ?? {};
  const record = {
    receivedAt,
    httpStatus: Number.isInteger(result?.status) ? result.status : 200,
    outcome: responsePayload?.handle === true
      ? (/duplikat/i.test(String(responsePayload?.msg || '')) ? 'DUPLICATE' : 'SUCCESS')
      : 'FAILURE',
    requestPayload: redactCallbackPayload(payload ?? {}),
    responsePayload: redactCallbackPayload(responsePayload),
    retainUntil: new Date(receivedAt.getTime() + 90 * 24 * 60 * 60 * 1000)
  };
  void Promise.resolve().then(() => insert(record)).catch(error => {
    logger.error('Betnex callback audit log insert failed', { code: error?.code || 'CALLBACK_LOG_FAILED' });
  });
}
function constantTimeSecretMatch(input, expected) {
  const provided = Buffer.from(String(input ?? ''));
  const stored = Buffer.from(String(expected ?? ''));
  return provided.length > 0 && provided.length === stored.length && timingSafeEqual(provided, stored);
}
function validAmount(value) {
  return typeof value === 'number' && Number.isFinite(value);
}
function validLedgerAmount(value) {
  return Number.isSafeInteger(value);
}
function duplicateCallbackResponse(currentBalance) {
  return response(200, true, true, currentBalance, 'Callback duplikat sudah diproses.');
}
async function knownMemberBalance(memberAccountCode, transaction) {
  if (!/^[a-f0-9]{32}$/.test(memberAccountCode)) return 0;
  try {
    return await transaction(async client => {
      const { rows } = await client.query(
        `SELECT id,status FROM users WHERE replace(lower(id::text),'-','')=$1 LIMIT 1`,
        [memberAccountCode]
      );
      if (!rows[0]) return 0;
      const account = await memberAccount(client, rows[0].id);
      return Number(account.current_balance) || 0;
    });
  } catch (error) {
    logger.error('Betnex callback balance lookup failed', { code: error?.code || 'CALLBACK_FAILED' });
    return 0;
  }
}

async function processBetnexCallbackCore(payload, { transaction = tx, transfer = postTransfer, providerCode = PROVIDER_CODE } = {}) {
  if (!config.betnexRealMoneyEnabled || !config.betnexCallbackKey) {
    return response(200, false, false, 0, 'Betnex wallet callback belum diaktifkan.');
  }
  if (providerCode !== PROVIDER_CODE) {
    logger.warn('Betnex callback rejected', { reason: 'unknown-provider' });
    return response(200, false, false, 0, 'Provider casino tidak dikenal.');
  }
  const memberAccountCode = clean(payload?.member_account, 32).toLowerCase();
  if (!constantTimeSecretMatch(payload?.api_key, config.betnexCallbackKey)) {
    logger.warn('Betnex callback rejected', { reason: 'invalid-key' });
    return response(200, false, false, await knownMemberBalance(memberAccountCode, transaction), 'Callback key tidak valid.');
  }

  const serialNumber = clean(payload?.serial_number, 160);
  const gameUid = clean(payload?.game_uid, 100);
  const gameRound = clean(payload?.game_round, 160);
  const currency = clean(payload?.currency_code, 3).toUpperCase();
  const betAmount = payload?.bet_amount;
  const winAmount = payload?.win_amount;
  const netAmount = winAmount - betAmount;
  if (!validAmount(betAmount) || !validAmount(winAmount) ||
      !validLedgerAmount(netAmount) || !validLedgerAmount(betAmount) || !validLedgerAmount(winAmount)) {
    const policy = FRACTIONAL_CALLBACK_POLICY === 'warn' ? 'warn' : 'reject';
    logger[policy === 'warn' ? 'warn' : 'error']('Betnex callback rejected: fractional or out-of-range amount', { policy });
    // TODO (menunggu keputusan Betnex): confirm callback amount precision and ledger unit before enabling any fractional conversion.
    return response(200, false, false, await knownMemberBalance(memberAccountCode, transaction), 'Nominal callback tidak valid.');
  }
  if (!/^[a-f0-9]{32}$/.test(memberAccountCode) || !serialNumber || !gameUid || !gameRound) {
    return response(200, false, false, await knownMemberBalance(memberAccountCode, transaction), 'Payload callback tidak valid.');
  }
  if (currency !== MONEY_CURRENCY) {
    return response(200, false, false, await knownMemberBalance(memberAccountCode, transaction), 'Mata uang callback tidak valid.');
  }

  let resolvedMemberId = null;
  let resolvedBalance = 0;
  try {
    return await transaction(async client => {
      await client.query("SET LOCAL lock_timeout = '3500ms'");
      await client.query("SET LOCAL statement_timeout = '4000ms'");
      const callbackKey = `${memberAccountCode}:${gameUid}:${gameRound}:${serialNumber}`;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [callbackKey]);
      const userResult = await client.query(
        `SELECT id,status FROM users WHERE replace(lower(id::text),'-','')=$1 LIMIT 1`,
        [memberAccountCode]
      );
      const user = userResult.rows[0];
      if (!user) return response(200, false, false, 0, 'Akun member tidak ditemukan atau tidak aktif.');
      resolvedMemberId = user.id;
      const account = await memberAccount(client, user.id, true);
      resolvedBalance = Number(account.current_balance);
      if (user.status !== 'ACTIVE') return response(200, false, false, resolvedBalance, 'Akun member tidak ditemukan atau tidak aktif.');
      if (account.status !== 'ACTIVE') return response(200, false, false, resolvedBalance, 'Akun saldo tidak aktif.');
      if (!Number.isSafeInteger(resolvedBalance + netAmount)) {
        return response(200, false, false, resolvedBalance, 'Nominal callback tidak valid.');
      }

      await client.query(
        `INSERT INTO casino_game_rounds(id,member_id,provider_code,game_uid,game_round,currency_code,game_mapping_status)
         VALUES($1,$2,$3,$4,$5,$6,'UNMAPPED') ON CONFLICT(member_id,provider_code,game_uid,game_round) DO NOTHING`,
        [randomUUID(), user.id, PROVIDER_CODE, gameUid, gameRound, currency]
      );
      const roundResult = await client.query(
        `SELECT id FROM casino_game_rounds WHERE member_id=$1 AND provider_code=$2 AND game_uid=$3 AND game_round=$4 FOR UPDATE`,
        [user.id, PROVIDER_CODE, gameUid, gameRound]
      );
      const round = roundResult.rows[0];
      if (!round) throw new AppError(500, 'Round casino tidak dapat disiapkan.', 'CASINO_ROUND_UNAVAILABLE');

      const duplicate = await client.query(
        `SELECT id FROM casino_callback_events
         WHERE member_id=$1 AND game_uid=$2 AND game_round=$3 AND serial_number=$4`,
        [user.id, gameUid, gameRound, serialNumber]
      );
      if (duplicate.rows[0]) return duplicateCallbackResponse(Number(account.current_balance));

      const sanitizedPayload = { member_account: memberAccountCode, game_uid: gameUid, game_round: gameRound, currency_code: currency, serial_number: serialNumber, bet_amount: betAmount, win_amount: winAmount };
      const eventInsert = await client.query(
        `INSERT INTO casino_callback_events(id,provider_code,serial_number,member_id,game_round_id,game_uid,game_round,bet_amount,win_amount,currency_code,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
        [randomUUID(), PROVIDER_CODE, serialNumber, user.id, round.id, gameUid, gameRound, betAmount, winAmount, currency, JSON.stringify(sanitizedPayload)]
      );
      if (!eventInsert.rows[0]) {
        const raced = await client.query(
          `SELECT id FROM casino_callback_events WHERE member_id=$1 AND game_uid=$2 AND game_round=$3 AND serial_number=$4`,
          [user.id, gameUid, gameRound, serialNumber]
        );
        if (!raced.rows[0]) throw new AppError(500, 'Hasil callback duplikat tidak tersedia.', 'CASINO_CALLBACK_RESULT_MISSING');
        return duplicateCallbackResponse(Number(account.current_balance));
      }

      if (netAmount !== 0) await transfer(client, {
        memberId: user.id, systemCode: SYSTEM_ACCOUNTS.CASINO_HOLD, memberDelta: netAmount,
        type: 'CASINO_ADJUSTMENT', referenceType: 'CASINO_CALLBACK',
        referenceId: `${memberAccountCode}:${gameUid}:${gameRound}:${serialNumber}`,
        idempotencyKey: `betnex:${memberAccountCode}:${gameUid}:${gameRound}:${serialNumber}`,
        metadata: { providerCode: PROVIDER_CODE, gameUid, gameRound, serialNumber, betAmount, winAmount, currency }
      });

      await client.query(
        `UPDATE casino_game_rounds
         SET bet_amount=bet_amount+$1,win_amount=win_amount+$2,
             processed_serials=array_append(processed_serials,$3),updated_at=now()
         WHERE id=$4`,
        [betAmount, winAmount, serialNumber, round.id]
      );
      const updatedAccount = await memberAccount(client, user.id);
      await client.query(`UPDATE casino_callback_events SET balance_after=$1,processed_at=now() WHERE id=$2`, [Number(updatedAccount.current_balance), eventInsert.rows[0].id]);
      logger.info('Betnex casino callback processed', { memberId: user.id, gameUid, gameRound, serialNumber, betAmount, winAmount, balanceAfter: Number(updatedAccount.current_balance) });
      return response(200, true, true, Number(updatedAccount.current_balance), 'Callback processed successfully.');
    });
  } catch (error) {
    if (error?.code === 'INSUFFICIENT_BALANCE' && resolvedMemberId) {
      // TODO (menunggu keputusan Betnex/bisnis): confirm the exact failure msg and money value.
      return response(200, false, false, resolvedBalance, 'Saldo member tidak mencukupi.');
    }
    logger.error('Betnex casino callback processing failed', { code: error?.code || 'CALLBACK_FAILED' });
    return response(200, false, false, resolvedBalance, 'Callback belum dapat diproses.');
  }
}

export async function processBetnexCallback(payload, options = {}) {
  const { callbackLogInsert = insertBetnexCallbackLog, ...coreOptions } = options;
  let result;
  try {
    result = await processBetnexCallbackCore(payload, coreOptions);
  } catch (error) {
    logger.error('Betnex callback processing failed', { code: error?.code || 'CALLBACK_FAILED' });
    result = response(200, false, false, 0, 'Callback belum dapat diproses.');
  }
  recordBetnexCallbackLog(payload, result, { insert: callbackLogInsert });
  return result;
}
