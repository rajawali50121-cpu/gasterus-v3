BEGIN;

-- Enterprise cash-out closes an OPEN ticket atomically and records an immutable
-- acceptance row. Signed offers remain ephemeral; only accepted money movement
-- is persisted.
ALTER TABLE sportsbook_tickets DROP CONSTRAINT IF EXISTS sportsbook_tickets_status_check;
ALTER TABLE sportsbook_tickets
  ADD CONSTRAINT sportsbook_tickets_status_check
  CHECK (status IN ('OPEN','WON','LOST','VOID','PARTIAL_VOID','PARTIAL_WIN','PARTIAL_LOSS','CANCELLED','CASHED_OUT'));

ALTER TABLE sportsbook_tickets
  ADD COLUMN IF NOT EXISTS cashout_amount BIGINT NOT NULL DEFAULT 0 CHECK (cashout_amount >= 0),
  ADD COLUMN IF NOT EXISTS cashout_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cashout_offer_id UUID;

CREATE TABLE IF NOT EXISTS sportsbook_cashouts (
  id UUID PRIMARY KEY,
  ticket_id UUID NOT NULL UNIQUE REFERENCES sportsbook_tickets(id) ON DELETE RESTRICT,
  member_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'ACCEPTED' CHECK (status IN ('ACCEPTED')),
  offer_amount BIGINT NOT NULL CHECK (offer_amount > 0),
  fair_value BIGINT NOT NULL CHECK (fair_value > 0),
  factor_bps INTEGER NOT NULL CHECK (factor_bps BETWEEN 5000 AND 10000),
  offered_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_feed_revision TEXT,
  pricing_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key TEXT NOT NULL,
  balance_before BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(member_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS sportsbook_cashouts_member_idx ON sportsbook_cashouts(member_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS sportsbook_cashouts_ticket_idx ON sportsbook_cashouts(ticket_id);

COMMIT;
