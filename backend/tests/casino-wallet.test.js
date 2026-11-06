import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

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
  BETNEX_REAL_MONEY_ENABLED: 'true'
});

const wallet = await import('../src/casino-wallet.js');
const memberId = '550e8400-e29b-41d4-a716-446655440000';
const memberAccountCode = memberId.replace(/-/g, '');

function fakeStore(startingBalance = 1000) {
  const state = {
    account: { id: randomUUID(), owner_user_id: memberId, current_balance: startingBalance, status: 'ACTIVE' },
    rounds: new Map(),
    events: new Map(),
    transfers: []
  };
  const client = {
    async query(sql, values = []) {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM users WHERE replace(lower(id::text)')) return { rows: [{ id: memberId, status: 'ACTIVE' }] };
      if (sql.includes('FROM ledger_accounts WHERE owner_user_id')) return { rows: [state.account] };
      if (sql.includes('FROM casino_callback_events WHERE provider_code')) {
        const event = state.events.get(values[1]);
        return { rows: event ? [{ member_id: event.memberId, balance_after: event.balanceAfter }] : [] };
      }
      if (sql.includes('INSERT INTO casino_game_rounds')) {
        const key = `${values[1]}:${values[2]}:${values[3]}:${values[4]}`;
        if (!state.rounds.has(key)) state.rounds.set(key, { id: values[0], memberId: values[1], provider: values[2], gameUid: values[3], gameRound: values[4], bet: 0, win: 0 });
        return { rows: [] };
      }
      if (sql.includes('SELECT id FROM casino_game_rounds')) {
        const key = `${values[0]}:${values[1]}:${values[2]}:${values[3]}`;
        const round = state.rounds.get(key);
        return { rows: round ? [{ id: round.id }] : [] };
      }
      if (sql.includes('INSERT INTO casino_callback_events')) {
        if (state.events.has(values[2])) return { rows: [] };
        state.events.set(values[2], { memberId: values[3], roundId: values[4], bet: values[5], win: values[6], balanceAfter: null, payload: JSON.parse(values[8]) });
        return { rows: [{ id: values[0] }] };
      }
      if (sql.includes('UPDATE casino_game_rounds')) {
        const round = [...state.rounds.values()].find(item => item.id === values[2]);
        round.bet += values[0];
        round.win += values[1];
        return { rows: [] };
      }
      if (sql.includes('UPDATE casino_callback_events')) {
        const event = [...state.events.values()].find(item => item.id === values[1]);
        if (event) event.balanceAfter = values[0];
        else {
          const pending = [...state.events.values()].find(item => item.balanceAfter === null);
          if (pending) pending.balanceAfter = values[0];
        }
        return { rows: [] };
      }
      throw new Error(`Unhandled fake query: ${sql}`);
    }
  };
  const transaction = fn => fn(client);
  const transfer = async (_client, input) => {
    const before = state.account.current_balance;
    const after = before + input.memberDelta;
    if (after < 0) {
      const error = new Error('Saldo tidak mencukupi.');
      error.code = 'INSUFFICIENT_BALANCE';
      throw error;
    }
    state.account.current_balance = after;
    state.transfers.push(input);
    return { before, after };
  };
  return { state, transaction, transfer };
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

test('Betnex launch binds stable member alias and current wallet balance', () => {
  const request = wallet.buildBetnexLaunchRequest({ id: memberId, balance: 125000 }, { gameId: 'pg-game-1189', platform: 2 });
  assert.equal(request.username, memberAccountCode);
  assert.equal(request.money, 125000);
  assert.equal(request.currency, 'IDR');
  assert.equal(request.platform, 2);
});

test('real Betnex launch sends the wallet snapshot only to the direct API', async () => {
  let call;
  const result = await wallet.launchBetnexGame({ id: memberId, balance: 125000 }, { gameId: 'pg-game-1189', platform: 1 }, async (url, options) => {
    call = { url: String(url), options };
    return new Response(JSON.stringify({ success: true, payload: { game_launch_url: 'https://livecasinoapi.betnex.co/session/test', expires_in: 60 } }), { status: 200 });
  });
  assert.equal(call.url, 'https://livecasinoapi.betnex.co/casino/getgameurl');
  assert.equal(call.options.headers['x-betnex-key'], 'test-betnex-direct-key');
  assert.equal(JSON.parse(call.options.body).money, 125000);
  assert.equal(result.mode, 'REAL');
  assert.equal(result.gameUrl, 'https://livecasinoapi.betnex.co/session/test');
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

test('Betnex real-money mode stays disabled unless explicitly configured', () => {
  assert.equal(wallet.betnexWalletStatus().launchMode, 'REAL');
  assert.equal('betnexApiKey' in wallet.betnexWalletStatus(), false);
  assert.equal('callbackKey' in wallet.betnexWalletStatus(), false);
});

test('Betnex callback rejects invalid API key without opening a transaction', async () => {
  let transactions = 0;
  const result = await wallet.processBetnexCallback(callback({ api_key: 'wrong' }), {
    transaction: async () => { transactions += 1; }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.handle, false);
  assert.equal(transactions, 0);
});

test('Betnex callback posts bet and win atomically and deduplicates serial number', async () => {
  const store = fakeStore();
  const first = await wallet.processBetnexCallback(callback(), store);
  assert.equal(first.body.handle, true);
  assert.equal(first.body.money, 900);
  const duplicate = await wallet.processBetnexCallback(callback(), store);
  assert.equal(duplicate.body.handle, true);
  assert.equal(duplicate.body.money, 900);
  assert.equal(store.state.transfers.length, 1);

  const win = await wallet.processBetnexCallback(callback({ serial_number: 'serial-002', bet_amount: 0, win_amount: 250 }), store);
  assert.equal(win.body.money, 1150);
  assert.equal(store.state.transfers.length, 2);
  assert.equal([...store.state.rounds.values()][0].bet, 100);
  assert.equal([...store.state.rounds.values()][0].win, 250);
});

test('Betnex negative amounts support refunds without changing the callback formula', async () => {
  const store = fakeStore(500);
  const result = await wallet.processBetnexCallback(callback({ bet_amount: -100 }), store);
  assert.equal(result.body.money, 600);
  assert.equal(store.state.transfers[0].memberDelta, 100);
});

test('Betnex callback rejects non-IDR transactions before ledger writes', async () => {
  const store = fakeStore();
  const result = await wallet.processBetnexCallback(callback({ currency_code: 'INR' }), store);
  assert.equal(result.body.handle, false);
  assert.equal(store.state.transfers.length, 0);
});
