import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { connectRedis, redis, closeRedis } from './redis.js';
import { tx, closeDatabase, query } from './db.js';
import { logger } from './logger.js';
import { postSystemTransfer, postTransfer, SYSTEM_ACCOUNTS, verifyLedger } from './ledger.js';
import { createMemberNotification } from './notifications.js';
import { autoSettleSportsbookTickets } from './sportsbook-auto-settlement.js';
import { autoSettleTotoPeriods } from './toto-auto-settlement.js';
import { retryPendingSportsbookSettlementCorrections } from './sportsbook-betting.js';
import { LOTTERY_WIN_PROBABILITY, calculateLotteryPricing, evaluateLotterySelection, legacyGameCode } from './lottery-games.js';
import { expireStaleWalletApprovals } from './money.js';
import { startMemoryGuard } from './memory-guard.js';

const processingQueue = `${config.queueName}:processing`;
const lockKey = job => `lock:settlement:${job.marketId}:${job.period}`;
async function heartbeat() {
  const ttl = Math.max(config.workerHeartbeatMaxAgeSeconds * 2, 60);
  await redis.set(config.workerHeartbeatKey, new Date().toISOString(), { EX: ttl });
}

let heartbeatTimer = null;
let heartbeatWriteInFlight = false;
function startHeartbeatLoop() {
  if (heartbeatTimer) return;
  const intervalMs = Math.max(5000, Math.min(30000, Math.floor((config.workerHeartbeatMaxAgeSeconds * 1000) / 3)));
  heartbeatTimer = setInterval(async () => {
    if (heartbeatWriteInFlight || !redis.isOpen) return;
    heartbeatWriteInFlight = true;
    try { await heartbeat(); }
    catch (error) { logger.warn('Settlement worker heartbeat refresh unavailable', { error: error.message }); }
    finally { heartbeatWriteInFlight = false; }
  }, intervalMs);
  heartbeatTimer.unref();
}
function stopHeartbeatLoop() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function acquire(key) {
  const token = randomUUID();
  const ok = await redis.set(key, token, { NX: true, PX: config.lockTtlMs });
  return ok ? token : null;
}

async function release(key, token) {
  await redis.eval(
    `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`,
    { keys: [key], arguments: [token] }
  );
}


const outboxMarkerKey = outboxId => `${config.queueName}:outbox:${outboxId}`;

async function enqueueOutboxPayload(queueName, outboxId, payload) {
  await redis.eval(
    `redis.call('LPUSH',KEYS[1],ARGV[1]); redis.call('SET',KEYS[2],'1'); return 1`,
    { keys: [queueName, outboxMarkerKey(outboxId)], arguments: [payload] }
  );
}

async function dispatchOutbox() {
  const claimed = await tx(async client => {
    const { rows } = await client.query(`
      SELECT * FROM job_outbox
      WHERE status='PENDING' AND available_at<=now()
      ORDER BY created_at
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    `);
    for (const row of rows) {
      await client.query(
        `UPDATE job_outbox
         SET status='PROCESSING',attempts=attempts+1,available_at=now()+interval '60 seconds'
         WHERE id=$1`,
        [row.id]
      );
    }
    return rows;
  });

  for (const row of claimed) {
    try {
      const payload = JSON.stringify({ ...row.payload, outboxId: row.id });
      await enqueueOutboxPayload(row.queue_name, row.id, payload);
      await query(
        `UPDATE job_outbox SET status='DISPATCHED',dispatched_at=now(),last_error=NULL WHERE id=$1`,
        [row.id]
      );
    } catch (error) {
      await query(
        `UPDATE job_outbox
         SET last_error=$1,
             available_at=now()+interval '30 seconds',
             status=CASE WHEN attempts>=10 THEN 'FAILED' ELSE 'PENDING' END
         WHERE id=$2`,
        [String(error.message).slice(0, 500), row.id]
      ).catch(() => {});
    }
  }
  return claimed.length;
}

async function recoverProcessingQueue() {
  let recovered = 0;
  while (true) {
    const payload = await redis.sendCommand(['RPOPLPUSH', processingQueue, config.queueName]);
    if (!payload) break;
    recovered += 1;
  }
  if (recovered) logger.warn('Recovered unfinished queue jobs', { recovered });
}

async function recoverLostDispatchedOutbox() {
  const staleProcessing = await query(`
    SELECT id,queue_name,payload,attempts
    FROM job_outbox
    WHERE status='PROCESSING' AND available_at<=now()
    ORDER BY available_at
    LIMIT 100
  `);
  let recoveredProcessing = 0;
  for (const row of staleProcessing.rows) {
    const markerExists = Number(await redis.sendCommand(['EXISTS', outboxMarkerKey(row.id)])) > 0;
    if (markerExists) {
      const result = await query(
        `UPDATE job_outbox SET status='DISPATCHED',dispatched_at=COALESCE(dispatched_at,now()),last_error=NULL
         WHERE id=$1 AND status='PROCESSING'`,
        [row.id]
      );
      recoveredProcessing += result.rowCount;
    } else {
      const result = await query(
        `UPDATE job_outbox
         SET status=CASE WHEN attempts>=10 THEN 'FAILED' ELSE 'PENDING' END,
             available_at=now(),last_error='Recovered stale PROCESSING outbox claim'
         WHERE id=$1 AND status='PROCESSING'`,
        [row.id]
      );
      recoveredProcessing += result.rowCount;
    }
  }

  const { rows } = await query(`
    SELECT o.id,o.queue_name,o.payload
    FROM job_outbox o
    JOIN settlement_runs r ON r.id=(o.payload->>'runId')::uuid
    WHERE o.status='DISPATCHED'
      AND r.status='QUEUED'
      AND o.dispatched_at IS NOT NULL
      AND o.dispatched_at < now()-interval '30 seconds'
    ORDER BY o.dispatched_at
    LIMIT 100
  `);
  let recoveredDispatched = 0;
  for (const row of rows) {
    const markerExists = Number(await redis.sendCommand(['EXISTS', outboxMarkerKey(row.id)])) > 0;
    if (markerExists) continue;
    const result = await query(
      `UPDATE job_outbox
       SET status='PENDING',available_at=now(),dispatched_at=NULL,last_error='Recovered after Redis queue loss'
       WHERE id=$1 AND status='DISPATCHED'`,
      [row.id]
    );
    recoveredDispatched += result.rowCount;
  }
  const recovered = recoveredProcessing + recoveredDispatched;
  if (recovered) logger.warn('Recovered durable outbox state', { recoveredProcessing, recoveredDispatched });
  return recovered;
}

async function reserveJob(timeoutSeconds = 5) {
  return redis.sendCommand([
    'BRPOPLPUSH',
    config.queueName,
    processingQueue,
    String(timeoutSeconds)
  ]);
}

async function removeProcessingPayload(payload) {
  await redis.sendCommand(['LREM', processingQueue, '1', payload]);
}

async function acknowledgeJob(payload, job) {
  await removeProcessingPayload(payload);
  if (job?.outboxId) await redis.del(outboxMarkerKey(job.outboxId));
}

async function requeueJob(payload) {
  await removeProcessingPayload(payload);
  await redis.lPush(config.queueName, payload);
}

async function processJob(job) {
  const key = lockKey(job);
  const token = await acquire(key);
  if (!token) {
    logger.warn('Settlement lock busy', { job });
    return 'retry';
  }

  try {
    await tx(async client => {
      const run = (
        await client.query('SELECT * FROM settlement_runs WHERE id=$1 FOR UPDATE', [job.runId])
      ).rows[0];

      if (!run || run.status === 'SUCCESS') return;
      if (run.status === 'RUNNING') {
        throw new Error('Settlement run is already marked RUNNING and requires operator review.');
      }

      await client.query(
        `UPDATE settlement_runs SET status='RUNNING',started_at=now() WHERE id=$1`,
        [run.id]
      );

      const orders = (
        await client.query(
          `SELECT * FROM bet_orders
           WHERE market_id=$1 AND period=$2 AND wallet_mode='CASH' AND status='ACCEPTED'
           ORDER BY created_at
           FOR UPDATE`,
          [run.market_id, run.period]
        )
      ).rows;

      let winners = 0;
      let totalPayout = 0;

      for (const order of orders) {
        if (run.mode === 'VOID') {
          const ledger = await postTransfer(client, {
            memberId: order.member_id,
            systemCode: SYSTEM_ACCOUNTS.BET_HOLD,
            memberDelta: Number(order.total_stake),
            type: 'BET_VOID_REFUND',
            referenceType: 'BET_ORDER',
            referenceId: order.id,
            idempotencyKey: `void:${run.id}:${order.id}`,
            metadata: { runId: run.id },
            actorId: run.approved_by
          });
          await client.query(
            `UPDATE bet_orders
             SET status='VOID',balance_after=$1,settled_at=now(),updated_at=now()
             WHERE id=$2`,
            [ledger.after, order.id]
          );
          continue;
        }

        await postSystemTransfer(client, {
          fromCode: SYSTEM_ACCOUNTS.BET_HOLD,
          toCode: SYSTEM_ACCOUNTS.PRIZE_POOL,
          amount: Number(order.total_stake),
          type: 'BET_STAKE_SETTLED',
          referenceType: 'BET_ORDER',
          referenceId: order.id,
          idempotencyKey: `stake-settle:${run.id}:${order.id}`,
          metadata: { runId: run.id },
          actorId: run.approved_by
        });

        const items = (
          await client.query(
            'SELECT * FROM bet_items WHERE order_id=$1 ORDER BY line_no FOR UPDATE',
            [order.id]
          )
        ).rows;

        let payout = 0;
        for (const item of items) {
          const evaluation = evaluateLotterySelection(item.game_code || legacyGameCode(item.bet_type), item.selection_value || item.number_value, run.result_value);
          const won = evaluation.won;
          const itemPayout = won
            ? calculateLotteryPricing(Number(item.amount),Number(item.discount_percent),Number(item.payout_multiplier),Number(evaluation.factor || 1)).potentialPayout
            : 0;
          payout += itemPayout;
          await client.query(
            `UPDATE bet_items SET result_match=$1,payout_amount=$2 WHERE id=$3`,
            [won, itemPayout, item.id]
          );
        }

        let balanceAfter = order.balance_after;
        if (payout > 0) {
          const ledger = await postTransfer(client, {
            memberId: order.member_id,
            systemCode: SYSTEM_ACCOUNTS.PRIZE_POOL,
            memberDelta: payout,
            type: 'BET_PAYOUT',
            referenceType: 'BET_ORDER',
            referenceId: order.id,
            idempotencyKey: `payout:${run.id}:${order.id}`,
            metadata: { runId: run.id, result: run.result_value },
            actorId: run.approved_by
          });
          balanceAfter = ledger.after;
          winners += 1;
          totalPayout += payout;
          await createMemberNotification(client, {
            memberId: order.member_id,
            type: 'TOGEL_WIN',
            title: 'Selamat, Betting Togel Menang!',
            message: `Tiket ${order.invoice} pada ${order.market_name} menang. Saldo kemenangan IDR ${payout.toLocaleString('id-ID')} telah otomatis ditambahkan.`,
            amount: payout,
            referenceType: 'BET_ORDER',
            referenceId: order.id,
            actionUrl: 'bet-history.html?game=togel&status=won',
            priority: 'HIGH',
            metadata: { invoice: order.invoice, marketName: order.market_name, result: run.result_value, balanceAfter }
          });
        }

        await client.query(
          `UPDATE bet_orders
           SET status=$1,total_payout=$2,balance_after=$3,result_value=$4,
               settled_at=now(),updated_at=now()
           WHERE id=$5`,
          [
            payout > 0 ? 'SETTLED_WON' : 'SETTLED_LOST',
            payout,
            balanceAfter,
            run.result_value,
            order.id
          ]
        );
      }

      // Result authority is immutable from the settlement path. The approval request was
      // already bound to OFFICIAL:/CONSENSUS: history and rechecked before this job was queued.
      // Settlement may consume that result, but must never rewrite markets/result provenance.

      // Audit untung-rugi riil per game untuk pasar + periode ini. Idempoten lewat
      // UNIQUE (market_id, period, game_code), jadi run yang diulang menimpa baris
      // yang sama dan tidak pernah menambah dobel.
      const { rows: perGame } = await client.query(
        `SELECT i.game_code,
                COUNT(*)::int AS line_count,
                COALESCE(SUM(i.stake_after_discount),0)::bigint AS stake,
                COALESCE(SUM(i.payout_amount),0)::bigint AS payout,
                MAX(i.payout_multiplier) AS multiplier
         FROM bet_items i
         JOIN bet_orders o ON o.id=i.order_id
         WHERE o.market_id=$1 AND o.period=$2 AND o.status IN('SETTLED_WON','SETTLED_LOST')
         GROUP BY i.game_code`,
        [run.market_id, run.period]
      );
      for (const row of perGame) {
        const stake = Number(row.stake) || 0;
        const payout = Number(row.payout) || 0;
        const multiplier = Number(row.multiplier) || 0;
        const probability = LOTTERY_WIN_PROBABILITY.get(row.game_code) ?? null;
        const realizedEv = stake > 0 ? payout / stake : 0;
        const theoreticalEv = probability !== null && multiplier > 0 ? probability * multiplier : null;
        // Anomali: EV riil di atas 1,00 (bayar lebih besar dari peluang jp), atau
        // jauh meleset dari EV teori pada sampel yang cukup besar.
        const anomaly = realizedEv > 1 || (theoreticalEv !== null && stake >= 1000000 && realizedEv > theoreticalEv * 2);
        await client.query(
          `INSERT INTO game_settlement_audit
             (run_id,market_id,period,game_code,line_count,total_stake,total_payout,realized_ev,theoretical_ev,anomaly)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (market_id,period,game_code) DO UPDATE SET
             run_id=EXCLUDED.run_id,
             line_count=EXCLUDED.line_count,
             total_stake=EXCLUDED.total_stake,
             total_payout=EXCLUDED.total_payout,
             realized_ev=EXCLUDED.realized_ev,
             theoretical_ev=EXCLUDED.theoretical_ev,
             anomaly=EXCLUDED.anomaly,
             recorded_at=now()`,
          [run.id, run.market_id, run.period, row.game_code, row.line_count, stake, payout, realizedEv, theoreticalEv, anomaly]
        );
      }

      const integrity = await verifyLedger(client);
      if (!integrity.balanced) {
        throw new Error(`Ledger integrity failed: ${JSON.stringify(integrity)}`);
      }

      await client.query(
        `UPDATE settlement_runs
         SET status='SUCCESS',processed_orders=$1,winning_orders=$2,
             total_payout=$3,finished_at=now()
         WHERE id=$4`,
        [orders.length, winners, totalPayout, run.id]
      );
      await client.query(
        `UPDATE approval_requests
         SET status='EXECUTED',executed_at=now(),updated_at=now()
         WHERE id=$1`,
        [run.approval_id]
      );
      await client.query(
        `INSERT INTO audit_logs(
           id,actor_id,actor_role,action,target_type,target_id,details
         ) VALUES($1,$2,'SUPERVISOR',$3,'SETTLEMENT_RUN',$4,$5::jsonb)`,
        [
          randomUUID(),
          run.approved_by,
          run.mode === 'VOID' ? 'VOID_EXECUTED' : 'SETTLEMENT_EXECUTED',
          run.id,
          JSON.stringify({
            marketId: run.market_id,
            period: run.period,
            processed: orders.length,
            winners,
            totalPayout
          })
        ]
      );
    }, { isolation: 'SERIALIZABLE' });

    logger.info('Settlement job completed', { runId: job.runId, mode: job.mode });
    return 'success';
  } catch (error) {
    logger.error('Settlement job failed', { runId: job.runId, error: error.message });
    await query(
      `UPDATE settlement_runs
       SET status='FAILED',error_message=$1,finished_at=now()
       WHERE id=$2 AND status<>'SUCCESS'`,
      [String(error.message).slice(0, 1000), job.runId]
    ).catch(() => {});
    await query(
      `UPDATE approval_requests
       SET status='FAILED',reason=$1,updated_at=now()
       WHERE id=$2 AND status<>'EXECUTED'`,
      [String(error.message).slice(0, 500), job.approvalId]
    ).catch(() => {});
    return 'failed';
  } finally {
    await release(key, token).catch(() => {});
  }
}

async function main() {
  await connectRedis();
  await recoverProcessingQueue();
  await recoverLostDispatchedOutbox();
  await heartbeat();
  startHeartbeatLoop();
  startMemoryGuard({ label: 'worker' });
  logger.info('Settlement worker ready', {
    queue: config.queueName,
    processingQueue
  });
  logger.info('Sportsbook auto-settlement scheduler initialized', {
    enabled: config.sportsbookAutoSettlementEnabled,
    seconds: config.sportsbookAutoSettlementSeconds
  });

  let lastSportsbookSettlement = 0;
  let lastTotoSettlement = 0;
  let lastMoneyCleanup = 0;
  let lastDurableQueueRecovery = 0;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  while (true) {
    try {
      await heartbeat();
    } catch (error) {
      // Transient Redis outage must not kill the scheduler loop. The dedicated
      // heartbeat timer keeps liveness updated between successful writes.
      logger.warn('Settlement worker heartbeat cycle unavailable', { error: error.message });
    }
    if(Date.now()-lastDurableQueueRecovery>=60000){lastDurableQueueRecovery=Date.now();try{await recoverLostDispatchedOutbox();}catch(error){logger.warn('Durable queue recovery unavailable',{error:error.message});}}
    try {
      await dispatchOutbox();
    } catch (error) {
      logger.warn('Outbox dispatch cycle unavailable', { error: error.message });
    }
    if(Date.now()-lastMoneyCleanup>=60000){lastMoneyCleanup=Date.now();try{const expired=await expireStaleWalletApprovals();if(expired)logger.warn('Expired wallet approvals released safely',{expired});}catch(error){logger.warn('Money approval cleanup unavailable',{error:error.message});}}
    if (config.sportsbookAutoSettlementEnabled && Date.now() - lastSportsbookSettlement >= config.sportsbookAutoSettlementSeconds * 1000) {
      logger.info('Sportsbook auto-settlement scheduler invoking', { enabled: config.sportsbookAutoSettlementEnabled, elapsedMs: Date.now() - lastSportsbookSettlement });
      lastSportsbookSettlement = Date.now();
      try {
        const summary = await autoSettleSportsbookTickets();
        const corrections = await retryPendingSportsbookSettlementCorrections({ limit: 50 });
        if (summary.checked || corrections.checked) logger.info('Sportsbook auto-settlement cycle completed', { ...summary, correctionRetry: corrections });
      } catch (error) {
        logger.warn('Sportsbook auto-settlement cycle unavailable', { error: error.message });
      }
    }
    if (config.totoAutoSettlementEnabled && Date.now() - lastTotoSettlement >= config.totoAutoSettlementSeconds * 1000) {
      lastTotoSettlement = Date.now();
      try {
        await autoSettleTotoPeriods();
      } catch (error) {
        logger.warn('TOTO auto-settlement cycle unavailable', { error: error.message });
      }
    }
    let payload = null;
    try {
      payload = await reserveJob(5);
    } catch (error) {
      // BRPOPLPUSH throws while Redis is reconnecting; back off briefly instead
      // of crashing the worker and losing scheduler uptime.
      logger.warn('Queue reservation unavailable', { error: error.message });
      await sleep(2000);
      continue;
    }
    if (!payload) continue;

    let job;
    try {
      job = JSON.parse(payload);
    } catch {
      logger.warn('Invalid queue payload');
      await removeProcessingPayload(payload);
      continue;
    }

    const outcome = await processJob(job);
    if (outcome === 'retry') {
      await new Promise(resolve => setTimeout(resolve, 500));
      await requeueJob(payload);
      continue;
    }
    // Successful jobs and terminal failures are acknowledged. Mid-process crashes
    // remain in the processing list and are recovered on the next worker start.
    if (outcome === 'failed' && job?.outboxId) {
      await query(`UPDATE job_outbox SET status='FAILED',last_error='Settlement job failed' WHERE id=$1 AND status='DISPATCHED'`,[job.outboxId]).catch(() => {});
    }
    await acknowledgeJob(payload, job);
  }
}

async function shutdown() {
  stopHeartbeatLoop();
  await closeRedis().catch(() => {});
  await closeDatabase().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
main().catch(error => {
  logger.error('Worker startup failed', { error: error.message });
  process.exit(1);
});
