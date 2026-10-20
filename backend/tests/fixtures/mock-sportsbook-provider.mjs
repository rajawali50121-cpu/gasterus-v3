import { createServer } from 'node:http';

let match = { status: 'NS', home: 1, away: 0, suspended: false };
const startAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
const fixtureId = 987654321;

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (request.method === 'POST' && url.pathname === '/_control/result') {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    let input;
    try { input = JSON.parse(raw); }
    catch { return send(response, 400, { error: 'invalid-json' }); }
    const allowed = new Set(['NS', 'FT', 'POSTP', 'CANC', 'SUSP']);
    if (!allowed.has(input.status) || !Number.isInteger(input.home) || !Number.isInteger(input.away)) {
      return send(response, 400, { error: 'invalid-result' });
    }
    match = { ...match, status: input.status, home: input.home, away: input.away };
    return send(response, 200, { updated: true });
  }

  if (request.method !== 'GET' || !/^\/v3\/football\/fixtures\/date\/\d{4}-\d{2}-\d{2}$/.test(url.pathname)) {
    return send(response, 404, { error: 'not-found' });
  }

  const stateNames = { NS: 'Not Started', FT: 'Full Time', POSTP: 'Postponed', CANC: 'Cancelled', SUSP: 'Suspended' };
  const finished = match.status === 'FT';
  const fixture = {
    id: fixtureId,
    starting_at: startAt.toISOString(),
    starting_at_timestamp: Math.floor(startAt.getTime() / 1000),
    state: { short_name: match.status, name: stateNames[match.status] },
    participants: [
      { name: 'Local Mock Home', meta: { location: 'home' } },
      { name: 'Local Mock Away', meta: { location: 'away' } }
    ],
    league: { name: 'Local Integration League', country: { name: 'Local Test' } },
    scores: finished ? [
      { description: 'CURRENT', score: { home: match.home, away: match.away } },
      { description: '1ST HALF', score: { home: 1, away: 0 } }
    ] : [],
    odds: [
      { id: 1, market_id: 1, market_description: 'Fulltime Result', label: 'Home', value: 2.0, stopped: match.suspended },
      { id: 2, market_id: 1, market_description: 'Fulltime Result', label: 'Draw', value: 3.2, stopped: match.suspended },
      { id: 3, market_id: 1, market_description: 'Fulltime Result', label: 'Away', value: 3.8, stopped: match.suspended }
    ]
  };
  send(response, 200, { data: [fixture], pagination: { has_more: false } });
});

server.listen(18081, '127.0.0.1', () => {
  console.log('Local mock Sportmonks odds/results source listening on 127.0.0.1:18081');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
