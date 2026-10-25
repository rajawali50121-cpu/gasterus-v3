-- R6.9.0.24: repair operator-approved manual TOTO results that were quarantined
-- to UNMAPPED/SINGLE_SOURCE. Only rows whose current result and period exactly match
-- an APPROVED_RESULT history entry for the same market are promoted. Idempotent.
UPDATE markets m
SET verification_status = 'VERIFIED',
    confidence = 1.0,
    source_updated_at = now(),
    updated_at = now()
WHERE m.verification_status IN ('UNMAPPED', 'SINGLE_SOURCE')
  AND m.result ~ '^[0-9]{3,6}$'
  AND m.period IS NOT NULL
  AND btrim(m.period) <> ''
  AND EXISTS (
    SELECT 1
    FROM market_result_history h
    WHERE h.market_id = m.id
      AND h.period = m.period
      AND h.result = m.result
      AND h.source_name = 'APPROVED_RESULT'
      AND h.result ~ '^[0-9]{3,6}$'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM market_result_history o
    WHERE o.market_id = m.id
      AND o.period = m.period
      AND o.result <> m.result
      AND (o.source_name LIKE 'OFFICIAL:%' OR o.source_name LIKE 'CONSENSUS:%')
  );
