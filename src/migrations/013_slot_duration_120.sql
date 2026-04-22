ALTER TABLE master_settings
  DROP CONSTRAINT IF EXISTS master_settings_slot_duration_minutes_check;

ALTER TABLE master_settings
  ADD CONSTRAINT master_settings_slot_duration_minutes_check
  CHECK (slot_duration_minutes IN (30,45,60,120));
