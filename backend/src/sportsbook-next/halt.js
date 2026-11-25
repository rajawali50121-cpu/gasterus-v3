export const HALT_KEY = "sportsbook:next:halted:v1";

export async function setSportsbookHalt(redis, error, now = new Date().toISOString()) {
  const status = Number(error?.httpStatus);
  if (status !== 401 && status !== 403) return false;
  await redis.set(HALT_KEY, JSON.stringify({
    code: error?.code || `SPORTRADAR_HTTP_${status}`,
    httpStatus: status,
    haltedAt: now
  }));
  return true;
}

export async function getSportsbookHalt(redis) {
  const value = await redis.get(HALT_KEY);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && (parsed.httpStatus === 401 || parsed.httpStatus === 403) ? parsed : { code: "SPORTRADAR_HALTED_INVALID_STATE", httpStatus: null };
  } catch {
    return { code: "SPORTRADAR_HALTED_INVALID_STATE", httpStatus: null };
  }
}

export async function clearSportsbookHalt(redis) {
  return redis.del(HALT_KEY);
}
