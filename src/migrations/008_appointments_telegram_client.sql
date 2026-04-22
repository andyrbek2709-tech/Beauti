ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS client_telegram_user_id text;

CREATE INDEX IF NOT EXISTS idx_appointments_salon_telegram_client_active
  ON appointments (salon_id, client_telegram_user_id, start_at)
  WHERE status = 'booked' AND client_telegram_user_id IS NOT NULL;
