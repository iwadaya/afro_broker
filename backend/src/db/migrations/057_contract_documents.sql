-- The contract's documents — the Documents step under Contracts, on both
-- the proportional and the non-proportional workflow: the slip, the
-- wording, the cedant's submission, bordereaux, statements and
-- correspondence, kept on the placement as uploaded files.

CREATE TABLE contract_document (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id  UUID NOT NULL REFERENCES placement(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'other'
                CHECK (kind IN ('slip','wording','submission','bordereau','statement','correspondence','other')),
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  content       BYTEA NOT NULL,
  note          TEXT,
  uploaded_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contract_document_placement ON contract_document(placement_id, created_at);
