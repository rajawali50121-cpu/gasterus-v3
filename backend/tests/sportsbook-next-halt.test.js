import test from "node:test";
import assert from "node:assert/strict";
import { HALT_KEY, setSportsbookHalt, getSportsbookHalt, clearSportsbookHalt } from "../src/sportsbook-next/halt.js";

function fakeRedis() {
  const values = new Map();
  return {
    values,
    async set(key, value) { values.set(key, value); return "OK"; },
    async get(key) { return values.get(key) ?? null; },
    async del(key) { return values.delete(key) ? 1 : 0; }
  };
}

test("401 and 403 activate a persistent halt", async () => {
  for (const status of [401, 403]) {
    const redis = fakeRedis();
    assert.equal(await setSportsbookHalt(redis, { httpStatus: status, code: `SPORTRADAR_HTTP_${status}` }), true);
    const halt = await getSportsbookHalt(redis);
    assert.equal(halt.httpStatus, status);
    assert.equal(halt.code, `SPORTRADAR_HTTP_${status}`);
  }
});

test("429 and unrelated errors do not activate the authentication halt", async () => {
  const redis = fakeRedis();
  assert.equal(await setSportsbookHalt(redis, { httpStatus: 429 }), false);
  assert.equal(await setSportsbookHalt(redis, { httpStatus: 500 }), false);
  assert.equal(await getSportsbookHalt(redis), null);
});

test("manual reset clears the halt", async () => {
  const redis = fakeRedis();
  await redis.set(HALT_KEY, JSON.stringify({ httpStatus: 403, code: "SPORTRADAR_HTTP_403" }));
  assert.equal(await clearSportsbookHalt(redis), 1);
  assert.equal(await getSportsbookHalt(redis), null);
});

test("invalid persisted halt state fails closed", async () => {
  const redis = fakeRedis();
  await redis.set(HALT_KEY, "{invalid");
  assert.equal((await getSportsbookHalt(redis)).code, "SPORTRADAR_HALTED_INVALID_STATE");
});
