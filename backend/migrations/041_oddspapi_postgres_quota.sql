BEGIN;

CREATE TABLE IF NOT EXISTS sportsbook_provider_quota_periods (
  provider TEXT NOT NULL,
  period_type TEXT NOT NULL,
  period_start DATE NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, period_type, period_start),
  CONSTRAINT sportsbook_provider_quota_period_type_check
    CHECK (period_type IN ('day', 'month')),
  CONSTRAINT sportsbook_provider_quota_count_check
    CHECK (request_count >= 0),
  CONSTRAINT sportsbook_provider_quota_period_start_check
    CHECK (
      (period_type = 'month' AND EXTRACT(DAY FROM period_start) = 1)
      OR period_type = 'day'
    )
);

CREATE TABLE IF NOT EXISTS sportsbook_provider_quota_reservations (
  provider TEXT NOT NULL,
  reservation_id UUID NOT NULL,
  day_start DATE NOT NULL,
  month_start DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, reservation_id),
  CONSTRAINT sportsbook_provider_quota_reservation_day_check
    CHECK (month_start = date_trunc('month', day_start)::date)
);

CREATE INDEX IF NOT EXISTS sportsbook_provider_quota_reservations_created_idx
  ON sportsbook_provider_quota_reservations(created_at);

COMMIT;
