import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://localhost/db',
  REDIS_URL: 'redis://localhost:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  GITSLOTPARK_ENABLED: 'true',
  GITSLOTPARK_API_TOKEN: 'test-slot-api-token',
  GITSLOTPARK_AGENT_ID: 'Partner01',
  GITSLOTPARK_SIGNING_KEY: 'test-slot-signing-key'
});
delete process.env.GITSLOTPARK_SIGNING_KEY;
process.env.GITSLOTPARK_SECRET = 'test-slot-signing-key';

const wallet = await import('../src/slot-wallet-router.js');
const provider = await import('../src/slot-provider-client.js');
const memberId = '550e8400-e29b-41d4-a716-446655440000';
const state = {
  balance: 1000,
  transactions: new Map(),
  transfers: []
};

function fakeStore() {
  state.balance = 1000;
  state.transactions.clear();
  state.transfers.length = 0;
  const client = {
    async query(sql, values = []) {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('WHERE username=$1')) {
        const ids = new Set(['player01', `g${memberId.replace(/-/g, '')}`]);
        return { rows: ids.has(values[0]) ? [{ id: memberId, status: 'ACTIVE' }] : [] };
      }
      if (sql.includes('FROM ledger_accounts WHERE owner_user_id')) {
        return { rows: [{ id: 'account-1', current_balance: state.balance, status: 'ACTIVE' }] };
      }
      if (sql.includes('SELECT member_id,event_type FROM slot_wallet_transactions')) {
        const row = state.transactions.get(values[1]);
        return { rows: row ? [{ member_id: row.member_id, event_type: row.event_type }] : [] };
      }
      if (sql.includes('SELECT member_id,event_type,game_id FROM slot_wallet_transactions')) {
        const row = state.transactions.get(values[1]);
        return { rows: row ? [{ member_id: row.member_id, event_type: row.event_type, game_id: row.game_id }] : [] };
      }
      if (sql.includes("event_type='ROLLBACK'")) {
        const row = [...state.transactions.values()].find(event =>
          event.event_type === 'ROLLBACK' && event.reference_transaction_id === values[1]
        );
        return { rows: row ? [{ id: row.id }] : [] };
      }
      if (sql.includes('SELECT id FROM slot_wallet_transactions')) {
        const row = state.transactions.get(values[1]);
        return { rows: row ? [{ id: row.id }] : [] };
      }
      if (sql.includes('SELECT * FROM slot_wallet_transactions')) {
        const row = state.transactions.get(values[1]);
        return { rows: row && row.member_id === values[2] ? [row] : [] };
      }
      if (sql.includes('INSERT INTO slot_wallet_transactions')) {
        const row = {
          id: values[0],
          transaction_id: values[2],
          reference_transaction_id: values[3],
          member_id: values[4],
          event_type: sql.includes("VALUES($1,$2,$3,$4,$5,'ROLLBACK'") ? 'ROLLBACK' : values[5],
          game_id: sql.includes("VALUES($1,$2,$3,$4,$5,'ROLLBACK'") ? values[5] : values[6],
          round_id: sql.includes("VALUES($1,$2,$3,$4,$5,'ROLLBACK'") ? values[6] : values[7],
          member_delta: sql.includes("VALUES($1,$2,$3,$4,$5,'ROLLBACK'") ? values[9] : values[10]
        };
        state.transactions.set(row.transaction_id, row);
        return { rows: [row] };
      }
      throw new Error(`Unhandled test query: ${sql}`);
    }
  };
  const transaction = fn => fn(client);
  const transfer = async (_client, input) => {
    const after = state.balance + input.memberDelta;
    if (after < 0) {
      const error = new Error('Insufficient funds');
      error.code = 'INSUFFICIENT_BALANCE';
      throw error;
    }
    state.balance = after;
    state.transfers.push(input);
  };
  return { transaction, transfer };
}

function signed(operation, fields) {
  const payload = { agentID: 'Partner01', userID: 'player01', gameID: 2001, ...fields };
  payload.sign = wallet.createSlotSignature(operation, payload);
  return payload;
}

test('Withdraw signature includes its documented fields and a two-decimal amount', () => {
  const payload = {
    agentID: 'Partner01',
    userID: 'Player01',
    amount: 12.3,
    transactionID: '474e1a293c2f4e7ab122c52d68423fcb',
    roundID: 'ab9c15f2efdd46278e4a56b303127234',
    gameID: 2001
  };
  assert.equal(
    wallet.createSlotSignature('WITHDRAW', payload, '1234567890'),
    '8A6D48E63CA6F9487B930EC9C1FDD2A41D5492536FF3D1445060DC4BD4F8BBC7'
  );
  assert.equal(
    wallet.createSlotSignature('WITHDRAW', payload, '1234567890', { includeGameId: false }),
    '475D834ACC3AB61D7DF4EA42751C6275387BC1787A098D2D0E091698D9BF2043'
  );
});

test('Withdraw is atomic and duplicate transaction returns provider code 11', async () => {
  const store = fakeStore();
  const request = signed('WITHDRAW', {
    amount: 100,
    transactionID: 'withdraw-1',
    roundID: 'round-1'
  });
  const first = await wallet.processSlotWalletCallback('WITHDRAW', request, store);
  assert.equal(first.code, 0);
  assert.equal(first.balance, 900);
  const duplicate = await wallet.processSlotWalletCallback('WITHDRAW', request, store);
  assert.equal(duplicate.code, 11);
  assert.equal('balance' in duplicate, false);
  assert.equal(state.transfers.length, 1);
});

test('Deposit requires its matching withdrawal and rollback credits the wallet atomically', async () => {
  const store = fakeStore();
  const withdraw = signed('WITHDRAW', {
    amount: 100,
    transactionID: 'withdraw-ref',
    roundID: 'round-1'
  });
  await wallet.processSlotWalletCallback('WITHDRAW', withdraw, store);
  const deposit = signed('DEPOSIT', {
    amount: 25,
    refTransactionID: 'withdraw-ref',
    transactionID: 'deposit-1',
    roundID: 'round-1'
  });
  const credited = await wallet.processSlotWalletCallback('DEPOSIT', deposit, store);
  assert.equal(credited.code, 0);
  assert.equal(credited.balance, 925);

  const rollback = signed('ROLLBACKTRANSACTION', { refTransactionID: 'deposit-1' });
  const reversed = await wallet.processSlotWalletCallback('ROLLBACKTRANSACTION', rollback, store);
  assert.equal(reversed.code, 0);
  assert.equal(state.balance, 900);
  assert.deepEqual(reversed, { code: 0, message: '' });
});

test('BetWin debits and credits in one transaction and rollback restores the net change', async () => {
  const store = fakeStore();
  const betWin = signed('BETWIN', {
    betAmount: 100,
    winAmount: 250,
    transactionID: 'betwin-1',
    roundID: 'round-1'
  });
  const settled = await wallet.processSlotWalletCallback('BETWIN', betWin, store);
  assert.equal(settled.balance, 1150);
  assert.equal(state.transfers.length, 2);

  const rollback = signed('ROLLBACKTRANSACTION', {
    refTransactionID: 'betwin-1'
  });
  const reversed = await wallet.processSlotWalletCallback('ROLLBACKTRANSACTION', rollback, store);
  assert.equal(reversed.code, 0);
  assert.equal(state.balance, 1000);
  const repeated = await wallet.processSlotWalletCallback('ROLLBACKTRANSACTION', rollback, store);
  assert.equal(repeated.code, 9);
});

test('insufficient balance and fractional IDR amount fail without ledger writes', async () => {
  const store = fakeStore();
  state.balance = 50;
  const insufficient = await wallet.processSlotWalletCallback('WITHDRAW', signed('WITHDRAW', {
    amount: 100,
    transactionID: 'withdraw-low',
    roundID: 'round-1'
  }), store);
  assert.equal(insufficient.code, 6);
  assert.equal(state.transfers.length, 0);

  const fractional = await wallet.processSlotWalletCallback('WITHDRAW', signed('WITHDRAW', {
    amount: 0.2,
    transactionID: 'withdraw-fraction',
    roundID: 'round-1'
  }), store);
  assert.equal(fractional.code, 2);
  assert.equal(state.transfers.length, 0);
});

test('callbacks reject a bad HMAC before database access', async () => {
  let opened = false;
  const response = await wallet.processSlotWalletCallback('WITHDRAW', {
    ...signed('WITHDRAW', { amount: 100, transactionID: 'bad-sign', roundID: 'round-1' }),
    sign: '0'.repeat(64)
  }, { transaction: async () => { opened = true; } });
  assert.equal(response.code, 3);
  assert.equal(opened, false);
});

test('callback accepts the published generic HMAC form that omits gameID', async () => {
  const store = fakeStore();
  const payload = {
    agentID: 'Partner01',
    userID: 'player01',
    gameID: 2001
  };
  payload.sign = wallet.createSlotSignature('GETBALANCE', payload, 'test-slot-signing-key', { includeGameId: false });
  const response = await wallet.processSlotWalletCallback('GETBALANCE', payload, store);
  assert.equal(response.code, 0);
  assert.equal(response.balance, 1000);
});

test('launch authenticates to UserAuth and verifies provider/game against its catalog', async () => {
  provider.__slotProviderClient.clearGameCatalogCache();
  const calls = [];
  const launch = await provider.launchGame({
    userId: memberId,
    username: 'player01',
    currency: 'IDR',
    providerCode: 'Pragmatic Play',
    gameCode: '2001'
  }, async (url, options) => {
    calls.push({ url: String(url), options });
    if (url.endsWith('/gamelist')) {
      return new Response(JSON.stringify({ code: 0, data: [{ vendorid: 'Pragmatic Play', gameid: 2001, name: 'Demo' }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, url: 'https://game.example/session/token' }), { status: 200 });
  });
  assert.equal(launch.gameUrl, 'https://game.example/session/token');
  assert.equal(calls[1].url, 'https://apiv2.gitslotpark.com/userAuth');
  assert.equal(calls[1].options.headers.authorization, 'Bearer test-slot-api-token');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    agentID: 'Partner01',
    userID: 'player01',
    lang: 'id',
    gameid: 2001,
    isaffiliate: false,
    lobbyUrl: 'https://gasterus.fun'
  });
});
