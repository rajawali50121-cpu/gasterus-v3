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

-- Keep every received Soccer result version auditable even when the provider
-- omits generated_at; receipt time is not misrepresented as provider time.
CREATE UNIQUE INDEX IF NOT EXISTS sportsbook_v2_result_revisions_receipt_version_uq
  ON sportsbook_v2_event_result_revisions(provider_event_id,result_source,received_at)
  WHERE provider_generated_at IS NULL;

COMMIT;
