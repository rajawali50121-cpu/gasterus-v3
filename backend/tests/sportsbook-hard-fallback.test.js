import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
const refreshPath = feed.slice(feed.indexOf('async function performRefresh'), feed.indexOf('function normalizedSport'));
const snapshotResponse = feed.slice(
  feed.indexOf('async function buildSportsbookSnapshotResponse'),
  feed.indexOf('export async function sportsbookEventSnapshot')
);

test('member sportsbook response exposes only provider-backed feed states', () => {
  assert.doesNotMatch(feed, /hardFallback|HARD_FALLBACK|SPORTS_HARD_FALLBACK|buildHardFallback/);
  assert.doesNotMatch(snapshotResponse, /HARD_FALLBACK|SPORTS_HARD_FALLBACK/);
  assert.match(snapshotResponse, /LIVE_SOURCE_AGGREGATOR/);
  assert.match(feed, /SPORTS_FEED_EMPTY/);
  assert.doesNotMatch(feed, /serving hard fallback|answering request with hard fallback/i);
  assert.doesNotMatch(refreshPath, /buildHardFallback|activateHardFallback|HARD_FALLBACK/);
});

test('empty provider refreshes fail explicitly instead of creating synthetic fixtures or odds', () => {
  assert.match(feed, /throw new AppError\(503, 'Provider sportsbook belum mengembalikan pertandingan asli\.', 'SPORTS_FEED_EMPTY'\)/);
  assert.doesNotMatch(feed, /activateHardFallback|buildHardFallback/);
});
