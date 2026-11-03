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

const { TOTO_SOURCES, collectTotoSources, fetchTotoHtml, validateSourceUrl, __totoSourceFetch } = await import('../src/toto-source-fetch.js');


function snapshotHtml(label = 'WELLINGTON', result = '4969') {
  return `<html><h4>Hasil Terakhir</h4><div>19 Agustus 2026</div><div>${label}</div>${String(result).split('').map(d => `<span>${d}</span>`).join('')}</html>`;
}
function htmlFor(url) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  if (['cindototopusat.com', 'sumtotoking.com', 'miototo.com', 'ikontoto.org', 'kiatoto.net'].includes(host)) return snapshotHtml();
  if (host === 'kingkongtoto-info.com') return `<html><h3>Wellington</h3><strong>4969</strong><div>Result: Rabu, 19-08-2026</div></html>`;
  return `<html>${host}</html>`;
}

function response(url, html, { status = 200, contentLength = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get(name) { return name.toLowerCase() === 'content-length' && contentLength !== null ? String(contentLength) : null; } },
    async text() { return html; }
  };
}

test('TOTO memakai VegasNet sebagai satu-satunya sumber (label & jadwal tampil utuh)', async () => {
  assert.deepEqual(TOTO_SOURCES.map(item => item.code), ['vegasnet']);
  assert.deepEqual(TOTO_SOURCES.map(item => item.url), ['https://widgets.vegasnet.info/result.php']);
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return response(String(url), htmlFor(url));
  };
  const results = await collectTotoSources(fakeFetch);
  const vegasnet = results.find(item => item.code === 'vegasnet');
  assert.equal(results.length, 1);
  assert.equal(vegasnet.ok, true);
  assert.match(vegasnet.contentType, /combined=vegasnet/);
  assert.equal(results.every(item => item.ok && item.bytes > 0), true);
  // Semua show_id aktif harus ikut terpakai, bukan hanya sebagian.
  assert.equal(TOTO_SOURCES[0].showIds.length, 167);
  const requested = calls.map(call => call.url).join(',');
  assert.match(requested, /show_id=1,2,3/);
  assert.match(requested, /171/);
  assert.equal(calls.length, Math.ceil(vegasnet.showIds.length / vegasnet.batchSize));
  assert.equal(calls.every(call => call.options.redirect === 'follow'), true);
  const byHost = new Map(calls.map(call => [new URL(call.url).hostname.replace(/^www\./, ''), call.options.headers]));
  assert.match(byHost.get('widgets.vegasnet.info')['user-agent'], /ASEAN777-Result-Collector\/6\.8\.14/);
});

test('TOTO network adapter menandai sumber gagal tanpa membuang hasil batch lain', async () => {
  const fakeFetch = async url => {
    if (new URL(url).searchParams.has('show_id')) {
      const ids = (new URL(url).searchParams.get('show_id') || '').split(',');
      if (!ids.includes('2')) return response(String(url), '', { status: 503 });
      return response(String(url), '<table><tr><td>Ohio Midday</td><td>12-09-2026</td><td>6364</td></tr></table>');
    }
    return response(String(url), htmlFor(url));
  };
  const results = await collectTotoSources(fakeFetch);
  const vegasnet = results[0];
  // Sebagian batch gagal tetap menghasilkan sumber usable selama ada satu batch sukses.
  assert.equal(vegasnet.ok, true);
  assert.match(vegasnet.html, /Ohio Midday/);
});

test('TOTO source fetch blocks unsafe URLs and cross-host redirects', async () => {
  assert.throws(() => validateSourceUrl('http://poskopaito.com/'), /HTTPS/);
  assert.throws(() => validateSourceUrl('https://127.0.0.1/feed'), /Private/);
  assert.throws(() => validateSourceUrl('https://user:pass@poskopaito.com/'), /credentials/);
  await assert.rejects(
    fetchTotoHtml({ code: 'x', name: 'x', url: 'https://poskopaito.com/' }, async () => response('https://evil.example/feed', '<html>bad</html>')),
    /redirect host blocked/
  );
});


test('vegasnet batched combineAll merges rows and tolerates empty batches', async () => {
  const source = TOTO_SOURCES.find(item => item.code === 'vegasnet');
  const calls = [];
  const result = await __totoSourceFetch.collectOneSource(source, async url => {
    calls.push(String(url));
    const ids = (new URL(url).searchParams.get('show_id') || '').split(',');
    const rows = [];
    if (ids.includes('2')) rows.push('<table><tr><td>Ohio Midday</td><td>12-09-2026</td><td>6364</td></tr></table>');
    if (ids.includes('9')) rows.push('<table><tr><td>Tennesse Midday</td><td>12-09-2026</td><td>1111</td></tr></table>');
    return response(String(url), rows.join('')); // batches without rows -> empty, tolerated
  });
  assert.equal(result.ok, true);
  assert.match(result.contentType, /combined=vegasnet/);
  assert.match(result.html, /Ohio Midday/);
  assert.match(result.html, /1111/);
  const batchCount = Math.ceil(source.showIds.length / source.batchSize);
  assert.equal(calls.length, batchCount);
  assert.equal(calls.every(u => new URL(u).hostname === 'widgets.vegasnet.info'), true);
  assert.match(result.attempts.find(a => a.error).error, /VEGASNET_SHOWID_FAILED/);
});

test('mapLimit bounds concurrent TOTO transport work', async () => {
  let active = 0;
  let peak = 0;
  await __totoSourceFetch.mapLimit([1,2,3,4,5,6], 2, async value => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return value;
  });
  assert.equal(peak, 2);
});
