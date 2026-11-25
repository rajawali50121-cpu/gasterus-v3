BEGIN;

CREATE TABLE IF NOT EXISTS sportsbook_tickets (
  id UUID PRIMARY KEY,
  invoice TEXT NOT NULL UNIQUE,
  member_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  bet_type TEXT NOT NULL CHECK (bet_type IN ('SINGLE','PARLAY','SYSTEM')),
  system_size INTEGER,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','WON','LOST','VOID','PARTIAL_VOID','CANCELLED')),
  selection_count INTEGER NOT NULL CHECK (selection_count BETWEEN 1 AND 30),
  combination_count INTEGER NOT NULL DEFAULT 1 CHECK (combination_count BETWEEN 1 AND 1000),
  unit_stake BIGINT NOT NULL CHECK (unit_stake > 0),
  total_stake BIGINT NOT NULL CHECK (total_stake > 0),
  total_odds NUMERIC(18,6) NOT NULL CHECK (total_odds >= 1),
  potential_payout BIGINT NOT NULL CHECK (potential_payout >= 0),
  payout BIGINT NOT NULL DEFAULT 0 CHECK (payout >= 0),
  balance_before BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  idempotency_key TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(member_id, idempotency_key),
  CHECK ((bet_type='SYSTEM' AND system_size IS NOT NULL) OR (bet_type<>'SYSTEM' AND system_size IS NULL))
);
CREATE INDEX IF NOT EXISTS sportsbook_tickets_member_idx ON sportsbook_tickets(member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sportsbook_tickets_open_idx ON sportsbook_tickets(status, accepted_at) WHERE status='OPEN';

CREATE TABLE IF NOT EXISTS sportsbook_legs (
  id UUID PRIMARY KEY,
  ticket_id UUID NOT NULL REFERENCES sportsbook_tickets(id) ON DELETE CASCADE,
  leg_no INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  sport TEXT NOT NULL,
  league TEXT NOT NULL,
  event_start TIMESTAMPTZ,
  event_live_at_bet BOOLEAN NOT NULL DEFAULT FALSE,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  market_id TEXT NOT NULL,
  market_key TEXT,
  market_type TEXT NOT NULL,
  market_label TEXT NOT NULL,
  market_period TEXT NOT NULL DEFAULT 'FT',
  market_line TEXT,
  selection_id TEXT NOT NULL,
  selection_label TEXT NOT NULL,
  accepted_odds NUMERIC(18,6) NOT NULL CHECK (accepted_odds > 1),
  result_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (result_status IN ('PENDING','WON','LOST','VOID','PUSH')),
  result_value TEXT,
  provider_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(ticket_id, leg_no),
  UNIQUE(ticket_id, event_id)
);
CREATE INDEX IF NOT EXISTS sportsbook_legs_event_idx ON sportsbook_legs(event_id, result_status);
CREATE INDEX IF NOT EXISTS sportsbook_legs_ticket_idx ON sportsbook_legs(ticket_id, leg_no);

COMMIT;
