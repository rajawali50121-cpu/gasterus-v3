BEGIN;

-- Enterprise sportsbook feed lifecycle / recovery observability.
-- Append-only transition history allows operators to audit provider flaps,
-- circuit breaker opens, recovery probes and betting re-enable events.
CREATE TABLE IF NOT EXISTS sportsbook_provider_incidents (
  id UUID PRIMARY KEY,
  provider_code TEXT NOT NULL,
  previous_state TEXT,
  state TEXT NOT NULL,
  previous_betting_allowed BOOLEAN NOT NULL DEFAULT false,
  betting_allowed BOOLEAN NOT NULL DEFAULT false,
  transport_healthy BOOLEAN NOT NULL DEFAULT false,
  pricing_ready BOOLEAN NOT NULL DEFAULT false,
  failure_streak INTEGER NOT NULL DEFAULT 0,
  success_streak INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sportsbook_provider_incidents_state_check
    CHECK (state IN ('DISABLED','HEALTHY','DEGRADED','OPEN_CIRCUIT','RECOVERING')),
  CONSTRAINT sportsbook_provider_incidents_previous_state_check
    CHECK (previous_state IS NULL OR previous_state IN ('DISABLED','HEALTHY','DEGRADED','OPEN_CIRCUIT','RECOVERING'))
);

CREATE INDEX IF NOT EXISTS sportsbook_provider_incidents_provider_created_idx
  ON sportsbook_provider_incidents(provider_code, created_at DESC);
CREATE INDEX IF NOT EXISTS sportsbook_provider_incidents_created_idx
  ON sportsbook_provider_incidents(created_at DESC);

-- Acceptance traceability now records the exact aggregate feed revision and
-- lifecycle state of the pricing provider at the final transactional recheck.
ALTER TABLE sportsbook_legs
  ADD COLUMN IF NOT EXISTS accepted_feed_revision TEXT,
  ADD COLUMN IF NOT EXISTS provider_state_at_acceptance TEXT;

CREATE INDEX IF NOT EXISTS sportsbook_legs_feed_revision_idx
  ON sportsbook_legs(accepted_feed_revision) WHERE accepted_feed_revision IS NOT NULL;

COMMIT;
