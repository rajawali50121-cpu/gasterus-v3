export async function fetchDiscoveryFeeds(client) {
  // A 429 on the first request must prevent the next request from being queued.
  const sportsResult = await client.getSports();
  const booksResult = await client.getBooks();
  return { sportsResult, booksResult };
}
