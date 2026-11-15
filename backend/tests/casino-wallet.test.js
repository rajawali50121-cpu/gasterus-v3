import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost/db',
  REDIS_URL: 'redis://localhost:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  BETNEX_API_KEY: 'test-betnex-direct-key',
  BETNEX_CALLBACK_KEY: 'test-betnex-callback-key',
  BETNEX_CALLBACK_FRACTIONAL_POLICY: 'reject',
  BETNEX_SEAMLESS_WALLET_PROTOCOL_VERIFIED: 'true',
  BETNEX_REAL_MONEY_ENABLED: 'true'
});

const wallet = await import('../src/casino-wallet.js');
const memberId = '550e8400-e29b-41d4-a716-446655440000';
const memberAccountCode = memberId.replace(/-/g, '');

function fakeStore(startingBalance = 2000, { failOnRoundUpdate = false, userStatus = 'ACTIVE' } = {}) {
  const state = {
    account: { id: randomUUID(), owner_user_id: memberId, current_balance: startingBalance, status: 'ACTIVE' },
    rounds: new Map(),
    events: new Map(),
    transfers: [],
    userStatus
  };
  function cloneState() {
    return {
      account: { ...state.account },
      rounds: new Map([...state.rounds].map(([key, value]) => [key, { ...value }])),
      events: new Map([...state.events].map(([key, value]) => [key, { ...value }])),
      transfers: [...state.transfers],
      userStatus: state.userStatus
    };
  }
  function createClient(workingState) {
    return {
      state: workingState,
      async query(sql, values = []) {
        if (sql.includes('pg_advisory_xact_lock') || sql.startsWith('SET LOCAL')) return { rows: [] };
        if (sql.includes('FROM users WHERE replace(lower(id::text)')) return { rows: [{ id: memberId, status: workingState.userStatus }] };
        if (sql.includes('FROM ledger_accounts WHERE owner_user_id')) return { rows: [workingState.account] };
        if (sql.includes('INSERT INTO casino_game_rounds')) {
          const key = `${values[1]}:${values[2]}:${values[3]}:${values[4]}`;
          if (!workingState.rounds.has(key)) workingState.rounds.set(key, { id: values[0], memberId: values[1], provider: values[2], gameUid: values[3], gameRound: values[4], bet: 0, win: 0, processedSerials: [], gameMappingStatus: 'UNMAPPED' });
          return { rows: [] };
        }
        if (sql.includes('SELECT id FROM casino_game_rounds')) {
          const key = `${values[0]}:${values[1]}:${values[2]}:${values[3]}`;
          const round = workingState.rounds.get(key);
          return { rows: round ? [{ id: round.id }] : [] };
        }
        if (sql.includes('FROM casino_callback_events') && sql.includes('game_uid')) {
          const event = [...workingState.events.values()].find(item => item.memberId === values[0] && item.gameUid === values[1] && item.gameRound === values[2] && item.serialNumber === values[3]);
          return { rows: event ? [{ member_id: event.memberId, balance_after: event.balanceAfter }] : [] };
        }
        if (sql.includes('INSERT INTO casino_callback_events')) {
          const key = `${values[3]}:${values[5]}:${values[6]}:${values[2]}`;
          if (workingState.events.has(key)) return { rows: [] };
          workingState.events.set(key, { id: values[0], memberId: values[3], roundId: values[4], gameUid: values[5], gameRound: values[6], serialNumber: values[2], bet: values[7], win: values[8], balanceAfter: null, payload: JSON.parse(values[10]) });
          return { rows: [{ id: values[0] }] };
        }
        if (sql.includes('UPDATE casino_game_rounds')) {
          if (failOnRoundUpdate) throw new Error('simulated database failure');
          const targetRound = [...workingState.rounds.values()].find(item => item.id === values[3]);
          targetRound.bet += values[0];
          targetRound.win += values[1];
          targetRound.processedSerials.push(values[2]);
          return { rows: [] };
        }
        if (sql.includes('UPDATE casino_callback_events')) {
          const event = [...workingState.events.values()].find(item => item.id === values[1]);
          if (event) event.balanceAfter = values[0];
          return { rows: [] };
        }
        throw new Error(`Unhandled fake query: ${sql}`);
      }
    }
  }
  let transactionTail = Promise.resolve();
  const transaction = async fn => {
    const previous = transactionTail;
    let release;
    transactionTail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const workingState = cloneState();
      const result = await fn(createClient(workingState));
      Object.assign(state, workingState);
      return result;
    } finally {
      release();
    }
  };
  const transfer = async (client, input) => {
    const workingState = client.state;
    const before = workingState.account.current_balance;
    const after = before + input.memberDelta;
    if (after < 0) {
      const error = new Error('Saldo tidak mencukupi.');
      error.code = 'INSUFFICIENT_BALANCE';
      throw error;
    }
    workingState.account.current_balance = after;
    workingState.transfers.push(input);
    return { before, after };
  };
  return { state, transaction, transfer, callbackLogInsert: async () => {} };
}

function callback(overrides = {}) {
  return {
    bet_amount: 100,
    win_amount: 0,
    member_account: memberAccountCode,
    game_uid: 'pg-game-1189',
    game_round: 'round-001',
    currency_code: 'IDR',
    api_key: 'test-betnex-callback-key',
    serial_number: 'serial-001',
    ...overrides
  };
}

test('Betnex launch binds a stable Gasterus member alias and includes its database balance', () => {
  const request = wallet.buildBetnexLaunchRequest({ id: memberId, balance: 999999 }, { gameId: 'pg-game-1189', platform: 2, money: 1 }, 125000);
  assert.equal(request.username, memberAccountCode);
  assert.equal(request.money, 125000);
  assert.equal(request.currency, 'IDR');
  assert.equal(request.platform, 2);
});

test('real Betnex launch reads ledger balance and sends JSON only to the direct API without caching launch URL', async () => {
  let transactionReads = 0;
  let calls = 0;
  const timeoutDelays = [];
  let call;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (handler, delay, ...args) => {
    timeoutDelays.push(delay);
    return originalSetTimeout(handler, delay, ...args);
  };
  const fetchImpl = async (url, options) => {
    calls += 1;
    call = { url: String(url), options };
    return new Response(JSON.stringify({ success: true, code: 0, payload: { game_launch_url: 'https://livecasinoapi.betnex.co/session/test', expires_in: 60 } }), { status: 200 });
  };
  const transaction = async fn => {
    transactionReads += 1;
    return fn({ query: async () => ({ rows: [{ current_balance: 125000, status: 'ACTIVE' }] }) });
  };
  let first;
  let second;
  try {
    first = await wallet.launchBetnexGame({ id: memberId, balance: 1 }, { gameId: 'pg-game-1189', platform: 1 }, fetchImpl, { transaction });
    second = await wallet.launchBetnexGame({ id: memberId, balance: 1 }, { gameId: 'pg-game-1189', platform: 1 }, fetchImpl, { transaction });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(call.url, 'https://livecasinoapi.betnex.co/casino/getgameurl');
  assert.equal(call.options.headers['x-betnex-key'], 'test-betnex-direct-key');
  assert.equal(call.options.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(call.options.body).username, memberAccountCode);
  assert.equal(JSON.parse(call.options.body).money, 125000);
  assert.equal(first.mode, 'REAL');
  assert.equal(second.gameUrl, first.gameUrl);
  assert.equal(transactionReads, 2);
  assert.equal(calls, 2);
  assert.ok(timeoutDelays.every(delay => delay >= 10000));
});

test('Betnex launch rejects responses without numeric code zero', async () => {
  const transaction = async fn => fn({ query: async () => ({ rows: [{ current_balance: 100, status: 'ACTIVE' }] }) });
  await assert.rejects(
    wallet.launchBetnexGame({ id: memberId }, { gameId: 'pg-game-1189' }, async () =>
      new Response(JSON.stringify({ success: true, payload: { game_launch_url: 'https://example.test/launch' } }), { status: 200 }),
    { transaction }),
    /Betnex menolak sesi game/
  );
});

test('real-money catalog hides providers and games unsupported for IDR', async () => {
  const providers = await wallet.betnexProvidersForCurrency('IDR', async (url, options) => {
    assert.equal(new URL(url).searchParams.get('currency'), 'IDR');
    assert.equal(options.headers['x-betnex-key'], 'test-betnex-direct-key');
    return new Response(JSON.stringify({ success: true, data: [
      { code: 'PG', name: 'PG Soft', status: 1 },
      { code: 'UNSUPPORTED', name: 'Unsupported', status: 0 }
    ] }), { status: 200 });
  });
  assert.deepEqual(providers.map(provider => provider.code), ['PG']);

  const games = await wallet.betnexGamesForCurrency('PG', 'IDR', async url => {
    assert.equal(new URL(url).searchParams.get('providercode'), 'PG');
    assert.equal(new URL(url).searchParams.get('currency'), 'IDR');
    return new Response(JSON.stringify({ success: true, data: [
      { game_uid: 'game-supported', game_name: 'Supported', status: 1 },
      { game_uid: 'game-unsupported', game_name: 'Unsupported', status: 0 }
    ] }), { status: 200 });
  });
  assert.deepEqual(games.map(game => game.game_uid), ['game-supported']);
});

test('Betnex real-money mode requires explicit protocol verification', () => {
  assert.equal(wallet.betnexWalletStatus().launchMode, 'REAL');
  assert.equal(wallet.betnexWalletStatus().protocolVerified, true);
  assert.equal('betnexApiKey' in wallet.betnexWalletStatus(), false);
  assert.equal('callbackKey' in wallet.betnexWalletStatus(), false);
});

test('Betnex callback rejects invalid API key and returns the known member ledger balance', async () => {
  let transactions = 0;
  const store = fakeStore(2000);
  const result = await wallet.processBetnexCallback(callback({ api_key: 'wrong' }), {
    ...store,
    transaction: async fn => { transactions += 1; return store.transaction(fn); },
    callbackLogInsert: async () => {}
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.handle, false);
  assert.equal(result.body.money, 2000);
  assert.equal(transactions, 1);
  assert.equal(store.state.transfers.length, 0);
});

test('Betnex callback debits a bet using one net Gasterus ledger transfer', async () => {
  const store = fakeStore(2000);
  const result = await wallet.processBetnexCallback(callback({ bet_amount: 600 }), store);
  assert.equal(result.body.handle, true);
  assert.equal(result.body.money, 1400);
  assert.equal(store.state.transfers.length, 1);
  assert.equal(store.state.transfers[0].memberDelta, -600);
});

test('Betnex callback credits a win and combines bet plus win into one net transfer', async () => {
  const store = fakeStore(2000);
  const win = await wallet.processBetnexCallback(callback({ bet_amount: 0, win_amount: 800 }), store);
  assert.deepEqual(win.body, { success: true, msg: 'Callback processed successfully.', handle: true, money: 2800 });

  const netBalanceStore = fakeStore(500);
  const netBalance = await wallet.processBetnexCallback(callback({ bet_amount: 600, win_amount: 800 }), netBalanceStore);
  assert.equal(netBalance.body.handle, true);
  assert.equal(netBalance.body.money, 700);
  assert.equal(netBalanceStore.state.transfers.length, 1);
  assert.equal(netBalanceStore.state.transfers[0].memberDelta, 200);

  const combinedStore = fakeStore(2000);
  const combined = await wallet.processBetnexCallback(callback({ bet_amount: 600, win_amount: 800 }), combinedStore);
  assert.equal(combined.body.money, 2200);
  assert.equal(combinedStore.state.transfers.length, 1);
  assert.equal(combinedStore.state.transfers[0].memberDelta, 200);
});

test('Betnex callback applies negative bet and win adjustments using the required net formula', async () => {
  const betRefundStore = fakeStore(2000);
  const betRefund = await wallet.processBetnexCallback(callback({ bet_amount: -600 }), betRefundStore);
  assert.equal(betRefund.body.money, 2600);

  const winReversalStore = fakeStore(2000);
  const winReversal = await wallet.processBetnexCallback(callback({ bet_amount: 0, win_amount: -800 }), winReversalStore);
  assert.equal(winReversal.body.money, 1200);

  const bothRefundStore = fakeStore(2000);
  const bothRefund = await wallet.processBetnexCallback(callback({ bet_amount: -600, win_amount: -800 }), bothRefundStore);
  assert.equal(bothRefund.body.money, 1800);
  assert.equal(bothRefundStore.state.transfers.length, 1);
  assert.equal(bothRefundStore.state.transfers[0].memberDelta, -200);
});

test('Betnex callback with zero net records its serial without calling postTransfer', async () => {
  const store = fakeStore(2000);
  let transferCalls = 0;
  const result = await wallet.processBetnexCallback(callback({ bet_amount: 100, win_amount: 100 }), {
    ...store,
    transfer: async (...args) => { transferCalls += 1; return store.transfer(...args); }
  });
  assert.deepEqual(result.body, { success: true, msg: 'Callback processed successfully.', handle: true, money: 2000 });
  assert.equal(transferCalls, 0);
  assert.equal(store.state.account.current_balance, 2000);
  assert.deepEqual([...store.state.rounds.values()][0].processedSerials, ['serial-001']);
  assert.equal(store.state.events.size, 1);
});

test('Betnex callback duplicate serial returns the current ledger balance without changing it', async () => {
  const store = fakeStore(2000);
  const first = await wallet.processBetnexCallback(callback({ bet_amount: 600 }), store);
  assert.equal(first.body.handle, true);
  assert.equal(first.body.money, 1400);
  await wallet.processBetnexCallback(callback({ serial_number: 'serial-002', bet_amount: 0, win_amount: 100 }), store);
  const [round] = store.state.rounds.values();
  assert.equal(round.bet, 600);
  assert.equal(round.win, 100);
  assert.deepEqual(round.processedSerials, ['serial-001', 'serial-002']);
  const duplicate = await wallet.processBetnexCallback(callback({ bet_amount: 600 }), store);
  assert.equal(duplicate.body.handle, true);
  assert.equal(duplicate.body.money, 1500);
  assert.equal(store.state.transfers.length, 2);
  assert.equal(Object.hasOwn([...store.state.events.values()][0].payload, 'api_key'), false);
});

test('same serial for another game round is not treated as a duplicate', async () => {
  const store = fakeStore(2000);
  const first = await wallet.processBetnexCallback(callback({ bet_amount: 100 }), store);
  const anotherProviderGame = await wallet.processBetnexCallback(callback({ game_uid: 'jili-game-2', game_round: 'round-2', bet_amount: 100 }), store);
  assert.equal(first.body.money, 1900);
  assert.equal(anotherProviderGame.body.money, 1800);
  assert.equal(store.state.transfers.length, 2);
});

test('Betnex callback rejects non-numeric and non-finite amounts with HTTP 200 and no ledger writes', async () => {
  for (const betAmount of ['100', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 45.21]) {
    const store = fakeStore(500);
    const result = await wallet.processBetnexCallback(callback({ bet_amount: betAmount }), store);
    assert.equal(result.body.handle, false, `accepted invalid amount ${String(betAmount)}`);
    assert.equal(store.state.account.current_balance, 500);
    assert.equal(store.state.transfers.length, 0);
  }
});

test('fractional Betnex callback amount 45.21 is rejected with a hard log and no ledger change', async () => {
  const store = fakeStore(2000);
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = function (chunk, ...args) {
    output += String(chunk);
    const callback = args.at(-1);
    if (typeof callback === 'function') callback();
    return true;
  };
  let result;
  try {
    result = await wallet.processBetnexCallback(callback({ bet_amount: 0, win_amount: 45.21 }), store);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(result.status, 200);
  assert.equal(result.body.handle, false);
  assert.equal(result.body.money, 2000);
  assert.match(output, /"level":"error"/);
  assert.equal(store.state.account.current_balance, 2000);
});

test('unknown callback provider fails with HTTP 200 and does not change wallet balance', async () => {
  const store = fakeStore(500);
  const result = await wallet.processBetnexCallback(callback(), { ...store, providerCode: 'UNKNOWN' });
  assert.equal(result.status, 200);
  assert.equal(result.body.handle, false);
  assert.equal(store.state.account.current_balance, 500);
});

test('unknown game_uid is processed and the round is explicitly marked UNMAPPED', async () => {
  const store = fakeStore(2000);
  const result = await wallet.processBetnexCallback(callback({ game_uid: 'not-in-local-catalog', bet_amount: 10 }), store);
  assert.equal(result.body.handle, true);
  const round = [...store.state.rounds.values()][0];
  assert.equal(round.gameUid, 'not-in-local-catalog');
  assert.equal(round.gameMappingStatus, 'UNMAPPED');
});

test('Betnex callback rejects insufficient balance without committing callback data', async () => {
  const store = fakeStore(50);
  const result = await wallet.processBetnexCallback(callback({ bet_amount: 100 }), store);
  assert.equal(result.body.handle, false);
  assert.equal(result.body.success, false);
  assert.equal(result.body.money, 50);
  assert.equal(store.state.account.current_balance, 50);
  assert.equal(store.state.events.size, 0);
  assert.equal(store.state.transfers.length, 0);
});

test('Betnex callback database failure rolls back ledger and callback changes', async () => {
  const store = fakeStore(1000, { failOnRoundUpdate: true });
  const result = await wallet.processBetnexCallback(callback({ bet_amount: 100 }), store);
  assert.equal(result.status, 200);
  assert.equal(result.body.handle, false);
  assert.equal(result.body.money, 1000);
  assert.equal(store.state.account.current_balance, 1000);
  assert.equal(store.state.events.size, 0);
  assert.equal(store.state.transfers.length, 0);
});

test('concurrent callbacks with the same scoped serial modify the balance once', async () => {
  const store = fakeStore(2000);
  const payload = callback({ bet_amount: 600 });
  const [first, second] = await Promise.all([
    wallet.processBetnexCallback(payload, store),
    wallet.processBetnexCallback(payload, store)
  ]);
  assert.equal(first.body.handle, true);
  assert.equal(second.body.handle, true);
  assert.equal(first.body.money, 1400);
  assert.equal(second.body.money, 1400);
  assert.equal(store.state.account.current_balance, 1400);
  assert.equal(store.state.transfers.length, 1);
});

test('Betnex callback rejects non-IDR transactions before ledger writes', async () => {
  const store = fakeStore(2000);
  const result = await wallet.processBetnexCallback(callback({ currency_code: 'INR' }), store);
  assert.equal(result.status, 200);
  assert.equal(result.body.handle, false);
  assert.equal(result.body.money, 2000);
  assert.equal(store.state.transfers.length, 0);
});

test('inactive member callback fails with HTTP 200 and no wallet mutation', async () => {
  const store = fakeStore(2000, { userStatus: 'SUSPENDED' });
  const result = await wallet.processBetnexCallback(callback(), store);
  assert.equal(result.status, 200);
  assert.equal(result.body.handle, false);
  assert.equal(result.body.money, 2000);
  assert.equal(store.state.account.current_balance, 2000);
  assert.equal(store.state.transfers.length, 0);
});

test('invalid API key responds HTTP 200 handle false with the current ledger balance', async () => {
  const store = fakeStore(2000);
  const result = await wallet.processBetnexCallback(callback({ api_key: 'wrong' }), store);
  assert.equal(result.status, 200);
  assert.equal(result.body.success, false);
  assert.equal(result.body.handle, false);
  assert.equal(result.body.money, 2000);
  assert.equal(store.state.account.current_balance, 2000);
});

test('callback logs and stored payload never expose api_key', async () => {
  const store = fakeStore();
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = function (chunk, ...args) {
    output += String(chunk);
    const callback = args.at(-1);
    if (typeof callback === 'function') callback();
    return true;
  };
  try {
    await wallet.processBetnexCallback(callback({ api_key: 'distinct-secret-callback-key' }), store);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(output.includes('distinct-secret-callback-key'), false);
  for (const event of store.state.events.values()) {
    assert.equal(Object.hasOwn(event.payload, 'api_key'), false);
  }
});

test('callback audit insert failure is fire-and-forget and cannot change the callback response', async () => {
  const store = fakeStore(2000);
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let loggedRecord;
  const result = await wallet.processBetnexCallback(callback({ bet_amount: 10 }), {
    ...store,
    callbackLogInsert: record => {
      loggedRecord = record;
      markStarted();
      return Promise.reject(new Error('simulated audit database failure'));
    }
  });
  await started;
  assert.equal(result.status, 200);
  assert.equal(result.body.handle, true);
  assert.equal(result.body.money, 1990);
  assert.equal(loggedRecord.httpStatus, 200);
  assert.equal(loggedRecord.outcome, 'SUCCESS');
  assert.equal(loggedRecord.requestPayload.api_key, '[REDACTED]');
  assert.deepEqual(loggedRecord.responsePayload, result.body);
  assert.ok(loggedRecord.retainUntil.getTime() - loggedRecord.receivedAt.getTime() >= 90 * 24 * 60 * 60 * 1000);
});

test('callback route catches wrong or missing internal proxy secrets and responds HTTP 200 handle false', () => {
  const appPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/app.js');
  const app = readFileSync(appPath, 'utf8');
  const routeStart = app.indexOf("add('POST',/^\\/api\\/member\\/casino\\/callback$/");
  const routeEnd = app.indexOf("add('GET',/^\\/api\\/member\\/casino\\/status$/", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const callbackRoute = app.slice(routeStart, routeEnd);
  assert.match(callbackRoute, /try\{internal\(req,'member'\);\}catch\{const result=.*recordBetnexCallbackLog\(null,result\);return json\(res,200,/);
  assert.match(callbackRoute, /handle:false,money:0/);
});

test('production config refuses startup when database, redis, or required secrets are absent', () => {
  const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const baseEnv = { PATH: process.env.PATH || '', NODE_ENV: 'production' };
  const scenarios = [
    { env: baseEnv, message: 'DATABASE_URL' },
    { env: { ...baseEnv, DATABASE_URL: 'postgresql://test:test@localhost/db' }, message: 'REDIS_URL' },
    { env: { ...baseEnv, DATABASE_URL: 'postgresql://test:test@localhost/db', REDIS_URL: 'redis://localhost:6379' }, message: 'MEMBER_PROXY_SECRET' }
  ];
  for (const { env, message } of scenarios) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config.js')"], { cwd: backendDir, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(message));
  }
});

test('production config keeps Betnex real-money disabled unless its production flags are explicitly set', () => {
  const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const env = {
    PATH: process.env.PATH || '',
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://test:test@localhost/db',
    REDIS_URL: 'redis://localhost:6379',
    MEMBER_PROXY_SECRET: 'm'.repeat(48),
    ADMIN_PROXY_SECRET: 'a'.repeat(48),
    OPS_INTERNAL_SECRET: 'o'.repeat(48),
    SESSION_HMAC_KEY: 's'.repeat(48),
    API_KEY_PEPPER: 'p'.repeat(48),
    MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
  };
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "const {config}=await import('./src/config.js');console.log(config.betnexRealMoneyEnabled)"], { cwd: backendDir, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /false/);
});

test('migration 042 scopes callback serial uniqueness by member, game, round, and serial without assuming a constraint name', () => {
  const migrationPath = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations/042_betnex_callback_idempotency_scope.sql');
  const migration = readFileSync(migrationPath, 'utf8');
  assert.match(migration, /ON casino_callback_events\(member_id, game_uid, game_round, serial_number\)/);
  assert.match(migration, /array_agg\(attribute\.attname::text ORDER BY attribute\.attname::text\)/);
  assert.match(migration, /processed_serials/);
  assert.match(migration, /game_mapping_status/);
});
