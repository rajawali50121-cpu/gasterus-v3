BEGIN;

-- Provider time and GASTERUS receipt time are different facts. Odds payloads
-- may omit generated_at, so price ingestion must not fabricate source time.
ALTER TABLE sportsbook_v2_prices
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS change_log_verified_at TIMESTAMPTZ;

UPDATE sportsbook_v2_prices p
SET received_at = COALESCE(p.source_updated_at, m.snapshot_at, now())
FROM sportsbook_v2_markets m
WHERE m.provider_event_id = p.provider_event_id
  AND m.provider_market_key = p.provider_market_key
  AND p.received_at IS NULL;

UPDATE sportsbook_v2_prices
SET received_at = now()
WHERE received_at IS NULL;

ALTER TABLE sportsbook_v2_prices
  ALTER COLUMN received_at SET DEFAULT now(),
  ALTER COLUMN received_at SET NOT NULL;

-- Persist exactly which settlement contract and outcome mapping were accepted.
-- Historical ticket legs are backfilled conservatively; new placements require
-- these fields to be resolved from an enabled, verified provider mapping.
ALTER TABLE sportsbook_v2_tickets
  ADD COLUMN IF NOT EXISTS settlement_ledger_transaction_id UUID
    REFERENCES ledger_transactions(id) ON DELETE RESTRICT;

ALTER TABLE sportsbook_v2_ticket_legs
  ADD COLUMN IF NOT EXISTS price_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS market_code TEXT,
  ADD COLUMN IF NOT EXISTS outcome_code TEXT,
  ADD COLUMN IF NOT EXISTS settlement_rule TEXT,
  ADD COLUMN IF NOT EXISTS mapping_version INTEGER;

UPDATE sportsbook_v2_ticket_legs
SET price_received_at = COALESCE(source_updated_at, created_at, now())
WHERE price_received_at IS NULL;

ALTER TABLE sportsbook_v2_ticket_legs
  ALTER COLUMN price_received_at SET DEFAULT now(),
  ALTER COLUMN price_received_at SET NOT NULL,
  ALTER COLUMN source_updated_at DROP NOT NULL;

CREATE INDEX IF NOT EXISTS sportsbook_v2_prices_bet_freshness_idx
  ON sportsbook_v2_prices(provider_event_id, provider_market_key, provider_book_id, is_active, change_log_verified_at DESC);

CREATE INDEX IF NOT EXISTS sportsbook_v2_open_tickets_idx
  ON sportsbook_v2_tickets(accepted_at)
  WHERE status = 'OPEN';

COMMIT;
