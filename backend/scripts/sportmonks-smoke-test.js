import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const unusedConfigSecrets = {
  MEMBER_PROXY_SECRET: 'sportmonks-smoke-test-unused-member-proxy-secret',
  ADMIN_PROXY_SECRET: 'sportmonks-smoke-test-unused-admin-proxy-secret',
  OPS_INTERNAL_SECRET: 'sportmonks-smoke-test-unused-ops-internal-secret',
  SESSION_HMAC_KEY: 'sportmonks-smoke-test-unused-session-hmac-key',
  API_KEY_PEPPER: 'sportmonks-smoke-test-unused-api-key-pepper',
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32).toString('base64')
};

export function summarizeSportmonksResult(result) {
  const events = Array.isArray(result?.events) ? result.events : [];
  const markets = events.flatMap(event => Array.isArray(event?.markets) ? event.markets : []);
  const diagnostics = result?.diagnostics || {};
  return {
    fixtures: Number(diagnostics.fixturesFetched || 0),
    fixturesAdvertiseOdds: Number(diagnostics.fixturesAdvertiseOdds || 0),
    fixturesWithOddsRows: Number(diagnostics.fixturesWithOddsRows || 0),
    oddsRowsFetched: Number(diagnostics.oddsRowsFetched || 0),
    fixturesWithMarkets: Number(diagnostics.fixturesWithMarkets || 0),
    events: events.length,
    markets: markets.length,
    odds: markets.reduce((count, market) => count + (Array.isArray(market?.selections) ? market.selections.length : 0), 0),
    bookmakers: new Set(markets.map(market => market?.bookmaker).filter(Boolean)).size,
    unknownMarkets: Number(diagnostics.unknownMarketCount || 0),
    pagesFetched: Number(diagnostics.pagesFetched || 0)
  };
}

export async function runSportmonksSmokeTest() {
  Object.assign(process.env, {
    SPORTSBOOK_RENDER_WORKER: 'true',
    SPORTMONKS_DAYS_AHEAD: '0',
    SPORTMONKS_ENABLED: 'true'
  });
  for (const [name, value] of Object.entries(unusedConfigSecrets)) {
    process.env[name] ||= value;
  }

  const { config } = await import('../src/config.js');
  if (!config.sportmonksKey) throw new Error('Set SPORTMONKS_API_KEY in the environment.');

  const { fetchSportmonks } = await import('../src/sportsbook-providers.js');
  const result = await fetchSportmonks({
    maxEvents: config.sportmonksMaxTotalEvents,
    maxPages: config.sportmonksMaxPages
  });
  const summary = summarizeSportmonksResult(result);
  console.log(JSON.stringify(summary, null, 2));

  const diagnostics = result.diagnostics || {};
  if (result.enabled !== true || result.stale === true || result.transportOk === false
    || diagnostics.pageBudgetExhausted || diagnostics.failedPages > 0) {
    throw new Error((result.errors || []).join('; ') || 'Sportmonks returned an incomplete fixture scan.');
  }
  return summary;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  runSportmonksSmokeTest().catch(error => {
    console.error(`Sportmonks smoke test failed: ${error.message}`);
    process.exitCode = 1;
  });
}
