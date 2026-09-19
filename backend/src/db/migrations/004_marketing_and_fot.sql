-- Lead/follow marketing: Approach, Quote, Subjectivity, and Firm Order Terms.

CREATE TABLE approach (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id   UUID NOT NULL REFERENCES layer(id) ON DELETE CASCADE,
  market_id  UUID NOT NULL REFERENCES market(id),
  role       TEXT NOT NULL CHECK (role IN ('lead','follow')),
  sent_date  DATE,
  status     TEXT NOT NULL DEFAULT 'APPROACHED'
             CHECK (status IN ('APPROACHED','QUOTED','AGREED','WRITTEN','SIGNED','DECLINED')),
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (layer_id, market_id)
);

CREATE INDEX idx_approach_layer ON approach(layer_id);

CREATE TABLE quote (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approach_id  UUID NOT NULL REFERENCES approach(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('indicative','firm')),
  rate         NUMERIC(12,6),     -- rate on line / rate %
  rol          NUMERIC(12,6),     -- rate on line (XoL)
  premium      NUMERIC(18,2),
  line_offered NUMERIC(7,4),      -- % the market would write
  terms        JSONB NOT NULL DEFAULT '{}'::jsonb,
  validity     DATE,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','superseded','withdrawn','accepted','declined')),
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_quote_approach ON quote(approach_id);

CREATE TABLE subjectivity (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id      UUID NOT NULL REFERENCES quote(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  resolved      BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_date DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_subjectivity_quote ON subjectivity(quote_id);

-- Firm Order Terms. Immutable once authorised; a change is a new version.
CREATE TABLE fot (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id      UUID NOT NULL REFERENCES layer(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  agreed_terms  JSONB NOT NULL DEFAULT '{}'::jsonb,  -- snapshot of agreed rate/premium/terms
  status        TEXT NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','authorised','superseded')),
  proposed_by   UUID REFERENCES users(id),
  authorised_by UUID REFERENCES users(id),
  agreed_date   DATE,
  authorised_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (layer_id, version)
);

CREATE INDEX idx_fot_layer ON fot(layer_id);

-- At most one authorised FOT per layer (the live terms).
CREATE UNIQUE INDEX idx_fot_one_authorised
  ON fot(layer_id) WHERE status = 'authorised';
