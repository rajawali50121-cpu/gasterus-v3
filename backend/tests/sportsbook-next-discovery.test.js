import test from "node:test";
import assert from "node:assert/strict";
import { fetchDiscoveryFeeds } from "../src/sportsbook-next/discovery.js";

test("discovery stops immediately after the first provider 429", async () => {
  const calls = [];
  const rateLimited = Object.assign(new Error("Sportradar rate limited"), {
    code: "SPORTRADAR_RATE_LIMITED",
    httpStatus: 429
  });
  const client = {
    getSports: async () => { calls.push("sports"); throw rateLimited; },
    getBooks: async () => { calls.push("books"); return { body: { books: [] } }; }
  };

  await assert.rejects(fetchDiscoveryFeeds(client), error => error === rateLimited);
  assert.deepEqual(calls, ["sports"]);
});

test("discovery requests Sports then Books sequentially after successful responses", async () => {
  const calls = [];
  const client = {
    getSports: async () => { calls.push("sports"); return { body: { sports: [] } }; },
    getBooks: async () => { calls.push("books"); return { body: { books: [] } }; }
  };

  const result = await fetchDiscoveryFeeds(client);
  assert.deepEqual(calls, ["sports", "books"]);
  assert.deepEqual(result, {
    sportsResult: { body: { sports: [] } },
    booksResult: { body: { books: [] } }
  });
});
