import { createHash, randomUUID } from "node:crypto";
import { query, tx } from "../db.js";
import { AppError, assert } from "../errors.js";
import { memberAccount, postSystemTransfer, postTransfer, SYSTEM_ACCOUNTS } from "../ledger.js";
import { enforceResponsiblePlay } from "../responsible-play.js";
import { audit } from "../audit.js";
import { evaluateOddsFreshness } from "./prematch-freshness-guard.js";

const CHANGE_LOG_LAST_SUCCESS_KEY = "sportsbook:next:changelog:last-success-ms:v1";
const FEED_STATUS_KEY = "sportsbook:next:feed-status:v1";
const SNAPSHOT_KEY = "sportsbook:next:snapshot:v1";
const SOCCER_STATUS_KEY = "sportsbook:soccer-v4:status:v1";
const SOCCER_HEARTBEAT_KEY = "sportsbook:soccer-v4:worker-heartbeat:v1";
const SETTLEMENT_STATUS_KEY = "sportsbook:settlement:status:v1";
const SETTLEMENT_HEARTBEAT_KEY = "sportsbook:settlement:heartbeat:v1";
const CHANGE_LOG_WINDOW_MS = 5 * 60 * 1000;
const PRICE_MAX_AGE_MINUTES = 5;
const KICKOFF_CUTOFF_MINUTES = 5;
const SCHEDULE_MAX_AGE_MINUTES = 60;
const ODDS_SCALE = 1_000_000n;
const MAX_LEGS = 10;
const PROVIDER_PRODUCT = "oddscomparison-prematch-v2";
const SUPPORTED_MARKET_CODE = "SOCCER_1X2_3WAY";
const SUPPORTED_SETTLEMENT_RULE = "SOCCER_1X2_3WAY";

function safeIntegerEnv(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function decimalOddsToMicros(value) {
  const input = String(value ?? "").trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input);
  if (!match) throw new AppError(400, "Format odds tidak valid.", "SPORTSBOOK_ODDS_INVALID");
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] || "").padEnd(6, "0") || "0");
  const micros = whole * ODDS_SCALE + fraction;
  if (micros <= ODDS_SCALE || micros > 1000n * ODDS_SCALE) {
    throw new AppError(400, "Nilai odds di luar batas aman.", "SPORTSBOOK_ODDS_OUT_OF_RANGE");
  }
  return micros;
}

function microsToDecimal(value) {
  const whole = value / ODDS_SCALE;
  const fraction = String(value % ODDS_SCALE).padStart(6, "0");
  return `${whole}.${fraction}`;
}

export function calculateSportsbookBetAmounts(stake, odds, maxPayout) {
  if (!Number.isSafeInteger(stake) || stake <= 0) {
    throw new AppError(400, "Nominal taruhan harus bilangan bulat positif.", "SPORTSBOOK_STAKE_INVALID");
  }
  if (!Array.isArray(odds) || odds.length < 1 || odds.length > MAX_LEGS) {
    throw new AppError(400, "Jumlah pilihan taruhan tidak valid.", "SPORTSBOOK_LEGS_INVALID");
  }
  if (!Number.isSafeInteger(maxPayout) || maxPayout <= 0) {
    throw new AppError(503, "Batas payout sportsbook belum dikonfigurasi.", "SPORTSBOOK_RISK_LIMIT_MISSING");
  }
  const values = odds.map(decimalOddsToMicros);
  const numerator = values.reduce((total, value) => total * value, 1n);
  const divisor = ODDS_SCALE ** BigInt(values.length - 1);
  const totalOddsMicros = numerator / divisor;
  const payout = (BigInt(stake) * totalOddsMicros) / ODDS_SCALE;
  if (payout > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError(400, "Potensi payout melebihi batas numerik.", "SPORTSBOOK_PAYOUT_OVERFLOW");
  }
  const potentialPayout = Number(payout);
  if (potentialPayout > maxPayout) {
    throw new AppError(400, "Potensi payout melebihi batas tiket yang diizinkan.", "SPORTSBOOK_PAYOUT_LIMIT");
  }
  return {
    totalOdds: microsToDecimal(totalOddsMicros),
    potentialPayout,
    oddsMicros: values.map(String)
  };
}

function parseRedisJson(raw, code) {
  if (!raw) throw new AppError(503, "Status feed Sportradar belum tersedia.", code);
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError(503, "Status feed Sportradar tidak valid.", code);
  }
}

export async function getSportsbookBetAcceptanceReadiness({
  redis, env = process.env, now = Date.now(),
  loadMappingCount = async () => {
    const result = await query(`
      SELECT COUNT(*)::int AS count
      FROM sportsbook_v2_provider_market_mappings pm
      JOIN sportsbook_v2_market_catalog catalog
        ON catalog.market_code=pm.market_code AND catalog.enabled=TRUE
      WHERE pm.provider_product='oddscomparison-prematch-v2'
        AND pm.sport_id='sr:sport:1'
        AND pm.period_code='FT'
        AND pm.mapping_status='VERIFIED'
        AND pm.enabled=TRUE
        AND pm.market_code='SOCCER_1X2_3WAY'
        AND catalog.settlement_rule='SOCCER_1X2_3WAY'
    `);
    return Number(result.rows[0]?.count || 0);
  },
  loadScheduleCount = async () => {
    const result = await query(`
      SELECT COUNT(*)::int AS count
      FROM sportsbook_v2_events
      WHERE schedule_verified_at >= now() - ($1::int * interval '1 minute')
    `, [SCHEDULE_MAX_AGE_MINUTES]);
    return Number(result.rows[0]?.count || 0);
  },
  loadRiskReserveBalance = async () => {
    const result = await query(`
      SELECT current_balance::bigint AS balance
      FROM ledger_accounts
      WHERE account_code = 'SYSTEM:SPORTSBOOK_RISK_RESERVE'
    `);
    return result.rows[0] ? Number(result.rows[0].balance) : null;
  }
}) {
  const reasons = [];
  if (String(env.SPORTSBOOK_BET_ACCEPTANCE_ENABLED || "").toLowerCase() !== "true") reasons.push("BET_ACCEPTANCE_DISABLED");
  if (String(env.SPORTRADAR_ODDS_ENABLED || "").toLowerCase() !== "true") reasons.push("ODDS_WORKER_DISABLED");
  if (String(env.SPORTRADAR_CHANGELOG_ENABLED || "").toLowerCase() !== "true") reasons.push("CHANGE_LOG_DISABLED");
  if (String(env.SPORTSBOOK_SETTLEMENT_ENABLED || "").toLowerCase() !== "true") reasons.push("SETTLEMENT_ENGINE_DISABLED");
  if (String(env.SPORTRADAR_ACCESS_LEVEL || "").toLowerCase() !== "production") reasons.push("PRODUCTION_ENTITLEMENT_REQUIRED");
  if (String(env.SPORTRADAR_QUOTA_BASELINE_CONFIRMED || "").toLowerCase() !== "true") reasons.push("QUOTA_BASELINE_UNCONFIRMED");
  if (String(env.SPORTRADAR_SOCCER_ENABLED || "").toLowerCase() !== "true") reasons.push("SOCCER_RESULTS_WORKER_DISABLED");
  const soccerAccessLevel = String(env.SPORTRADAR_SOCCER_ACCESS_LEVEL || env.SPORTRADAR_ACCESS_LEVEL || "").toLowerCase();
  if (soccerAccessLevel !== "production") reasons.push("SOCCER_PRODUCTION_ENTITLEMENT_REQUIRED");
  if (String(env.SPORTRADAR_SOCCER_QUOTA_BASELINE_CONFIRMED || "").toLowerCase() !== "true") reasons.push("SOCCER_QUOTA_BASELINE_UNCONFIRMED");
  const soccerMaxCalls = safeIntegerEnv(env, "SPORTRADAR_SOCCER_MAX_CALLS_PER_30_DAYS");
  const soccerInitialRaw = String(env.SPORTRADAR_SOCCER_INITIAL_30_DAY_USAGE ?? "").trim();
  const soccerInitialUsage = /^\d+$/.test(soccerInitialRaw) ? Number(soccerInitialRaw) : null;
  const soccerPollMinutes = Number(env.SPORTRADAR_SOCCER_POLL_MINUTES ?? 60);
  const soccerMinimumCalls = Number.isInteger(soccerPollMinutes) && soccerPollMinutes >= 60
    ? Math.ceil((30 * 24 * 60) / soccerPollMinutes)
    : Number.POSITIVE_INFINITY;
  if (!soccerMaxCalls || !Number.isSafeInteger(soccerInitialUsage) || soccerInitialUsage < 0 ||
      soccerInitialUsage > soccerMaxCalls || soccerMaxCalls - soccerInitialUsage < soccerMinimumCalls) {
    reasons.push("SOCCER_QUOTA_BUDGET_INSUFFICIENT");
  }

  const maxCalls = safeIntegerEnv(env, "SPORTRADAR_MAX_CALLS_PER_30_DAYS");
  const initialRaw = String(env.SPORTRADAR_INITIAL_30_DAY_USAGE ?? "").trim();
  const initialUsage = /^\d+$/.test(initialRaw) ? Number(initialRaw) : null;
  const pollSeconds = Number(env.SPORTRADAR_CHANGELOG_POLL_SECONDS ?? 240);
  const cycleCalls = safeIntegerEnv(env, "SPORTRADAR_MAX_CALLS_PER_CYCLE");
  const schedulePollMinutes = Number(env.SPORTRADAR_SCHEDULE_POLL_MINUTES ?? 60);
  const marketPollMinutes = Number(env.SPORTSBOOK_POLL_MINUTES ?? 150);
  const daysAhead = Number(env.SPORTRADAR_DAYS_AHEAD ?? 0);
  const sportCount = String(env.SPORTRADAR_SPORT_IDS || "sr:sport:1").split(",").filter(Boolean).length;
  const dateCount = Number.isInteger(daysAhead) && daysAhead >= 0 ? daysAhead + 1 : Number.POSITIVE_INFINITY;
  const cadenceValid = Number.isInteger(schedulePollMinutes) && schedulePollMinutes >= 60 &&
    Number.isInteger(marketPollMinutes) && marketPollMinutes >= 1 && Number.isFinite(dateCount) && sportCount > 0;
  const minimumChangeLogCalls = Number.isInteger(pollSeconds) && pollSeconds >= 60 && pollSeconds <= 300 && cycleCalls
    ? Math.ceil((30 * 24 * 60 * 60) / pollSeconds) + cycleCalls
    : Number.POSITIVE_INFINITY;
  const minimumScheduleCalls = cadenceValid
    ? Math.ceil((30 * 24 * 60) / schedulePollMinutes) * sportCount * dateCount
    : Number.POSITIVE_INFINITY;
  const minimumMarketCalls = cadenceValid
    ? Math.ceil((30 * 24 * 60) / marketPollMinutes) * sportCount * dateCount
    : Number.POSITIVE_INFINITY;
  const minimumDiscoveryCalls = 90;
  const minimumCalls = minimumChangeLogCalls + minimumScheduleCalls + minimumMarketCalls + minimumDiscoveryCalls;
  if (!maxCalls || !Number.isSafeInteger(initialUsage) || initialUsage < 0 ||
      maxCalls - initialUsage < minimumCalls) reasons.push("CHANGE_LOG_QUOTA_BUDGET_INSUFFICIENT");

  if (!safeIntegerEnv(env, "SPORTSBOOK_BET_MAX_STAKE_IDR")) reasons.push("MAX_STAKE_NOT_CONFIGURED");
  if (!safeIntegerEnv(env, "SPORTSBOOK_BET_MAX_PAYOUT_IDR")) reasons.push("MAX_PAYOUT_NOT_CONFIGURED");

  let riskReserveBalance = null;
  const requiredRiskReserve = safeIntegerEnv(env, "SPORTSBOOK_BET_MAX_PAYOUT_IDR");
  try {
    riskReserveBalance = await loadRiskReserveBalance();
    if (!Number.isSafeInteger(riskReserveBalance) || riskReserveBalance < 0 ||
        !requiredRiskReserve || riskReserveBalance < requiredRiskReserve) {
      reasons.push("RISK_RESERVE_BELOW_MAX_SINGLE_TICKET_PAYOUT");
    }
  } catch {
    reasons.push("RISK_RESERVE_ACCOUNT_UNAVAILABLE");
  }

  let verifiedMappingCount = 0;
  try {
    verifiedMappingCount = await loadMappingCount();
    if (!Number.isSafeInteger(verifiedMappingCount) || verifiedMappingCount < 1) {
      reasons.push("NO_VERIFIED_MARKET_MAPPINGS");
    }
  } catch {
    reasons.push("MARKET_MAPPING_SCHEMA_UNAVAILABLE");
  }
  let freshScheduleCount = 0;
  try {
    freshScheduleCount = await loadScheduleCount();
    if (!Number.isSafeInteger(freshScheduleCount) || freshScheduleCount < 1) {
      reasons.push("NO_FRESH_DAILY_SCHEDULES");
    }
  } catch {
    reasons.push("DAILY_SCHEDULES_SCHEMA_UNAVAILABLE");
  }

  let feedStatus = null;
  let snapshot = null;
  let soccerStatus = null;
  let settlementStatus = null;
  let lastSuccessAt = null;
  let soccerHeartbeatAt = null;
  let settlementHeartbeatAt = null;
  try {
    const [
      statusRaw, snapshotRaw, lastSuccessRaw, soccerStatusRaw,
      soccerHeartbeatRaw, settlementStatusRaw, settlementHeartbeatRaw
    ] = await Promise.all([
      redis.get(FEED_STATUS_KEY), redis.get(SNAPSHOT_KEY), redis.get(CHANGE_LOG_LAST_SUCCESS_KEY),
      redis.get(SOCCER_STATUS_KEY), redis.get(SOCCER_HEARTBEAT_KEY),
      redis.get(SETTLEMENT_STATUS_KEY), redis.get(SETTLEMENT_HEARTBEAT_KEY)
    ]);
    feedStatus = parseRedisJson(statusRaw, "SPORTSBOOK_FEED_STATUS_INVALID");
    snapshot = parseRedisJson(snapshotRaw, "SPORTSBOOK_SNAPSHOT_INVALID");
    soccerStatus = parseRedisJson(soccerStatusRaw, "SOCCER_RESULTS_STATUS_INVALID");
    settlementStatus = parseRedisJson(settlementStatusRaw, "SPORTSBOOK_SETTLEMENT_STATUS_INVALID");
    const timestamp = Number(lastSuccessRaw);
    if (Number.isFinite(timestamp) && timestamp > 0) lastSuccessAt = timestamp;
    const soccerTime = Date.parse(String(soccerHeartbeatRaw || ""));
    if (Number.isFinite(soccerTime)) soccerHeartbeatAt = soccerTime;
    const settlementTime = Date.parse(String(settlementHeartbeatRaw || ""));
    if (Number.isFinite(settlementTime)) settlementHeartbeatAt = settlementTime;
  } catch (error) {
    reasons.push(error?.code || "SPORTSBOOK_FEED_STATE_UNAVAILABLE");
  }

  if (feedStatus?.complete !== true || feedStatus?.changeLogPoll !== true ||
      feedStatus?.quotaLimited === true || feedStatus?.errorCount > 0) {
    reasons.push("CHANGE_LOG_FEED_NOT_HEALTHY");
  }
  if (snapshot?.complete !== true || snapshot?.refreshPending !== false) {
    reasons.push("SPORTSBOOK_RECONCILIATION_PENDING");
  }
  if (lastSuccessAt === null || lastSuccessAt > now + 60_000 ||
      now - lastSuccessAt > CHANGE_LOG_WINDOW_MS) {
    reasons.push("CHANGE_LOG_WINDOW_STALE");
  }
  if (soccerStatus?.complete === false || soccerStatus?.code) {
    reasons.push("SOCCER_RESULTS_WORKER_UNHEALTHY");
  }
  const maxSoccerHeartbeatAgeMs = Math.max(3 * soccerPollMinutes * 60_000, 3 * 60 * 60_000);
  if (soccerHeartbeatAt === null || soccerHeartbeatAt > now + 60_000 ||
      now - soccerHeartbeatAt > maxSoccerHeartbeatAgeMs) {
    reasons.push("SOCCER_RESULTS_HEARTBEAT_STALE");
  }
  if (settlementStatus?.healthy !== true) reasons.push("SETTLEMENT_WORKER_UNHEALTHY");
  const settlementPollSeconds = Number(env.SPORTSBOOK_SETTLEMENT_POLL_SECONDS ?? 15);
  const maxSettlementHeartbeatAgeMs = Math.max(10 * settlementPollSeconds * 1000, 5 * 60_000);
  if (settlementHeartbeatAt === null || settlementHeartbeatAt > now + 60_000 ||
      now - settlementHeartbeatAt > maxSettlementHeartbeatAgeMs) {
    reasons.push("SETTLEMENT_HEARTBEAT_STALE");
  }

  return {
    enabled: reasons.length === 0,
    reasons: [...new Set(reasons)],
    verifiedMappingCount,
    freshScheduleCount,
    riskReserveBalance,
    requiredRiskReserveBalance: requiredRiskReserve,
    soccerHeartbeatAt: soccerHeartbeatAt ? new Date(soccerHeartbeatAt).toISOString() : null,
    settlementHeartbeatAt: settlementHeartbeatAt ? new Date(settlementHeartbeatAt).toISOString() : null,
    lastChangeLogSuccessAt: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null,
    maxPriceAgeMs: PRICE_MAX_AGE_MINUTES * 60_000,
    kickoffCutoffMinutes: KICKOFF_CUTOFF_MINUTES
  };
}

export function normalizeSportsbookLegInput(leg) {
  assert(leg && typeof leg === "object", 400, "Pilihan taruhan tidak valid.", "SPORTSBOOK_LEG_INVALID");
  const providerEventId = String(leg.providerEventId || "");
  const providerMarketKey = String(leg.providerMarketKey || "");
  const providerBookId = String(leg.providerBookId || "");
  const providerSelectionKey = String(leg.providerSelectionKey || "");
  assert(/^sr:sport_event:\d+$/.test(providerEventId), 400, "ID pertandingan Sportradar tidak valid.", "SPORTSBOOK_EVENT_ID_INVALID");
  assert(providerMarketKey.length > 0 && providerMarketKey.length <= 512, 400, "Market tidak valid.", "SPORTSBOOK_MARKET_INVALID");
  assert(providerBookId.length > 0 && providerBookId.length <= 128, 400, "Bookmaker tidak valid.", "SPORTSBOOK_BOOK_INVALID");
  assert(providerSelectionKey.length > 0 && providerSelectionKey.length <= 256, 400, "Pilihan odds tidak valid.", "SPORTSBOOK_SELECTION_INVALID");
  const expectedOdds = String(leg.expectedOdds ?? "");
  const expectedOddsMicros = decimalOddsToMicros(expectedOdds);
  return { providerEventId, providerMarketKey, providerBookId, providerSelectionKey, expectedOdds, expectedOddsMicros };
}

function requestFingerprint(stake, legs) {
  const payload = JSON.stringify({
    stake,
    legs: legs.map(leg => ({
      providerEventId: leg.providerEventId,
      providerMarketKey: leg.providerMarketKey,
      providerBookId: leg.providerBookId,
      providerSelectionKey: leg.providerSelectionKey,
      expectedOddsMicros: String(leg.expectedOddsMicros)
    }))
  });
  return createHash("sha256").update(payload).digest("hex");
}

function mapExistingTicket(row, fingerprint) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  assert(metadata.requestFingerprint === fingerprint, 409,
    "Idempotency key sudah digunakan untuk tiket dengan isi berbeda.", "SPORTSBOOK_IDEMPOTENCY_CONFLICT");
  return {
    id: row.id, invoice: row.invoice, stake: Number(row.stake),
    totalOdds: String(row.total_odds), potentialPayout: Number(row.potential_payout),
    status: row.status, ledgerTransactionId: row.ledger_transaction_id,
    balanceBefore: Number(row.balance_before), balanceAfter: Number(row.balance_after),
    duplicate: true
  };
}

async function loadBettablePrice(client, leg, nowMs) {
  const result = await client.query(`
    SELECT e.provider_event_id, e.sport_id, e.scheduled_at, e.event_status, e.schedule_verified_at,
           m.provider_market_key, m.provider_market_id, m.market_name,
           m.is_live, m.is_active AS market_active, m.provider_payload AS market_payload,
           p.provider_book_id, p.provider_book_name, p.provider_selection_key,
           p.outcome_type, p.outcome_name,
           p.odds_decimal::text AS odds_decimal, p.is_active AS price_active,
           p.source_updated_at, p.received_at, p.change_log_verified_at,
           mapped.market_code, mapped.settlement_rule, mapped.mapping_status,
           mapped.mapping_version, mapped.period_code, mapped.outcomes,
           mapped.mapping_count
    FROM sportsbook_v2_events e
    JOIN sportsbook_v2_markets m
      ON m.provider_event_id = e.provider_event_id
    JOIN sportsbook_v2_prices p
      ON p.provider_event_id = m.provider_event_id
     AND p.provider_market_key = m.provider_market_key
    LEFT JOIN LATERAL (
      SELECT pm.market_code, pm.settlement_rule, pm.mapping_status,
             pm.mapping_version, pm.period_code, pm.outcomes,
             COUNT(*) OVER() AS mapping_count
      FROM sportsbook_v2_provider_market_mappings pm
      JOIN sportsbook_v2_market_catalog catalog
        ON catalog.market_code = pm.market_code
       AND catalog.enabled = TRUE
      WHERE pm.provider_product = $5
        AND pm.sport_id = e.sport_id
        AND pm.provider_market_id = m.provider_market_id
        AND pm.provider_market_name = m.market_name
        AND pm.period_code = 'FT'
        AND pm.mapping_status = 'VERIFIED'
        AND pm.enabled = TRUE
        AND COALESCE(pm.provider_definition->>'specifiers', '') =
            COALESCE(m.provider_payload->>'specifiers', '')
    ) mapped ON TRUE
    WHERE e.provider_event_id = $1
      AND m.provider_market_key = $2
      AND p.provider_book_id = $3
      AND p.provider_selection_key = $4
    FOR SHARE OF e, m, p
  `, [
    leg.providerEventId, leg.providerMarketKey, leg.providerBookId,
    leg.providerSelectionKey, PROVIDER_PRODUCT
  ]);
  assert(result.rows.length >= 1, 409,
    "Harga pilihan sudah berubah atau tidak tersedia. Muat ulang odds.", "SPORTSBOOK_PRICE_UNAVAILABLE");
  const row = result.rows[0];
  if (Number(row.mapping_count || 0) > 1 || result.rows.length > 1) {
    throw new AppError(409, "Mapping market ambigu; taruhan ditahan untuk pemeriksaan operator.", "SPORTSBOOK_MARKET_MAPPING_AMBIGUOUS");
  }
  assert(row.market_code && row.mapping_status === "VERIFIED", 409,
    "Market belum memiliki mapping settlement resmi yang diverifikasi.", "SPORTSBOOK_MARKET_UNMAPPED");
  assert(row.market_code === SUPPORTED_MARKET_CODE && row.settlement_rule === SUPPORTED_SETTLEMENT_RULE,
    409, "Market ini belum didukung oleh evaluator settlement aktif.", "SPORTSBOOK_SETTLEMENT_RULE_UNSUPPORTED");
  assert(String(row.sport_id) === "sr:sport:1", 409,
    "Jenis olahraga ini belum diaktifkan untuk taruhan.", "SPORTSBOOK_SPORT_UNSUPPORTED");
  const outcomeMap = row.outcomes && typeof row.outcomes === "object" ? row.outcomes : {};
  const outcomeCode = outcomeMap[String(row.outcome_type || "").toUpperCase()];
  assert(typeof outcomeCode === "string" && ["HOME", "DRAW", "AWAY"].includes(outcomeCode),
    409, "Outcome belum memiliki mapping settlement yang diverifikasi.", "SPORTSBOOK_OUTCOME_UNMAPPED");
  assert(row.market_active === true && row.price_active === true && row.is_live === false,
    409, "Market atau harga sudah ditutup.", "SPORTSBOOK_MARKET_NOT_OPEN");
  const eventStatus = String(row.event_status || "").toLowerCase();
  assert(["not_started", "scheduled"].includes(eventStatus), 409,
    "Status pertandingan tidak mengizinkan taruhan prematch.", "SPORTSBOOK_EVENT_NOT_PREMATCH");
  assert(row.scheduled_at && new Date(row.scheduled_at).getTime() > nowMs, 409,
    "Jadwal pertandingan sudah dimulai atau tidak valid.", "SPORTSBOOK_EVENT_STARTED");
  assert(row.change_log_verified_at, 409,
    "Harga belum dikonfirmasi oleh Change Log Sportradar.", "SPORTSBOOK_PRICE_NOT_CHANGELOG_VERIFIED");
  const scheduleVerifiedAt = Date.parse(String(row.schedule_verified_at || ""));
  assert(Number.isFinite(scheduleVerifiedAt) &&
    nowMs - scheduleVerifiedAt <= SCHEDULE_MAX_AGE_MINUTES * 60_000,
    409, "Jadwal pertandingan belum diverifikasi dari Daily Schedules terbaru.", "SPORTSBOOK_SCHEDULE_NOT_VERIFIED");
  assert(row.received_at, 409,
    "Waktu penerimaan harga tidak tersedia.", "SPORTSBOOK_PRICE_RECEIPT_TIME_MISSING");

  const storedOddsMicros = decimalOddsToMicros(row.odds_decimal);
  assert(storedOddsMicros === leg.expectedOddsMicros, 409,
    "Harga odds berubah. Periksa harga terbaru sebelum mengirim tiket.", "SPORTSBOOK_PRICE_CHANGED");
  const priceCheck = evaluateOddsFreshness({
    snapshot: {
      capturedAt: row.change_log_verified_at,
      marketStatus: "open",
      eventStartsAt: row.scheduled_at,
      price: Number(row.odds_decimal)
    },
    clientPrice: Number(leg.expectedOdds),
    now: nowMs,
    config: { maxAgeMinutes: PRICE_MAX_AGE_MINUTES, cutoffBeforeKickoffMinutes: KICKOFF_CUTOFF_MINUTES }
  });
  assert(priceCheck.ok, 409, priceCheck.reason, `SPORTSBOOK_${priceCheck.code}`);

  return { row, outcomeCode, odds: row.odds_decimal };
}

export async function createSportsbookTicket(session, input, { redis, env = process.env, ip = "" } = {}) {
  const readiness = await getSportsbookBetAcceptanceReadiness({ redis, env });
  if (!readiness.enabled) {
    throw new AppError(503, "Penerimaan taruhan sportsbook belum siap atau sedang dihentikan demi keamanan.", "SPORTSBOOK_BET_ACCEPTANCE_NOT_READY", readiness);
  }

  const maxStake = safeIntegerEnv(env, "SPORTSBOOK_BET_MAX_STAKE_IDR");
  const maxPayout = safeIntegerEnv(env, "SPORTSBOOK_BET_MAX_PAYOUT_IDR");
  const stake = input?.stake;
  assert(Number.isSafeInteger(stake) && stake > 0, 400, "Nominal taruhan tidak valid.", "SPORTSBOOK_STAKE_INVALID");
  assert(stake <= maxStake, 400, "Nominal taruhan melebihi batas maksimum.", "SPORTSBOOK_STAKE_LIMIT");
  const idempotencyKey = String(input?.idempotencyKey || "").trim();
  assert(/^[A-Za-z0-9:_-]{8,128}$/.test(idempotencyKey), 400,
    "Idempotency key wajib unik dan valid.", "SPORTSBOOK_IDEMPOTENCY_KEY_INVALID");
  assert(Array.isArray(input?.legs) && input.legs.length >= 1 && input.legs.length <= MAX_LEGS,
    400, "Jumlah pilihan taruhan tidak valid.", "SPORTSBOOK_LEGS_INVALID");
  const legs = input.legs.map(normalizeSportsbookLegInput);
  const eventIds = legs.map(leg => leg.providerEventId);
  assert(new Set(eventIds).size === eventIds.length, 400,
    "Satu tiket tidak boleh memuat dua pilihan dari pertandingan yang sama.", "SPORTSBOOK_DUPLICATE_EVENT");
  const fingerprint = requestFingerprint(stake, legs);
  const ticketId = randomUUID();
  const invoice = `SB-${Date.now()}-${ticketId.slice(0, 8).toUpperCase()}`;

  return tx(async client => {
    const existing = await client.query(`
      SELECT id,invoice,stake,total_odds,potential_payout,status,ledger_transaction_id,
             balance_before,balance_after,metadata
      FROM sportsbook_v2_tickets
      WHERE member_id = $1 AND idempotency_key = $2
      FOR UPDATE
    `, [session.userId, idempotencyKey]);
    if (existing.rows[0]) return mapExistingTicket(existing.rows[0], fingerprint);

    const account = await memberAccount(client, session.userId, true);
    const dbTime = await client.query("SELECT (EXTRACT(EPOCH FROM now()) * 1000)::bigint AS now_ms");
    const nowMs = Number(dbTime.rows[0].now_ms);
    const resolved = [];
    for (const leg of legs) resolved.push(await loadBettablePrice(client, leg, nowMs));

    const amounts = calculateSportsbookBetAmounts(stake, resolved.map(item => item.odds), maxPayout);
    const metadata = {
      requestFingerprint: fingerprint,
      provider: PROVIDER_PRODUCT,
      priceVerifiedBy: "sportradar-prematch-change-log",
      acceptedIp: String(ip || "").slice(0, 64),
      acceptedLegCount: resolved.length
    };
    const inserted = await client.query(`
      INSERT INTO sportsbook_v2_tickets(
        id,invoice,member_id,stake,total_odds,potential_payout,status,idempotency_key,
        balance_before,balance_after,metadata
      ) VALUES($1,$2,$3,$4,$5,$6,'OPEN',$7,$8,$8,$9::jsonb)
      ON CONFLICT(member_id,idempotency_key) DO NOTHING
      RETURNING id
    `, [
      ticketId, invoice, session.userId, stake, amounts.totalOdds,
      amounts.potentialPayout, idempotencyKey, Number(account.current_balance), JSON.stringify(metadata)
    ]);
    if (!inserted.rowCount) {
      const duplicate = await client.query(`
        SELECT id,invoice,stake,total_odds,potential_payout,status,ledger_transaction_id,
               balance_before,balance_after,metadata
        FROM sportsbook_v2_tickets
        WHERE member_id = $1 AND idempotency_key = $2
        FOR UPDATE
      `, [session.userId, idempotencyKey]);
      assert(duplicate.rows[0], 409, "Idempotency collision; ulangi dengan key baru.", "SPORTSBOOK_IDEMPOTENCY_CONFLICT");
      return mapExistingTicket(duplicate.rows[0], fingerprint);
    }

    await enforceResponsiblePlay(session.userId, {
      kind: "BET", amount: stake, client, sessionCreatedAt: session.createdAt
    });

    for (let index = 0; index < resolved.length; index += 1) {
      const { row, outcomeCode } = resolved[index];
      await client.query(`
        INSERT INTO sportsbook_v2_ticket_legs(
          id,ticket_id,leg_no,provider_event_id,provider_market_key,provider_market_id,
          provider_market_name,provider_book_id,provider_book_name,provider_selection_key,
          provider_outcome_name,provider_outcome_type,accepted_odds,source_updated_at,
          price_received_at,market_code,outcome_code,settlement_rule,mapping_version
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      `, [
        randomUUID(), ticketId, index + 1, row.provider_event_id, row.provider_market_key,
        row.provider_market_id, row.market_name, row.provider_book_id, row.provider_book_name,
        row.provider_selection_key, row.outcome_name, row.outcome_type,
        row.odds_decimal, row.source_updated_at, row.received_at, row.market_code,
        outcomeCode, row.settlement_rule, row.mapping_version
      ]);
    }

    const ledger = await postTransfer(client, {
      memberId: session.userId,
      systemCode: SYSTEM_ACCOUNTS.SPORTSBOOK_HOLD,
      memberDelta: -stake,
      type: "SPORTSBOOK_BET_PLACED",
      referenceType: "SPORTSBOOK_TICKET",
      referenceId: ticketId,
      idempotencyKey: `sportsbook:ticket:${ticketId}:placed`,
      metadata: { invoice, stake, totalOdds: amounts.totalOdds, potentialPayout: amounts.potentialPayout },
      actorId: session.userId
    });
    assert(ledger.duplicate !== true && ledger.transactionId, 500,
      "Ledger mendeteksi transaksi duplikat yang tidak diharapkan.", "SPORTSBOOK_LEDGER_IDEMPOTENCY_CONFLICT");

    // Stake is held from the member; the additional potential profit is reserved
    // from a separately funded risk account before the ticket can be accepted.
    const profitReserve = amounts.potentialPayout - stake;
    if (profitReserve > 0) {
      let reserve;
      try {
        reserve = await postSystemTransfer(client, {
          fromCode: SYSTEM_ACCOUNTS.SPORTSBOOK_RISK_RESERVE,
          toCode: SYSTEM_ACCOUNTS.SPORTSBOOK_HOLD,
          amount: profitReserve,
          type: "SPORTSBOOK_PAYOUT_RESERVE",
          referenceType: "SPORTSBOOK_TICKET",
          referenceId: ticketId,
          idempotencyKey: `sportsbook:ticket:${ticketId}:reserve`,
          metadata: { invoice, stake, potentialPayout: amounts.potentialPayout, profitReserve },
          actorId: session.userId,
          requireFromAvailable: true
        });
      } catch (error) {
        if (error?.code === "SYSTEM_ACCOUNT_INSUFFICIENT") {
          throw new AppError(503, "Cadangan risiko sportsbook tidak mencukupi. Tiket tidak diterima dan saldo tidak dipotong.", "SPORTSBOOK_RISK_RESERVE_INSUFFICIENT");
        }
        throw error;
      }
      assert(reserve.duplicate !== true && reserve.transactionId, 500,
        "Dana risk reserve tidak berhasil dikunci.", "SPORTSBOOK_RISK_RESERVE_FAILED");
    }

    const ticketUpdate = await client.query(`
      UPDATE sportsbook_v2_tickets
      SET ledger_transaction_id=$1,balance_before=$2,balance_after=$3
      WHERE id=$4 AND status='OPEN'
      RETURNING id
    `, [ledger.transactionId, ledger.before, ledger.after, ticketId]);
    assert(ticketUpdate.rowCount === 1, 500,
      "Status tiket berubah saat transaksi diterima.", "SPORTSBOOK_TICKET_STATE_CONFLICT");
    await audit({
      actorId: session.userId, actorRole: "MEMBER", action: "SPORTSBOOK_BET_ACCEPTED",
      targetType: "SPORTSBOOK_TICKET", targetId: ticketId,
      details: { invoice, stake, totalOdds: amounts.totalOdds, potentialPayout: amounts.potentialPayout, legs: resolved.length },
      ip, client
    });

    return {
      id: ticketId, invoice, stake, totalOdds: amounts.totalOdds,
      potentialPayout: amounts.potentialPayout, status: "OPEN",
      ledgerTransactionId: ledger.transactionId,
      balanceBefore: ledger.before, balanceAfter: ledger.after, duplicate: false
    };
  });
}

export const __sportsbookBetting = {
  CHANGE_LOG_LAST_SUCCESS_KEY, FEED_STATUS_KEY, SNAPSHOT_KEY,
  SOCCER_STATUS_KEY, SOCCER_HEARTBEAT_KEY,
  SETTLEMENT_STATUS_KEY, SETTLEMENT_HEARTBEAT_KEY,
  CHANGE_LOG_WINDOW_MS, SCHEDULE_MAX_AGE_MINUTES, ODDS_SCALE, MAX_LEGS, PROVIDER_PRODUCT
};


export async function listMemberSportsbookTickets(memberId, { limit = 20, offset = 0 } = {}) {
  const safeLimit = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 20;
  const safeOffset = Number.isInteger(offset) ? Math.max(0, offset) : 0;
  const result = await query(`
    SELECT t.id,t.invoice,t.stake,t.total_odds::text AS total_odds,
           t.potential_payout,t.status,t.accepted_at,t.settled_at,
           t.review_required,t.review_reason,
           COALESCE(jsonb_agg(jsonb_build_object(
             'eventId',l.provider_event_id,
             'home',e.home_name,
             'away',e.away_name,
             'scheduledAt',e.scheduled_at,
             'market',l.provider_market_name,
             'bookmaker',l.provider_book_name,
             'selection',l.provider_outcome_name,
             'outcomeType',l.provider_outcome_type,
             'acceptedOdds',l.accepted_odds::text,
             'resultStatus',l.result_status
           ) ORDER BY l.leg_no) FILTER (WHERE l.id IS NOT NULL),'[]'::jsonb) AS legs
    FROM sportsbook_v2_tickets t
    LEFT JOIN sportsbook_v2_ticket_legs l ON l.ticket_id=t.id
    LEFT JOIN sportsbook_v2_events e ON e.provider_event_id=l.provider_event_id
    WHERE t.member_id=$1
    GROUP BY t.id
    ORDER BY t.accepted_at DESC
    LIMIT $2 OFFSET $3
  `, [memberId, safeLimit, safeOffset]);
  return { tickets: result.rows, limit: safeLimit, offset: safeOffset };
}
