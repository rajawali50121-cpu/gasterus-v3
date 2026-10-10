import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ticketCalculation } from '../src/sportsbook-calculation.js';
import { systemBetMetrics } from '../../frontend/js/sportsbook-slip-calculation.js';

const frontend = readFileSync(new URL('../../frontend/js/sportsbook.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../../frontend/sportsbook.html', import.meta.url), 'utf8');
const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');

test('member sportsbook lazy-loads complete event market details rather than only compact list markets', () => {
  assert.match(frontend, /const FEED_DETAIL_URL = \(id\) => `\/api\/member\/sportsbook\/events\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(frontend, /await api\.get\(FEED_DETAIL_URL\(eventId\)\)/);
  assert.match(frontend, /function renderAllEventMarkets\(event\)[\s\S]*event\.markets[\s\S]*market\.selections\.map/);
  assert.match(feed, /function memberPublicEvent\(event\)[\s\S]*compactMemberMarkets\(item\.markets \|\| \[\]\)/);
  assert.match(feed, /function memberPublicEventDetail\(event\)[\s\S]*memberEventShape\(item, item\.markets \|\| \[\]\)/);
});

test('detailed markets are refreshed by feed revision and stale odds cannot place a bet during refresh', () => {
  assert.match(feed, /feedRevision: feed\.revision \|\| null/);
  assert.match(frontend, /detailRefreshIds\.add\(eventId\)/);
  assert.match(frontend, /\[\.\.\.selected\.values\(\)\]\.some\(selection => pendingEventDetails\.has\(selection\.eventId\)\)/);
  assert.match(frontend, /requestGeneration !== quoteGeneration/);
  assert.match(frontend, /pendingEventDetails\.has\(selection\.eventId\)\)\) \{\s*showToast\('Odds sedang diperbarui/);
});

test('event cards render only provider-backed primary markets and do not advertise inactive bet builder tabs', () => {
  assert.match(frontend, /import \{ primaryMarketColumns \} from '\.\/sportsbook-markets\.js'/);
  assert.match(frontend, /function eventMarketPeriods\(event\)/);
  assert.match(frontend, /data-match-period=/);
  assert.match(frontend, /const activeMarkets = primaryMarketColumns\(e, activePeriod\)/);
  assert.match(frontend, /\$\{marketsCount \? `<div class="sb-detail-markets-wrapper">/);
  assert.match(frontend, /Odds utama belum tersedia dari provider/);
  assert.doesNotMatch(frontend, /<button[^>]*>Bet Builder<\/button>/);
});

test('sports selector options are derived from sports that exist in the live feed', () => {
  assert.match(frontend, /const sports = \[\.\.\.new Set\(list\.map\(\(e\) => e\.sport/);
  assert.match(frontend, /dropdown\.innerHTML = options\.map/);
  assert.doesNotMatch(frontend, /data-sport="Basketball"/);
});

test('sportsbook filters and mix-parlay shortcuts update the actual active betting mode', () => {
  assert.match(frontend, /function setMatchFilter\(filter\)[\s\S]*aria-pressed[\s\S]*renderAll\(\)/);
  assert.match(frontend, /setSlipTab\('parlay'\)/);
  assert.match(frontend, /setMatchFilter\(currentFilter === 'fav' \? 'today' : 'fav'\)/);
  assert.match(frontend, /mixParlayButton\.classList\.toggle\('active', activeSlipTab === 'parlay'\)/);
});

test('member betslip exposes server-quoted System combinations with matching total stake calculation', () => {
  assert.match(page, /data-bstab="system"/);
  assert.match(page, /data-slip-tab="system"/);
  assert.match(frontend, /betType: type,[\s\S]*type === 'SYSTEM' \? \{ systemSize: activeSystemSize \}/);
  assert.match(frontend, /systemBetMetrics\(stake, legs\.map\(leg => Number\(leg\.odds\)\), systemSize\)/);
  assert.match(frontend, /metrics\.totalStake > betslipBalance\(\)/);
  assert.match(frontend, /betslipReady\(\)/);
  assert.match(frontend, /metrics\.totalStake > bettingConfig\.maxStake \|\| metrics\.totalStake > betslipBalance\(\)/);
  assert.match(frontend, /if \(nextTab !== activeSlipTab\)[\s\S]*quoteGeneration \+= 1/);
});

test('System betslip payout matches backend combination count and payout rounding', () => {
  const odds = [1.45, 1.82, 2.1, 1.67, 2.35];
  const stake = 2500;
  for (const systemSize of [2, 3, 4]) {
    const ui = systemBetMetrics(stake, odds, systemSize);
    const backend = ticketCalculation('SYSTEM', stake, odds.map(value => ({ selection: { odds: value } })), systemSize);
    assert.equal(ui.combinationCount, backend.combinationCount);
    assert.equal(ui.potentialPayout, backend.potentialPayout);
  }
});

test('sportsbook does not fabricate live scores and clears suspended or unpriced betslip legs', () => {
  assert.match(frontend, /function scoreText\(score\)[\s\S]*score === null \|\| score === undefined \|\| score === '' \? '—'/);
  assert.match(frontend, /if \(mk\.suspended\) continue/);
  assert.match(frontend, /if \(!sk\.suspended && Number\.isFinite\(odds\) && odds > 1\)/);
});

test('sportsbook event list renders bounded pages and accessible league accordions', () => {
  assert.match(frontend, /const EVENTS_PAGE_SIZE = 30/);
  assert.match(frontend, /data-load-more-events/);
  assert.match(frontend, /aria-expanded="true" aria-controls="sb-league-list-/);
  assert.match(frontend, /leagueHead\.setAttribute\('aria-expanded', String\(!collapsed\)\)/);
});

test('betslip desktop and mobile breakpoints match the visible sidebar breakpoint', () => {
  const styles = readFileSync(new URL('../../frontend/css/pages/sportsbook-v3.css', import.meta.url), 'utf8');
  assert.match(frontend, /const BETSLIP_MOBILE_BREAKPOINT = 860/);
  assert.doesNotMatch(frontend, /innerWidth[^;\n]*1024/);
  assert.match(styles, /@media \(max-width: 860px\)[\s\S]*?\.sb-betslip\s*\{\s*display: none/);
  assert.match(styles, /@media \(min-width: 861px\)[\s\S]*?\.sb-bottom-nav\s*\{\s*display: none/);
});

test('desktop betslip stays sticky while its content remains independently scrollable', () => {
  const styles = readFileSync(new URL('../../frontend/css/pages/sportsbook-v3.css', import.meta.url), 'utf8');
  assert.match(styles, /\.sb-betslip\s*\{[^}]*position: sticky;[^}]*max-height: calc\(100vh - \d+px\)/);
  assert.match(styles, /\.sb-betslip-body\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto/);
});

test('zero-valued market lines remain visible in the betslip', () => {
  assert.match(frontend, /marketLine: market\.line \?\? selection\.line \?\? null/);
  assert.match(frontend, /s\.marketLine !== null && s\.marketLine !== undefined/);
});

test('match cards present fixtures and provider-backed markets as a responsive sportsbook board', () => {
  const styles = readFileSync(new URL('../../frontend/css/pages/sportsbook-v3.css', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../../frontend/sportsbook.html', import.meta.url), 'utf8');
  assert.match(page, /<h1>Pertandingan &amp; Odds<\/h1>/);
  assert.match(page, /og:title" content="GASTERUS Sportsbook \| Pertandingan & Odds"/);
  assert.match(frontend, /<div class="sb-match-info">[\s\S]*<div class="sb-teams-row">[\s\S]*<div class="sb-match-market-head">/);
  assert.match(frontend, /PASAR UTAMA/);
  assert.match(styles, /\.sb-match-card\s*\{[\s\S]*grid-template-columns: minmax\(176px, 0\.72fr\) minmax\(0, 1\.7fr\)/);
  assert.match(styles, /\.sb-market-grid\s*\{[\s\S]*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 860px\)[\s\S]*?\.sb-match-card\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(page, /sportsbook-v3\.css\?v=20261010-sportsbook-board-r4/);
  assert.match(page, /sportsbook\.js\?v=20261010-sportsbook-board-r4/);
});

test('sportsbook cashout action routes to the dedicated cashout page instead of a duplicate bets modal', () => {
  assert.match(frontend, /window\.location\.href = '\/cashout\.html'/);
  assert.doesNotMatch(frontend, /openUserBetsModal\('Fitur Bayar Sekarang \(Cashout\)'/);
});

test('match cards expose real sportsbook metadata including provider badges and live market summary', () => {
  assert.match(frontend, /sb-match-meta-row/);
  assert.match(frontend, /sb-provider-chip/);
  assert.match(frontend, /market summary|pasar|provider/);
});

test('full market explorer exposes provider markets with working type, period, and search filters', () => {
  const styles = readFileSync(new URL('../../frontend/css/pages/sportsbook-v3.css', import.meta.url), 'utf8');
  assert.match(frontend, /function renderAllEventMarkets\(event\)[\s\S]*data-market-browser-search/);
  assert.match(frontend, /data-market-browser-filter="\$\{escapeHtml\(value\)\}"/);
  assert.match(frontend, /function applyMarketBrowserFilters\(panel\)[\s\S]*dataset\.marketType[\s\S]*dataset\.marketPeriod[\s\S]*market\.textContent\.toLowerCase\(\)\.includes\(query\)/);
  assert.match(frontend, /ev\.addEventListener\('input', \(e\) =>/);
  assert.match(styles, /\.sb-market-browser-toolbar/);
  assert.match(styles, /\.sb-market-browser-chip\.active/);
  assert.match(styles, /\.sb-detail-market\[hidden\]/);
});

test('market explorer reports the number of markets matching the active filters', () => {
  assert.match(frontend, /data-market-browser-summary/);
  assert.match(frontend, /function applyMarketBrowserFilters\(panel\)[\s\S]*summary\.textContent/);
});

test('market explorer labels HT and FT periods clearly and does not confuse odd/even with totals', () => {
  assert.match(frontend, /FT: 'FT · Full Time', '1H': 'HT · Babak 1'/);
  assert.match(frontend, /ODD_EVEN: 'Ganjil \/ Genap'/);
  assert.match(frontend, /sb-market-browser-filter-label/);
  assert.match(frontend, /countFor\(value\)/);
});

test('odds movement indicators remain readable long enough to identify direction', () => {
  const styles = readFileSync(new URL('../../frontend/css/pages/sportsbook-v3.css', import.meta.url), 'utf8');
  assert.match(frontend, /scheduleOddsMovementCleanup\(key, 1800\)/);
  assert.match(styles, /\.sb-odd-cell\.sb-odd-movement-up\s*\{\s*animation: sbOddFlashGreen 1800ms/);
  assert.match(styles, /\.sb-odd-cell\.sb-odd-movement-down\s*\{\s*animation: sbOddFlashRed 1800ms/);
});
