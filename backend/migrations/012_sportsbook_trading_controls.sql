BEGIN;

-- HF6 Phase 2: operator trading controls for event / market / selection.
-- Current state is stored separately from immutable change history so live bet-stop
-- remains fast while every operator action remains auditable.
CREATE TABLE IF NOT EXISTS sportsbook_trading_controls (
  id UUID PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  market_id TEXT,
  selection_id TEXT,
  suspended BOOLEAN NOT NULL DEFAULT false,
  max_stake BIGINT,
  max_liability BIGINT,
  reason TEXT,
  expires_at TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 1,
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sportsbook_trading_controls_scope_check
    CHECK (scope_type IN ('EVENT','MARKET','SELECTION')),
  CONSTRAINT sportsbook_trading_controls_identity_check
    CHECK (
      (scope_type='EVENT' AND market_id IS NULL AND selection_id IS NULL) OR
      (scope_type='MARKET' AND market_id IS NOT NULL AND selection_id IS NULL) OR
      (scope_type='SELECTION' AND market_id IS NOT NULL AND selection_id IS NOT NULL)
    ),
  CONSTRAINT sportsbook_trading_controls_max_stake_check
    CHECK (max_stake IS NULL OR max_stake > 0),
  CONSTRAINT sportsbook_trading_controls_max_liability_check
    CHECK (max_liability IS NULL OR max_liability > 0)
);

CREATE INDEX IF NOT EXISTS sportsbook_trading_controls_event_idx
  ON sportsbook_trading_controls(event_id, scope_type);
CREATE INDEX IF NOT EXISTS sportsbook_trading_controls_expiry_idx
  ON sportsbook_trading_controls(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS sportsbook_trading_control_history (
  id UUID PRIMARY KEY,
  control_id UUID,
  scope_key TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id UUID REFERENCES users(id),
  previous_state JSONB,
  next_state JSONB,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sportsbook_trading_control_history_action_check
    CHECK (action IN ('UPSERT','CLEAR'))
);

CREATE INDEX IF NOT EXISTS sportsbook_trading_control_history_scope_idx
  ON sportsbook_trading_control_history(scope_key, created_at DESC);
CREATE INDEX IF NOT EXISTS sportsbook_trading_control_history_created_idx
  ON sportsbook_trading_control_history(created_at DESC);

COMMIT;
