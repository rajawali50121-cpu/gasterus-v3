BEGIN;

CREATE TABLE IF NOT EXISTS sportsbook_event_states (
  event_id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  league TEXT NOT NULL,
  start_time TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN (
    'SCHEDULED','LIVE','FINISHED','SUSPENDED','CANCELLED','CANCELED','ABANDONED','POSTPONED','VOID'
  )),
  provider_status TEXT,
  is_live BOOLEAN NOT NULL DEFAULT FALSE,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  home_score NUMERIC,
  away_score NUMERIC,
  period_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  feed_revision TEXT,
  state_updated_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'LIVE') = is_live)
);

CREATE INDEX IF NOT EXISTS sportsbook_event_states_status_start_idx
  ON sportsbook_event_states(status, start_time DESC);

COMMIT;
