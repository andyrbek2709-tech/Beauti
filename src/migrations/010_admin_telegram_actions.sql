CREATE TABLE IF NOT EXISTS telegram_admin_actions (
  salon_id text NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  admin_telegram_user_id text NOT NULL,
  action_type text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (salon_id, admin_telegram_user_id)
);
