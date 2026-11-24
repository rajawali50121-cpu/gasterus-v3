const DROP_KEYS = new Set(["raw", "raw_data", "raw_payload", "xml", "debug", "description_html"]);

export function getRemovalStatus(value) {
  if (!value || typeof value !== "object") return false;
  return value.removed === true || value.removed === "true";
}

export function sanitizePayload(value, depth = 0) {
  if (depth > 30) return null;
  if (Array.isArray(value)) return value.map(item => sanitizePayload(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (DROP_KEYS.has(key.toLowerCase())) continue;
    clean[key] = sanitizePayload(child, depth + 1);
  }
  // Preserve provider's original fields and expose a normalized flag only when supplied.
  if (Object.hasOwn(value, "removed")) clean.is_removed = getRemovalStatus(value);
  return clean;
}
