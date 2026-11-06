CREATE TABLE IF NOT EXISTS casino_game_rounds (
  id UUID PRIMARY KEY,
  member_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_code TEXT NOT NULL,
  game_uid TEXT NOT NULL,
  game_round TEXT NOT NULL,
  bet_amount BIGINT NOT NULL DEFAULT 0,
  win_amount BIGINT NOT NULL DEFAULT 0,
  currency_code CHAR(3) NOT NULL CHECK (currency_code = 'IDR'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, provider_code, game_uid, game_round)
);

CREATE INDEX IF NOT EXISTS casino_game_rounds_member_created_idx
  ON casino_game_rounds(member_id, created_at DESC);

CREATE TABLE IF NOT EXISTS casino_callback_events (
  id UUID PRIMARY KEY,
  provider_code TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  member_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  game_round_id UUID NOT NULL REFERENCES casino_game_rounds(id) ON DELETE RESTRICT,
  bet_amount BIGINT NOT NULL,
  win_amount BIGINT NOT NULL,
  currency_code CHAR(3) NOT NULL CHECK (currency_code = 'IDR'),
  balance_after BIGINT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_code, serial_number)
);

CREATE INDEX IF NOT EXISTS casino_callback_events_member_created_idx
  ON casino_callback_events(member_id, created_at DESC);
