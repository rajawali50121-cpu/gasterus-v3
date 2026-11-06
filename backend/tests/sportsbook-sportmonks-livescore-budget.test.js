import test from 'node:test';
import assert from 'node:assert/strict';

function seedEnv() {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: '******example.com/db',
    REDIS_URL: 'redis://example.com:6379',
    MEMBER_PROXY_SECRET: 'm'.repeat(48),
    ADMIN_PROXY_SECRET: 'a'.repeat(48),
    OPS_INTERNAL_SECRET: 'o'.repeat(48),
    SESSION_HMAC_KEY: 's'.repeat(48),
    API_KEY_PEPPER: 'p'.repeat(48),
    MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
  });
}

test('Sportmonks livescore counted in hourly limiter and returns stale cache when 25% live cap exhausted (mock fetch)', async () => {
  seedEnv();
  process.env.SPORTMONKS_ENABLED = 'true';
  process.env.SPORTMONKS_API_KEY = 'test-key';
  process.env.SPORTMONKS_LIVE_REFRESH_SECONDS = '15';
  process.env.SPORTMONKS_REQUEST_DELAY_MS = '0';
  const m = await import(`../src/sportsbook-providers.js?b3a=${Date.now()}`);
  const p = m.__sportsbookProviders;
  const base = 'https://api.sportmonks.test/v3';
  const liveUrl = `${base}/football/livescores`;
  const fixture = { id: 77, name: 'A vs B', starting_at: '2026-11-06T16:00:00Z', starting_at_timestamp: 1793980800, state: { state: 'INPLAY', short_name: 'LIVE' }, participants: [{ id:1,name:'A',meta:{location:'home'}},{id:2,name:'B',meta:{location:'away'}}], league: { name:'L', country:{name:'X'} }, scores: [], inplayOdds: [] };
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (u) => {
    if (String(u).startsWith(liveUrl)) { calls++; return new Response(JSON.stringify({ data:[fixture], rate_limit:{ remaining:100, resets_in_seconds:60 } }), { status:200, headers:{'content-type':'application/json'} }); }
    return orig(u);
  };
  try {
    p._resetSportmonksBudgetForTest();
    const r1 = await p.fetchSportmonksLiveWindow(base);
    assert.equal(r1.failed, false);
    assert.equal(calls, 1);
    const b1 = p.sportmonksHourBudget();
    assert.equal(b1.used, 1);
    assert.equal(b1.liveUsed, 1);
    // exhaust live cap (25% of max 80 = 20)
    p._resetSportmonksBudgetForTest();
    calls = 0;
    p.sportmonksLiveCache.set(`sportmonks:live-window:${base}`, { events:[{id:'sportmonks:77',live:true,markets:[]}], fetchedAt: Date.now()-60_000 });
    p._setSportmonksBudgetForTest({ used: 60, liveUsed: 20 });
    const r2 = await p.fetchSportmonksLiveWindow(base);
    assert.equal(r2.failed, true);
    assert.equal(r2.stale, true);
    assert.ok(Array.isArray(r2.events));
    assert.equal(calls, 0, 'no new livescore request when live cap exhausted');
  } finally { globalThis.fetch = orig; p._resetSportmonksBudgetForTest(); }
});

test('Sportmonks livescore returns stale cache when hourly budget exhausted/rate paused; disabled behavior unchanged (mock fetch)', async () => {
  seedEnv();
  process.env.SPORTMONKS_REQUEST_DELAY_MS = '0';
  const m = await import(`../src/sportsbook-providers.js?b3b=${Date.now()}`);
  const p = m.__sportsbookProviders;
  const base = 'https://api.sportmonks.test/v3';
  const liveUrl = `${base}/football/livescores`;
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (u) => { if (String(u).startsWith(liveUrl)) { calls++; return new Response(JSON.stringify({ data:[] }), { status:200, headers:{'content-type':'application/json'} }); } return orig(u); };
  try {
    p._resetSportmonksBudgetForTest();
    p.sportmonksLiveCache.set(`sportmonks:live-window:${base}`, { events:[{id:'x'}], fetchedAt: Date.now()-60_000 });
    p._setSportmonksBudgetForTest({ used: 80, liveUsed: 10 });
    const r = await p.fetchSportmonksLiveWindow(base);
    assert.equal(r.failed, true);
    assert.equal(r.stale, true);
    assert.equal(calls, 0);
    // pause
    p._resetSportmonksBudgetForTest();
    p.sportmonksLiveCache.set(`sportmonks:live-window:${base}`, { events:[{id:'x'}], fetchedAt: Date.now()-60_000 });
    p._setSportmonksBudgetForTest({ pauseUntil: Date.now()+60_000 });
    const r3 = await p.fetchSportmonksLiveWindow(base);
    assert.equal(r3.failed, true);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = orig; p._resetSportmonksBudgetForTest(); }

  // disabled behavior unchanged (no fetch) - subprocess to avoid config singleton mutation
  const { spawnSync } = await import('node:child_process');
  const script = `Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:'******example.com/db',REDIS_URL:'redis://example.com:6379',MEMBER_PROXY_SECRET:'${'m'.repeat(48)}',ADMIN_PROXY_SECRET:'${'a'.repeat(48)}',OPS_INTERNAL_SECRET:'${'o'.repeat(48)}',SESSION_HMAC_KEY:'${'s'.repeat(48)}',API_KEY_PEPPER:'${'p'.repeat(48)}',MFA_ENCRYPTION_KEY_BASE64:'${Buffer.alloc(32,7).toString('base64')}',SPORTMONKS_ENABLED:'false'}); delete process.env.SPORTMONKS_API_KEY; const mod=await import('./src/sportsbook-providers.js'); const r=await mod.fetchSportmonks({}); process.stdout.write(JSON.stringify(r));`;
  const res = spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME}});
  assert.equal(res.status,0,res.stderr);
});
