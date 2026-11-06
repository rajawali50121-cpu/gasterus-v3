import test from 'node:test';
import assert from 'node:assert/strict';
const env = { DATABASE_URL: 'postgresql://user:pass@localhost/db', REDIS_URL: 'redis://localhost:6379', MEMBER_PROXY_SECRET: 'm'.repeat(48), ADMIN_PROXY_SECRET: 'a'.repeat(48), OPS_INTERNAL_SECRET: 'o'.repeat(48), SESSION_HMAC_KEY: 'y'.repeat(48), API_KEY_PEPPER: 'z'.repeat(48), MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'), RAPIDAPI_CASINO_KEY: 'test-rapidapi-key' };
Object.assign(process.env, env);
const casino = await import('../src/casino-rapidapi.js');
test('normalizeProviders maps games array to coded categories', () => {
  const out = casino.normalizeProviders({ success: true, games: ['PGSOFT', 'EVOLUTIONLIVE', 'CMDSPORTS', 'AVIATOR', 'pgsoft', '  '] });
  assert.deepEqual(out.map((p) => p.code), ['AVIATOR', 'CMDSPORTS', 'EVOLUTIONLIVE', 'PGSOFT']);
  assert.equal(out.find((p) => p.code === 'PGSOFT').category, 'SLOTS');
  assert.equal(out.find((p) => p.code === 'EVOLUTIONLIVE').category, 'LIVE_CASINO');
  assert.equal(out.find((p) => p.code === 'CMDSPORTS').category, 'SPORTSBOOK');
  assert.equal(out.find((p) => p.code === 'AVIATOR').category, 'CRASH_ARCADE');
});
test('casinoRapidApiStatus never leaks key', () => {
  const status = casino.casinoRapidApiStatus();
  assert.equal('key' in status, false);
  assert.equal('rapidApiKey' in status, false);
  assert.equal(JSON.stringify(status).toLowerCase().includes('rapidapi-key'), false);
});
test('normalizeGames maps SPRIBE-style and PG-style game payloads', () => {
  const spribe = casino.normalizeGames({
    success: true, provider: 'SPRIBE', totalGames: 2,
    games: [
      { name: 'Aviator', id: 'a04d', img: 'https://cdn.example/spribe/0.png', type: 'crash', provider: 'SPRIBE' },
      { name: 'Dice', id: '8a87', img: 'https://cdn.example/spribe/1.png', type: 'crash', provider: 'SPRIBE' },
    ],
  }, 'SPRIBE');
  assert.equal(spribe.length, 2);
  assert.deepEqual(spribe[0], { name: 'Aviator', id: 'a04d', img: 'https://cdn.example/spribe/0.png', type: 'crash', provider: 'SPRIBE' });
  const pg = casino.normalizeGames({
    success: true,
    data: [{ game_uid: '1189', game_name: 'Mahjong Ways', game_type: 'Slot', status: 1 }],
  }, 'PG');
  assert.equal(pg.length, 1);
  assert.equal(pg[0].id, '1189');
  assert.equal(pg[0].name, 'Mahjong Ways');
  assert.equal(pg[0].type, 'Slot');
  assert.equal(pg[0].provider, 'PG');
  assert.deepEqual(casino.normalizeGames({}), []);
});
test('diagnoseCasinoUpstream is exported and probes without leaking key', async () => {
  assert.equal(typeof casino.diagnoseCasinoUpstream, 'function');
});
test('demo launch payload uses the member-bound alias and never sends wallet balance', () => {
  const request = casino.buildCasinoDemoRequest('550e8400-e29b-41d4-a716-446655440000', { gameId: '1189baca', platform: 2 });
  assert.equal(request.username, 'g550e8400e29b41d4a71644665544000');
  assert.equal(request.gameId, '1189baca');
  assert.equal(request.money, 0);
  assert.equal(request.platform, 2);
  assert.equal(request.currency, 'IDR');
  assert.equal('balance' in request, false);
});
test('demo launch accepts only successful HTTPS game URLs', () => {
  assert.deepEqual(casino.normalizeCasinoDemoLaunch({ code: 0, payload: { game_launch_url: 'https://livecasinoapi.betnex.co/session/demo', expires_in: 300 } }), {
    gameUrl: 'https://livecasinoapi.betnex.co/session/demo', mode: 'DEMO', expiresIn: 300
  });
  assert.throws(() => casino.normalizeCasinoDemoLaunch({ code: 1, msg: 'rejected' }), /rejected/);
  assert.throws(() => casino.normalizeCasinoDemoLaunch({ code: 0, payload: { game_launch_url: 'javascript:alert(1)' } }), /HTTPS/);
});
test('demo launch POST is not cached and sends money=0', async () => {
  const originalFetch = globalThis.fetch;
  let call;
  let callCount = 0;
  globalThis.fetch = async (url, options) => {
    callCount += 1;
    call = { url: String(url), options };
    return new Response(JSON.stringify({ code: 0, payload: { game_launch_url: 'https://livecasinoapi.betnex.co/session/demo' } }), { status: 200 });
  };
  try {
    const result = await casino.launchCasinoDemo('550e8400-e29b-41d4-a716-446655440000', { gameId: '1189baca' });
    assert.equal(call.url, `https://${casino.casinoRapidApiStatus().host}/casino/getgameurl`);
    assert.equal(call.options.method, 'POST');
    assert.equal(JSON.parse(call.options.body).money, 0);
    assert.equal(call.options.headers['x-rapidapi-key'], 'test-rapidapi-key');
    assert.equal(result.mode, 'DEMO');
    await casino.launchCasinoDemo('550e8400-e29b-41d4-a716-446655440000', { gameId: '1189baca' });
    assert.equal(callCount, 2, 'URL sesi tidak boleh di-cache');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
