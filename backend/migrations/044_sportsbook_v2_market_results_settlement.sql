BEGIN;

CREATE TABLE IF NOT EXISTS sportsbook_v2_market_catalog (
  market_code TEXT PRIMARY KEY,
  sport_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  settlement_rule TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mapping_version INTEGER NOT NULL DEFAULT 1 CHECK (mapping_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sportsbook_v2_provider_market_mappings (
  provider_product TEXT NOT NULL,
  sport_id TEXT NOT NULL,
  provider_market_id TEXT NOT NULL,
  provider_market_name TEXT NOT NULL,
  period_code TEXT NOT NULL,
  market_code TEXT NOT NULL REFERENCES sportsbook_v2_market_catalog(market_code) ON DELETE RESTRICT,
  mapping_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (mapping_status IN ('PENDING','VERIFIED','DISABLED')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  outcomes JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(outcomes) = 'object'),
  provider_definition JSONB NOT NULL DEFAULT '{}'::jsonb,
  mapping_version INTEGER NOT NULL DEFAULT 1 CHECK (mapping_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(provider_product,sport_id,provider_market_id,provider_market_name,period_code)
);
CREATE INDEX IF NOT EXISTS sportsbook_v2_market_mapping_lookup_idx
  ON sportsbook_v2_provider_market_mappings(provider_product,sport_id,provider_market_id,period_code)
  WHERE mapping_status = 'VERIFIED' AND enabled = TRUE;

CREATE TABLE IF NOT EXISTS sportsbook_v2_event_result_revisions (
  id BIGSERIAL PRIMARY KEY,
  provider_event_id TEXT NOT NULL REFERENCES sportsbook_v2_events(provider_event_id) ON DELETE RESTRICT,
  result_source TEXT NOT NULL,
  event_status TEXT NOT NULL,
  home_score INTEGER CHECK (home_score IS NULL OR home_score >= 0),
  away_score INTEGER CHECK (away_score IS NULL OR away_score >= 0),
  provider_generated_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sportsbook_v2_result_revisions_event_idx
  ON sportsbook_v2_event_result_revisions(provider_event_id,provider_generated_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS sportsbook_v2_settlement_revisions (
  id UUID PRIMARY KEY,
  ticket_id UUID NOT NULL REFERENCES sportsbook_v2_tickets(id) ON DELETE RESTRICT,
  revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  previous_status TEXT,
  new_status TEXT NOT NULL CHECK (new_status IN ('OPEN','WON','LOST','VOID','CANCELLED')),
  payout_amount BIGINT NOT NULL DEFAULT 0 CHECK (payout_amount >= 0),
  ledger_transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  result_revision_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(result_revision_ids) = 'array'),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM','OWNER','OPERATOR')),
  actor_id UUID,
  reason TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(ticket_id,revision_no)
);
CREATE INDEX IF NOT EXISTS sportsbook_v2_settlement_revisions_ticket_idx
  ON sportsbook_v2_settlement_revisions(ticket_id,revision_no DESC);

COMMIT;
