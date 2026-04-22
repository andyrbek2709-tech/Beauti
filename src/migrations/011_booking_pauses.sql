CREATE TABLE IF NOT EXISTS booking_pauses (
  id bigserial PRIMARY KEY,
  salon_id text NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date date NOT NULL,
  reason text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_date <= end_date)
);

CREATE INDEX IF NOT EXISTS idx_booking_pauses_salon_active
  ON booking_pauses (salon_id, start_date, end_date)
  WHERE is_active = true;
