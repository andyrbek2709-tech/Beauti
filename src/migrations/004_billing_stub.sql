CREATE TABLE IF NOT EXISTS subscriptions (
  id text PRIMARY KEY,
  salon_id text NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  plan_code text NOT NULL DEFAULT 'beautime-basic',
  status text NOT NULL CHECK (status IN ('trial','active','past_due','canceled')),
  trial_started_at timestamptz NULL,
  trial_ends_at timestamptz NULL,
  current_period_start timestamptz NULL,
  current_period_end timestamptz NULL,
  payment_provider text NULL,
  provider_customer_id text NULL,
  provider_subscription_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_salon ON subscriptions (salon_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions (status);

CREATE TABLE IF NOT EXISTS billing_events (
  id bigserial PRIMARY KEY,
  salon_id text NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_events_salon ON billing_events (salon_id, created_at DESC);
