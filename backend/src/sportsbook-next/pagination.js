export function aggregatePaginationMeta(feeds = []) {
  const reportedTotalsAvailable = feeds.length > 0 && feeds.every(feed => Number.isSafeInteger(feed.reportedTotal) && feed.reportedTotal >= 0);
  return {
    truncated: feeds.some(feed => feed.truncated === true),
    reportedTotal: reportedTotalsAvailable
      ? feeds.reduce((total, feed) => total + feed.reportedTotal, 0)
      : null,
    fetched: feeds.reduce((total, feed) => total + (Number.isFinite(feed.fetched) ? feed.fetched : 0), 0),
    pages: feeds.reduce((total, feed) => total + (Number.isFinite(feed.pages) ? feed.pages : 0), 0),
    feeds
  };
}
