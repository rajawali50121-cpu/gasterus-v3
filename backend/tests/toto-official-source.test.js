import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),

});
const { TOTO_OFFICIAL_SOURCES, parseOfficialSource, officialDecision, collectOfficialTotoSources } = await import('../src/toto-official-source.js');

const source = parser => TOTO_OFFICIAL_SOURCES.find(x => x.parser === parser);
const html = lines => lines.map(x=>`<div>${x}</div>`).join('');

function obs(parser, lines) { return parseOfficialSource(source(parser), html(lines)); }
function bySlug(items, slug) { return items.find(x=>x.slug===slug); }

test('Singapore Pools 4D parser uses official first prize',()=>{
  const items=obs('singapore',['4D Results','Wed, 29 Jul 2026 | Draw No. 5515','1st Prize | 8813','2nd Prize | 1641','3rd Prize | 0173']);
  assert.equal(bySlug(items,'singapore-pool')?.result,'8813');
  assert.equal(bySlug(items,'singapore-pool')?.drawDate,'2026-07-29');
});

test('Georgia Cash 4 parser preserves Midday Evening and Night sessions',()=>{
  const items=obs('georgia',['Play Cash 4','3x Daily','LATEST DRAW RESULTS','MIDDAY 06/14/2026','4 1 7 6','EVENING 06/14/2026','4 7 4 6','NIGHT 06/13/2026','0 9 2 5','NEXT DRAW: 06/14/2026']);
  assert.equal(bySlug(items,'georgia-mid-pool')?.result,'4176');
  assert.equal(bySlug(items,'georgia-eve-pool')?.result,'4746');
  assert.equal(bySlug(items,'georgia-ngt-pool')?.result,'0925');
});

test('PCSO 4DL parser uses exactly the four drawn digits',()=>{
  const items=obs('pcso',['4DL','38 WINNERS','July 31, 2026','₱798,836.00','01','07','00','04','3DL']);
  assert.equal(bySlug(items,'pcso-pool')?.result,'1704');
  assert.equal(bySlug(items,'pcso-pool')?.drawDate,'2026-07-31');
});

test('California Daily 4 parser reads official four-digit result',()=>{
  const items=obs('california',['Daily 4','Winning Numbers:','THU/JUL 30, 2026','6','0','3','2','Detailed Draw Results']);
  assert.equal(bySlug(items,'california-pool')?.result,'6032');
});

test('Wisconsin Pick 4 chooses latest session on latest date',()=>{
  const items=obs('wisconsin',['Wednesday, Midday','07/29/2026','Pick 4','7','9','0','6','Wednesday, Evening','07/29/2026','Pick 4','0','0','5','1']);
  assert.equal(bySlug(items,'wisconsin-pool')?.result,'0051');
});

test('Maryland table parser skips Pick 3 and reads Pick 4',()=>{
  const items=obs('maryland',['07/31/26 Midday MID','5','4','8','5','6','6','0','9','7','8','3','2','07/30/26 Evening EVE','1','2','7','0','6','0','1','0','1','9','4','4']);
  assert.equal(bySlug(items,'maryland-mid-pool')?.result,'5660');
  assert.equal(bySlug(items,'maryland-eve-pool')?.result,'0601');
});

test('Indiana Daily 4 ignores Superball fifth value',()=>{
  const items=obs('indiana',['Daily 4 Midday','Winning Numbers','Midday Sunday, August 2nd','09 07 04 08 02','Evening Sunday, August 2nd','02 03 05 03 02']);
  assert.equal(bySlug(items,'indiana-mid-pool')?.result,'9748');
  assert.equal(bySlug(items,'indiana-eve-pool')?.result,'2353');
});

test('Tennessee Cash 4 ignores Wild Ball fifth value',()=>{
  const items=obs('tennessee',['Sat, August 01, 2026','Draw Results','morning','9','3','4','7','8','midday','4','7','7','7','1','evening','9','7','6','6','8']);
  assert.equal(bySlug(items,'tennesse-mor-pool')?.result,'9347');
  assert.equal(bySlug(items,'tennessee-mid-pool')?.result,'4777');
  assert.equal(bySlug(items,'tennessee-eve-pool')?.result,'9766');
});

test('Texas Daily 4 ignores Fireball and preserves all four sessions',()=>{
  const items=obs('texas',['Daily 4 Winning Numbers for:','07/30/2026 Morning','4','3','3','0','FIREBALL 1','Daily 4 Winning Numbers for:','07/30/2026 Day','1','9','1','7','FIREBALL 2','Daily 4 Winning Numbers for:','07/29/2026 Evening','4','3','4','8','FIREBALL 5','Daily 4 Winning Numbers for:','07/29/2026 Night','1','5','3','6','FIREBALL 9']);
  assert.equal(bySlug(items,'texas-mor-pool')?.result,'4330');
  assert.equal(bySlug(items,'texas-day-pool')?.result,'1917');
  assert.equal(bySlug(items,'texas-eve-pool')?.result,'4348');
  assert.equal(bySlug(items,'texas-night-pool')?.result,'1536');
});

test('Illinois Pick 4 excludes fifth Fireball value',()=>{
  const items=obs('illinois',['Monday Jul 27, 2026 evening 4 7 2 7 3','Monday Jul 27, 2026 midday 3 4 5 2 8']);
  assert.equal(bySlug(items,'illinois-eve-pool')?.result,'4727');
  assert.equal(bySlug(items,'illinois-mid-pool')?.result,'3452');
});

test('Missouri Pick 4 excludes Wild Ball',()=>{
  const items=obs('missouri',['2026-07-30 Evening 8 1 0 0 5','2026-07-30 Midday 2 7 3 4 6']);
  assert.equal(bySlug(items,'missouri-eve-pool')?.result,'8100');
  assert.equal(bySlug(items,'missouri-mid-pool')?.result,'2734');
});

test('Virginia Pick 4 excludes Fireball',()=>{
  const items=obs('virginia',['Latest Drawing: Tue 7/21/2026','Tue 7/21/2026 Winning Numbers','DAY: 3 4 9 0 2 FIREBALL','NIGHT: 2 9 5 8 0 FIREBALL']);
  assert.equal(bySlug(items,'virginia-day-pool')?.result,'3490');
  assert.equal(bySlug(items,'virginia-ngt-pool')?.result,'2958');
});

test('North Carolina Pick 4 uses base four digits before Fireball',()=>{
  const items=obs('northcarolina',['Latest Daytime Drawing Wed, Apr 1','5','4','9','0','5','Latest Evening Drawing Wed, Apr 1','2','2','6','0','0']);
  assert.equal(bySlug(items,'northcaroday-pool')?.result,'5490');
  assert.equal(bySlug(items,'northcaroeve-pool')?.result,'2260');
});

test('New Jersey Pick-4 uses base four digits before Fireball',()=>{
  const items=obs('newjersey',['PICK-4 BRINGS YOU FUN, EXCITEMENT AND PRIZES.','MIDDAY (06/14/2026)','9','8','6','2','6','EVENING (06/13/2026)','9','6','3','5','6']);
  assert.equal(bySlug(items,'newjersey-mid-pool')?.result,'9862');
  assert.equal(bySlug(items,'newjerseyeve-pool')?.result,'9635');
});

test('New York State Gaming Commission open-data parser preserves Midday and Evening Win 4',()=>{
  const payload=JSON.stringify([
    { draw_date:'2026-08-19T00:00:00.000', midday_win_4:'0123', evening_win_4:'9876' },
    { draw_date:'2026-08-18T00:00:00.000', midday_win_4:'1111', evening_win_4:'2222' }
  ]);
  const items=parseOfficialSource(source('newyork'),payload);
  assert.equal(bySlug(items,'newyork-mid-pool')?.result,'0123');
  assert.equal(bySlug(items,'newyork-mid-pool')?.drawDate,'2026-08-19');
  assert.equal(bySlug(items,'newyork-eve-pool')?.result,'9876');
});

test('officialDecision gives official observation precedence and verified authority',()=>{
  const src=source('california');
  const results=[{...src,ok:true,observations:obs('california',['Daily 4','Winning Numbers:','THU/JUL 30, 2026','6','0','3','2'])}];
  const d=officialDecision('california-pool',results);
  assert.equal(d.status,'VERIFIED');
  assert.equal(d.result,'6032');
  assert.equal(d.authority,'OFFICIAL');
  assert.equal(d.confidence,1);
});


test('HF13 official fetches use a browser-compatible request profile without weakening HTTPS source policy', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      url: String(url),
      headers: { get() { return null; } },
      async text() { return '<html><body>no current result in fixture</body></html>'; }
    };
  };
  const results = await collectOfficialTotoSources(fakeFetch, async () => ({
    ok: false,
    error: 'fixture browser fallback disabled'
  }));
  assert.equal(results.length, TOTO_OFFICIAL_SOURCES.length);
  assert.equal(calls.length, TOTO_OFFICIAL_SOURCES.length);
  assert.equal(calls.every(call => /^https:\/\//.test(call.url)), true);
  assert.equal(calls.every(call => /Mozilla\/5\.0/.test(call.options.headers['user-agent'])), true);
  assert.equal(calls.every(call => /en-US/.test(call.options.headers['accept-language'])), true);
});
