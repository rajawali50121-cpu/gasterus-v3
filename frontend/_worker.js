// Cloudflare Pages Advanced Mode (_worker.js) — reverse proxy API dan Admin ke backend Railway.
// Semua request non-proxy dilayani dari static assets frontend (env.ASSETS).

const DEFAULT_BACKEND = 'https://web-production-dc041.up.railway.app';

// Edge cache (Cloudflare Cache API) HANYA untuk endpoint publik non-personal ber-GET.
// Jalur lain (/api/member/*, /api/owner/*, /admin-api/*, /internal/*,
// /api/member/sportsbook/stream, betting/quote/cashout/settlement) TIDAK pernah ada di
// peta ini → selalu proxy langsung ke origin tanpa cache.
// /api/public/withdrawal-ticker sengaja TIDAK di-cache: memuat username (privacy).
const PUBLIC_EDGE_CACHE_TTL_SECONDS = {
  '/api/public/markets': 15,
  '/api/public/bank-status': 30,
};

const HOP_BY_HOP = new Set([
  'host', 'cf-ray', 'cf-visitor', 'cdn-loop',
  'cf-worker', 'x-forwarded-proto', 'x-forwarded-host',
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
]);

function shouldProxyToBackend(pathname, env) {
  if (pathname.startsWith('/api/')) return true;
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return true;
  if (pathname === '/admin-api' || pathname.startsWith('/admin-api/')) return true;
  if (pathname.startsWith('/cc-')) return true;
  const customPrefix = env?.ADMIN_PATH_PREFIX;
  if (customPrefix && (pathname === customPrefix || pathname.startsWith(customPrefix + '/'))) return true;
  return false;
}

// Domain kanonik tunggal. www dan domain utama adalah situs yang sama.
const CANONICAL_HOST = 'gasterus.fun';

function canonicalRedirect(request) {
  const url = new URL(request.url);
  if (url.hostname.toLowerCase() !== `www.${CANONICAL_HOST}`) return null;
  const target = new URL(url.toString());
  target.hostname = CANONICAL_HOST;
  target.protocol = 'https:';
  return new Response(null, {
    status: 301,
    headers: {
      location: target.toString(),
      'cache-control': 'no-store',
      'x-redirect-reason': 'canonical-host'
    }
  });
}

export default {
  async fetch(request, env) {
    const redirect = canonicalRedirect(request);
    if (redirect) return redirect;

    const url = new URL(request.url);
    if (!shouldProxyToBackend(url.pathname, env)) {
      return env.ASSETS.fetch(request);
    }

    const backendOrigin = (env?.BACKEND_URL || DEFAULT_BACKEND).replace(/\/+$/, '');

    const edgeTtlSeconds = request.method === 'GET' ? PUBLIC_EDGE_CACHE_TTL_SECONDS[url.pathname] || 0 : 0;
    if (edgeTtlSeconds) {
      try {
        const hit = await caches.default.match(new Request(url.toString()));
        if (hit) {
          const hitHeaders = new Headers(hit.headers);
          hitHeaders.set('x-gasterus-edge', 'HIT');
          return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: hitHeaders });
        }
      } catch { /* cache unavailable — fall through to origin */ }
    }

    const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for');
    const headers = new Headers(request.headers);
    for (const h of HOP_BY_HOP) headers.delete(h);
    headers.set('x-forwarded-proto', 'https');
    headers.set('x-forwarded-host', url.hostname);
    if (clientIp) {
      headers.set('cf-connecting-ip', clientIp);
      headers.set('x-forwarded-for', clientIp);
    }

    let upstream;
    try {
      upstream = await fetch(backendOrigin + url.pathname + url.search, {
        method: request.method,
        headers,
        body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
        redirect: 'manual',
      });
    } catch (fetchErr) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'BACKEND_UNAVAILABLE',
        message: 'Layanan backend sedang dalam pemeliharaan berkala atau proses restart. Silakan refresh beberapa detik lagi.',
        upstream: backendOrigin,
        time: new Date().toISOString()
      }), {
        status: 503,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'retry-after': '10',
          'cache-control': 'no-store'
        }
      });
    }

    const out = new Headers(upstream.headers);
    out.delete('content-encoding');
    out.delete('content-length');
    out.delete('transfer-encoding');

    const loc = out.get('location');
    if (loc && loc.includes(backendOrigin)) {
      out.set('location', loc.replace(backendOrigin, ''));
    }

    // Simpan ke edge Cache API hanya untuk endpoint publik ber-GET sukses (200).
    if (edgeTtlSeconds && upstream.status === 200) {
      out.set('cache-control', `public, max-age=${edgeTtlSeconds}`);
      out.delete('set-cookie');
      out.set('x-gasterus-edge', 'MISS');
      const cacheable = new Response(upstream.body, { status: upstream.status, headers: out });
      try {
        await caches.default.put(new Request(url.toString()), cacheable.clone());
      } catch { /* ignore cache write fail */ }
      return cacheable;
    }

    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
