-- Modelling data captured on the placement page — one row per screen section,
-- the same per-screen persistence the Universe modelling tool uses (triangles,
-- straight stats, loss lists and selections, dev factors, profiles, CRESTA,
-- event loss tables, pricing). Sections are free-form keys owned by the
-- frontend workflow ("triangle_premium", "loss_selection_large", …) so a new
-- screen never needs a migration; the data itself is the screen's JSON state.

CREATE TABLE placement_modelling (
  placement_id UUID NOT NULL REFERENCES placement(id) ON DELETE CASCADE,
  section      TEXT NOT NULL CHECK (section ~ '^[a-z0-9][a-z0-9_:.-]{0,79}$'),
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by   UUID REFERENCES users(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (placement_id, section)
);

CREATE INDEX idx_placement_modelling_placement ON placement_modelling (placement_id);
