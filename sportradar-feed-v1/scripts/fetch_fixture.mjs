import { config as loadEnv } from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
loadEnv({ path: resolve(repoRoot, ".env"), quiet: true });

const apiKey = process.env.SPORTRADAR_API_KEY?.trim();
const accessLevel = (process.env.SPORTRADAR_ACCESS_LEVEL || "trial").trim().toLowerCase();
const language = (process.env.SPORTRADAR_LANGUAGE || "en").trim();
const configuredSport = process.env.SPORTRADAR_SPORT_ID
  || process.env.SPORTRADAR_SPORT_IDS?.split(",")[0]
  || "sr:sport:1";
const sportId = configuredSport.trim();
const date = (process.env.SPORTRADAR_FIXTURE_DATE || new Date().toISOString().slice(0, 10)).trim();

function validUtcDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function reportStatus(status) {
  console.log("HTTP status: " + status);
}

if (!apiKey) {
  reportStatus("NOT_SENT");
  process.exit(1);
}

if (!["trial", "production"].includes(accessLevel)
  || !/^sr:sport:\d+$/.test(sportId)
  || !/^[a-z]{2}$/.test(language)
  || !validUtcDate(date)) {
  reportStatus("NOT_SENT");
  process.exit(1);
}

const endpoint = new URL(
  "https://api.sportradar.com/oddscomparison-prematch/" + accessLevel
  + "/v2/" + language + "/sports/" + sportId + "/schedules/" + date
  + "/sport_event_markets.json"
);
endpoint.searchParams.set("start", "0");

let response;
try {
  response = await fetch(endpoint, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "accept": "application/json"
    },
    signal: AbortSignal.timeout(60_000)
  });
} catch {
  reportStatus("NETWORK_ERROR");
  process.exit(1);
}

reportStatus(response.status);
if (response.status !== 200) process.exit(1);

let rawBody;
let payload;
try {
  rawBody = await response.text();
  payload = JSON.parse(rawBody);
} catch {
  process.exit(1);
}

const fixturePath = resolve(repoRoot, "sportradar-feed-v1/fixtures/daily_markets.sample.json");
try {
  await mkdir(dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, rawBody, "utf8");
} catch {
  process.exit(1);
}

for (const headerName of ["X-Max-Results", "X-Offset", "X-Result"]) {
  console.log(headerName + ": " + (response.headers.get(headerName) ?? "(absent)"));
}
console.log("generated_at: " + (typeof payload?.generated_at === "string" ? payload.generated_at : "(absent)"));
