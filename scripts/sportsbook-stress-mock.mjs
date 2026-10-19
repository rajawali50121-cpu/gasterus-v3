import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import https from 'node:https';

const port = Number(process.env.MOCK_ODDS_PORT || 8443);
const host = process.env.MOCK_ODDS_HOST || '0.0.0.0';
const key = readFileSync(process.env.MOCK_ODDS_KEY || '/tmp/gasterus-stress/mock.key');
const cert = readFileSync(process.env.MOCK_ODDS_CERT || '/tmp/gasterus-stress/mock.crt');
const stats = { calls: 0, activeCalls: 0, maxConcurrentCalls: 0, byApiKey: {}, byProvider: {}, lastPayloadEvents: 0, variants: new Set() };
const firstKickoff = Date.now() + 6 * 60 * 60_000;

function send(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  response.end(body);
}

function buildEvents(variant) {
  const now = Date.now();
  return Array.from({ length: 500 }, (_, index) => {
    const home = `Home ${index}`;
    const away = `Away ${index}`;
    const base = 1.85 + (variant % 5) * 0.01;
    return {
      id: `mock-${String(index).padStart(4, '0')}`,
      sport_key: 'soccer_epl',
      sport_title: 'English Premier League',
      commence_time: new Date(firstKickoff + index * 60_000).toISOString(),
      home_team: home,
      away_team: away,
      completed: false,
      bookmakers: [{
        key: 'local-mock',
        title: 'Local Mock Book',
        last_update: new Date(now).toISOString(),
        markets: [
          { key: 'h2h', last_update: new Date(now).toISOString(), outcomes: [
            { name: home, price: base }, { name: 'Draw', price: 3.4 }, { name: away, price: 4.0 }
          ] },
          { key: 'spreads', last_update: new Date(now).toISOString(), outcomes: [
            { name: home, price: 1.91, point: -0.5 }, { name: away, price: 1.91, point: 0.5 }
          ] },
          { key: 'totals', last_update: new Date(now).toISOString(), outcomes: [
            { name: 'Over', price: 1.91, point: 2.5 }, { name: 'Under', price: 1.91, point: 2.5 }
          ] }
        ]
      }]
    };
  });
}

https.createServer({ key, cert }, (request, response) => {
  const url = new URL(request.url || '/', 'https://mock-odds');
  if (request.method === 'POST' && url.pathname === '/api/internal/sportsbook/ingest') {
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: Number(process.env.CORE_PORT || 18083),
      path: url.pathname,
      method: 'POST',
      headers: request.headers
    }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', error => send(response, 502, { error: error.message }));
    request.pipe(upstream);
    return;
  }
  if (url.pathname === '/__stats') {
    return send(response, 200, { ...stats, variants: [...stats.variants] });
  }
  if (url.pathname === '/__reset') {
    stats.calls = 0;
    stats.activeCalls = 0;
    stats.maxConcurrentCalls = 0;
    stats.byApiKey = {};
    stats.byProvider = {};
    stats.lastPayloadEvents = 0;
    stats.variants.clear();
    return send(response, 200, { reset: true });
  }
  if (request.method === 'GET' && /^\/v3\/football\/fixtures\/date\/\d{4}-\d{2}-\d{2}$/.test(url.pathname)) {
    stats.calls += 1;
    stats.activeCalls += 1;
    stats.maxConcurrentCalls = Math.max(stats.maxConcurrentCalls, stats.activeCalls);
    stats.byApiKey[url.searchParams.get('api_token') || 'unknown'] = (stats.byApiKey[url.searchParams.get('api_token') || 'unknown'] || 0) + 1;
    stats.byProvider.sportmonks = (stats.byProvider.sportmonks || 0) + 1;
    const kickoff = new Date(firstKickoff);
    const now = new Date().toISOString();
    stats.lastPayloadEvents = 1;
    stats.activeCalls -= 1;
    return send(response, 200, {
      data: [{
        id: 'mock-sportmonks-0',
        starting_at: kickoff.toISOString(),
        starting_at_timestamp: Math.floor(kickoff.getTime() / 1000),
        state: { name: 'Not Started', short_name: 'NS' },
        participants: [
          { id: 1, name: 'Home 0', meta: { location: 'home' } },
          { id: 2, name: 'Away 0', meta: { location: 'away' } }
        ],
        league: { name: 'English Premier League', country: { name: 'England' } },
        odds: [
          { id: 'sm-home', market_id: 1, market_description: 'Match Result', label: 'Home', value: '1.86', latest_bookmaker_update: now },
          { id: 'sm-draw', market_id: 1, market_description: 'Match Result', label: 'Draw', value: '3.40', latest_bookmaker_update: now },
          { id: 'sm-away', market_id: 1, market_description: 'Match Result', label: 'Away', value: '4.00', latest_bookmaker_update: now }
        ]
      }],
      pagination: { has_more: false }
    });
  }
  if (!/^\/v4\/sports\/[^/]+\/odds$/.test(url.pathname)) {
    return send(response, 404, { error: 'mock route not found' });
  }
  stats.calls += 1;
  stats.activeCalls += 1;
  stats.maxConcurrentCalls = Math.max(stats.maxConcurrentCalls, stats.activeCalls);
  const apiKey = url.searchParams.get('apiKey') || 'unknown';
  stats.byApiKey[apiKey] = (stats.byApiKey[apiKey] || 0) + 1;
  stats.byProvider['the-odds-api'] = (stats.byProvider['the-odds-api'] || 0) + 1;
  const variant = stats.calls % 12;
  stats.variants.add(variant);
  const events = buildEvents(variant);
  stats.lastPayloadEvents = events.length;
  setTimeout(() => {
    stats.activeCalls -= 1;
    send(response, 200, events);
  }, Math.max(0, Number(process.env.MOCK_ODDS_DELAY_MS) || 0));
}).listen(port, host, () => {
  console.log(JSON.stringify({ service: 'mock-odds-api', port, eventCount: 500 }));
});