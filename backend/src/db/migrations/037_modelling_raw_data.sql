-- The cedant's raw data behind the modelling screens (bordereaux, loss runs,
-- premium listings, profiles — Excel, CSV, PDF), uploaded on the placement's
-- Modelling Pack view so the AI can cross-check what was entered on the
-- screens against the source and report the differences.
CREATE TABLE placement_modelling_document (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id  UUID NOT NULL REFERENCES placement(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  content       BYTEA NOT NULL,
  text_content  TEXT,                 -- text/CSV uploads, decoded once
  note          TEXT,                 -- what the file is ("2025 loss run", "premium bordereau")
  uploaded_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_modelling_document_placement ON placement_modelling_document(placement_id);
