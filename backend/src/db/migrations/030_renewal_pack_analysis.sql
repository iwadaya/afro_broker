-- AI renewal pack analysis: the broker enters the cedant, class of business
-- and treaty type, uploads the renewal packs (typically the expiring and the
-- current submissions), and the model reviews them — commentary per pack, a
-- change-by-change comparison and recommendations. Standalone of the
-- placement spine: packs are analysed before a placement necessarily exists.

CREATE TABLE renewal_pack_analysis (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cedant_name       TEXT NOT NULL,
  cedant_domicile   TEXT,
  cedant_notes      TEXT,
  class_of_business TEXT NOT NULL,
  treaty_type       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','analysing','complete','failed')),
  result            JSONB,               -- structured model output
  provider          TEXT,                -- which provider answered (anthropic/openai)
  model             TEXT,
  error             TEXT,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  analysed_at       TIMESTAMPTZ
);

CREATE TABLE renewal_pack_analysis_document (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id  UUID NOT NULL REFERENCES renewal_pack_analysis(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'other' CHECK (role IN ('expiring','current','other')),
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  content      BYTEA NOT NULL,
  text_content TEXT,                     -- extracted text for text-like uploads
  uploaded_by  UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rpa_doc_analysis ON renewal_pack_analysis_document(analysis_id);
