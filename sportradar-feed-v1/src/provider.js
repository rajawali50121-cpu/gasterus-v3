import { config } from "./config.js";
import { assertProviderAllowed, openCircuitBreaker } from "./guard.js";

export async function fetchMarketsPage(sportId, date, start = 0, limit = 100) {
  await assertProviderAllowed();
  const url = new URL(`https://api.sportradar.com/oddscomparison-prematch/${config.accessLevel}/v2/${config.language}/sports/${sportId}/schedules/${date}/sport_event_markets.json`);
  url.searchParams.set("start", String(start));
  url.searchParams.set("limit", String(limit));

  let response;
  try {
    response = await fetch(url, {
      headers: { "x-api-key": config.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(60000)
    });
  } catch (error) {
    throw new Error(`Sportradar network failure: ${error.name || "fetch error"}`);
  }

  if (response.status === 403 || response.status === 429) await openCircuitBreaker(response.status);
  if (!response.ok) {
    // Never include request URL or credentials in logs/errors.
    throw new Error(`Sportradar HTTP ${response.status}`);
  }

  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error("Sportradar returned invalid JSON"); }
  return {
    payload,
    headers: {
      maxResults: response.headers.get("x-max-results"),
      offset: response.headers.get("x-offset"),
      result: response.headers.get("x-result")
    }
  };
}
