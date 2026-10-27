import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
});

const core = await import('../src/toto-collector-core.js');
const __totoCollector = { ...core, MARKET_MAP: core.MARKET_MAP };

const source = (code, name, html, extra = {}) => ({ code, name, family: code, ok: true, html, ...extra });

test('setiap pool punya jadwal draw sendiri sehingga collector tidak pernah skip', () => {
  // Key DRAW_SCHEDULE harus persis sama dengan slug. Sebelumnya 'sydney' tidak
  // cocok dengan slug 'sydney-pool' sehingga Sydney jatuh ke WINDOW_DEFAULT dan
  // angka Sydney hanya terkumpul pada jam tertentu.
  const slugs = __totoCollector.MARKET_MAP.map(item => item.slug);
  const missing = slugs.filter(slug => !__totoCollector.DRAW_SCHEDULE[slug]);
  assert.deepEqual(missing, [], `pool tanpa jadwal draw: ${missing.join(', ')}`);
  for (const item of __totoCollector.MARKET_MAP) {
    const [open, close] = __totoCollector.drawWindowFor(item.slug);
    assert.match(open, /^\d{2}:\d{2}$/, `${item.slug} punya jam buka tidak valid`);
    assert.match(close, /^\d{2}:\d{2}$/, `${item.slug} punya jam tutup tidak valid`);
  }
  // Sydney wajib memakai jadwalnya sendiri, bukan default.
  assert.deepEqual(__totoCollector.drawWindowFor('sydney-pool'), ['12:00', '20:00']);
});


test('setiap pool TOTO punya alias VegasNet dan jadwal tutup/result sendiri', () => {
  // Vegasnet tidak mengirim jam, jadi jadwal harus dipetakan agar pasar punya
  // close_at dan bisa dibuka lagi setelah result keluar.
  assert.equal(__totoCollector.MARKET_MAP.length, 45);
  assert.equal(__totoCollector.MARKET_MAP.filter(item => Object.keys(item.sources).length).length, 45);
  assert.equal(__totoCollector.MARKET_MAP.filter(item => !item.sources.vegasnet).length, 0);
  for (const item of __totoCollector.MARKET_MAP) {
    assert.ok(item.schedule?.closeTime, `${item.slug} tanpa jam tutup`);
    assert.ok(item.schedule?.resultTime, `${item.slug} tanpa jam result`);
    assert.equal(item.schedule.timezone, 'Asia/Jakarta');
  }
  // Jadwal harus benar-benar dipakai collector, bukan sekadar menempel di peta.
  const bullseye = __totoCollector.MARKET_MAP.find(item => item.sources.vegasnet === 'Bullseye');
  const decision = __totoCollector.resolveDecision(bullseye, [
    source('vegasnet', 'Vegasnet', '<table><tr><td>Bullseye</td><td>25-09-2026</td><td>1234</td></tr></table>')
  ]);
  assert.ok(decision.schedule?.closeTime);
});

test('Vegasnet spelling mismatch tidak membuat hasil Tennessee unavailable', () => {
  const sourceResult = source('vegasnet', 'Vegasnet', `<table>
    <tr><td>Tennesse Midday</td><td>08-10-2026</td><td>6078</td></tr>
    <tr><td>Tennesse Evening</td><td>08-10-2026</td><td>2086</td></tr>
  </table>`);

  for (const [slug, result] of [['tennessee-mid-pool', '6078'], ['tennessee-eve-pool', '2086']]) {
    const mapping = __totoCollector.MARKET_MAP.find(item => item.slug === slug);
    const decision = __totoCollector.resolveDecision(mapping, [sourceResult]);
    assert.equal(decision.status, 'VERIFIED', `${slug} harus terpetakan`);
    assert.equal(decision.result, result);
    assert.equal(decision.drawDate, '2026-10-08');
  }
});

test('collector parses DataToto table rows without losing leading zeroes', () => {
  const html = `<table><tr><th>Market</th><th>Live</th><th>Tanggal</th><th>Hari</th><th>Result</th></tr>
    <tr><td>Sydlotto</td><td>13:30 WIB</td><td>10-08-2026</td><td>Senin</td><td>0332</td></tr></table>`;
  const obs = __totoCollector.parseObservation(html, 'Sydlotto', { code: 'datatoto', name: 'DataToto' });
  assert.deepEqual(obs, { source: 'datatoto', sourceName: 'DataToto', sourceFamily: 'datatoto', alias: 'Sydlotto', result: '0332', drawDate: '2026-08-10', drawTime: '13:30:00' });
});

test('collector parses PoskoPaito-style spaced result digits', () => {
  const html = `<table><tr><td><button>Hongkong Lotto</button></td><td>09/08/2026<br>Live: 23:20 WIB</td><td>3 7 5 2</td></tr></table>`;
  const obs = __totoCollector.parseObservation(html, 'Hongkong Lotto', { code: 'poskopaito', name: 'PoskoPaito' });
  assert.equal(obs.result, '3752');
  assert.equal(obs.drawDate, '2026-08-09');
  assert.equal(obs.drawTime, '23:20:00');
});

test('collector parses MasterLive card-style result blocks', () => {
  const html = `<section><h3>SYDNEY</h3><div>Senin, 10 Agustus 2026</div><div>Jam Buka 14:00 WIB</div><strong>9086</strong><div>RESULT 3 HARI TERAKHIR</div></section>`;
  const obs = __totoCollector.parseObservation(html, 'SYDNEY', { code: 'masterlive', name: 'MasterLive' });
  assert.equal(obs.result, '9086');
  assert.equal(obs.drawDate, '2026-08-10');
  assert.equal(obs.drawTime, '14:00:00');
});

test('resolver marks result VERIFIED when two or more latest sources agree', () => {
  const mapping = { slug: 'sydney-pool', sources: { poskopaito: 'Sydney Lotto', datatoto: 'Sydlotto', masterlive: 'SYDNEY' } };
  const sources = [
    source('poskopaito', 'PoskoPaito', `<table><tr><td>Sydney Lotto</td><td>10/08/2026</td><td>9 0 8 6</td></tr></table>`),
    source('datatoto', 'DataToto', `<table><tr><td>Sydlotto</td><td>13:30 WIB</td><td>10-08-2026</td><td>Senin</td><td>9086</td></tr></table>`),
    source('masterlive', 'MasterLive', `<h3>SYDNEY</h3><p>Senin, 10 Agustus 2026</p><p>Jam Buka 14:00 WIB</p><b>9086</b>`)
  ];
  const decision = __totoCollector.resolveDecision(mapping, sources);
  assert.equal(decision.status, 'VERIFIED');
  assert.equal(decision.result, '9086');
  assert.equal(decision.drawDate, '2026-08-10');
  assert.equal(decision.confidence, 1);
});

test('resolver refuses overwrite when latest sources conflict', () => {
  const mapping = { slug: 'china-pool', sources: { poskopaito: 'China', datatoto: 'China' } };
  const sources = [
    source('poskopaito', 'PoskoPaito', `<table><tr><td>China</td><td>10/08/2026</td><td>8957</td></tr></table>`),
    source('datatoto', 'DataToto', `<table><tr><td>China</td><td>15:30 WIB</td><td>10-08-2026</td><td>Senin</td><td>3946</td></tr></table>`)
  ];
  const decision = __totoCollector.resolveDecision(mapping, sources);
  assert.equal(decision.status, 'CONFLICT');
  assert.equal(decision.result, null);
});

test('resolver uses SINGLE_SOURCE for a newer result when other source is stale (fail-closed when single-source publish disabled)', () => {
  const mapping = { slug: 'singapore-pool', sources: { poskopaito: 'Singapore', datatoto: 'Singapore' } };
  const sources = [
    source('poskopaito', 'PoskoPaito', `<table><tr><td>Singapore</td><td>10/08/2026</td><td>7777</td></tr></table>`),
    source('datatoto', 'DataToto', `<table><tr><td>Singapore</td><td>17:30 WIB</td><td>09-08-2026</td><td>Minggu</td><td>7137</td></tr></table>`)
  ];
  const decision = __totoCollector.resolveDecision(mapping, sources, { singleSourceCanPublishVerified: false });
  assert.equal(decision.status, 'SINGLE_SOURCE');
  assert.equal(decision.result, '7777');
  assert.equal(decision.drawDate, '2026-08-10');
  // Dengan operator flag ON (default), single-source nyah menjadi VERIFIED display+betting-ready.
  const decisionOn = __totoCollector.resolveDecision(mapping, sources);
  assert.equal(decisionOn.status, 'VERIFIED');
});

test('snapshot-board parser reads exact market label and split digits without colliding with session labels', () => {
  const html = `<section><h4>Hasil Terakhir</h4><div>03 Agustus 2026</div><div>Image</div>
    <div>NEWYORK</div><span>6</span><span>5</span><span>2</span><span>5</span>
    <div>NEWYORK MID</div><span>1</span><span>1</span><span>1</span><span>1</span></section>`;
  const obs = __totoCollector.parseObservation(html, 'NEWYORK', { code: 'cindototo', name: 'CindoToto Public Result Board' });
  assert.equal(obs.result, '6525');
  assert.equal(obs.drawDate, '2026-08-03');
  assert.equal(obs.alias, 'NEWYORK');
  assert.equal(obs.sourceClass, 'CONSENSUS_INPUT');
});

test('snapshot-board parser accepts configured alias variants', () => {
  const mapping = { slug: 'napier-hasti-pool', sources: { sumtoto: ['NAPIER-HASTI', 'NAPIER HASTI'] } };
  const sources = [source('sumtoto', 'SumToto Public Result Board', `<h4>Hasil Terakhir</h4><div>04 Juli 2026</div><div>NAPIER-HASTI</div><div>5</div><div>1</div><div>2</div><div>4</div>`)];
  const observations = __totoCollector.observationsForMapping(mapping, sources);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].result, '5124');
  assert.equal(observations[0].alias, 'NAPIER-HASTI');
});

test('previously unmapped market becomes VERIFIED only when two boards agree for the same snapshot date', () => {
  const mapping = { slug: 'wellington-pool', sources: { cindototo: 'WELLINGTON', sumtoto: ['WELLINGTON'] } };
  const sources = [
    source('cindototo', 'CindoToto Public Result Board', `<h4>Hasil Terakhir</h4><div>19 Agustus 2026</div><div>WELLINGTON</div><div>4</div><div>9</div><div>6</div><div>9</div>`),
    source('sumtoto', 'SumToto Public Result Board', `<h4>Hasil Terakhir</h4><div>19 Agustus 2026</div><div>WELLINGTON</div><div>4969</div>`)
  ];
  const decision = __totoCollector.resolveDecision(mapping, sources);
  assert.equal(decision.status, 'VERIFIED');
  assert.equal(decision.result, '4969');
  assert.equal(decision.drawDate, '2026-08-19');
  assert.equal(decision.sources.length, 2);
});

test('supplemental boards remain fail-closed when they disagree', () => {
  const mapping = { slug: 'wellington-pool', sources: { cindototo: 'WELLINGTON', sumtoto: ['WELLINGTON'] } };
  const sources = [
    source('cindototo', 'CindoToto Public Result Board', `<h4>Hasil Terakhir</h4><div>19 Agustus 2026</div><div>WELLINGTON</div><div>4969</div>`),
    source('sumtoto', 'SumToto Public Result Board', `<h4>Hasil Terakhir</h4><div>19 Agustus 2026</div><div>WELLINGTON</div><div>1111</div>`)
  ];
  const decision = __totoCollector.resolveDecision(mapping, sources);
  assert.equal(decision.status, 'CONFLICT');
  assert.equal(decision.result, null);
});

test('a single supplemental board never becomes VERIFIED when single-source publish is disabled', () => {
  const mapping = { slug: 'delaware-day-pool', sources: { datatoto: 'Delaware Day', miototo: 'DELAWARE DAY' } };
  const sources = [
    source('miototo', 'MioToto Public Result Board', `<h4>Hasil Terakhir</h4><div>19 Agustus 2026</div><div>DELAWARE DAY</div><div>9813</div>`)
  ];
  const decision = __totoCollector.resolveDecision(mapping, sources, { singleSourceCanPublishVerified: false });
  assert.equal(decision.status, 'SINGLE_SOURCE');
  assert.equal(decision.result, '9813');
  // Dengan flag operator ON deterministik EXplisit.
  const decisionOn = __totoCollector.resolveDecision(mapping, sources, { singleSourceCanPublishVerified: true });
  assert.equal(decisionOn.status, 'VERIFIED');
  assert.equal(decisionOn.result, '9813');
});



test('global snapshot board supplements markets using canonical aliases derived from existing mappings', () => {
  const mapping = { name: 'FLORIDA EVE POOL', slug: 'florida-eve-pool', sources: { datatoto: 'Florida Evening', poskopaito: 'Florida Evening' } };
  const sources = [{ ...source('cindototo', 'CindoToto Public Result Board', `<h4>Hasil Terakhir</h4><div>19 Agustus 2026</div><div>FLORIDAEVE</div><div>1</div><div>8</div><div>7</div><div>0</div>`), globalBoard: true }];
  const observations = __totoCollector.observationsForMapping(mapping, sources);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].result, '1870');
  assert.equal(observations[0].alias.replace(/\s+/g, '').toUpperCase(), 'FLORIDAEVE');
});

test('global snapshot aliases keep NEWYORK exact and do not collide with NEWYORK MID', () => {
  const mapping = { name: 'NEWYORK POOL', slug: 'newyork-pool', sources: { datatoto: 'New York' } };
  const sources = [{ ...source('sumtoto', 'SumToto Public Result Board', `<h4>Hasil Terakhir</h4><div>19 Agustus 2026</div><div>NEWYORK MID</div><div>1111</div><div>NEWYORK</div><div>6525</div>`), globalBoard: true }];
  const observations = __totoCollector.observationsForMapping(mapping, sources);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].result, '6525');
});

test('global snapshot aliases recognize public-board Washington typo without fuzzy result matching', () => {
  const mapping = { name: 'WASHINGTONMD POOL', slug: 'washingtonmd-pool', sources: { datatoto: 'Washington Dc Midday' } };
  const sources = [{ ...source('sumtoto', 'SumToto Public Result Board', `<h4>Hasil Terakhir</h4><div>19 Agustus 2026</div><div>WASHIGTONMID</div><div>6</div><div>6</div><div>4</div><div>3</div>`), globalBoard: true }];
  const observations = __totoCollector.observationsForMapping(mapping, sources);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].result, '6643');
});


test('HF13 DOM tokenization preserves nested board labels and split result digits', () => {
  const html = `<main><section><h4><span>Hasil</span> <strong>Terakhir</strong></h4><div><b>19</b> Agustus <i>2026</i></div>
    <article><button><span>WELLINGTON</span></button><div class="result"><span>4</span><span>9</span><span>6</span><span>9</span></div></article></section></main>`;
  const lines = __totoCollector.htmlLines(html);
  assert.ok(lines.includes('WELLINGTON'));
  assert.deepEqual(lines.filter(x => /^\d$/.test(x)).slice(-4), ['4', '9', '6', '9']);
  const obs = __totoCollector.parseObservation(html, 'WELLINGTON', { code: 'cindototo', name: 'CindoToto Public Result Board' });
  assert.equal(obs?.result, '4969');
  assert.equal(obs?.drawDate, '2026-08-19');
});

test('HF13 raw source diagnostics retain stale parsed observations separately from selected latest authority', () => {
  const mapping = { slug: 'x-pool', sources: { poskopaito: 'Example', datatoto: 'Example' } };
  const sources = [
    source('poskopaito', 'PoskoPaito', `<table><tr><td>Example</td><td>10/08/2026</td><td>1234</td></tr></table>`),
    source('datatoto', 'DataToto', `<table><tr><td>Example</td><td>18/08/2026</td><td>5678</td></tr></table>`)
  ];
  const decision = __totoCollector.resolveDecision(mapping, sources, { singleSourceCanPublishVerified: false });
  assert.equal(decision.status, 'SINGLE_SOURCE');
  assert.equal(decision.observations.length, 1);
  assert.equal(decision.allObservations.length, 2);
  const raw = __totoCollector.rawObservationSummaryBySource([decision]);
  assert.deepEqual(raw.get('poskopaito'), { parsedMarkets: 1, latestDrawDate: '2026-08-10' });
  assert.deepEqual(raw.get('datatoto'), { parsedMarkets: 1, latestDrawDate: '2026-08-18' });
});


test('source federation parses Kingkong market cards where result precedes result date', () => {
  const html = `<article><h3>Merida Mor</h3><strong>7521</strong><div>Result: Rabu, 19-08-2026</div><h6>Result Pasaran:</h6><span>16:00 WIB</span></article>`;
  const obs = __totoCollector.parseObservation(html, 'Merida Mor', { code: 'kingkonginfo', name: 'Kingkong Result Board', family: 'kingkongtoto-info.com', parser: 'market-card' });
  assert.equal(obs?.result, '7521');
  assert.equal(obs?.drawDate, '2026-08-19');
  assert.equal(obs?.drawTime, '16:00:00');
  assert.equal(obs?.sourceFamily, 'kingkongtoto-info.com');
});

test('source federation requires two distinct source families, not duplicate mirrors', () => {
  const mapping = { slug: 'wellington-pool', sources: { cindototo: 'WELLINGTON' } };
  const html = `<h4>Hasil Terakhir</h4><div>19 Agustus 2026</div><div>WELLINGTON</div><div>4969</div>`;
  const sources = [
    source('mirror-a', 'Mirror A', html, { family: 'same-provider', parser: 'snapshot-board', globalBoard: true }),
    source('mirror-b', 'Mirror B', html, { family: 'same-provider', parser: 'snapshot-board', globalBoard: true })
  ];
  const decision = __totoCollector.resolveDecision(mapping, sources, { singleSourceCanPublishVerified: false });
  assert.equal(decision.status, 'SINGLE_SOURCE');
  assert.deepEqual(decision.sourceFamilies, ['same-provider']);
});

test('runtime freshness gate rejects old consensus without altering current fresh consensus', () => {
  const fresh = { slug: 'x-pool', status: 'VERIFIED', result: '1234', drawDate: '2026-08-19', confidence: 1 };
  assert.equal(__totoCollector.enforceDecisionFreshness(fresh, { now: new Date('2026-08-19T09:00:00Z'), maxAgeDays: 4 }).status, 'VERIFIED');
  const stale = __totoCollector.enforceDecisionFreshness({ ...fresh, drawDate: '2026-08-10' }, { now: new Date('2026-08-19T09:00:00Z'), maxAgeDays: 4 });
  assert.equal(stale.status, 'STALE_SOURCE');
  assert.equal(stale.confidence, 0);
});

test('source federation global-board parser can address every canonical market when a board exposes their known aliases', () => {
  const aliasesOf = value => Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const rows = [];
  for (const mapping of __totoCollector.MARKET_MAP) {
    const alias = Object.values(mapping.sources || {}).flatMap(aliasesOf)[0] || mapping.name;
    const result = /5d/i.test(alias) ? '12345' : '1234';
    rows.push(`<div>${alias}</div><div>${result}</div>`);
  }
  const board = {
    code: 'cindototo', name: 'Synthetic Federation Board', family: 'synthetic-independent-board', ok: true,
    parser: 'snapshot-board', globalBoard: true,
    html: `<h4>Hasil Terakhir</h4><div>19 Agustus 2026</div>${rows.join('')}`
  };
  const covered = __totoCollector.MARKET_MAP.filter(mapping => __totoCollector.observationsForMapping(mapping, [board]).length === 1);
  assert.equal(covered.length, __totoCollector.MARKET_MAP.length);
});
