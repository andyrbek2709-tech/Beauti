ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reminder_24h_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_1h_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS client_confirmed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_appointments_reminder_24h
  ON appointments (start_at)
  WHERE status = 'booked' AND client_telegram_user_id IS NOT NULL AND reminder_24h_sent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_reminder_1h
  ON appointments (start_at)
  WHERE status = 'booked' AND client_telegram_user_id IS NOT NULL AND reminder_1h_sent_at IS NULL;
