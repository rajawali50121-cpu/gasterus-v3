import { createHash, randomUUID } from "node:crypto";
import { query, tx } from "../db.js";
import { AppError, assert } from "../errors.js";
import { memberAccount, postSystemTransfer, postTransfer, SYSTEM_ACCOUNTS } from "../ledger.js";
import { enforceResponsiblePlay } from "../responsible-play.js";
import { audit } from "../audit.js";
import { evaluateOddsFreshness, FRESHNESS_CODES } from "./prematch-freshness-guard.js";
import { SportradarClient } from "./sportradar-client.js";
import { loadSportsbookConfig } from "./config.js";
import { normalizeEventMarkets } from "./normalize.js";
import { reserveSportradarCall, waitForSportradarRequestSlot, applySportradarRateLimitCooldown } from "./quota.js";

const FEED_STATUS_KEY = "sportsbook:next:feed-status:v1";
const SNAPSHOT_KEY = "sportsbook:next:snapshot:v1";
const SOCCER_STATUS_KEY = "sportsbook:soccer-v4:status:v1";
const SOCCER_HEARTBEAT_KEY = "sportsbook:soccer-v4:worker-heartbeat:v1";
const SETTLEMENT_STATUS_KEY = "sportsbook:settlement:status:v1";
const SETTLEMENT_HEARTBEAT_KEY = "sportsbook:settlement:heartbeat:v1";
const KICKOFF_CUTOFF_MINUTES = 5;
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
  if (String(env.SPORTSBOOK_PROVIDER_REVALIDATION_ENABLED || "").toLowerCase() !== "true") {
    reasons.push("PROVIDER_PRICE_REVALIDATION_DISABLED");
  }
  if (String(env.SPORTSBOOK_PROVIDER_REVALIDATION_ENABLED || "").toLowerCase() === "true" &&
      !String(env.SPORTRADAR_API_KEY || "").trim()) {
    reasons.push("PROVIDER_API_KEY_MISSING");
  }
  if (String(env.SPORTSBOOK_BET_ACCEPTANCE_ENABLED || "").toLowerCase() !== "true") reasons.push("BET_ACCEPTANCE_DISABLED");
  if (String(env.SPORTRADAR_ODDS_ENABLED || "").toLowerCase() !== "true") reasons.push("ODDS_WORKER_DISABLED");
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
  const soccerLookbackDays = Number(env.SPORTRADAR_SOCCER_MAX_LOOKBACK_DAYS ?? 2);
  const soccerMinimumCalls = Number.isInteger(soccerPollMinutes) && soccerPollMinutes === 60 &&
    Number.isInteger(soccerLookbackDays) && soccerLookbackDays >= 1 && soccerLookbackDays <= 14
    ? Math.ceil((30 * 24 * 60) / soccerPollMinutes) + (30 * soccerLookbackDays)
    : Number.POSITIVE_INFINITY;
  if (!soccerMaxCalls || !Number.isSafeInteger(soccerInitialUsage) || soccerInitialUsage < 0 ||
      soccerInitialUsage > soccerMaxCalls || soccerMaxCalls - soccerInitialUsage < soccerMinimumCalls) {
    reasons.push("SOCCER_QUOTA_BUDGET_INSUFFICIENT");
  }

  const maxCalls = safeIntegerEnv(env, "SPORTRADAR_MAX_CALLS_PER_30_DAYS");
  const initialRaw = String(env.SPORTRADAR_INITIAL_30_DAY_USAGE ?? "").trim();
  const initialUsage = /^\d+$/.test(initialRaw) ? Number(initialRaw) : null;
  const marketPollMinutes = Number(env.SPORTSBOOK_POLL_MINUTES ?? 150);
  const daysAhead = Number(env.SPORTRADAR_DAYS_AHEAD ?? 0);
  const sportCount = String(env.SPORTRADAR_SPORT_IDS || "sr:sport:1").split(",").map(value => value.trim()).filter(Boolean).length;
  const targetEvents = Number(env.SPORTRADAR_TARGET_EVENTS ?? 50);
  const marketPageSize = Number(env.SPORTRADAR_MARKET_PAGE_SIZE ?? 50);
  const dateCount = Number.isInteger(daysAhead) && daysAhead >= 0 ? daysAhead + 1 : Number.POSITIVE_INFINITY;
  const marketCadenceValid = Number.isInteger(marketPollMinutes) && marketPollMinutes >= 1 &&
    Number.isFinite(dateCount) && sportCount > 0 &&
    Number.isSafeInteger(targetEvents) && targetEvents > 0 &&
    Number.isSafeInteger(marketPageSize) && marketPageSize > 0;
  const marketPagesPerCycle = marketCadenceValid ? Math.ceil(targetEvents / marketPageSize) : Number.POSITIVE_INFINITY;
  const minimumMarketCalls = marketCadenceValid
    ? Math.ceil((30 * 24 * 60) / marketPollMinutes) * marketPagesPerCycle * sportCount * dateCount
    : Number.POSITIVE_INFINITY;
  const minimumCalls = minimumMarketCalls + 90;
  const betRevalidationBudget = safeIntegerEnv(env, "SPORTSBOOK_PROVIDER_REVALIDATION_MAX_CALLS_PER_30_DAYS");
  if (!maxCalls || !Number.isSafeInteger(initialUsage) || initialUsage < 0 ||
      maxCalls - initialUsage < minimumCalls) reasons.push("ODDS_COMPARISON_QUOTA_BUDGET_INSUFFICIENT");
  if (String(env.SPORTSBOOK_PROVIDER_REVALIDATION_ENABLED || "").toLowerCase() === "true" &&
      (!betRevalidationBudget || !maxCalls || !Number.isSafeInteger(initialUsage) ||
       maxCalls - initialUsage < minimumCalls + betRevalidationBudget)) {
    reasons.push("PROVIDER_REVALIDATION_QUOTA_BUDGET_INSUFFICIENT");
  }

  if (!safeIntegerEnv(env, "SPORTSBOOK_PROVIDER_MAX_AGE_SECONDS")) reasons.push("PROVIDER_TIMESTAMP_MAX_AGE_NOT_CONFIGURED");
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
  let feedStatus = null;
  let snapshot = null;
  let soccerStatus = null;
  let settlementStatus = null;
  let soccerHeartbeatAt = null;
  let settlementHeartbeatAt = null;
  try {
    const [
      statusRaw, snapshotRaw, soccerStatusRaw,
      soccerHeartbeatRaw, settlementStatusRaw, settlementHeartbeatRaw
    ] = await Promise.all([
      redis.get(FEED_STATUS_KEY), redis.get(SNAPSHOT_KEY),
      redis.get(SOCCER_STATUS_KEY), redis.get(SOCCER_HEARTBEAT_KEY),
      redis.get(SETTLEMENT_STATUS_KEY), redis.get(SETTLEMENT_HEARTBEAT_KEY)
    ]);
    feedStatus = parseRedisJson(statusRaw, "SPORTSBOOK_FEED_STATUS_INVALID");
    snapshot = parseRedisJson(snapshotRaw, "SPORTSBOOK_SNAPSHOT_INVALID");
    soccerStatus = parseRedisJson(soccerStatusRaw, "SOCCER_RESULTS_STATUS_INVALID");
    settlementStatus = parseRedisJson(settlementStatusRaw, "SPORTSBOOK_SETTLEMENT_STATUS_INVALID");
    const soccerTime = Date.parse(String(soccerHeartbeatRaw || ""));
    if (Number.isFinite(soccerTime)) soccerHeartbeatAt = soccerTime;
    const settlementTime = Date.parse(String(settlementHeartbeatRaw || ""));
    if (Number.isFinite(settlementTime)) settlementHeartbeatAt = settlementTime;
  } catch (error) {
    reasons.push(error?.code || "SPORTSBOOK_FEED_STATE_UNAVAILABLE");
  }

  if (feedStatus?.complete !== true || feedStatus?.quotaLimited === true || feedStatus?.errorCount > 0) {
    reasons.push("SPORTSBOOK_FEED_NOT_HEALTHY");
  }
  if (snapshot?.complete !== true) reasons.push("SPORTSBOOK_SNAPSHOT_INCOMPLETE");
  if (soccerStatus?.complete === false || soccerStatus?.code || soccerStatus?.pagination?.complete === false) {
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
    riskReserveBalance,
    requiredRiskReserveBalance: requiredRiskReserve,
    soccerHeartbeatAt: soccerHeartbeatAt ? new Date(soccerHeartbeatAt).toISOString() : null,
    settlementHeartbeatAt: settlementHeartbeatAt ? new Date(settlementHeartbeatAt).toISOString() : null,
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

export function evaluateStoredBetPriceFreshness({ receivedAt, scheduledAt, odds, expectedOdds, marketActive, priceActive, isLive, scheduleConfirmed, replacedBy, nowMs, maxAgeSeconds }) {
  const invalid = (code, reason) => ({ ok: false, code, reason });
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    return invalid("SPORTSBOOK_PRICE_STALE", "Batas umur harga wajib dikonfigurasi.");
  }
  if (scheduleConfirmed !== true) {
    return invalid("SPORTSBOOK_SCHEDULE_UNCONFIRMED", "Jadwal belum dikonfirmasi oleh Sportradar.");
  }
  if (typeof replacedBy === "string" && replacedBy) {
    return invalid("SPORTSBOOK_EVENT_REPLACED", "Pertandingan telah digantikan oleh event provider lain.");
  }
  const capturedAt = Date.parse(String(receivedAt || ""));
  const startsAt = Date.parse(String(scheduledAt || ""));
  if (!Number.isFinite(capturedAt) || !Number.isFinite(startsAt) || !Number.isFinite(nowMs)) {
    return invalid("SPORTSBOOK_PRICE_STALE", "Timestamp harga atau jadwal tidak valid.");
  }
  const result = evaluateOddsFreshness({
    snapshot: {
      capturedAt,
      eventStartsAt: startsAt,
      marketStatus: marketActive === true && priceActive === true && isLive === false ? "open" : "removed",
      price: Number(odds)
    },
    clientPrice: Number(expectedOdds),
    now: nowMs,
    config: { maxAgeMinutes: maxAgeSeconds / 60, cutoffBeforeKickoffMinutes: KICKOFF_CUTOFF_MINUTES }
  });
  if (result.ok) return result;
  if (result.code === FRESHNESS_CODES.STALE_SNAPSHOT) {
    return invalid("SPORTSBOOK_PRICE_STALE", "Harga odds sudah kedaluwarsa. Muat ulang odds terbaru.");
  }
  if (result.code === FRESHNESS_CODES.EVENT_NEAR_KICKOFF || result.code === FRESHNESS_CODES.EVENT_STARTED) {
    return invalid("SPORTSBOOK_KICKOFF_CUTOFF", result.reason);
  }
  if (result.code === FRESHNESS_CODES.PRICE_CHANGED) {
    return invalid("SPORTSBOOK_PRICE_CHANGED", result.reason);
  }
  return invalid("SPORTSBOOK_PRICE_STALE", result.reason);
}

async function loadBettablePrice(client, leg, nowMs, env) {
  const result = await client.query(`
    SELECT e.provider_event_id, e.sport_id, e.scheduled_at, e.event_status,
           COALESCE((e.provider_payload->>'startTimeConfirmed')::boolean,FALSE) AS start_time_confirmed,
           NULLIF(e.provider_payload->>'replacedBy','') AS replaced_by,
           m.provider_market_key, m.provider_market_id, m.market_name,
           m.is_live, m.is_active AS market_active, m.provider_payload AS market_payload,
           p.provider_book_id, p.provider_book_name, p.provider_selection_key,
           p.outcome_type, p.outcome_name,
           p.odds_decimal::text AS odds_decimal, p.is_active AS price_active,
           p.source_updated_at, p.received_at,
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
  // The stored snapshot is a lookup/mapping reference only. Its ingestion
  // age must not reject a ticket when the exact selection is revalidated
  // against the live provider immediately afterwards.
  assert(row.start_time_confirmed === true, 409,
    "Jadwal belum dikonfirmasi oleh Sportradar.", "SPORTSBOOK_SCHEDULE_UNCONFIRMED");
  assert(!row.replaced_by, 409,
    "Pertandingan telah digantikan oleh event provider lain.", "SPORTSBOOK_EVENT_REPLACED");

  const storedOddsMicros = decimalOddsToMicros(row.odds_decimal);
  assert(storedOddsMicros === leg.expectedOddsMicros, 409,
    "Harga odds berubah. Periksa harga terbaru sebelum mengirim tiket.", "SPORTSBOOK_PRICE_CHANGED");


  return { row, outcomeCode, odds: row.odds_decimal };
}

export function verifyProviderBetPrice(providerPayload, leg, storedRow, nowMs = Date.now(), maxProviderAgeSeconds = 300) {
  let normalized;
  try {
    normalized = normalizeEventMarkets(providerPayload, new Date(nowMs).toISOString());
  } catch {
    throw new AppError(503, "Respons revalidasi Sportradar tidak valid.", "SPORTSBOOK_PROVIDER_RESPONSE_INVALID");
  }
  const providerGeneratedAtMs = Date.parse(String(normalized.providerGeneratedAt || ""));
  if (!Number.isSafeInteger(maxProviderAgeSeconds) || maxProviderAgeSeconds < 1 ||
      !Number.isFinite(providerGeneratedAtMs) ||
      providerGeneratedAtMs > nowMs + 60_000 ||
      nowMs - providerGeneratedAtMs > maxProviderAgeSeconds * 1000) {
    throw new AppError(503, "Timestamp data Sportradar tidak valid atau sudah kedaluwarsa.", "SPORTSBOOK_PROVIDER_DATA_STALE");
  }
  const event = normalized.event;
  assert(event.id === leg.providerEventId, 503,
    "Sportradar mengembalikan pertandingan yang berbeda.", "SPORTSBOOK_PROVIDER_EVENT_MISMATCH");
  assert(event.startTimeConfirmed === true, 409,
    "Jadwal pertandingan belum dikonfirmasi Sportradar.", "SPORTSBOOK_SCHEDULE_UNCONFIRMED");
  assert(!event.replacedBy, 409,
    "Pertandingan telah digantikan oleh event Sportradar lain.", "SPORTSBOOK_EVENT_REPLACED");
  assert(String(event.status || "").toLowerCase() === "not_started", 409,
    "Status pertandingan dari Sportradar tidak mengizinkan taruhan prematch.", "SPORTSBOOK_EVENT_NOT_PREMATCH");
  const providerStart = Date.parse(String(event.scheduled || ""));
  const storedStart = new Date(storedRow.scheduled_at).getTime();
  assert(Number.isFinite(providerStart) && providerStart === storedStart, 409,
    "Jadwal pertandingan berubah di Sportradar. Muat ulang pilihan.", "SPORTSBOOK_PROVIDER_SCHEDULE_CHANGED");
  assert(providerStart - nowMs > KICKOFF_CUTOFF_MINUTES * 60_000, 409,
    "Taruhan ditutup lima menit sebelum kick-off.", "SPORTSBOOK_KICKOFF_CUTOFF");

  const market = normalized.markets.find(item => item.key === leg.providerMarketKey);
  assert(market && market.id === storedRow.provider_market_id && market.live === false, 409,
    "Market tidak tersedia atau sudah live menurut Sportradar.", "SPORTSBOOK_PROVIDER_MARKET_CLOSED");
  const book = market.books.find(item => item.id === leg.providerBookId && item.removed !== true);
  assert(book, 409, "Bookmaker sudah tidak menyediakan market ini.", "SPORTSBOOK_PROVIDER_BOOK_REMOVED");
  const outcome = book.outcomes.find(item => item.selectionKey === leg.providerSelectionKey && item.removed !== true);
  assert(outcome && Number.isFinite(outcome.oddsDecimal) && outcome.oddsDecimal > 1, 409,
    "Outcome sudah tidak tersedia di Sportradar.", "SPORTSBOOK_PROVIDER_OUTCOME_REMOVED");
  const providerOddsMicros = decimalOddsToMicros(String(outcome.oddsDecimal));
  assert(providerOddsMicros === leg.expectedOddsMicros, 409,
    "Harga odds berubah di Sportradar. Periksa harga terbaru sebelum mengirim tiket.", "SPORTSBOOK_PRICE_CHANGED");
  const storedOddsMicros = decimalOddsToMicros(storedRow.odds_decimal);
  assert(providerOddsMicros === storedOddsMicros, 409,
    "Harga Sportradar tidak cocok dengan snapshot sportsbook.", "SPORTSBOOK_PROVIDER_SNAPSHOT_MISMATCH");
  return {
    odds: String(outcome.oddsDecimal),
    providerGeneratedAt: normalized.providerGeneratedAt,
    verifiedAt: new Date(nowMs).toISOString()
  };
}

function createTicketProviderClient(redis, env) {
  let config;
  try {
    config = loadSportsbookConfig(env);
  } catch (error) {
    throw new AppError(503, "Konfigurasi koneksi atau kuota Sportradar tidak lengkap.", "SPORTSBOOK_PROVIDER_CONFIG_INVALID");
  }
  return new SportradarClient(config, {
    beforeRequest: async () => {
      await waitForSportradarRequestSlot(redis);
      await reserveSportradarCall(redis, config, Date.now(), { purpose: "bet" });
    },
    onRateLimit: ({ retryAfter }) => applySportradarRateLimitCooldown(redis, retryAfter)
  });
}

async function revalidateBetPriceWithProvider(providerClient, leg, storedRow, nowMs, env) {
  let result;
  try {
    result = await providerClient.getSportEventMarkets(leg.providerEventId, { live: false });
  } catch (error) {
    const code = error?.code === "SPORTRADAR_RATE_LIMITED" ? "SPORTSBOOK_PROVIDER_RATE_LIMITED"
      : ["SPORTRADAR_30_DAY_QUOTA_EXHAUSTED", "SPORTRADAR_BET_REVALIDATION_BUDGET_EXHAUSTED"].includes(error?.code) ? "SPORTSBOOK_PROVIDER_QUOTA_EXHAUSTED"
        : error?.code === "SPORTRADAR_HOURLY_QUOTA_EXHAUSTED" ? "SPORTSBOOK_PROVIDER_QUOTA_EXHAUSTED"
          : "SPORTSBOOK_PROVIDER_UNAVAILABLE";
    throw new AppError(503, "Tidak dapat memverifikasi harga langsung ke Sportradar. Taruhan ditolak.", code);
  }
  return verifyProviderBetPrice(result.body, leg, storedRow, Date.now(), safeIntegerEnv(env, "SPORTSBOOK_PROVIDER_MAX_AGE_SECONDS"));
}

export async function createSportsbookTicket(session, input, { redis, env = process.env, ip = "", providerClient = null } = {}) {
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
  const prior = await query(`
    SELECT id,invoice,stake,total_odds,potential_payout,status,ledger_transaction_id,
           balance_before,balance_after,metadata
    FROM sportsbook_v2_tickets
    WHERE member_id = $1 AND idempotency_key = $2
  `, [session.userId, idempotencyKey]);
  if (prior.rows[0]) return mapExistingTicket(prior.rows[0], fingerprint);

  // Read the exact stored selection, then verify it directly against Sportradar
  // before opening the financial transaction. Provider latency never holds DB locks.
  const dbClock = await query("SELECT (EXTRACT(EPOCH FROM now()) * 1000)::bigint AS now_ms");
  const preflightNowMs = Number(dbClock.rows[0].now_ms);
  const preflight = [];
  for (const leg of legs) preflight.push(await loadBettablePrice(query, leg, preflightNowMs, env));
  const liveClient = providerClient || createTicketProviderClient(redis, env);
  const providerChecks = [];
  for (let index = 0; index < legs.length; index += 1) {
    providerChecks.push(await revalidateBetPriceWithProvider(liveClient, legs[index], preflight[index].row, Date.now(), env));
  }

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
    for (let index = 0; index < legs.length; index += 1) {
      const current = await loadBettablePrice(client, legs[index], nowMs, env);
      const before = preflight[index].row;
      assert(current.row.odds_decimal === before.odds_decimal &&
        new Date(current.row.scheduled_at).getTime() === new Date(before.scheduled_at).getTime() &&
        current.row.event_status === before.event_status &&
        current.row.start_time_confirmed === before.start_time_confirmed &&
        current.row.replaced_by === before.replaced_by &&
        current.row.market_active === before.market_active &&
        current.row.price_active === before.price_active &&
        current.row.is_live === before.is_live &&
        current.row.provider_market_key === before.provider_market_key &&
        current.row.provider_market_id === before.provider_market_id &&
        current.row.provider_book_id === before.provider_book_id &&
        current.row.provider_selection_key === before.provider_selection_key &&
        current.outcomeCode === preflight[index].outcomeCode &&
        current.row.mapping_version === before.mapping_version,
      409, "Snapshot atau mapping berubah selama verifikasi provider. Kirim ulang tiket dengan odds terbaru.", "SPORTSBOOK_PROVIDER_SNAPSHOT_CHANGED");
      assert(decimalOddsToMicros(providerChecks[index].odds) === decimalOddsToMicros(current.odds), 409,
        "Harga provider tidak cocok dengan snapshot saat tiket diproses.", "SPORTSBOOK_PROVIDER_SNAPSHOT_MISMATCH");
      resolved.push(current);
    }

    const amounts = calculateSportsbookBetAmounts(stake, resolved.map(item => item.odds), maxPayout);
    const metadata = {
      requestFingerprint: fingerprint,
      provider: PROVIDER_PRODUCT,
      priceVerifiedBy: "sportradar-synchronous-sport-event-markets",
      providerVerifiedAt: providerChecks.map(check => check.verifiedAt),
      providerGeneratedAt: providerChecks.map(check => check.providerGeneratedAt),
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
  FEED_STATUS_KEY, SNAPSHOT_KEY,
  SOCCER_STATUS_KEY, SOCCER_HEARTBEAT_KEY,
  SETTLEMENT_STATUS_KEY, SETTLEMENT_HEARTBEAT_KEY,
  ODDS_SCALE, MAX_LEGS, PROVIDER_PRODUCT, KICKOFF_CUTOFF_MINUTES
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
