import autocannon from 'autocannon';
import { randomInt } from 'node:crypto';

const url = process.env.STRESS_EVENTS_URL || 'http://127.0.0.1:18083/api/member/sportsbook/events';
const secret = process.env.STRESS_MEMBER_PROXY_SECRET;
const amount = Number(process.env.STRESS_REQUESTS || 100_000);
if (!secret || secret.length < 32) throw new Error('STRESS_MEMBER_PROXY_SECRET must be set to 32+ characters.');

let completedRequests = 0;
let largeLimitRequests = 0;
const maxLargeLimitRequests = Math.floor(amount * 0.2);
const responseTimes = [];
const run = autocannon({
  url,
  connections: Number(process.env.STRESS_CONNECTIONS || 100),
  amount,
  pipelining: 1,
  requests: [{
    method: 'GET',
    path: '/api/member/sportsbook/events',
    headers: { 'x-internal-proxy-secret': secret },
    setupRequest(request) {
      const id = randomInt(1024);
      const params = new URLSearchParams();
      params.set('sport', ['Football', 'basketball', ''][randomInt(3)]);
      params.set('live', ['true', 'false', 'wild'][randomInt(3)]);
      params.set('q', ['%_[]', `team-${id}`, 'x'.repeat(randomInt(32))][randomInt(3)]);
      params.set('offset', ['0', '-5', 'not-a-number', String(randomInt(7000))][randomInt(4)]);
      const useLargeLimit = largeLimitRequests < maxLargeLimitRequests && randomInt(5) === 0;
      if (useLargeLimit) largeLimitRequests += 1;
      params.set('limit', useLargeLimit ? ['500', '999999'][randomInt(2)] : ['1', '5', '10', '30', '-1'][randomInt(5)]);
      params.set('__wild', `value-${id}-[]*`);
      if (randomInt(10) === 0) params.append('limit', 'duplicate');
      const ipId = randomInt(1024);
      request.path = `/api/member/sportsbook/events?${params}`;
      request.headers['x-forwarded-for'] = `10.31.${Math.floor(ipId / 256)}.${(ipId % 254) + 1}`;
      return request;
    }
  }]
});

run.on('response', (_client, _statusCode, _responseBytes, responseTime) => {
  responseTimes.push(responseTime);
  completedRequests += 1;
  if (completedRequests % 1000 === 0) console.log(`AUTOCANNON_PROGRESS ${completedRequests}/${amount}`);
});
run.on('done', result => {
  responseTimes.sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(responseTimes.length * 0.95) - 1);
  console.log(JSON.stringify({
    requests: result.requests,
    durationSeconds: result.duration,
    largeLimitRequests,
    largeLimitPercent: amount ? largeLimitRequests / amount * 100 : 0,
    p95Ms: responseTimes[p95Index] ?? null,
    latencyMs: result.latency,
    statusCodes: result.statusCodeStats,
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: result.non2xx
  }));
});
run.on('error', error => {
  console.error(error);
  process.exitCode = 1;
});