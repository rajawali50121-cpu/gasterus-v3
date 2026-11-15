// Tipsters Odds Cache Worker (Cloudflare Workers + KV)
const RAPIDAPI_HOST = 'odds-feed.p.rapidapi.com';
const RAPIDAPI_BASE = 'https://odds-feed.p.rapidapi.com';
const MARKET_EVENTS_DEFAULT = 3;
const MARKET_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function kvKey(kind, id = '') { return `tipsters:${kind}${id ? ':' + id : ''}`; }
function authOk(request, env) {
  const token = env.TIPSTERS_CACHE_TOKEN;
  if (!token) return false;
  const h = request.headers.get('Authorization') || '';
  if (h === `Bearer ${token}`) return true;
  try { return new URL(request.url).searchParams.get('token') === token; } catch {}
  return false;
}
async function rapidApiFetch(path, env) {
  const url = new URL(path, RAPIDAPI_BASE);
  return fetch(url.toString(), {
    headers: { 'x-rapidapi-key': env.RAPIDAPI_ODDS_KEY, 'x-rapidapi-host': RAPIDAPI_HOST, Accept: 'application/json' }
  });
}
async function readMeta(env) {
  const raw = await env.TIPSTERS_CACHE.get(kvKey('meta'));
  return raw ? JSON.parse(raw) : { remaining: null, requestsToday: 0, date: '' };
}
async function writeMeta(env, m) { await env.TIPSTERS_CACHE.put(kvKey('meta'), JSON.stringify(m)); }
function utcToday() { return new Date().toISOString().slice(0, 10); }
function parseStartAt(raw) {
  if (!raw || !raw.start_at) return null;
  const s = new Date(String(raw.start_at).replace(' ', 'T') + 'Z');
  return Number.isFinite(s.getTime()) ? s : null;
}
async function cronA(env, ctx) {
  const maxMarketEvents = Math.max(1, Number(env.RAPIDAPI_ODDS_MARKET_EVENTS || MARKET_EVENTS_DEFAULT));
  const dailyRequestBudget = Math.max(1, Number(env.RAPIDAPI_ODDS_DAILY_REQUEST_BUDGET || 10));
  const meta = await readMeta(env);
  const today = utcToday();
  let requestsToday = meta.date === today ? Number(meta.requestsToday || 0) : 0;
  if (Number(meta.remaining || 0) < 60) return { skipped: 'quota_remaining_below_60', remaining: meta.remaining };
  if (requestsToday >= dailyRequestBudget) return { skipped: 'daily_request_limit_reached', requestsToday };
  let eventsRes;
  try { eventsRes = await rapidApiFetch('/api/v1/events?page=1&per_page=100&placing=PREMATCH', env); } catch (e) { return { error: 'events_fetch_failed', message: String(e.message) }; }
  requestsToday += 1;
  if (!eventsRes.ok) return { skipped: 'events_non_2xx', status: eventsRes.status, remaining: eventsRes.headers.get('x-ratelimit-requests-remaining') };
  const remaining = eventsRes.headers.get('x-ratelimit-requests-remaining');
  let eventsData;
  try { eventsData = await eventsRes.json(); } catch { return { skipped: 'events_invalid_json' }; }
  const rows = Array.isArray(eventsData?.data) ? eventsData.data : [];
  const now = new Date();
  const upcoming = rows.map(r => ({ raw: r, start: parseStartAt(r) }))
    .filter(i => i.start && i.start > now).sort((a,b)=>a.start-b.start);
  let marketFetched = 0;
  let oneX2OnlyEvents = 0;
  for (const item of upcoming) {
    if (marketFetched >= maxMarketEvents) { oneX2OnlyEvents += 1; continue; }
    const eid = String(item.raw.id);
    const cached = await env.TIPSTERS_CACHE.get(kvKey('markets', eid));
    let fresh = false;
    if (cached) { try { const c = JSON.parse(cached); if (c.fetchedAt && now - new Date(c.fetchedAt) < MARKET_CACHE_TTL_MS) fresh = true; } catch {} }
    if (fresh) { marketFetched += 1; continue; }
    if (requestsToday >= dailyRequestBudget) { oneX2OnlyEvents += 1; continue; }
    try {
      const mRes = await rapidApiFetch(`/api/v1/events/markets?event_id=${eid}`, env);
      requestsToday += 1;
      if (!mRes.ok) { oneX2OnlyEvents += 1; continue; }
      const mText = await mRes.text();
      await env.TIPSTERS_CACHE.put(kvKey('markets', eid), JSON.stringify({ fetchedAt: now.toISOString(), data: mText, remaining }));
      marketFetched += 1;
    } catch { oneX2OnlyEvents += 1; continue; }
  }
  // Remaining upcoming events not fetched with full markets are 1X2-only from list payload.
  for (let i = marketFetched + oneX2OnlyEvents; i < upcoming.length; i += 1) oneX2OnlyEvents += 0; // explicit accounting via loop above
  const eventsText = await eventsRes.text();
  await env.TIPSTERS_CACHE.put(kvKey('events'), JSON.stringify({ fetchedAt: now.toISOString(), data: eventsText, remaining }));
  await writeMeta(env, { remaining, requestsToday, date: today, fetchedAt: now.toISOString(), marketFetched, oneX2OnlyEvents, upcomingEvents: upcoming.length });
  return { ok: true, events: rows.length, marketsFetched: marketFetched, oneX2OnlyEvents, requestsToday, remaining };
}
async function cronB(env, ctx) {
  const meta = await readMeta(env);
  const remaining = Number(meta.remaining || 0);
  if (remaining <= 0) return { skipped: 'quota_exhausted', remaining };
  const today = utcToday();
  const from = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().slice(0, 10);
  let res;
  try { res = await rapidApiFetch(`/api/v1/results?from=${fmt(from)}&to=${fmt(new Date())}`, env); } catch (e) { return { error: 'results_fetch_failed', message: String(e.message) }; }
  if (!res.ok) return { skipped: 'results_non_2xx', status: res.status, remaining: res.headers.get('x-ratelimit-requests-remaining') };
  const newRemaining = res.headers.get('x-ratelimit-requests-remaining');
  const text = await res.text();
  await env.TIPSTERS_CACHE.put(kvKey('results'), JSON.stringify({ fetchedAt: new Date().toISOString(), data: text, remaining: newRemaining }));
  await writeMeta(env, { ...meta, remaining: newRemaining, date: today, requestsToday: Number(meta.requestsToday || 0) + 1 });
  return { ok: true, remaining: newRemaining };
}
export default {
  async scheduled(event, env, ctx) {
    // Daily fetch (1x/day) for events+markets and results to save quota.
    if (event.cron === '5 17 * * *' || event.cron === '0 0,12 * * *') return await cronA(env, ctx);
    if (event.cron === '20 17 * * *' || event.cron === '0 21 * * *') return await cronB(env, ctx);
    return { skipped: 'unknown_cron', cron: event.cron };
  },
  async fetch(request, env) {
    if (!authOk(request, env)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    const serveJson = kind => async id => {
      const raw = await env.TIPSTERS_CACHE.get(kvKey(kind, id));
      if (!raw) return new Response(JSON.stringify({ data: [] }), { headers: { 'Content-Type': 'application/json' } });
      try { const p = JSON.parse(raw); const b = p.data != null ? p.data : raw; return new Response(typeof b === 'string' ? b : JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } }); }
      catch { return new Response(raw, { headers: { 'Content-Type': 'application/json' } }); }
    };
    if (path === '/events') return await serveJson('events')();
    if (path === '/markets') return await serveJson('markets')(url.searchParams.get('event_id') || '');
    if (path === '/results') return await serveJson('results')();
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  },
};
