-- Written/signed Lines (the ledger) and Documents.

CREATE TABLE line (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id       UUID NOT NULL REFERENCES layer(id) ON DELETE CASCADE,
  market_id      UUID NOT NULL REFERENCES market(id),
  approach_id    UUID REFERENCES approach(id),
  written_pct    NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (written_pct >= 0),
  signed_pct     NUMERIC(7,4) CHECK (signed_pct IS NULL OR signed_pct >= 0),
  signing_factor NUMERIC(12,8),
  to_stand       BOOLEAN NOT NULL DEFAULT FALSE,
  premium_signed NUMERIC(18,2),
  status         TEXT NOT NULL DEFAULT 'WRITTEN'
                 CHECK (status IN ('APPROACHED','QUOTED','AGREED','WRITTEN','SIGNED','DECLINED')),
  bound_date     DATE,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (layer_id, market_id)
);

CREATE INDEX idx_line_layer ON line(layer_id);
CREATE INDEX idx_line_market ON line(market_id);

CREATE TABLE document (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id UUID REFERENCES placement(id) ON DELETE CASCADE,
  layer_id     UUID REFERENCES layer(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('mrc_slip','cover_note','signing_slip','closing')),
  version      INTEGER NOT NULL DEFAULT 1,
  file         TEXT,
  content      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_document_placement ON document(placement_id);
CREATE INDEX idx_document_layer ON document(layer_id);
