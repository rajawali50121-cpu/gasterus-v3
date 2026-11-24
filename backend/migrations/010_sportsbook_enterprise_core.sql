BEGIN;

-- Enterprise Sportsbook acceptance traceability: immutable provider/price identity
-- captured on every accepted leg. Existing tickets remain valid with nullable fields.
ALTER TABLE sportsbook_legs
  ADD COLUMN IF NOT EXISTS odds_version TEXT,
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_name TEXT,
  ADD COLUMN IF NOT EXISTS provider_market_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_selection_id TEXT,
  ADD COLUMN IF NOT EXISTS accepted_feed_at TIMESTAMPTZ;

-- Asian quarter-line settlement requires explicit half-win / half-loss leg states.
ALTER TABLE sportsbook_legs DROP CONSTRAINT IF EXISTS sportsbook_legs_result_status_check;
ALTER TABLE sportsbook_legs
  ADD CONSTRAINT sportsbook_legs_result_status_check
  CHECK (result_status IN ('PENDING','WON','LOST','VOID','PUSH','HALF_WON','HALF_LOST'));

ALTER TABLE sportsbook_tickets DROP CONSTRAINT IF EXISTS sportsbook_tickets_status_check;
ALTER TABLE sportsbook_tickets
  ADD CONSTRAINT sportsbook_tickets_status_check
  CHECK (status IN ('OPEN','WON','LOST','VOID','PARTIAL_VOID','PARTIAL_WIN','PARTIAL_LOSS','CANCELLED'));

CREATE INDEX IF NOT EXISTS sportsbook_legs_risk_event_idx
  ON sportsbook_legs(event_id, market_type, market_period, market_line, selection_label);
CREATE INDEX IF NOT EXISTS sportsbook_legs_odds_version_idx
  ON sportsbook_legs(odds_version) WHERE odds_version IS NOT NULL;

COMMIT;
