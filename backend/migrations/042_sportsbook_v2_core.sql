BEGIN;

CREATE TABLE IF NOT EXISTS sportsbook_v2_events (
  provider_event_id TEXT PRIMARY KEY CHECK (provider_event_id LIKE 'sr:sport_event:%'),
  sport_id TEXT NOT NULL,
  competition_id TEXT,
  competition_name TEXT,
  scheduled_at TIMESTAMPTZ,
  event_status TEXT NOT NULL DEFAULT 'unknown',
  home_name TEXT,
  away_name TEXT,
  snapshot_at TIMESTAMPTZ NOT NULL,
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sportsbook_v2_events_schedule_idx ON sportsbook_v2_events(scheduled_at);
CREATE INDEX IF NOT EXISTS sportsbook_v2_events_sport_idx ON sportsbook_v2_events(sport_id, scheduled_at);

CREATE TABLE IF NOT EXISTS sportsbook_v2_markets (
  provider_event_id TEXT NOT NULL REFERENCES sportsbook_v2_events(provider_event_id) ON DELETE RESTRICT,
  provider_market_key TEXT NOT NULL,
  provider_market_id TEXT NOT NULL,
  market_name TEXT,
  is_live BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  snapshot_at TIMESTAMPTZ NOT NULL,
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(provider_event_id, provider_market_key)
);
CREATE INDEX IF NOT EXISTS sportsbook_v2_markets_active_idx ON sportsbook_v2_markets(is_active, provider_event_id);

CREATE TABLE IF NOT EXISTS sportsbook_v2_prices (
  id BIGSERIAL PRIMARY KEY,
  provider_event_id TEXT NOT NULL,
  provider_market_key TEXT NOT NULL,
  provider_market_key TEXT NOT NULL,
  provider_market_id TEXT NOT NULL,
  provider_book_id TEXT NOT NULL,
  provider_book_name TEXT,
  provider_selection_key TEXT NOT NULL,
  provider_outcome_id TEXT,
  external_outcome_id TEXT,
  external_market_id TEXT,
  external_sport_event_id TEXT,
  field_id TEXT,
  player_id TEXT,
  player_name TEXT,
  outcome_type TEXT,
  outcome_name TEXT,
  odds_decimal NUMERIC(18,6) NOT NULL CHECK (odds_decimal > 1),
  opening_odds_decimal NUMERIC(18,6),
  line_value TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  source_updated_at TIMESTAMPTZ NOT NULL,
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT sportsbook_v2_prices_market_fk FOREIGN KEY(provider_event_id,provider_market_key)
    REFERENCES sportsbook_v2_markets(provider_event_id,provider_market_key) ON DELETE RESTRICT,
  CONSTRAINT sportsbook_v2_prices_unique UNIQUE(provider_event_id,provider_market_key,provider_book_id,provider_selection_key)
);
CREATE INDEX IF NOT EXISTS sportsbook_v2_prices_active_idx ON sportsbook_v2_prices(is_active, source_updated_at DESC);
CREATE INDEX IF NOT EXISTS sportsbook_v2_prices_lookup_idx ON sportsbook_v2_prices(provider_event_id,provider_market_id,provider_book_id);

CREATE TABLE IF NOT EXISTS sportsbook_v2_tickets (
  id UUID PRIMARY KEY,
  invoice TEXT NOT NULL UNIQUE,
  member_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  stake BIGINT NOT NULL CHECK (stake > 0),
  total_odds NUMERIC(18,6) NOT NULL CHECK (total_odds > 1),
  potential_payout BIGINT NOT NULL CHECK (potential_payout >= 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','WON','LOST','VOID','CANCELLED')),
  idempotency_key TEXT NOT NULL,
  ledger_transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  balance_before BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(member_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS sportsbook_v2_tickets_member_idx ON sportsbook_v2_tickets(member_id,accepted_at DESC);
CREATE INDEX IF NOT EXISTS sportsbook_v2_tickets_open_idx ON sportsbook_v2_tickets(status,accepted_at) WHERE status='OPEN';

CREATE TABLE IF NOT EXISTS sportsbook_v2_ticket_legs (
  id UUID PRIMARY KEY,
  ticket_id UUID NOT NULL REFERENCES sportsbook_v2_tickets(id) ON DELETE RESTRICT,
  leg_no INTEGER NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_market_id TEXT NOT NULL,
  provider_book_id TEXT NOT NULL,
  provider_selection_key TEXT NOT NULL,
  accepted_odds NUMERIC(18,6) NOT NULL CHECK (accepted_odds > 1),
  source_updated_at TIMESTAMPTZ NOT NULL,
  result_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (result_status IN ('PENDING','WON','LOST','VOID','PUSH')),
  result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(ticket_id,leg_no),
  UNIQUE(ticket_id,provider_event_id)
);
CREATE INDEX IF NOT EXISTS sportsbook_v2_ticket_legs_event_idx ON sportsbook_v2_ticket_legs(provider_event_id,result_status);

CREATE TABLE IF NOT EXISTS sportsbook_v2_event_results (
  provider_event_id TEXT PRIMARY KEY REFERENCES sportsbook_v2_events(provider_event_id) ON DELETE RESTRICT,
  result_source TEXT NOT NULL,
  event_status TEXT NOT NULL,
  home_score INTEGER,
  away_score INTEGER,
  source_updated_at TIMESTAMPTZ NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

COMMIT;
