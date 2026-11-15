CREATE TABLE IF NOT EXISTS casino_callback_logs (
  id UUID PRIMARY KEY,
  provider_code TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  http_status INTEGER NOT NULL CHECK (http_status BETWEEN 100 AND 599),
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS','DUPLICATE','FAILURE')),
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  retain_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS casino_callback_logs_retain_until_idx
  ON casino_callback_logs(retain_until);

COMMENT ON TABLE casino_callback_logs IS
  'Betnex callback audit records; retain each row for at least 90 days.';
