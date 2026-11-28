import test from "node:test";
import assert from "node:assert/strict";
import { persistSportsbookSnapshot } from "../src/sportsbook-next/repository.js";

const event = (id, scheduled = "2026-11-28T12:00:00.000Z") => ({
  id: `sr:sport_event:${id}`,
  sportId: "sr:sport:1",
  scheduled,
  status: "not_started",
  home: "Home",
  away: "Away",
  competition: "League",
  competitionId: "sr:competition:1",
  markets: [{
    id: "sr:market:1",
    key: "sr:market:1|1x2",
    name: "1x2",
    live: false,
    books: [{
      id: "sr:book:1",
      name: "Book",
      outcomes: [{ id: "sr:outcome:1", type: "home", name: "Home", oddsDecimal: 2.1 }]
    }]
  }]
});

test("snapshot persistence rejects incomplete input before opening a transaction", async () => {
  let opened = false;
  await assert.rejects(
    persistSportsbookSnapshot([event(1)], "2026-11-28T00:00:00.000Z", {
      complete: false,
      transaction: async () => { opened = true; }
    }),
    error => error.message === "SPORTSBOOK_SNAPSHOT_INCOMPLETE"
  );
  assert.equal(opened, false);
});

test("complete empty feed deactivates all events in the requested sport/date scope", async () => {
  const statements = [];
  const transaction = async callback => callback({
    query: async (sql, params) => { statements.push({ sql, params }); return { rowCount: 1 }; }
  });
  const result = await persistSportsbookSnapshot([], "2026-11-28T00:00:00.000Z", {
    complete: true,
    scopes: [{ sportId: "sr:sport:1", date: "2026-11-28", ids: [] }],
    transaction
  });
  assert.deepEqual(result, { events: 0, markets: 0, prices: 0 });
  const deactivateMarkets = statements.find(item => item.sql.includes("UPDATE sportsbook_v2_markets m SET is_active=FALSE"));
  const deactivatePrices = statements.find(item => item.sql.includes("UPDATE sportsbook_v2_prices p SET is_active=FALSE"));
  assert.deepEqual(deactivateMarkets.params, ["sr:sport:1", "2026-11-28", []]);
  assert.deepEqual(deactivatePrices.params, ["sr:sport:1", "2026-11-28", []]);
});

test("complete snapshot refreshes event schedule/status and deactivates omitted same-sport UTC-day events", async () => {
  const statements = [];
  const transaction = async callback => callback({
    query: async (sql, params) => { statements.push({ sql, params }); return { rowCount: 1 }; }
  });
  const result = await persistSportsbookSnapshot(
    [event(101, "2026-11-28T12:30:00.000Z")],
    "2026-11-28T00:00:00.000Z",
    { complete: true, scopes: [{ sportId: "sr:sport:1", date: "2026-11-28", ids: ["sr:sport_event:101"] }], transaction }
  );
  assert.deepEqual(result, { events: 1, markets: 1, prices: 1 });
  const upsert = statements.find(item => item.sql.includes("INSERT INTO sportsbook_v2_events"));
  assert.match(upsert.sql, /scheduled_at=COALESCE\(excluded\.scheduled_at,sportsbook_v2_events\.scheduled_at\)/);
  assert.match(upsert.sql, /competition_id=COALESCE\(excluded\.competition_id,sportsbook_v2_events\.competition_id\)/);
  assert.match(upsert.sql, /competition_name=COALESCE\(excluded\.competition_name,sportsbook_v2_events\.competition_name\)/);
  assert.match(upsert.sql, /home_name=COALESCE\(excluded\.home_name,sportsbook_v2_events\.home_name\)/);
  assert.match(upsert.sql, /away_name=COALESCE\(excluded\.away_name,sportsbook_v2_events\.away_name\)/);
  assert.match(upsert.sql, /THEN sportsbook_v2_events\.event_status ELSE excluded\.event_status END/);
  const deactivateMarkets = statements.find(item => item.sql.includes("UPDATE sportsbook_v2_markets m SET is_active=FALSE"));
  const deactivatePrices = statements.find(item => item.sql.includes("UPDATE sportsbook_v2_prices p SET is_active=FALSE"));
  assert.ok(deactivateMarkets);
  assert.ok(deactivatePrices);
  assert.deepEqual(deactivateMarkets.params, ["sr:sport:1", "2026-11-28", ["sr:sport_event:101"]]);
  assert.match(deactivateMarkets.sql, /ANY\(\$3::text\[\]\)/);
  assert.match(deactivatePrices.sql, /ANY\(\$3::text\[\]\)/);
});
