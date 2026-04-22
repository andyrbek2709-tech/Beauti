CREATE TABLE IF NOT EXISTS telegram_clients (
  id bigserial PRIMARY KEY,
  salon_id text NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  telegram_user_id text NOT NULL,
  telegram_username text,
  telegram_first_name text,
  telegram_last_name text,
  client_name text NOT NULL,
  client_phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (salon_id, telegram_user_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_clients_salon
  ON telegram_clients (salon_id);
