import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apiKey = String(process.env.SPORTRADAR_API_KEY || "").trim();
if (!apiKey) {
  console.error("SPORTRADAR_API_KEY is missing; no request was made.");
  process.exit(2);
}

const accessLevel = String(process.env.SPORTRADAR_ACCESS_LEVEL || "trial").toLowerCase();
if (!["trial", "production"].includes(accessLevel)) {
  console.error("SPORTRADAR_ACCESS_LEVEL must be trial or production.");
  process.exit(2);
}
const language = String(process.env.SPORTRADAR_LANGUAGE || "en").trim();
const sportId = String((process.env.SPORTRADAR_SPORT_IDS || "sr:sport:1").split(",")[0]).trim();
if (!/^sr:sport:\\d+$/.test(sportId)) {
  console.error("SPORTRADAR_SPORT_IDS must begin with a valid Sportradar sport URN.");
  process.exit(2);
}

const date = new Date().toISOString().slice(0, 10);
const url = new URL(`https://api.sportradar.com/oddscomparison-prematch/${accessLevel}/v2/${encodeURIComponent(language)}/sports/${encodeURIComponent(sportId)}/schedules/${date}/sport_event_markets.json`);
url.searchParams.set("start", "0");
url.searchParams.set("limit", "50");

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);
let response;
try {
  // Exactly one request. No retries, pagination or automatic follow-up calls.
  response = await fetch(url, {
    method: "GET",
    headers: { "x-api-key": apiKey, accept: "application/json" },
    signal: controller.signal
  });
} catch (error) {
  console.error(`Sportradar request failed before receiving a response: ${error.name || "NETWORK_ERROR"}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}

if (response) {
  console.log(`HTTP_STATUS=${response.status}`);
  console.log(`CONTENT_TYPE=${response.headers.get("content-type") || "unknown"}`);
  console.log(`DATE_UTC=${date}`);
  console.log(`SPORT_ID=${sportId}`);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body.message === "string"
      ? body.message.replace(/[\\r\\n\\t]+/g, " ").slice(0, 180)
      : "No provider message";
    console.error(`Provider rejected the request: ${message}`);
    console.error("No retry was attempted and no fixture was written.");
    process.exitCode = 1;
  } else if (!body || typeof body !== "object" || Array.isArray(body)) {
    console.error("Provider returned a non-object JSON payload; no fixture was written.");
    process.exitCode = 1;
  } else {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const output = resolve(scriptDir, "../tests/fixtures/sportradar/daily-sport-event-markets.sample.json");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({
      capturedAt: new Date().toISOString(),
      request: { endpoint: "daily-sport-event-markets", accessLevel, language, sportId, date, start: 0, limit: 50 },
      response: body
    }, null, 2) + "\\n", { flag: "wx" });
    const arrayKeys = Object.keys(body).filter(key => Array.isArray(body[key]));
    console.log(`FIXTURE_WRITTEN=${output}`);
    console.log(`ROOT_KEYS=${Object.keys(body).sort().join(",")}`);
    console.log(`ARRAY_KEYS=${arrayKeys.map(key => `${key}:${body[key].length}`).join(",") || "none"}`);
  }
}
