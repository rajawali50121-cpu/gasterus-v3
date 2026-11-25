import { randomBytes } from 'node:crypto';

process.env.NODE_ENV ||= 'production';
process.env.SPORTSBOOK_RENDER_WORKER = 'true';
for (const name of [
  'MEMBER_PROXY_SECRET',
  'ADMIN_PROXY_SECRET',
  'OPS_INTERNAL_SECRET',
  'SESSION_HMAC_KEY',
  'API_KEY_PEPPER',
  'MFA_ENCRYPTION_KEY_BASE64'
]) {
  process.env[name] ||= randomBytes(32).toString('base64url');
}

const [{ config }, { redis, connectRedis }, { installSportradarQuotaGuard }] = await Promise.all([
  import('./config.js'),
  import('./redis.js'),
  import('./sportradar-quota-guard.js')
]);

installSportradarQuotaGuard({ redis, connectRedis, config });
console.info(JSON.stringify({
  service: 'sportsbook-render-worker',
  event: 'sportradar-quota-guard-installed',
  monthlyLimit: Number(process.env.SPORTRADAR_MAX_CALLS_PER_30_DAYS || 800),
  maxCallsPerCycle: Number(process.env.SPORTRADAR_MAX_CALLS_PER_CYCLE || 5),
  redisRequired: true
}));
