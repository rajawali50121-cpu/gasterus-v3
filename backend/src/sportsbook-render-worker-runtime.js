export function assertSportsbookWorkerStorage(env = process.env) {
  const missing = ['DATABASE_URL', 'REDIS_URL'].find(name => !String(env[name] || '').trim());
  if (missing) {
    throw new Error(`${missing} is required by sportsbook-render-worker`);
  }
}

export function sportsbookWorkerStorageAvailable(env = process.env) {
  return ['DATABASE_URL', 'REDIS_URL'].every(name => String(env[name] || '').trim().length > 0);
}
