function providerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function safeProviderError(status) {
  return providerError(`SPORTRADAR_HTTP_${status}`, `Sportradar request failed (HTTP ${status})`, { httpStatus: status });
}

export class SportradarClient {
  constructor(config, { fetchImpl = fetch, now = () => Date.now(), beforeRequest = null } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.beforeRequest = beforeRequest;
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
      if (response.status === 429) {
        throw providerError("SPORTRADAR_RATE_LIMITED", "Sportradar rate limit reached (HTTP 429)", {
          httpStatus: 429,
          retryAfter: response.headers.get("retry-after")
        });
      }
      if (!response.ok) throw safeProviderError(response.status);
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
  getCompetitions(sportId) { return this.request(this.config.prematchBaseUrl, `sports/${encodeURIComponent(sportId)}/competitions`); }
  getDailySchedules(sportId, date, { start = 0, limit = 50 } = {}) {
    return this.request(this.config.prematchBaseUrl,
      `sports/${encodeURIComponent(sportId)}/schedules/${encodeURIComponent(date)}/schedules`, { start, limit });
  }
  async getAllDailySchedules(sportId, date, { pageSize = 50, maxPages = 20 } = {}) {
    const items = [];
    let start = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.getDailySchedules(sportId, date, { start, limit: pageSize });
      const rows = result.body?.schedules ?? [];
      items.push(...rows);
      const reported = Number(result.headers.get("x-max-results"));
      const received = Number(result.headers.get("x-result"));
      if (Number.isFinite(reported) && reported > start + rows.length) {
        start += rows.length || pageSize;
        continue;
      }
      if (Number.isFinite(received) && received >= pageSize) {
        start += rows.length || pageSize;
        continue;
      }
      break;
    }
    return items;
  }
  getDailySportEventMarkets(sportId, date, { start = 0, limit = 50 } = {}) {
    return this.request(this.config.prematchBaseUrl,
      `sports/${encodeURIComponent(sportId)}/schedules/${encodeURIComponent(date)}/sport_event_markets`, { start, limit });
  }
  getSportEventMarkets(eventId) {
    return this.request(this.config.prematchBaseUrl, `sport_events/${encodeURIComponent(eventId)}/sport_event_markets`);
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
