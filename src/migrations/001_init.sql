CREATE TABLE IF NOT EXISTS salons (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admins (
  id text PRIMARY KEY,
  salon_id text NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_integrations (
  salon_id text PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
  bot_token text NOT NULL,
  telegram_user_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS master_settings (
  salon_id text PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
  slot_duration_minutes integer NOT NULL CHECK (slot_duration_minutes IN (30,45,60)),
  booking_horizon_days integer NOT NULL CHECK (booking_horizon_days > 0 AND booking_horizon_days <= 30),
  cancel_cutoff_hours integer NOT NULL CHECK (cancel_cutoff_hours >= 0 AND cancel_cutoff_hours <= 48),
  timezone text NOT NULL DEFAULT 'Europe/Moscow',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS working_rules (
  id bigserial PRIMARY KEY,
  salon_id text NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  weekday integer NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_minute integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute integer NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_minute < end_minute)
);

CREATE INDEX IF NOT EXISTS idx_working_rules_salon_weekday ON working_rules (salon_id, weekday);

CREATE TABLE IF NOT EXISTS schedule_exceptions (
  id bigserial PRIMARY KEY,
  salon_id text NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  date date NOT NULL,
  is_closed boolean NOT NULL,
  custom_start_minute integer NULL CHECK (custom_start_minute BETWEEN 0 AND 1439),
  custom_end_minute integer NULL CHECK (custom_end_minute BETWEEN 1 AND 1440),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (salon_id, date)
);

CREATE TABLE IF NOT EXISTS appointments (
  id text PRIMARY KEY,
  salon_id text NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  client_name text NOT NULL,
  client_phone text NOT NULL,
  source text NOT NULL CHECK (source IN ('telegram','web')),
  status text NOT NULL CHECK (status IN ('booked','cancelled')),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  cancelled_at timestamptz NULL,
  cancelled_by text NULL CHECK (cancelled_by IN ('client','admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_at < end_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_slot_per_salon ON appointments (salon_id, start_at) WHERE status = 'booked';
CREATE INDEX IF NOT EXISTS idx_appt_salon_start ON appointments (salon_id, start_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  request_id text NOT NULL,
  salon_id text NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('book','cancel')),
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, salon_id, operation)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  salon_id text NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  actor_admin_id text NULL,
  action text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
