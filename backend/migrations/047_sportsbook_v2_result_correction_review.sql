BEGIN;

-- A provider may revise a result after a ticket was settled. Never silently
-- reverse money automatically: quarantine the ticket for owner reconciliation
-- and stop new bet acceptance until the review is acknowledged.
ALTER TABLE sportsbook_v2_tickets
  ADD COLUMN IF NOT EXISTS review_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS review_reason TEXT,
  ADD COLUMN IF NOT EXISTS review_detected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID,
  ADD COLUMN IF NOT EXISTS review_note TEXT;

CREATE INDEX IF NOT EXISTS sportsbook_v2_ticket_review_queue_idx
  ON sportsbook_v2_tickets(review_detected_at DESC)
  WHERE review_required=TRUE;

COMMIT;
