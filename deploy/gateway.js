import { createServer, request as httpRequest } from 'node:http';
import { isIP } from 'node:net';

const HOST = String(process.env.HOST || '0.0.0.0');
const PORT = Number(process.env.PORT || 8080);
const MEMBER_PORT = Number(process.env.MEMBER_INTERNAL_PORT || 8082);
const ADMIN_PORT = Number(process.env.ADMIN_INTERNAL_PORT || 8081);
const MEMBER_HOST = normalizeHost(process.env.MEMBER_PUBLIC_HOST || '');
const ADMIN_HOST = normalizeHost(process.env.ADMIN_PUBLIC_HOST || '');
const PATH_MODE = String(process.env.ADMIN_PATH_MODE ?? (ADMIN_HOST ? 'false' : 'true')).toLowerCase() !== 'false';
// R6.94 security hardening: admin UI prefix is configurable and obfuscated so scanners
// cannot discover the back office at the predictable /admin/ path. Legacy /admin links
// permanently redirect to the configured prefix.
const ADMIN_PATH_PREFIX = (() => {
  const raw = String(process.env.ADMIN_PATH_PREFIX ?? '/cc-x7k9').trim();
  if (!/^\/[a-z0-9/_-]*[a-z0-9_-]$/i.test(raw) || raw.toLowerCase().startsWith('/admin')) {
    throw new Error('ADMIN_PATH_PREFIX must look like /cc-x7k9 (letters, digits, -, _, /) and must not start with /admin');
  }
  return raw;
})();
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
// R6.94 gateway-level login throttling: max 5 FAILED admin login attempts per IP per
// 15 minutes. Core already enforces its own limit; this stops credential stuffing
// before it ever reaches the backend.
const ADMIN_LOGIN_LIMIT = Math.max(1, Number(process.env.ADMIN_LOGIN_FAILED_LIMIT || 5));
const ADMIN_LOGIN_WINDOW_MS = Math.max(60000, Number(process.env.ADMIN_LOGIN_WINDOW_SECONDS || 900) * 1000);
const loginFailures = new Map();
function loginIp(req) { return clientAddress(req).slice(0, 100); }
function loginBlocked(ip) {
  const entry = loginFailures.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) { loginFailures.delete(ip); return false; }
  return entry.count >= ADMIN_LOGIN_LIMIT;
}
function recordLoginFailure(ip) {
  if (!ip) return;
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || now > entry.resetAt) loginFailures.set(ip, { count: 1, resetAt: now + ADMIN_LOGIN_WINDOW_MS });
  else entry.count += 1;
  if (loginFailures.size > 10000) { for (const [key, value] of loginFailures) if (now > value.resetAt) loginFailures.delete(key); }
}
function clearLoginFailures(ip) { if (ip) loginFailures.delete(ip); }

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be a valid TCP port');
if (MEMBER_HOST && ADMIN_HOST && MEMBER_HOST === ADMIN_HOST) throw new Error('MEMBER_PUBLIC_HOST and ADMIN_PUBLIC_HOST must be different');

const hopByHop = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade']);
function normalizeHost(value) { return String(value || '').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/$/,'').split(':')[0]; }
function requestHost(req) { return normalizeHost(req.headers.host || ''); }
function beginResponse(res, status, headers) {
  if (res.writableEnded || res.destroyed) return false;
  if (res.headersSent) { res.destroy(); return false; }
  res.writeHead(status, headers);
  return true;
}
function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  if (!beginResponse(res,status,{'content-type':'application/json; charset=utf-8','content-length':data.length,'cache-control':'no-store'})) return false;
  res.end(data);
  return true;
}
function text(res, status, body) {
  const data = Buffer.from(body);
  if (!beginResponse(res,status,{'content-type':'text/plain; charset=utf-8','content-length':data.length,'cache-control':'no-store'})) return false;
  res.end(data);
  return true;
}
function proxyFailure(res) {
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  json(res,502,{error:{message:'Layanan sementara tidak tersedia.'}});
}
function clientAddress(req) {
  for (const raw of [req.headers['cf-connecting-ip'], req.headers['x-real-ip'], req.headers['x-forwarded-for']]) {
    const value = String(raw || '').split(',')[0].trim();
    if (isIP(value)) return value;
  }
  return String(req.socket.remoteAddress || '').slice(0,100);
}
function proxy(req, res, targetPort, path, onStatus) {
  const headers = {...req.headers};
  headers.host = req.headers.host || 'localhost';
  headers['x-forwarded-for'] = clientAddress(req);
  headers['x-forwarded-proto'] = String(req.headers['x-forwarded-proto'] || (IS_PRODUCTION ? 'https' : 'http')).split(',')[0].trim();
  const upstream = httpRequest({hostname:'127.0.0.1', port:targetPort, method:req.method, path, headers, timeout:30000}, upstreamRes => {
    const out = {};
    for (const [name,value] of Object.entries(upstreamRes.headers)) if (!hopByHop.has(name.toLowerCase()) && value !== undefined) out[name] = value;
    if (typeof onStatus === 'function') { try { onStatus(upstreamRes.statusCode || 502); } catch {} }
    if (!beginResponse(res,upstreamRes.statusCode || 502,out)) { upstreamRes.destroy(); return; }
    upstreamRes.on('aborted',()=>{ if (!res.writableEnded && !res.destroyed) res.destroy(); });
    upstreamRes.on('error',()=>{ if (!res.writableEnded && !res.destroyed) res.destroy(); });
    upstreamRes.pipe(res);
  });
  upstream.on('timeout',()=>upstream.destroy(new Error('upstream timeout')));
  upstream.on('error',()=>proxyFailure(res));
  req.on('aborted',()=>{ if (!upstream.destroyed) upstream.destroy(); });
  req.on('error',()=>{ if (!upstream.destroyed) upstream.destroy(); });
  res.on('close',()=>{ if (!res.writableEnded && !upstream.destroyed) upstream.destroy(); });
  req.pipe(upstream);
}
async function localReady(port, path='/ready') {
  try { const r = await fetch(`http://127.0.0.1:${port}${path}`, {signal:AbortSignal.timeout(2500)}); return r.ok; }
  catch { return false; }
}

const server = createServer(async (req,res) => {
  const url = new URL(req.url || '/', 'http://gateway.internal');
  if (url.pathname === '/healthz') {
    const coreHealthy = await localReady(Number(process.env.CORE_INTERNAL_PORT || 8083), '/healthz');
    return json(res, coreHealthy ? 200 : 503, {status: coreHealthy ? 'ok' : 'degraded'});
  }
  if (url.pathname === '/readyz') {
    const [member,admin,core] = await Promise.all([localReady(MEMBER_PORT),localReady(ADMIN_PORT),localReady(Number(process.env.CORE_INTERNAL_PORT || 8083))]);
    return json(res, member && admin && core ? 200 : 503, {status:member&&admin&&core?'ready':'degraded', member, admin, core, mode: PATH_MODE?'single-domain':'host-isolated', deploymentId:process.env.RAILWAY_DEPLOYMENT_ID||null});
  }

  const host = requestHost(req);
  if (ADMIN_HOST && host === ADMIN_HOST) {
    if (url.pathname.startsWith('/admin-api/')) return proxy(req,res,ADMIN_PORT,`${url.pathname.replace(/^\/admin-api/,'/api')}${url.search}`);
    return proxy(req,res,ADMIN_PORT,`${url.pathname}${url.search}`);
  }
  // R6.94 hardening: member host must never expose raw admin APIs.
  // When no dedicated ADMIN_HOST is set (single-domain), the obfuscated admin path prefix
  // must remain reachable so the back-office is not locked out entirely.
  if (MEMBER_HOST && host === MEMBER_HOST) {
    const prefixRe = new RegExp(`^${ADMIN_PATH_PREFIX.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:/|$)`,'i');
    // Raw admin API routes are always blocked on the member host.
    if (/^\/(?:admin-api(?:\/|$)|api\/owner(?:\/|$))/i.test(url.pathname)) return text(res,404,'Not found');
    // /admin → redirect to obfuscated prefix (only when sharing domain with member)
    if (/^\/admin(?:\/|$)/i.test(url.pathname)) {
      if (!ADMIN_HOST) {
        const rest = url.pathname.slice('/admin'.length) || '/';
        res.writeHead(308,{location:`${ADMIN_PATH_PREFIX}${rest}${url.search}`,'cache-control':'no-store'}); return res.end();
      }
      return text(res,404,'Not found');
    }
    // ADMIN_PATH_PREFIX → proxy to admin server (only when no dedicated ADMIN_HOST)
    if (prefixRe.test(url.pathname)) {
      if (!ADMIN_HOST) {
        if (url.pathname === ADMIN_PATH_PREFIX) { res.writeHead(308,{location:`${ADMIN_PATH_PREFIX}/`,'cache-control':'no-store'}); return res.end(); }
        const stripped = url.pathname.slice(ADMIN_PATH_PREFIX.length) || '/';
        return proxy(req,res,ADMIN_PORT,`${stripped}${url.search}`);
      }
      return text(res,404,'Not found');
    }
    return proxy(req,res,MEMBER_PORT,`${url.pathname}${url.search}`);
  }

  if (!PATH_MODE && (MEMBER_HOST || ADMIN_HOST)) return text(res,421,'Misdirected Request');

  // Single-domain mode: member at /, obfuscated admin UI at ADMIN_PATH_PREFIX.
  // Legacy /admin links redirect permanently to the configured prefix so old
  // bookmarks keep working while scanners probing /admin/ reveal nothing new.
  if (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname.startsWith('/admin/')) {
    const rest = url.pathname === '/admin' ? '' : url.pathname.slice('/admin'.length);
    res.writeHead(308,{location:`${ADMIN_PATH_PREFIX}${rest || '/'}${url.search}`,'cache-control':'no-store'}); return res.end();
  }
  if (url.pathname === ADMIN_PATH_PREFIX) { res.writeHead(308,{location:`${ADMIN_PATH_PREFIX}/`,'cache-control':'no-store'}); return res.end(); }
  if (url.pathname === '/admin-api/owner/login') {
    const ip = loginIp(req);
    if (req.method === 'POST') {
      if (loginBlocked(ip)) return json(res,429,{error:{message:'Terlalu banyak percobaan login gagal. Coba lagi dalam 15 menit.',code:'LOGIN_RATE_LIMITED'}});
      return proxy(req,res,ADMIN_PORT,`${url.pathname.replace(/^\/admin-api/,'/api')}${url.search}`,status => {
        if (status === 401 || status === 403) recordLoginFailure(ip); else if (status >= 200 && status < 300) clearLoginFailures(ip);
      });
    }
  }
  if (url.pathname.startsWith('/admin-api/')) return proxy(req,res,ADMIN_PORT,`${url.pathname.replace(/^\/admin-api/,'/api')}${url.search}`);
  if (url.pathname.startsWith(`${ADMIN_PATH_PREFIX}/`)) {
    const stripped = url.pathname.slice(ADMIN_PATH_PREFIX.length) || '/';
    return proxy(req,res,ADMIN_PORT,`${stripped}${url.search}`);
  }
  if (/^\/api\/owner(?:\/|$)/i.test(url.pathname)) return text(res,404,'Not found');
  return proxy(req,res,MEMBER_PORT,`${url.pathname}${url.search}`);
});
server.keepAliveTimeout=65000; server.headersTimeout=66000; server.requestTimeout=30000; server.maxHeadersCount=100;
server.listen(PORT,HOST,()=>console.log(JSON.stringify({service:'gasterus-app-gateway',status:'ready',host:HOST,port:PORT,adminMode:PATH_MODE?'path':'host',adminPathPrefix:PATH_MODE?ADMIN_PATH_PREFIX:null,loginRateLimit:{failedAttempts:ADMIN_LOGIN_LIMIT,windowSeconds:ADMIN_LOGIN_WINDOW_MS/1000}})));
function shutdown(){server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',shutdown); process.on('SIGINT',shutdown);
