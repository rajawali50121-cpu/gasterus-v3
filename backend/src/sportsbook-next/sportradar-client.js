function providerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function safeProviderError(status, details = {}) {
  return providerError(`SPORTRADAR_HTTP_${status}`, `Sportradar request failed (HTTP ${status})`, { httpStatus: status, ...details });
}

function safeProviderMessage(body, apiKey) {
  if (!body || typeof body !== "object" || typeof body.message !== "string") return null;
  let message = body.message.replace(/[\\r\\n\\t]+/g, " ").trim();
  const key = String(apiKey || "").trim();
  if (key) message = message.split(key).join("[REDACTED]");
  return message.slice(0, 240) || null;
}

function encodeUrnPathSegment(value) {
  // Sportradar examples use colon-delimited URNs as literal path segments.
  // Keep the separators intact while still escaping any other unsafe chars.
  return encodeURIComponent(String(value)).replace(/%3A/gi, ":");
}

export class SportradarClient {
  constructor(config, { fetchImpl = fetch, now = () => Date.now(), beforeRequest = null, onResponse = null, onRateLimit = null } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.beforeRequest = beforeRequest;
    this.onResponse = onResponse;
    this.onRateLimit = onRateLimit;
    this.calls = [];
  }

  get callsUsed30Days() {
    const cutoff = this.now() - 30 * 24 * 60 * 60 * 1000;
    this.calls = this.calls.filter(at => at >= cutoff);
    return this.config.initialCallsUsed30Days + this.calls.length;
  }

  async request(baseUrl, path, query = {}) {
    // In production, beforeRequest reserves quota atomically in Redis across all workers.
    // The local counter is only a fallback for standalone client use without that hook.
    if (!this.beforeRequest && this.callsUsed30Days >= this.config.maxCallsPer30Days) {
      throw providerError("SPORTRADAR_30_DAY_QUOTA_EXHAUSTED", "SPORTRADAR_30_DAY_QUOTA_EXHAUSTED", {
        quotaScope: "30_days", quotaUsed: this.callsUsed30Days, quotaLimit: this.config.maxCallsPer30Days
      });
    }
    const url = new URL(`${baseUrl}/${String(path).replace(/^\/+/, "")}.json`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    if (this.beforeRequest) await this.beforeRequest();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    this.calls.push(this.now());
    try {
      const response = await this.fetch(url, {
        method: "GET",
        headers: { "x-api-key": this.config.apiKey, accept: "application/json" },
        signal: controller.signal
      });
      const body = await response.json().catch(() => null);
      const topLevelKeys = body && typeof body === "object" && !Array.isArray(body)
        ? Object.keys(body).sort()
        : [];
      const arrayCounts = Object.fromEntries(topLevelKeys
        .filter(key => Array.isArray(body[key]))
        .map(key => [key, body[key].length]));
      const providerMessage = response.ok ? null : safeProviderMessage(body, this.config.apiKey);
      const originId = response.headers.get("x-origin-id");
      const retryAfterHeader = response.headers.get("retry-after");
      try {
        this.onResponse?.({
          httpStatus: response.status,
          contentType: response.headers.get("content-type"),
          contentLength: response.headers.get("content-length"),
          providerMessage,
          originId,
          retryAfter: retryAfterHeader,
          cacheControl: response.headers.get("cache-control"),
          topLevelKeys,
          arrayCounts,
          pagination: {
            maxResults: response.headers.get("x-max-results"),
            offset: response.headers.get("x-offset"),
            result: response.headers.get("x-result")
          }
        });
      } catch {
        // Diagnostic logging must never change provider request behavior.
      }
      if (response.status === 429) {
        const retryAfter = retryAfterHeader;
        try { await this.onRateLimit?.({ retryAfter, httpStatus: 429 }); } catch { /* retain original provider error */ }
        throw providerError("SPORTRADAR_RATE_LIMITED", "Sportradar rate limit reached (HTTP 429)", {
          httpStatus: 429, retryAfter, providerMessage, originId
        });
      }
      if (!response.ok) throw safeProviderError(response.status, { providerMessage, originId });
      if (!body || typeof body !== "object") {
        throw providerError("SPORTRADAR_INVALID_JSON", "Sportradar returned invalid JSON");
      }
      return { body, headers: response.headers };
    } finally {
      clearTimeout(timeout);
    }
  }

  getSports() { return this.request(this.config.prematchBaseUrl, "sports"); }
  getBooks() { return this.request(this.config.prematchBaseUrl, "books"); }
  getCompetitions(sportId) { return this.request(this.config.prematchBaseUrl, `sports/${encodeUrnPathSegment(sportId)}/competitions`); }
  getDailySchedules(sportId, date, { start = 0, limit = 50 } = {}) {
    return this.request(this.config.prematchBaseUrl,
      `sports/${encodeUrnPathSegment(sportId)}/schedules/${encodeURIComponent(date)}/schedules`, { start, limit });
  }
  async getAllDailySchedules(sportId, date, { pageSize = 50, maxPages = 20 } = {}) {
    const items = [];
    let start = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.getDailySchedules(sportId, date, { start, limit: pageSize });
      const rows = result.body?.schedules ?? [];
      items.push(...rows);
      const reportedHeader = result.headers.get("x-max-results");
      const receivedHeader = result.headers.get("x-result");
      const reported = reportedHeader === null ? null : Number(reportedHeader);
      const received = receivedHeader === null ? null : Number(receivedHeader);
      if (reported !== null && Number.isFinite(reported) && reported > start + rows.length) {
        start += rows.length || pageSize;
        continue;
      }
      if (received !== null && Number.isFinite(received) && received >= pageSize) {
        start += rows.length || pageSize;
        continue;
      }
      // Some provider responses omit pagination headers. A full page is the
      // only safe signal to request the next offset; maxPages remains the cap.
      if ((reportedHeader === null && receivedHeader === null) && rows.length >= pageSize) {
        start += rows.length || pageSize;
        continue;
      }
      break;
    }
    return items;
  }
  getDailySportEventMarkets(sportId, date, { start = 0, limit = 50 } = {}) {
    return this.request(this.config.prematchBaseUrl,
      `sports/${encodeUrnPathSegment(sportId)}/schedules/${encodeURIComponent(date)}/sport_event_markets`, { start, limit });
  }
  async getAllDailySportEventMarkets(sportId, date, { pageSize = 50, maxPages = 10 } = {}) {
    const items = [];
    let start = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.getDailySportEventMarkets(sportId, date, { start, limit: pageSize });
      const rows = result.body?.sport_schedule_sport_event_markets
        ?? result.body?.sport_events
        ?? result.body?.events
        ?? result.body?.schedules;
      if (!Array.isArray(rows)) {
        throw providerError(
          "SPORTRADAR_BULK_MARKETS_SHAPE_INVALID",
          "Sportradar Prematch Daily Sport Event Markets response is missing a documented event array"
        );
      }
      items.push(...rows);
      const reportedHeader = result.headers.get("x-max-results");
      const receivedHeader = result.headers.get("x-result");
      const reported = reportedHeader === null ? null : Number(reportedHeader);
      const received = receivedHeader === null ? null : Number(receivedHeader);
      if (reported !== null && Number.isFinite(reported) && reported > start + rows.length) {
        start += rows.length || pageSize;
        continue;
      }
      if (received !== null && Number.isFinite(received) && received >= pageSize) {
        start += rows.length || pageSize;
        continue;
      }
      // If the provider omits both pagination headers, a full page is the
      // only safe signal to request another offset; maxPages remains the cap.
      if (reportedHeader === null && receivedHeader === null && rows.length >= pageSize) {
        start += rows.length || pageSize;
        continue;
      }
      break;
    }
    return { body: { sport_events: items } };
  }
  getSportEventMarkets(eventId) {
    return this.request(this.config.prematchBaseUrl, `sport_events/${encodeUrnPathSegment(eventId)}/sport_event_markets`);
  }
  getSportEventMarketsChangeLog() {
    return this.request(this.config.prematchBaseUrl, "sport_event_markets_changelog");
  }
  getSoccerDailySchedules(date) {
    return this.request(this.config.soccerBaseUrl, `schedules/${encodeURIComponent(date)}/schedules`);
  }
  getSoccerDailySummaries(date) {
    return this.request(this.config.soccerBaseUrl, `schedules/${encodeURIComponent(date)}/summaries`);
  }
  getSoccerLiveSummaries() { return this.request(this.config.soccerBaseUrl, "schedules/live/summaries"); }
}
