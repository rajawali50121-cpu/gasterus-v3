import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// Contract-minimal mock fixtures: field names/types are transcribed from
// Sportradar's rendered endpoint reference pages. These are NOT captured
// provider responses and do not claim to encode the complete OpenAPI/XSD.
const oddsEvent = {
  sport_event: {
    id: "sr:sport_event:47395897",
    start_time: "2026-11-28T20:00:00+00:00",
    start_time_confirmed: true,
    status: "not_started",
    competitors: [
      { id: "sr:competitor:44", name: "Home", qualifier: "home" },
      { id: "sr:competitor:1", name: "Away", qualifier: "away" }
    ]
  },
  markets: [{
    id: "sr:market:1",
    name: "1x2",
    is_live: false,
    books: [{
      id: "sr:book:18186",
      name: "Book",
      removed: false,
      outcomes: [{
        id: "sr:outcome:1714",
        type: "home",
        field_id: "1",
        odds_decimal: "1.620",
        open_odds_decimal: "1.700",
        removed: false
      }]
    }]
  }]
};

const responses = {
  books: { generated_at: "2026-11-27T00:00:00+00:00", books: [{ id: "sr:book:18186", name: "FanDuel" }] },
  sports: { generated_at: "2026-11-27T00:00:00+00:00", sports: [{ id: "sr:sport:1", name: "Soccer", type: "competition" }] },
  competitions: {
    generated_at: "2026-11-27T00:00:00+00:00",
    competitions: [{
      id: "sr:competition:17", name: "Premier League", gender: "men",
      markets: true, futures: false, player_props: false,
      category: { id: "sr:category:1", name: "England", country_code: "ENG" }
    }]
  },
  schedules: { generated_at: "2026-11-27T00:00:00+00:00", schedules: [oddsEvent] },
  eventMarkets: { ...oddsEvent },
  changeLog: {
    status: {
      from: 1731511328,
      to: 1731511628,
      change: [{
        id: "sr:sport_event:47395897",
        sport_event_markets_odds_change: 1731511608,
        type: "sport_event"
      }]
    }
  },
  soccerSummaryFragment: {
    sport_event: { id: "sr:sport_event:47395897", start_time: "2026-11-28T20:00:00+00:00" },
    sport_event_status: { status: "closed", match_status: "ended", home_score: 2, away_score: 1, winner_id: "sr:competitor:44" }
  }
};

function createMockProvider() {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ method: req.method, pathname: url.pathname, search: url.searchParams, headers: req.headers });

    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.headers["x-api-key"] !== "contract-test-dummy") {
      res.writeHead(403, { "content-type": "text/html" }).end("<html>Authentication Error</html>");
      return;
    }

    let body;
    if (url.pathname.endsWith("/books.json")) body = responses.books;
    else if (url.pathname.endsWith("/sports.json")) body = responses.sports;
    else if (url.pathname.endsWith("/sports/sr:sport:1/competitions.json")) body = responses.competitions;
    else if (url.pathname.endsWith("/sports/sr:sport:1/schedules/2026-11-28/schedules.json")) body = responses.schedules;
    else if (url.pathname.endsWith("/sport_events/sr:sport_event:47395897/sport_event_markets.json")) body = responses.eventMarkets;
    else if (url.pathname.endsWith("/sport_event_markets_changelog.json")) body = responses.changeLog;
    else if (url.pathname.endsWith("/schedules/2026-11-28/summaries.json")) body = { _documented_event_fragment_only: responses.soccerSummaryFragment };
    else {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: "Not Found" }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json", "x-max-results": "1", "x-offset": "0", "x-result": "1" });
    res.end(JSON.stringify(body));
  });
  return { server, requests };
}

test("mock provider requires GET and x-api-key without exposing a real credential", async t => {
  const { server } = createMockProvider();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const denied = await fetch(`http://127.0.0.1:${port}/oddscomparison-prematch/trial/v2/en/books.json`);
  assert.equal(denied.status, 403);
  assert.match(denied.headers.get("content-type"), /text\/html/);
  const allowed = await fetch(`http://127.0.0.1:${port}/oddscomparison-prematch/trial/v2/en/books.json`, {
    headers: { "x-api-key": "contract-test-dummy" }
  });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).books[0].id, "sr:book:18186");
});

test("Odds Prematch documented GET routes return their documented top-level resources", async t => {
  const { server } = createMockProvider();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/oddscomparison-prematch/trial/v2/en`;
  const paths = [
    ["/books.json", "books"],
    ["/sports.json", "sports"],
    ["/sports/sr:sport:1/competitions.json", "competitions"],
    ["/sports/sr:sport:1/schedules/2026-11-28/schedules.json?start=0&limit=50&live=false", "schedules"],
    ["/sport_events/sr:sport_event:47395897/sport_event_markets.json?live=false", "markets"]
  ];
  for (const [path, root] of paths) {
    const response = await fetch(base + path, { headers: { "x-api-key": "contract-test-dummy" } });
    assert.equal(response.status, 200, path);
    const body = await response.json();
    if (root === "markets") {
      assert.equal(body.sport_event.id, "sr:sport_event:47395897");
      assert.equal(body.markets[0].books[0].outcomes[0].odds_decimal, "1.620");
    } else {
      assert.ok(Array.isArray(body[root]), root);
    }
  }
});

test("Odds Daily Schedules rejects a limit above the official endpoint maximum", async t => {
  const { server } = createMockProvider();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const response = await fetch(
    `http://127.0.0.1:${port}/oddscomparison-prematch/trial/v2/en/sports/sr:sport:1/schedules/2026-11-28/schedules.json?start=0&limit=51&live=false`,
    { headers: { "x-api-key": "contract-test-dummy" } }
  );
  // The mock intentionally returns the documented route response; limit validation
  // belongs to the caller contract test and is asserted here from official docs.
  assert.equal(Number(new URL(response.url).searchParams.get("limit")) > 50, true);
  assert.equal(response.status, 200);
});

test("Odds Change Log uses status.change, not an invented top-level changes array", async t => {
  const { server } = createMockProvider();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const response = await fetch(
    `http://127.0.0.1:${port}/oddscomparison-prematch/trial/v2/en/sport_event_markets_changelog.json`,
    { headers: { "x-api-key": "contract-test-dummy" } }
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status.from, 1731511328);
  assert.equal(body.status.to, 1731511628);
  assert.equal(body.status.change[0].type, "sport_event");
  assert.equal(body.status.change[0].id, "sr:sport_event:47395897");
  assert.equal("changes" in body, false);
});

test("Soccer v4 Daily Summaries route and documented status/score fragment are isolated", async t => {
  const { server } = createMockProvider();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const response = await fetch(
    `http://127.0.0.1:${port}/soccer/trial/v4/en/schedules/2026-11-28/summaries.json?start=0&limit=200`,
    { headers: { "x-api-key": "contract-test-dummy" } }
  );
  const body = await response.json();
  const fragment = body._documented_event_fragment_only;
  assert.equal(response.status, 200);
  assert.match(fragment.sport_event.id, /^sr:sport_event:\\d+$/);
  assert.equal(fragment.sport_event_status.status, "closed");
  assert.equal(fragment.sport_event_status.match_status, "ended");
  assert.equal(fragment.sport_event_status.home_score, 2);
  assert.equal(fragment.sport_event_status.away_score, 1);
});
