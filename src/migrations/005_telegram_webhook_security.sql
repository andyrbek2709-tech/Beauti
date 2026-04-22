ALTER TABLE telegram_integrations
  ADD COLUMN IF NOT EXISTS webhook_secret text;

CREATE TABLE IF NOT EXISTS telegram_updates_processed (
  id bigserial PRIMARY KEY,
  salon_id text NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  update_id bigint NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (salon_id, update_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_updates_salon_processed
  ON telegram_updates_processed (salon_id, processed_at DESC);
