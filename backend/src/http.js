import { AppError } from './errors.js';
import { isIP } from 'node:net';
import { config } from './config.js';

function normalizedIp(value) {
  const ip = String(value || '').trim().toLowerCase();
  if (isIP(ip) === 0) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function json(response, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data));
  response.writeHead(status, {'content-type':'application/json; charset=utf-8','content-length':body.length,'cache-control':'no-store',...headers});
  response.end(body);
}
export function ok(response, data, status = 200, headers = {}) { json(response, status, { data }, headers); }
export function fail(response, error) {
  const status = Number(error?.status) || 500;
  const generic = status >= 500 && error?.code !== 'CASINO_UPSTREAM_ERROR';
  const payload = { error: { message: generic ? 'Layanan sedang mengalami gangguan.' : error.message, code: error?.code || 'INTERNAL_ERROR' } };
  if (error?.details && status < 500) payload.error.details = error.details;
  json(response, status, payload);
}
export async function body(request, limit = 131072) {
  const chunks=[]; let size=0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new AppError(413,'Ukuran permintaan terlalu besar.','PAYLOAD_TOO_LARGE'); chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError(400,'Format JSON tidak valid.','INVALID_JSON'); }
}
export function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [decodeURIComponent(x.slice(0,i)),decodeURIComponent(x.slice(i+1))]}));
}
export function bearerToken(request) {
  const match = String(request.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}
export function cookie(name,value,maxAge,secure=true) {
  // SameSite is Strict by default (highest CSRF hardening). Deployments that serve the
  // member frontend from a DIFFERENT site than the API (e.g. static Pages domain ->
  // Railway API) must set COOKIE_SAMESITE=None so the browser stores and sends the
  // session cookie on cross-site fetches (SameSite=None additionally requires Secure,
  // which COOKIE_SECURE=true already guarantees in production). CSRF protection for
  // state-changing routes is independently enforced via the x-csrf-token check.
  const sameSite = String(process.env.COOKIE_SAMESITE ?? '').trim().toUpperCase() === 'NONE' ? 'SameSite=None' : 'SameSite=Strict';
  const parts=[`${name}=${encodeURIComponent(value)}`,'Path=/','HttpOnly',sameSite,`Max-Age=${maxAge}`];
  const domain=String(process.env.COOKIE_DOMAIN??'').trim();
  if(domain)parts.push(`Domain=${domain}`);
  if(secure)parts.push('Secure');
  return parts.join('; ');
}
export function clientIp(request) {
  const remoteAddress = normalizedIp(request.socket.remoteAddress) || 'unknown';
  const trustedProxyIps = config.trustedProxyIps.map(normalizedIp);
  if (!trustedProxyIps.includes(remoteAddress)) return remoteAddress.slice(0, 100);

  const forwardedAddresses = String(request.headers['x-forwarded-for'] || '').split(',');
  const nearestForwardedAddress = normalizedIp(forwardedAddresses.at(-1));
  return (nearestForwardedAddress || remoteAddress).slice(0, 100);
}
export function securityHeaders(response) {
  response.setHeader('x-content-type-options','nosniff');
  response.setHeader('x-frame-options','DENY');
  response.setHeader('referrer-policy','no-referrer');
  response.setHeader('permissions-policy','camera=(), microphone=(), geolocation=()');
  response.setHeader('cross-origin-opener-policy','same-origin');
  response.setHeader('cross-origin-resource-policy','same-origin');
  response.setHeader('content-security-policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  const secureTransport = !['0','false','no','off'].includes(String(process.env.COOKIE_SECURE ?? 'true').toLowerCase());
  if(process.env.NODE_ENV==='production' && secureTransport)response.setHeader('strict-transport-security','max-age=31536000; includeSubDomains');
}
