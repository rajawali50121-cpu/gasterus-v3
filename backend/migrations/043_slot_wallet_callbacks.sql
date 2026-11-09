BEGIN;

CREATE TABLE IF NOT EXISTS slot_wallet_transactions (
  id UUID PRIMARY KEY,
  provider_code TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  reference_transaction_id TEXT,
  member_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('WITHDRAW','DEPOSIT','BETWIN','ROLLBACK')),
  game_id INTEGER NOT NULL CHECK (game_id > 0),
  round_id TEXT,
  debit_amount BIGINT NOT NULL DEFAULT 0 CHECK (debit_amount >= 0),
  credit_amount BIGINT NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  member_delta BIGINT NOT NULL,
  currency_code CHAR(3) NOT NULL CHECK (currency_code = 'IDR'),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_code, transaction_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS slot_wallet_transactions_rollback_reference_uq
  ON slot_wallet_transactions(provider_code, reference_transaction_id)
  WHERE event_type = 'ROLLBACK';

CREATE INDEX IF NOT EXISTS slot_wallet_transactions_member_created_idx
  ON slot_wallet_transactions(member_id, created_at DESC);

COMMIT;
