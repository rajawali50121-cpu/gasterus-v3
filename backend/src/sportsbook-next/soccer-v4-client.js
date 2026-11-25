function providerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

export function parseSoccerCacheTtlMs(cacheControl) {
  if (typeof cacheControl !== "string") return null;
  const match = cacheControl.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i);
  return match ? Number(match[1]) * 1000 : null;
}

function parseHeaderInteger(value) {
  if (typeof value !== "string" || !/^\\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function getSoccerNextPageStart({ start, limit, returned, maxResults }) {
  if (![start, limit, returned].every(Number.isSafeInteger) || start < 0 || limit < 1 || limit > 200 || returned < 0) {
    throw new TypeError("SOCCER_V4_PAGINATION_INVALID");
  }
  if (maxResults !== null && maxResults !== undefined) {
    if (!Number.isSafeInteger(maxResults) || maxResults < 0) throw new TypeError("SOCCER_V4_PAGINATION_INVALID");
    return start + returned < maxResults ? start + returned : 0;
  }
  return returned === limit ? start + returned : 0;
}

export class SoccerV4Client {
  constructor(config, { fetchImpl = fetch, beforeRequest = null, onRateLimit = null, onResponse = null } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.beforeRequest = beforeRequest;
    this.onRateLimit = onRateLimit;
    this.onResponse = onResponse;
    this.cycleCalls = 0;
  }

  async getDailySummaries(date, { start = 0, limit = 200 } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + "T00:00:00Z"))) {
      throw new TypeError("SOCCER_V4_DATE_INVALID");
    }
    if (this.beforeRequest) await this.beforeRequest();
    const url = this.config.baseUrl + "/schedules/" + encodeURIComponent(date) + "/summaries.json?start=" + start + "&limit=" + limit;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    this.cycleCalls += 1;
    try {
      const response = await this.fetch(url, {
        method: "GET",
        headers: { "x-api-key": this.config.apiKey, accept: "application/json" },
        signal: controller.signal
      });
      const retryAfter = response.headers.get("retry-after");
      const cacheControl = response.headers.get("cache-control");
      const metadata = {
        httpStatus: response.status,
        retryAfter,
        cacheControl,
        cacheTtlMs: parseSoccerCacheTtlMs(cacheControl),
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),\n        maxResults: parseHeaderInteger(response.headers.get("x-max-results")),\n        resultCountHeader: parseHeaderInteger(response.headers.get("x-result")),\n        offset: parseHeaderInteger(response.headers.get("x-offset"))
      };
      this.onResponse?.(metadata);
      if (response.status === 429) {
        try { await this.onRateLimit?.({ retryAfter, httpStatus: 429 }); } catch {}
        throw providerError("SOCCER_V4_RATE_LIMITED", "Sportradar Soccer v4 rate limit reached", {
          httpStatus: 429, retryAfter
        });
      }
      if (!response.ok) {
        throw providerError("SOCCER_V4_HTTP_" + response.status, "Sportradar Soccer v4 request failed (HTTP " + response.status + ")", {
          httpStatus: response.status, retryAfter
        });
      }
      const body = await response.json().catch(() => null);
      if (!body || typeof body !== "object" || !Array.isArray(body.summaries)) {
        throw providerError("SOCCER_V4_RESULTS_SHAPE_INVALID", "Soccer v4 summaries response has an invalid shape");
      }
      return { body, headers: response.headers, metadata };
    } finally {
      clearTimeout(timeout);
    }
  }
}
