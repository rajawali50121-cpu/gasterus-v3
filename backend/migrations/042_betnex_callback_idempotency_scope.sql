ALTER TABLE casino_game_rounds
  ADD COLUMN IF NOT EXISTS processed_serials TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS game_mapping_status TEXT NOT NULL DEFAULT 'UNMAPPED';

ALTER TABLE casino_callback_events
  ADD COLUMN IF NOT EXISTS game_uid TEXT,
  ADD COLUMN IF NOT EXISTS game_round TEXT;

UPDATE casino_callback_events AS event
SET game_uid = round.game_uid,
    game_round = round.game_round
FROM casino_game_rounds AS round
WHERE round.id = event.game_round_id
  AND (event.game_uid IS NULL OR event.game_round IS NULL);

UPDATE casino_game_rounds AS round
SET processed_serials = processed.serials
FROM (
  SELECT game_round_id, array_agg(serial_number ORDER BY created_at, id) AS serials
  FROM casino_callback_events
  GROUP BY game_round_id
) AS processed
WHERE round.id = processed.game_round_id;

ALTER TABLE casino_callback_events
  ALTER COLUMN game_uid SET NOT NULL,
  ALTER COLUMN game_round SET NOT NULL;

DO $$
DECLARE
  old_constraint RECORD;
BEGIN
  FOR old_constraint IN
    SELECT constraint_row.conname
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'casino_callback_events'::regclass
      AND constraint_row.contype = 'u'
      AND (
        SELECT array_agg(attribute.attname::text ORDER BY attribute.attname::text)
        FROM unnest(constraint_row.conkey) AS key_column(attnum)
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = constraint_row.conrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['provider_code', 'serial_number']::text[]
  LOOP
    EXECUTE format('ALTER TABLE casino_callback_events DROP CONSTRAINT %I', old_constraint.conname);
  END LOOP;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS casino_callback_events_member_game_round_serial_uq
  ON casino_callback_events(member_id, game_uid, game_round, serial_number);
