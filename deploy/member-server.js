import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { extname, resolve, sep } from 'node:path';

const APP = 'member';
const DEFAULT_PORT = 8082;
const ROOT = resolve(process.cwd());
const PUBLIC = existsSync(resolve(ROOT, 'frontend')) ? resolve(ROOT, 'frontend') : resolve(ROOT, '../frontend');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function readSetting(name, fallback = '') {
  const file = String(process.env[`${name}_FILE`] ?? '').trim();
  if (file) {
    try { return readFileSync(file, 'utf8').trim(); }
    catch { throw new Error(`Unable to read secret file for ${name}`); }
  }
  return String(process.env[name] ?? fallback).trim();
}
function required(name, fallback = '') {
  const value = readSetting(name, fallback);
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
}
function port(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a valid TCP port`);
  return value;
}

const PORT = port('PORT', DEFAULT_PORT);
const HOST = required('HOST', '0.0.0.0');
const CORE_HOST = required('CORE_HOST');
const CORE_PORT = port('CORE_PORT', 8080);
const PUBLIC_PROTO = readSetting('PUBLIC_PROTO', IS_PRODUCTION ? 'https' : 'http').toLowerCase();
if (!['http', 'https'].includes(PUBLIC_PROTO)) throw new Error('PUBLIC_PROTO must be http or https');
const SECRET = required('MEMBER_PROXY_SECRET');
if (SECRET.length < 32) throw new Error('MEMBER_PROXY_SECRET must contain at least 32 characters');
function publicUrl(name) {
  const value = readSetting(name);
  if (!value) return '';
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be a valid URL`); }
  const allowed = IS_PRODUCTION ? ['https:'] : ['http:', 'https:'];
  if (!allowed.includes(parsed.protocol)) throw new Error(`${name} must use ${IS_PRODUCTION ? 'https' : 'http or https'}`);
  if (parsed.username || parsed.password) throw new Error(`${name} must not contain URL credentials`);
  return parsed.href;
}
const MEMBER_SUPPORT_URL = publicUrl('MEMBER_SUPPORT_URL');
const MEMBER_WHATSAPP_URL = publicUrl('MEMBER_WHATSAPP_URL');
const MEMBER_TELEGRAM_URL = publicUrl('MEMBER_TELEGRAM_URL');
const MEMBER_API_BASE_URL = publicUrl('MEMBER_API_BASE_URL');
// Canonical origins that are ALWAYS whitelisted. These can never be removed by
// environment variables so a fresh deploy works without any env hand-tuning.
// Env value (ALLOWED_MEMBER_ORIGIN), when present, MERGES with these rather
// than overriding them entirely.
const FORCED_ORIGINS = new Set([
  'https://www.gasterus.fun',
  'https://gasterus.fun',
  'https://preview.gasterus.fun',
]);
const ALLOWED_MEMBER_ORIGINS = new Set(
  String(process.env.ALLOWED_MEMBER_ORIGIN ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);
// Guarantee the first-party / preview origins are always accepted.
for (const o of FORCED_ORIGINS) ALLOWED_MEMBER_ORIGINS.add(o);
console.log('[member] allowed origin', IS_PRODUCTION ? 'PROD' : 'DEV', [...ALLOWED_MEMBER_ORIGINS].join(', '));
function corsHeaders(request) {
  const origin = String(request.headers.origin ?? '');
  if (!origin || !ALLOWED_MEMBER_ORIGINS.has(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-csrf-token, idempotency-key, last-event-id',
    'access-control-max-age': '600',
    vary: 'Origin'
  };
}

const contentTypes = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
});
const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade']);
const responseHidden = new Set(['server', 'x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version', 'x-runtime', 'via', 'source-map', 'x-source-map', 'x-provider', 'x-upstream', 'x-backend']);
const requestAllowed = new Set(['accept', 'accept-language', 'content-type', 'content-length', 'cookie', 'user-agent', 'origin', 'referer', 'authorization', 'x-csrf-token', 'idempotency-key', 'last-event-id', 'x-sportsbook-timestamp', 'x-sportsbook-signature']);
const blockedPublicPath = /(?:^|\/)(?:\.|node_modules(?:\/|$))|(?:\.map|\.env|\.log|\.bak|\.old|\.sql|\.sqlite|\.db|\.pem|\.key|\.crt|\.yaml|\.yml|\.toml|\.ini|\.md|package(?:-lock)?\.json)$/i;

function sha256(value) { return createHash('sha256').update(value).digest('base64'); }
function inlineScriptHashes(html) {
  const hashes = [];
  const pattern = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(pattern)) hashes.push(`'sha256-${sha256(match[1])}'`);
  return [...new Set(hashes)];
}
function cspForHtml(html) {
  const scripts = ["'self'", ...inlineScriptHashes(html)].join(' ');
  const directives = [
    "default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-src 'none'", "frame-ancestors 'none'",
    "form-action 'self'", `script-src ${scripts}`, "script-src-attr 'none'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:", "font-src 'self' data: https://fonts.gstatic.com", "connect-src 'self'", "media-src 'self'", "worker-src 'self' blob:",
    "manifest-src 'self'"
  ];
  if (PUBLIC_PROTO === 'https') directives.push("upgrade-insecure-requests");
  return directives.join('; ');
}
function applySecurityHeaders(response, csp = null) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()');
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
  response.setHeader('origin-agent-cluster', '?1');
  response.setHeader('x-dns-prefetch-control', 'off');
  response.setHeader('x-permitted-cross-domain-policies', 'none');
  response.setHeader('content-security-policy', csp || "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if (IS_PRODUCTION && PUBLIC_PROTO === 'https') response.setHeader('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
}
function send(response, statusCode, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  const buffer = Buffer.from(body);
  response.writeHead(statusCode, { 'content-type': contentType, 'content-length': buffer.length, 'cache-control': 'no-store', ...headers });
  response.end(buffer);
}
function serveStatic(request, response, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return send(response, 400, 'Bad request'); }
  if (decoded.includes('\0') || blockedPublicPath.test(decoded)) return send(response, 404, 'Not found');
  const relative = decoded === '/' ? '/index.html' : decoded;
  let file = resolve(PUBLIC, `.${relative}`);
  if (!(file === PUBLIC || file.startsWith(`${PUBLIC}${sep}`))) return send(response, 404, 'Not found');
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (existsSync(`${file}.html`) && statSync(`${file}.html`).isFile()) {
      file = `${file}.html`;
    } else {
      return send(response, 404, 'Not found');
    }
  }
  const extension = extname(file).toLowerCase();
  const type = contentTypes[extension];
  if (!type) return send(response, 404, 'Not found');
  const stat = statSync(file);
  if (extension === '.html') {
    const html = readFileSync(file, 'utf8');
    applySecurityHeaders(response, cspForHtml(html));
    return send(response, 200, request.method === 'HEAD' ? '' : html, type, { 'cache-control': 'no-store' });
  }
  applySecurityHeaders(response, cspForHtml(''));
  const cacheControl = ['.css', '.js'].includes(extension) ? 'no-store' : 'public, max-age=86400';
  response.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff'
  });
  if (request.method === 'HEAD') return response.end();
  createReadStream(file).pipe(response);
}
function clientAddress(request) {
  for (const value of [request.headers['x-real-ip'], request.headers['cf-connecting-ip']]) {
    const candidate = String(value ?? '').split(',')[0].trim();
    if (isIP(candidate)) return candidate;
  }
  return String(request.socket.remoteAddress ?? '').slice(0, 100);
}
function forwardedHeaders(request) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (requestAllowed.has(lower) && value !== undefined) headers[lower] = value;
  }
  headers.host = `${CORE_HOST}:${CORE_PORT}`;
  headers['x-internal-proxy-secret'] = SECRET;
  headers['x-forwarded-for'] = clientAddress(request);
  headers['x-forwarded-host'] = String(request.headers.host ?? '').slice(0, 255);
  headers['x-forwarded-proto'] = PUBLIC_PROTO;
  return headers;
}
function proxy(request, response, path) {
  applySecurityHeaders(response);
  const cors = corsHeaders(request);
  const isRealtimeStream = path.startsWith('/api/member/sportsbook/stream');
  const upstream = httpRequest({ hostname: CORE_HOST, port: CORE_PORT, path, method: request.method, headers: forwardedHeaders(request), timeout: isRealtimeStream ? 0 : 30000 }, upstreamResponse => {
    const headers = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      const lower = name.toLowerCase();
      if (!hopByHop.has(lower) && !responseHidden.has(lower) && value !== undefined) headers[lower] = value;
    }
    if (cors) { for (const [name, value] of Object.entries(cors)) headers[name.toLowerCase()] = value; }
    response.writeHead(upstreamResponse.statusCode ?? 502, headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error', () => {
    if (response.headersSent) {
      if (!response.writableEnded) response.end();
      return;
    }
    send(response, 502, JSON.stringify({ error: { message: 'Layanan sementara tidak tersedia.' } }), 'application/json; charset=utf-8');
  });
  request.pipe(upstream);
}
function checkCore(response) {
  const upstream = httpRequest({ hostname: CORE_HOST, port: CORE_PORT, path: '/ready', method: 'GET', headers: { 'x-internal-proxy-secret': SECRET }, timeout: 3000 }, result => {
    result.resume();
    send(response, (result.statusCode ?? 500) < 400 ? 200 : 503, JSON.stringify({ status: (result.statusCode ?? 500) < 400 ? 'ready' : 'unavailable' }), 'application/json; charset=utf-8');
  });
  upstream.on('timeout', () => upstream.destroy(new Error('Readiness timeout')));
  upstream.on('error', () => send(response, 503, JSON.stringify({ status: 'unavailable' }), 'application/json; charset=utf-8'));
  upstream.end();
}

const server = createServer((request, response) => {
  applySecurityHeaders(response);
  const url = new URL(request.url ?? '/', 'http://internal.invalid');
  if (url.pathname === '/health') return send(response, 200, JSON.stringify({ status: 'ok' }), 'application/json; charset=utf-8');
  if (url.pathname === '/runtime-config.js') {
    const config = { supportUrl: MEMBER_SUPPORT_URL, whatsappUrl: MEMBER_WHATSAPP_URL, telegramUrl: MEMBER_TELEGRAM_URL, apiBaseUrl: MEMBER_API_BASE_URL };
    return send(response, 200, `window.ASEAN_RUNTIME_CONFIG=Object.freeze(${JSON.stringify(config)});\n`, 'text/javascript; charset=utf-8');
  }
  if (url.pathname === '/ready') return checkCore(response);
  if (request.method === 'OPTIONS' && (url.pathname.startsWith('/api/member/') || url.pathname.startsWith('/member-api/'))) {
    const cors = corsHeaders(request);
    if (!cors) return send(response, 403, 'Origin not allowed');
    return send(response, 204, '', 'text/plain; charset=utf-8', { ...cors, 'access-control-max-age': '600' });
  }
  const hiddenManagementPath = /^(?:\/admin(?:\/|$)|\/owner(?:\/|$)|\/dashboard(?:\/|$)|\/login-admin(?:\/|$)|\/api\/(?:owner|admin)(?:\/|$))/i;
  if (hiddenManagementPath.test(url.pathname)) return send(response, 404, 'Not found');
  if (url.pathname === '/api/internal/sportsbook/ingest') {
    if (request.method !== 'POST') return send(response, 405, 'Method not allowed');
    return proxy(request, response, `${url.pathname}${url.search}`);
  }
  if (url.pathname.startsWith('/api/member/') || url.pathname.startsWith('/member-api/')) return proxy(request, response, `${url.pathname}${url.search}`);
  if (url.pathname.startsWith('/api/public/')) return proxy(request, response, `${url.pathname}${url.search}`);
  if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) return send(response, 405, 'Method not allowed');
  serveStatic(request, response, url.pathname);
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 30000;
server.maxHeadersCount = 80;
server.listen(PORT, HOST, () => console.log(`${APP} service ready`));
// memory guard — graceful self-recycle before OS OOM-kill. Reads the per-child
// heap cap injected by launcher NODE_OPTIONS (or MEMBER_HEAP_MB), and exits
// cleanly if heap stays above 90% for 3 consecutive checks so launcher
// recover() restarts ONLY this service instead of the whole container.
(function memberMemoryGuard() {
  const optMatch = String(process.env.NODE_OPTIONS || '').match(/--max-old-space-size=(\d+)/);
  const heapMB = optMatch ? Number(optMatch[1]) : (Number(process.env.MEMBER_HEAP_MB) || 224);
  const highWater = Math.floor(heapMB * 0.9 * 1024 * 1024);
  let highCount = 0;
  const timer = setInterval(() => {
    if (process.memoryUsage().heapUsed >= highWater) {
      highCount += 1;
      if (highCount >= 3) {
        clearInterval(timer);
        console.error(`memory-guard[member] recycling: heap sustained above ${heapMB}MB — graceful restart via launcher`);
        return shutdown();
      }
    } else {
      highCount = 0;
    }
  }, 60000);
  timer.unref();
})();
function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
