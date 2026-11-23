function safeProviderError(status, body) {
  const message = typeof body?.message === "string" ? body.message : `Sportradar request failed (HTTP ${status})`;
  return new Error(message.slice(0, 240));
}

export class SportradarClient {
  constructor(config, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.calls = [];
  }

  get callsUsed30Days() {
    const cutoff = this.now() - 30 * 24 * 60 * 60 * 1000;
    this.calls = this.calls.filter(at => at >= cutoff);
    return this.config.initialCallsUsed30Days + this.calls.length;
  }

  async request(baseUrl, path, query = {}) {
    if (this.callsUsed30Days >= this.config.maxCallsPer30Days) throw new Error("SPORTRADAR_30_DAY_QUOTA_EXHAUSTED");
    const url = new URL(`${baseUrl}/${String(path).replace(/^\\/+/, "")}.json`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
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
        const error = new Error("SPORTRADAR_RATE_LIMITED");
        error.code = "SPORTRADAR_RATE_LIMITED";
        error.retryAfter = response.headers.get("retry-after");
        throw error;
      }
      if (!response.ok) throw safeProviderError(response.status, body);
      if (!body || typeof body !== "object") throw new Error("SPORTRADAR_INVALID_JSON");
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
  getSportEventMarkets(eventId) {
    return this.request(this.config.prematchBaseUrl, `sport_events/${encodeURIComponent(eventId)}/sport_event_markets`);
  }
  getSoccerDailySchedules(date) {
    return this.request(this.config.soccerBaseUrl, `schedules/${encodeURIComponent(date)}/schedules`);
  }
  getSoccerDailySummaries(date) {
    return this.request(this.config.soccerBaseUrl, `schedules/${encodeURIComponent(date)}/summaries`);
  }
  getSoccerLiveSummaries() { return this.request(this.config.soccerBaseUrl, "schedules/live/summaries"); }
}
