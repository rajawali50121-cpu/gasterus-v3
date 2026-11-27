BEGIN;

ALTER TABLE sportsbook_v2_events
  ADD COLUMN IF NOT EXISTS provider_generated_at TIMESTAMPTZ;

ALTER TABLE sportsbook_v2_markets
  ADD COLUMN IF NOT EXISTS provider_generated_at TIMESTAMPTZ;

-- A missing provider timestamp must remain unknown, not be replaced with ingestion time.
ALTER TABLE sportsbook_v2_prices
  ALTER COLUMN source_updated_at DROP NOT NULL;

CREATE INDEX IF NOT EXISTS sportsbook_v2_events_provider_time_idx
  ON sportsbook_v2_events(provider_generated_at DESC);

CREATE INDEX IF NOT EXISTS sportsbook_v2_markets_provider_time_idx
  ON sportsbook_v2_markets(provider_generated_at DESC);

COMMIT;
