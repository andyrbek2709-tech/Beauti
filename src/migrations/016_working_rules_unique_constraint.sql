-- Deduplicate working_rules rows (keep latest per salon_id/weekday), then add UNIQUE constraint.
DELETE FROM working_rules a
USING working_rules b
WHERE a.id < b.id
  AND a.salon_id = b.salon_id
  AND a.weekday = b.weekday;

DROP INDEX IF EXISTS idx_working_rules_salon_weekday;

ALTER TABLE working_rules
  ADD CONSTRAINT uq_working_rules_salon_weekday UNIQUE (salon_id, weekday);
