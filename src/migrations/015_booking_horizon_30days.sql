-- Increase default booking horizon from 14 to 30 days for all existing salons.
UPDATE master_settings
SET booking_horizon_days = 30
WHERE booking_horizon_days = 14;
