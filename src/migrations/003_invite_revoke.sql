ALTER TABLE salon_invites
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS idx_salon_invites_revoked_at ON salon_invites (revoked_at);
