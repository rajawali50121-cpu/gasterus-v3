import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const feedSource = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
const validationStart = feedSource.indexOf('const MIN_1X2_OVERROUND');
const validationEnd = feedSource.indexOf('\nconst LIFECYCLE_GENERATION', validationStart);
assert.ok(validationStart >= 0 && validationEnd > validationStart, 'feed validator block must exist');
const validationBlock = feedSource
  .slice(validationStart, validationEnd)
  .replace('export function validateAllHandicapOdds', 'function validateAllHandicapOdds');
const validationLogs = [];
const validationLogger = {
  info: (...args) => validationLogs.push(args),
  warn: (...args) => validationLogs.push(args)
};
const validateAllHandicapOdds = new Function(
  'logger',
  `${validationBlock}; return validateAllHandicapOdds;`
)(validationLogger);

function eventWithMarket(market) {
  return { id: 'event-1', markets: [market] };
}

function market(type, line, selectionLines, odds) {
  return {
    id: `${type}-${line}`,
    type,
    line,
    selections: odds.map((price, index) => ({
      key: `${index}`,
      line: selectionLines?.[index] ?? null,
      odds: price,
      suspended: false
    }))
  };
}

test('accepts quarter handicap and totals lines, rejects other increments', () => {
  for (const line of [-1.5, -0.25, 0.75]) {
    const events = [eventWithMarket(market('HANDICAP', line, [line, -line], [1.8, 1.9]))];
    validateAllHandicapOdds(events);
    assert.equal(events[0].markets.length, 1, `line ${line} should be accepted`);
  }

  for (const line of [0.25, 2.5, 3.75]) {
    const events = [eventWithMarket(market('TOTALS', line, [line, line], [1.8, 1.9]))];
    validateAllHandicapOdds(events);
    assert.equal(events[0].markets.length, 1, `totals line ${line} should be accepted`);
  }

  for (const line of [-11.76, 0.3]) {
    const events = [eventWithMarket(market('HANDICAP', line, [line, -line], [1.8, 1.9]))];
    validateAllHandicapOdds(events);
    assert.equal(events[0].markets.length, 0, `line ${line} should be quarantined`);
  }

  const invalidTotals = [eventWithMarket(market('TOTALS', 2.3, [2.3, 2.3], [1.8, 1.9]))];
  validateAllHandicapOdds(invalidTotals);
  assert.equal(invalidTotals[0].markets.length, 0);
});

test('caps Indonesian negative odds at -5.00 and rejects values outside range or non-numeric values', () => {
  for (const odds of [1.20, 100]) {
    const events = [eventWithMarket(market('OTHER', null, null, [odds]))];
    validateAllHandicapOdds(events);
    assert.equal(events[0].markets.length, 1, `odds ${odds} should be accepted`);
  }

  for (const odds of [1.199, 1.085, 1.005, 100.5, NaN, null]) {
    const events = [eventWithMarket(market('OTHER', null, null, [odds]))];
    validateAllHandicapOdds(events);
    assert.equal(events[0].markets.length, 0, `odds ${odds} should be quarantined`);
  }
});

test('accepts 1X2 overround 1.05 and quarantines overrounds outside 1.00-1.25', () => {
  const valid = [2, 3.2, 4.2];
  assert.ok(Math.abs(valid.reduce((sum, odds) => sum + 1 / odds, 0) - 1.05) < 0.001);
  const validEvents = [eventWithMarket(market('1X2', null, null, valid))];
  validateAllHandicapOdds(validEvents);
  assert.equal(validEvents[0].markets.length, 1);

  for (const odds of [[2.5, 3, 5], [2, 2.5, 2.5]]) {
    const events = [eventWithMarket(market('1X2', null, null, odds))];
    validateAllHandicapOdds(events);
    assert.equal(events[0].markets.length, 0);
  }
});

test('quarantines handicap prices that form an implausible underround', () => {
  const events = [eventWithMarket(market('HANDICAP', -0.5, [-0.5, 0.5], [11.76, 1.25]))];
  validateAllHandicapOdds(events);
  assert.equal(events[0].markets.length, 0);
  assert.equal(validationLogs.at(-1)[1].reasons.OVERROUND_HANDICAP, 1);
});

test('quarantines incomplete or excessively imbalanced handicap markets', () => {
  const events = [
    eventWithMarket(market('HANDICAP', -0.5, [-0.5, 0.5], [1.95])),
    eventWithMarket(market('HANDICAP', -0.5, [-0.5, 0.5], [1.25, 5]))
  ];
  validateAllHandicapOdds(events);
  assert.deepEqual(events.map(event => event.markets.length), [0, 0]);
});

test('does not change valid markets and retains events whose markets are all quarantined', () => {
  const validMarket = market('TOTALS', 2.5, [2.5, 2.5], [1.91, 1.95]);
  const before = structuredClone(validMarket);
  const validEvent = eventWithMarket(validMarket);
  const validEvents = [validEvent];
  assert.strictEqual(validateAllHandicapOdds(validEvents), validEvents);
  assert.strictEqual(validEvents[0], validEvent);
  assert.strictEqual(validEvents[0].markets[0], validMarket);
  assert.deepEqual(validMarket, before);

  const invalidEvent = {
    id: 'all-invalid',
    markets: [
      market('HANDICAP', -11.76, [-11.76, 11.76], [1.8, 1.9]),
      market('TOTALS', 2.3, [2.3, 2.3], [1.8, 1.9])
    ]
  };
  const events = [invalidEvent];
  const logsBefore = validationLogs.length;
  validateAllHandicapOdds(events);
  assert.equal(events.length, 1);
  assert.strictEqual(events[0], invalidEvent);
  assert.deepEqual(invalidEvent.markets, []);
  assert.equal(validationLogs.length - logsBefore, 1);
  assert.equal(validationLogs.at(-1)[0], 'Sportsbook market validation quarantine summary');
  assert.equal(validationLogs.at(-1)[1].total, 2);
});

test('refresh invokes validation without calling the removed reset helper', () => {
  assert.doesNotMatch(feedSource, /resetAbnormalOddsLog\s*\(/);
  assert.match(feedSource, /events = validateAllHandicapOdds\(events\);/);
});

test('suspended selections do not quarantine a market for their odds', () => {
  const suspendedMarket = market('OTHER', null, null, [1.8, 250]);
  suspendedMarket.selections[1].suspended = true;
  const events = [eventWithMarket(suspendedMarket)];

  validateAllHandicapOdds(events);

  assert.strictEqual(events[0].markets[0], suspendedMarket);
});
