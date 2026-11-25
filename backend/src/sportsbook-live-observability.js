export function priceVersionChangeCount(previousEvents = [], nextEvents = []) {
  const previous = new Map();
  for (const event of previousEvents || []) {
    for (const market of event.markets || []) {
      for (const selection of market.selections || []) {
        previous.set(`${event.id}|${market.id}|${selection.key}`, selection.priceVersion || null);
      }
    }
  }
  let changes = 0;
  for (const event of nextEvents || []) {
    for (const market of event.markets || []) {
      for (const selection of market.selections || []) {
        const key = `${event.id}|${market.id}|${selection.key}`;
        const previousVersion = previous.get(key);
        if (previousVersion && selection.priceVersion && previousVersion !== selection.priceVersion) changes += 1;
      }
    }
  }
  return changes;
}
