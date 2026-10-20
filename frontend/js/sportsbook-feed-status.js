export function deriveSportsbookFeedPresentation(feed, now = Date.now()) {
  const source = feed?.source || {};
  const fetchedAt = Date.parse(source.fetchedAt || '');
  const staleAfterSeconds = Number(source.staleAfterSeconds);
  const staleAfterMs = Number.isFinite(staleAfterSeconds) && staleAfterSeconds > 0
    ? staleAfterSeconds * 1000
    : 180_000;
  const isAgeStale = !Number.isFinite(fetchedAt) || now - fetchedAt > staleAfterMs;
  const pricedMarkets = Number.isFinite(Number(source.pricedMarkets))
    ? Number(source.pricedMarkets)
    : 0;
  const bettableMarkets = Number.isFinite(Number(source.bettableMarkets))
    ? Number(source.bettableMarkets)
    : 0;
  const isReadOnly = String(source.mode || '').startsWith('READ_ONLY')
    || source.status === 'PRICED_READ_ONLY';

  let statusText = 'Menunggu odds';
  if (isAgeStale) statusText = 'Feed tertunda';
  else if (isReadOnly && pricedMarkets > 0) statusText = 'Odds ditampilkan - taruhan belum dibuka';
  else if (feed?.degraded || source.status === 'DEGRADED') statusText = 'Feed terbatas';
  else if (feed?.events?.length && (bettableMarkets > 0 || pricedMarkets > 0)) statusText = 'Feed aktif';

  return {
    banner: isAgeStale ? 'stale' : feed?.degraded && !isReadOnly ? 'degraded' : null,
    isAgeStale,
    isReadOnly,
    pricedMarkets,
    statusText
  };
}