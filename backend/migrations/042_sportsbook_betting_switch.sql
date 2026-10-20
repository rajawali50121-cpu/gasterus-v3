BEGIN;

INSERT INTO system_settings(setting_key,setting_value,description,is_public)
VALUES(
  'sportsbook.betting.acceptance',
  '{"closed":true}'::jsonb,
  'Kill switch penerimaan tiket sportsbook',
  FALSE
)
ON CONFLICT(setting_key) DO NOTHING;

COMMIT;
