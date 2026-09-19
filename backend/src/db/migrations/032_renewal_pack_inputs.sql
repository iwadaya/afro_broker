-- Manual renewal-pack inputs.
--
-- The pack is assembled from data the broker pastes straight out of Excel —
-- large losses, triangulations, straight stats, profiles — one block per
-- template section, exactly as the Universe modelling tool's input tabs work.
-- Each row holds one section's data for one placement, already normalised to
-- the shape the pack template renders and exports; `raw` keeps the paste as it
-- arrived so a mis-mapped block can be re-read. Saving again replaces the
-- section (UNIQUE), and a cut pack version still snapshots the data it used.

CREATE TABLE renewal_pack_input (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id UUID NOT NULL REFERENCES placement(id) ON DELETE CASCADE,
  section_key  TEXT NOT NULL,
  data         JSONB NOT NULL,
  raw          TEXT,
  updated_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (placement_id, section_key)
);

CREATE INDEX idx_pack_input_placement ON renewal_pack_input(placement_id);
