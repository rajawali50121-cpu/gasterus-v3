import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.js';

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
  GITSLOTPARK_API_KEY: 'test-rapidapi-key',
  GITSLOTPARK_BASE_URL: 'https://fallback-slots.p.rapidapi.com',
  GITSLOTPARK_AGENT_ID: 'Partner01',
  GITSLOTPARK_SECRET: 'test-callback-hmac-secret'
});
delete process.env.GITSLOTPARK_API_TOKEN;
delete process.env.GITSLOTPARK_ENABLED;

const { config } = await import('../src/config.js');
const provider = await import('../src/slot-provider-client.js');
const wallet = await import('../src/slot-wallet-router.js');

test('RapidAPI catalog fallback and callback remain available without Seamless token', async () => {
  assert.equal(config.slotProviderToken, '');
  assert.equal(config.slotWalletEnabled, true);
  assert.equal(config.rapidApiCasinoBaseUrl, 'https://fallback-slots.p.rapidapi.com');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    if (parsed.pathname === '/casino/getallproviders') {
      return new Response(JSON.stringify({ games: ['PGSOFT'] }), { status: 200 });
    }
    if (parsed.pathname === '/casino/getallgamesandprovider') {
      return new Response(JSON.stringify({
        provider: 'PGSOFT',
        games: [{ id: '1189', name: 'Test Slot', img: 'https://cdn.example/game.png', provider: 'PGSOFT' }]
      }), { status: 200 });
    }
    throw new Error(`Unexpected API request: ${parsed.pathname}`);
  };

  try {
    const providers = await provider.slotProviderCatalog();
    assert.equal(providers[0].code, 'PGSOFT');
    const games = await provider.slotGameCatalog('PGSOFT');
    assert.equal(games[0].gameCode, '1189');
    assert.equal(games[0].name, 'Test Slot');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('launcher reports missing Seamless token as a handled configuration error', async () => {
  await assert.rejects(
    provider.launchGame({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      username: 'player01',
      currency: 'IDR',
      providerCode: 'PGSOFT',
      gameCode: '1189'
    }),
    error => error instanceof AppError && error.code === 'SLOT_PROVIDER_TOKEN_MISSING'
  );
});

test('signed balance callback works without the optional Seamless token', async () => {
  const payload = { agentID: 'Partner01', userID: 'player01', gameID: 2001 };
  payload.sign = wallet.createSlotSignature('GETBALANCE', payload);
  const response = await wallet.processSlotWalletCallback('GETBALANCE', payload, {
    transaction: fn => fn({
      async query(sql) {
        if (sql.includes('WHERE username=$1')) return { rows: [{ id: 'member-1', status: 'ACTIVE' }] };
        if (sql.includes('FROM ledger_accounts WHERE owner_user_id')) {
          return { rows: [{ current_balance: 4200, status: 'ACTIVE' }] };
        }
        throw new Error(`Unexpected database query: ${sql}`);
      }
    })
  });
  assert.deepEqual(response, { code: 0, message: '', balance: 4200 });
});
