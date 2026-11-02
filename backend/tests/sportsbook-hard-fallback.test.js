import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');

test('empty or failed provider refreshes never activate synthetic fixtures', () => {
  const refresh = feed.slice(feed.indexOf('async function performRefresh'), feed.indexOf('export async function refreshSportsbookFeed'));
  assert.doesNotMatch(refresh, /buildHardFallbackEvents/);
  assert.match(refresh, /activateUnavailableFeed/);
  assert.doesNotMatch(feed, /async function activateHardFallback/);
  assert.doesNotMatch(feed, /return activateHardFallback/);
  assert.doesNotMatch(feed, /buildHardFallbackEvents, buildHardFallbackFeed/);
});

test('unavailable feed snapshots return no events and expose an offline status', () => {
  assert.match(feed, /async function activateUnavailableFeed[\s\S]*events: \[\]/);
  assert.match(feed, /const unavailable = Boolean\(feed\.hardFallback \|\| \(feed\.readOnlySource && !feed\.events\?\.length\)\)/);
  assert.match(feed, /const soccerEvents = unavailable\s*\?\s*\[\]/);
  assert.match(feed, /mode: unavailable\s*\?\s*'UNAVAILABLE'/);
  assert.match(feed, /status: unavailable \? 'OFFLINE'/);
  assert.match(feed, /hardFallback: false/);
  assert.match(feed, /logger\.error\('Sportsbook snapshot unavailable'[\s\S]*throw error/);
});

test('legacy hard-fallback Redis and revision snapshots are rejected', () => {
  assert.match(feed, /if \(parsed\.hardFallback\) \{\s*logger\.warn\('Discarding legacy synthetic sportsbook cache'/);
  assert.match(feed, /if \(snapshot\.hardFallback\) return null/);
  assert.match(feed, /if \(feed\.hardFallback\) \{\s*throw new AppError\(503, 'Odds pertandingan belum tersedia dari sumber live\.'/);
  assert.match(feed, /if \(feed\.hardFallback\) \{\s*throw new AppError\(503, 'Odds sportsbook belum tersedia dari sumber live\.'/);
});
