BEGIN;

-- HF6 Phase 3: durable live market lifecycle. Redis remains the hot-path state;
-- PostgreSQL stores the current operator-visible state plus append-only transitions.
CREATE TABLE IF NOT EXISTS sportsbook_market_lifecycle (
  id UUID PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  state TEXT NOT NULL,
  reopen_success_streak INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  provider_source TEXT,
  last_observation_token TEXT,
  last_reopen_observation_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_state_change_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sportsbook_market_lifecycle_state_check
    CHECK (state IN ('ACTIVE','SUSPENDED','REOPENING','CLOSED')),
  CONSTRAINT sportsbook_market_lifecycle_streak_check
    CHECK (reopen_success_streak >= 0)
);
CREATE INDEX IF NOT EXISTS sportsbook_market_lifecycle_event_idx
  ON sportsbook_market_lifecycle(event_id,state,updated_at DESC);
CREATE INDEX IF NOT EXISTS sportsbook_market_lifecycle_state_idx
  ON sportsbook_market_lifecycle(state,updated_at DESC);

CREATE TABLE IF NOT EXISTS sportsbook_market_lifecycle_history (
  id UUID PRIMARY KEY,
  scope_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_state TEXT,
  state TEXT NOT NULL,
  reason TEXT,
  provider_source TEXT,
  feed_revision TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sportsbook_market_lifecycle_history_action_check
    CHECK (action IN ('BET_STOP','REOPENING','REOPEN','CLOSE')),
  CONSTRAINT sportsbook_market_lifecycle_history_state_check
    CHECK (state IN ('ACTIVE','SUSPENDED','REOPENING','CLOSED')),
  CONSTRAINT sportsbook_market_lifecycle_history_previous_state_check
    CHECK (previous_state IS NULL OR previous_state IN ('ACTIVE','SUSPENDED','REOPENING','CLOSED'))
);
CREATE INDEX IF NOT EXISTS sportsbook_market_lifecycle_history_created_idx
  ON sportsbook_market_lifecycle_history(created_at DESC);
CREATE INDEX IF NOT EXISTS sportsbook_market_lifecycle_history_event_idx
  ON sportsbook_market_lifecycle_history(event_id,market_id,created_at DESC);

-- Settlement is revisioned rather than overwritten silently. Every settle,
-- rollback and cancellation becomes an immutable correction record.
ALTER TABLE sportsbook_tickets
  ADD COLUMN IF NOT EXISTS settlement_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS settlement_correction_pending BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_settlement_action TEXT,
  ADD COLUMN IF NOT EXISTS last_settlement_feed_revision TEXT;

ALTER TABLE sportsbook_legs
  ADD COLUMN IF NOT EXISTS settlement_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS settlement_source TEXT,
  ADD COLUMN IF NOT EXISTS settlement_feed_revision TEXT;

CREATE TABLE IF NOT EXISTS sportsbook_settlement_revisions (
  id UUID PRIMARY KEY,
  ticket_id UUID NOT NULL REFERENCES sportsbook_tickets(id) ON DELETE RESTRICT,
  revision_no INTEGER NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'APPLIED',
  previous_ticket_status TEXT NOT NULL,
  next_ticket_status TEXT NOT NULL,
  previous_payout BIGINT NOT NULL DEFAULT 0,
  next_payout BIGINT NOT NULL DEFAULT 0,
  payout_delta BIGINT NOT NULL DEFAULT 0,
  result_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  previous_result_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_feed_revision TEXT,
  source_name TEXT,
  reason TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  actor_id UUID REFERENCES users(id),
  actor_role TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT sportsbook_settlement_revisions_ticket_revision_uq UNIQUE(ticket_id,revision_no),
  CONSTRAINT sportsbook_settlement_revisions_action_check CHECK (action IN ('SETTLE','ROLLBACK','CANCEL')),
  CONSTRAINT sportsbook_settlement_revisions_status_check CHECK (status IN ('APPLIED','PENDING_FUNDS','REJECTED')),
  CONSTRAINT sportsbook_settlement_revisions_revision_check CHECK (revision_no > 0),
  CONSTRAINT sportsbook_settlement_revisions_payout_check CHECK (previous_payout >= 0 AND next_payout >= 0)
);
CREATE INDEX IF NOT EXISTS sportsbook_settlement_revisions_ticket_idx
  ON sportsbook_settlement_revisions(ticket_id,revision_no DESC);
CREATE INDEX IF NOT EXISTS sportsbook_settlement_revisions_status_idx
  ON sportsbook_settlement_revisions(status,created_at);
CREATE INDEX IF NOT EXISTS sportsbook_settlement_revisions_created_idx
  ON sportsbook_settlement_revisions(created_at DESC);

COMMIT;
