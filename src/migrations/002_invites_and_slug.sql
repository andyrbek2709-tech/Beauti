ALTER TABLE salons
  ADD COLUMN IF NOT EXISTS slug text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_salons_slug ON salons (slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS salon_invites (
  token text PRIMARY KEY,
  created_by text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL,
  used_by_salon_id text NULL REFERENCES salons(id) ON DELETE SET NULL,
  note text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_salon_invites_expires ON salon_invites (expires_at);
