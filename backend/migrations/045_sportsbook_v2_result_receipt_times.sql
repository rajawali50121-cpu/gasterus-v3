BEGIN;

-- Soccer Daily Summaries does not guarantee generated_at in every response.
-- Preserve provider source time as NULL and track local ingestion independently.
ALTER TABLE sportsbook_v2_event_results
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;

UPDATE sportsbook_v2_event_results
SET received_at = source_updated_at
WHERE received_at IS NULL;

ALTER TABLE sportsbook_v2_event_results
  ALTER COLUMN received_at SET DEFAULT now(),
  ALTER COLUMN received_at SET NOT NULL,
  ALTER COLUMN source_updated_at DROP NOT NULL;

CREATE INDEX IF NOT EXISTS sportsbook_v2_event_results_received_at_idx
  ON sportsbook_v2_event_results(received_at DESC);

COMMIT;
