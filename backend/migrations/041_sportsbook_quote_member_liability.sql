BEGIN;

SET LOCAL lock_timeout = '5s';

-- A signed quote is single-use per member, even when retries generate a new
-- request idempotency key.
-- This migration fails safely if existing tickets contain duplicate non-empty quoteIds.
CREATE UNIQUE INDEX IF NOT EXISTS sportsbook_tickets_quote_id_uq
  ON sportsbook_tickets (member_id, (metadata->>'quoteId'))
  WHERE COALESCE(metadata->>'quoteId', '') <> '';

COMMIT;
