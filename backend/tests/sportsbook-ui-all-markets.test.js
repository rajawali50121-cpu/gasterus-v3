import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ticketCalculation } from '../src/sportsbook-calculation.js';
import { mergeProviderEvents } from '../src/sportsbook-feed-utils.js';
import { systemBetMetrics } from '../../frontend/js/sportsbook-slip-calculation.js';
import { projectMemberMarkets, selectMemberSummaryMarkets } from '../src/sportsbook-member-projection.js';
import { __sportsbookFeed } from '../src/sportsbook-feed.js';
import { availableMarketPeriods, primaryMarketColumns, selectMarketPeriod } from '../../frontend/js/sportsbook-markets.js';

const frontend = readFileSync(new URL('../../frontend/js/sportsbook.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../../frontend/sportsbook.html', import.meta.url), 'utf8');
const sportsbookCss = readFileSync(new URL('../../frontend/css/pages/sportsbook-v3.css', import.meta.url), 'utf8');
const responsiveCss = readFileSync(new URL('../../frontend/css/pages/sportsbook-responsive-hotfix.css', import.meta.url), 'utf8');
const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
const realtime = readFileSync(new URL('../src/sportsbook-realtime.js', import.meta.url), 'utf8');

function market(id, period, odds = 2.1) {
  return {
    id,
    type: '1X2',
    period,
    selections: [
      { key: 'HOME', label: 'Home', odds, suspended: false },
      { key: 'DRAW', label: 'Draw', odds: odds + 1, suspended: false },
      { key: 'AWAY', label: 'Away', odds: odds + 2, suspended: false }
    ]
  };
}

test('member REST snapshot projection retains valid FT and HT markets without duplicates', () => {
  const markets = [
    { ...market('ft-main', 'FT'), selections: [...market('ft-main', 'FT').selections, market('ft-main', 'FT').selections[0]] },
    market('ht-main', '1H', 1.8),
    market('ht-main', '1H', 1.7),
    market('ft-main', '1H', 1.9),
    { ...market('malformed-ht', '1H'), selections: [null, { key: 'HOME', label: 'Home', odds: 2.2 }] },
    market('second-half', '2H')
  ];
  const result = projectMemberMarkets(selectMemberSummaryMarkets(markets));
  assert.deepEqual([...new Set(result.map(item => item.period))], ['FT', '1H']);
  assert.equal(new Set(result.map(item => `${item.id}|${item.period}|${item.line ?? ''}`)).size, result.length);
  const ftMarket = result.find(item => item.id === 'ft-main' && item.period === 'FT');
  assert.equal(new Set(ftMarket.selections.map(item => `${item.key}|${item.line ?? ''}`)).size, ftMarket.selections.length);
  assert.equal(result.some(item => item.id === 'ft-main' && item.period === '1H'), true);
  assert.equal(result.find(item => item.id === 'ht-main').selections.some(item => item.key === 'HOME'), true);
});

test('Sportradar member projection preserves bookmaker and strips provider identifiers', () => {
  const projected = projectMemberMarkets([{
    id: 'sr-market-1',
    type: '1X2',
    label: 'Match Result',
    period: 'FT',
    source: 'sportradar',
    sourceMarketId: 'sr:market:1',
    bookmaker: 'Bookmaker A',
    updatedAt: '2026-11-17T10:00:00.000Z',
    suspended: false,
    selections: [{
      key: 'sr-selection-1',
      label: 'Home',
      odds: 2.1,
      suspended: false,
      source: 'sportradar',
      sourceSelectionId: 'sr:outcome:1',
      updatedAt: '2026-11-17T10:00:00.000Z'
    }]
  }]);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].sourceLabel, 'Sportradar');
  assert.equal(projected[0].bookmaker, 'Bookmaker A');
  assert.equal('sourceMarketId' in projected[0], false);
  assert.equal('updatedAt' in projected[0], false);
  assert.equal('source' in projected[0].selections[0], false);
  assert.equal('sourceSelectionId' in projected[0].selections[0], false);
});

test('Sportradar detail preserves useful price metadata but strips raw provider payloads', () => {
  const event = {
    id: 'sr:sport_event:fixture-1',
    sport: 'Soccer',
    sportId: 'sr:sport:1',
    league: 'Premier League',
    country: 'England',
    startTime: '2026-11-20T20:00:00.000Z',
    status: 'SCHEDULED',
    providerStatus: 'not_started',
    replacedBy: 'sr:sport_event:replacement-1',
    startTimeConfirmed: true,
    resumeTime: null,
    sourceData: { sportEvent: { id: 'sr:sport_event:fixture-1', status: 'not_started' } },
    home: { name: 'Home FC' },
    away: { name: 'Away FC' },
    live: false,
    _sources: ['sportradar'],
    markets: [{
      id: 'market-instance-1',
      source: 'sportradar',
      sourceMarketId: 'sr:market:1',
      sourceMarketName: 'Match Result',
      sourceBookId: 'sr:book:1',
      externalMarketId: 'external-market-1',
      externalSportEventId: 'external-event-1',
      bookmaker: 'Book A',
      removed: false,
      isLive: false,
      sourceData: { market: { id: 'sr:market:1' }, book: { id: 'sr:book:1' } },
      type: '1X2',
      label: 'Match Result',
      period: 'FT',
      selections: [{
        key: 'home',
        label: 'Home',
        odds: 2.1,
        oddsAmerican: '+110',
        oddsFraction: '11/10',
        openOddsDecimal: 2.0,
        openOddsAmerican: '+100',
        openOddsFraction: '1/1',
        handicap: 0.5,
        spread: 0.5,
        total: 2.5,
        openHandicap: 0,
        openTotal: 2.25,
        handicap7day: 0,
        total7day: 2.0,
        odds7dayDecimal: 1.9,
        odds7dayAmerican: '-110',
        odds7dayFraction: '10/11',
        removed: false,
        outcomeType: 'home',
        fieldId: 'field-1',
        externalOutcomeId: 'external-outcome-1',
        playerId: 'player-1',
        playerName: 'Player One',
        sourceData: { id: 'sr:outcome:1', odds_decimal: '2.10' },
        source: 'sportradar',
        sourceSelectionId: 'sr:outcome:1',
        suspended: false
      }]
    }]
  };

  const detail = __sportsbookFeed.memberPublicEventDetail(event);
  assert.equal(detail.sportId, undefined);
  assert.equal(detail.replacedBy, undefined);
  assert.equal(detail.sourceData, undefined);
  assert.equal(detail.providerStatus, undefined);
  const market = detail.markets[0];
  assert.equal(market.sourceMarketName, undefined);
  assert.equal(market.sourceBookId, undefined);
  assert.equal(market.sourceData, undefined);
  assert.equal(market.sourceMarketId, undefined);
  const selection = market.selections[0];
  assert.equal(selection.oddsAmerican, '+110');
  assert.equal(selection.openOddsDecimal, 2);
  assert.equal(selection.odds7dayDecimal, 1.9);
  assert.equal(selection.handicap, 0.5);
  assert.equal(selection.total, 2.5);
  assert.equal(selection.playerName, 'Player One');
  assert.equal(selection.sourceData, undefined);
  assert.equal(selection.sourceSelectionId, undefined);
  assert.equal(selection.source, undefined);
});

test('Sportradar prices outside the bettable range are not selectable but remain in detail data', () => {
  const periods = availableMarketPeriods({
    markets: [{
      source: 'sportradar',
      period: 'FT',
      selections: [{ odds: 1, source: 'sportradar', suspended: false }]
    }]
  });
  assert.deepEqual(periods, []);
  assert.match(frontend, /if \(!Number\.isFinite\(decOdds\)\)/);
  assert.match(frontend, /if \(decOdds <= 1\)/);
  assert.match(frontend, /const markets = \(event\.markets \|\| \[\]\)\.filter\(market => market && typeof market === 'object'\)/);
});

test('detailed event projection preserves every supplied market and selection line', () => {
  const markets = Array.from({ length: 14 }, (_, index) => ({
    id: `market-${index}`,
    type: index === 13 ? 'OTHER' : ['1X2', 'HANDICAP', 'TOTALS', 'BTTS'][index % 4],
    period: index % 2 ? '1H' : 'FT',
    selections: [{
      key: `selection-${index}`,
      label: `Selection ${index}`,
      odds: 1.91,
      line: index,
      suspended: false
    }]
  }));
  const projected = projectMemberMarkets(markets);
  assert.equal(projected.length, markets.length);
  assert.equal(projected[13].selections[0].line, 13);
  const detailProjection = feed.slice(
    feed.indexOf('function memberPublicEventDetail(event)'),
    feed.indexOf('export async function sportsbookSnapshot')
  );
  assert.match(detailProjection, /memberEventShape\(item, item\.markets \|\| \[\], \{/);
  const refresh = feed.slice(feed.indexOf('async function performRefresh'));
  assert.doesNotMatch(refresh, /capMarketsPerEvent/);
});

test('the SSE broadcaster sends the same member snapshot projection, including FT and HT updates', () => {
  assert.match(feed, /sourceEvents\.map\(memberPublicEvent\)/);
  assert.match(realtime, /pending = sportsbookSnapshot\(client\.filters\)/);
  assert.match(realtime, /broadcastSnapshot\(client, await pending\)/);
  const result = projectMemberMarkets(selectMemberSummaryMarkets([market('ft-main', 'FT'), market('ht-main', '1H', 1.9)]));
  assert.deepEqual(result.map(item => item.period), ['FT', '1H']);
});

test('valid FT and HT odds create selectable tabs and render the selected period markets', () => {
  const event = { markets: [market('ft-main', 'FT'), market('ht-main', '1H', 1.9)] };
  const periods = availableMarketPeriods(event);
  assert.deepEqual(periods, ['FT', '1H']);
  assert.equal(primaryMarketColumns(event, selectMarketPeriod(periods, 'FT'))[2].market.id, 'ft-main');
  assert.equal(primaryMarketColumns(event, selectMarketPeriod(periods, '1H'))[2].market.id, 'ht-main');
  assert.equal(selectMarketPeriod(periods, '1H'), '1H');
  assert.match(frontend, /selectedEventPeriods\.set\(match\.dataset\.evid, periodButton\.dataset\.matchPeriod\);\s*renderAll\(\)/);
});

test('priced read-only HT bookmaker row wins over an earlier unpriced HT row', () => {
  const event = {
    markets: [
      { ...market('ht-unpriced-first', '1H', null), suspended: true, oddsDisplayOnly: true,
        selections: [{ key: 'HOME', label: 'Home', odds: null, suspended: true }] },
      { ...market('ht-priced-second', '1H', 1.85), suspended: true, oddsDisplayOnly: true,
        selections: market('ht-priced-second', '1H', 1.85).selections.map(selection => ({ ...selection, suspended: true })) }
    ]
  };
  const columns = primaryMarketColumns(event, '1H');
  assert.equal(columns.find(item => item.type === '1X2')?.market?.id, 'ht-priced-second');
  assert.equal(columns.find(item => item.type === '1X2')?.outcomes.find(([label]) => label === '1')?.[1]?.odds, 1.85);
});

test('invalid or suspended HT markets remain visible as an explicit unavailable or suspended primary slot', () => {
  const event = {
    markets: [
      market('ft-main', 'FT'),
      null,
      { id: 'malformed-ft', type: '1X2', period: 'FT', selections: [null] },
      { ...market('ht-invalid', '1H', Infinity), selections: [null, { key: 'HOME', odds: 'bad' }] },
      { ...market('ht-suspended', '1H'), suspended: true }
    ]
  };
  assert.deepEqual(availableMarketPeriods(event), ['FT']);
  assert.equal(primaryMarketColumns(event, 'FT')[2].market.id, 'ft-main');
  assert.equal(primaryMarketColumns(event, '1H')[2].market.suspended, true);
});

test('HT odds remain visible read-only without HT settlement authority while FT remains unchanged', () => {
  const [event] = mergeProviderEvents([{
    provider: 'sportradar',
    enabled: true,
    events: [{
      id: 'sr-event-ht-readonly',
      sport: 'Football',
      league: 'Test League',
      status: 'SCHEDULED',
      live: false,
      home: { name: 'Home' },
      away: { name: 'Away' },
      _sources: ['sportradar'],
      _settlementReadySources: ['manual-ops'],
      markets: [market('ft-main', 'FT'), market('ht-main', '1H', 1.85)]
    }]
  }]);
  const projected = projectMemberMarkets(event.markets);
  const ft = projected.find(item => item.period === 'FT');
  const ht = projected.find(item => item.period === '1H');
  assert.equal(ft.suspended, false);
  assert.equal(ft.oddsDisplayOnly, false);
  assert.equal(ht.suspended, true, 'HT remains blocked for wagering');
  assert.equal(ht.oddsDisplayOnly, true, 'HT prices are marked for read-only display');
  assert.equal(ht.selections[0].suspended, true, 'HT selections remain non-bettable');
  assert.ok(availableMarketPeriods({ markets: projected }).includes('1H'));
  const htColumns = primaryMarketColumns({ home: { name: 'Home' }, away: { name: 'Away' }, markets: projected }, '1H');
  assert.equal(htColumns.find(item => item.type === '1X2')?.market?.oddsDisplayOnly, true);
});

test('main market cells show unavailable or suspended status without creating bet buttons', () => {
  const start = frontend.indexOf('function renderOddCell(');
  const end = frontend.indexOf('\nfunction renderMarketColumns(', start);
  assert.ok(start >= 0 && end > start, 'main odd cell renderer must exist');
  const renderOddCell = new Function('formatOdds', 'escapeHtml', 'oddsFormat', `${frontend.slice(start, end)}; return renderOddCell;`)(value => String(value), value => String(value), 'DECIMAL');
  const unavailable = renderOddCell({ id: 'event' }, null, null);
  const suspended = renderOddCell({ id: 'event' }, { id: 'market', suspended: true }, null);
  const htReadOnly = renderOddCell({ id: 'event' }, { id: 'ht-market', suspended: true, oddsDisplayOnly: true }, { odds: 1.85, suspended: true });
  assert.match(unavailable, /Tidak tersedia/);
  assert.match(suspended, /Ditangguhkan/);
  assert.match(htReadOnly, /1\.85/);
  assert.match(htReadOnly, /informasi saja/);
  assert.doesNotMatch(unavailable + suspended + htReadOnly, /<button/);
});

test('premium sportsbook skin separates LIVE and prematch with aligned responsive odds', () => {
  assert.match(page, /<body class="sb-page sb-premium">/);
  assert.match(frontend, /class="sb-match-card \$\{isLive \? 'is-live' : 'is-prematch'\}"/);
  assert.match(frontend, /const isLive = Boolean\(e\.live\) \|\| String\(e\.status \|\| ''\)\.toUpperCase\(\) === 'LIVE'/);
  assert.ok(sportsbookCss.includes('.sb-premium .sb-match-card.is-live {'));
  assert.ok(sportsbookCss.includes('background: linear-gradient(145deg, #fff 0%, #fff4f6 100%)'));
  assert.ok(sportsbookCss.includes('.sb-premium .sb-match-card.is-prematch {'));
  assert.ok(sportsbookCss.includes('background: linear-gradient(145deg, #fff 0%, #f1f7ff 100%)'));
  assert.ok(sportsbookCss.includes('min-height: 48px;'));
  assert.ok(sportsbookCss.includes('grid-template-columns: repeat(3, minmax(0, 1fr));'));
  assert.ok(sportsbookCss.includes('@media (max-width: 860px)'));
  assert.ok(sportsbookCss.includes('@media (max-width: 480px)'));
  assert.ok(sportsbookCss.includes('.sb-market-period-tab[data-match-period="1H"].active'));
});

test('MAX SPEED feed status is visible and reflects snapshot freshness without claiming betting availability', () => {
  assert.match(page, /id="sb-max-speed-status"[^>]*data-state="connecting"/);
  assert.match(frontend, /const snapshotAt = Date\.parse\(feed\.source\?\.capturedAt \|\| feed\.source\?\.fetchedAt \|\| ''\)/);
  assert.match(frontend, /feed\.stale \|\| snapshotAgeMs === null \|\| snapshotAgeMs > staleAfterMs/);
  assert.match(frontend, /MAX SPEED FEED · \$\{labels\[syncState\]\}/);
  assert.match(sportsbookCss, /\.sb-max-speed-status\[data-state="delayed"\]/);
});

test('member sportsbook lazy-loads complete event market details and retains all list market variants', () => {
  assert.match(frontend, /const FEED_DETAIL_URL = \(id\) => `\/api\/member\/sportsbook\/events\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(frontend, /await api\.get\(FEED_DETAIL_URL\(eventId\)\)/);
  assert.match(frontend, /function renderAllEventMarkets\(event\)[\s\S]*event\.markets[\s\S]*market\.selections\.map/);
  assert.ok(feed.includes('function memberPublicEvent(event)'));
  assert.ok(feed.includes('selectMemberSummaryMarkets(item.markets)'));
  assert.ok(feed.includes('function memberPublicEventDetail(event)'));
  assert.ok(feed.includes('includeDetailFields: true'));
});

test('detailed markets are refreshed by feed revision and stale odds cannot place a bet during refresh', () => {
  assert.match(feed, /feedRevision: feed\.revision \|\| null/);
  assert.match(frontend, /detailRefreshIds\.add\(eventId\)/);
  assert.match(frontend, /\[\.\.\.selected\.values\(\)\]\.some\(selection => pendingEventDetails\.has\(selection\.eventId\)\)/);
  assert.match(frontend, /requestGeneration !== quoteGeneration/);
  assert.match(frontend, /pendingEventDetails\.has\(selection\.eventId\)\)\) \{\s*showToast\('Odds sedang diperbarui/);
});

test('event cards render six stable primary market slots and keep additional markets in All Markets', () => {
  assert.match(frontend, /import \{[^}]*primaryMarketColumns[^}]*\} from '\.\/sportsbook-markets\.js\?v=\d+-market-integrity-r2'/);
  assert.match(frontend, /function eventMarketPeriods\(\)/);
  assert.match(frontend, /data-match-period=/);
  assert.match(frontend, /const activeMarkets = primaryMarketColumns\(e, activePeriod\)/);
  assert.match(frontend, /function eventMarketPeriods\(\) \{\s*return \['FT', '1H'\]/);
  assert.match(frontend, /Tidak tersedia/);
  assert.match(frontend, /Ditangguhkan/);
  assert.match(frontend, /\$\{marketsCount \? `<div class="sb-detail-markets-wrapper">/);
  assert.doesNotMatch(frontend, /<button[^>]*>Bet Builder<\/button>/);
});

test('sports selector options are derived from sports that exist in the live feed', () => {
  assert.match(frontend, /const sports = \[\.\.\.new Set\(\(list \|\| \[\]\)\.map\(\(e\) => e\.sport/);
  assert.match(frontend, /dropdown\.innerHTML = options\.map/);
  assert.doesNotMatch(frontend, /data-sport="Basketball"/);
});

test('sportsbook filters and mix-parlay shortcuts update the actual active betting mode', () => {
  assert.match(frontend, /function setMatchFilter\(filter\)[\s\S]*aria-pressed[\s\S]*refreshFeedView\(\)/);
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

test('sportsbook league labels include payload country and remain responsive on mobile', () => {
  const styles = readFileSync(new URL('../../frontend/css/pages/sportsbook-v3.css', import.meta.url), 'utf8');
  assert.match(frontend, /function formatLeagueLabel\(event, fallback = 'Match'\)/);
  assert.match(frontend, /const country = String\(event\?\.country \|\| category \|\| ''\)\.trim\(\)/);
  assert.match(frontend, /formatLeagueLabel\(e, 'Live Match'\)/);
  assert.match(frontend, /sb-match-league">\$\{escapeHtml\(formatLeagueLabel\(e\)\)\}<\/span>/);
  assert.match(frontend, /const lg = formatLeagueLabel\(e, 'Liga Internasional'\)/);
  assert.match(styles, /\.sb-match-league\s*\{[^}]*min-width: 0;[^}]*flex: 1 1 auto;[^}]*overflow-wrap: anywhere/);
  assert.match(styles, /\.sb-league-title\s*\{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere/);
  assert.match(styles, /\.sb-live-league-label\s*\{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere/);
  assert.match(styles, /@media \(max-width: 860px\)[\s\S]*?\.sb-match-card\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
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
  assert.match(page, /sportsbook-v3\.css\?v=[^"']+/);
  assert.match(page, /sportsbook\.js\?v=[^"']+/);
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
  assert.match(frontend, /FT: 'FT · Full Time \/ Babak Penuh \(BP\)', '1H': 'HT · Half Time \/ Babak Pertama \(B1\)'/);
  assert.match(frontend, /HT_FT: 'HT\/FT \(Kombinasi Half Time \/ Full Time\)'/);
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

test('primary Asian Handicap slot selects a complete priced line from multi-line markets', () => {
  const event = { markets: [{
    id: 'asian-handicap-lines',
    type: 'HANDICAP',
    period: 'FT',
    selections: [
      { key: 'home-0.25', label: 'Home', line: -0.25, odds: 1.91, suspended: false },
      { key: 'away-0.25', label: 'Away', line: 0.25, odds: 1.95, suspended: false },
      { key: 'home-0.5', label: 'Home', line: -0.5, odds: 1.88, suspended: false },
      { key: 'away-0.5', label: 'Away', line: 0.5, odds: 1.98, suspended: false }
    ]
  }] };
  const handicap = primaryMarketColumns(event, 'FT').find(item => item.type === 'HANDICAP');
  assert.equal(handicap.outcomes.length, 2);
  assert.equal(handicap.outcomes.every(([, selection]) => Number(selection?.odds) > 1), true);
  assert.equal(new Set(handicap.outcomes.map(([, selection]) => selection.line)).size, 2);
});

test('mobile sportsbook CSS forces full-width cards and a two-column compact period switcher', () => {
  assert.match(responsiveCss, /\.sb-premium \.sb-market-period-tabs\s*\{[^}]*display:\s*grid/s);
  assert.match(responsiveCss, /\.sb-match-card\s*\{[^}]*width:\s*100%/s);
  assert.match(frontend, /MARKET_PERIOD_TAB_LABELS/);
});
