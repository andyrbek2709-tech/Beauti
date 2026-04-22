CREATE TABLE IF NOT EXISTS salon_work_patterns (
  id bigserial PRIMARY KEY,
  salon_id text NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  pattern_type text NOT NULL CHECK (pattern_type IN ('even_dates','odd_dates','every_other_day')),
  anchor_date date NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_start <= period_end)
);

CREATE INDEX IF NOT EXISTS idx_salon_work_patterns_active
  ON salon_work_patterns (salon_id, period_start, period_end)
  WHERE is_active = true;
