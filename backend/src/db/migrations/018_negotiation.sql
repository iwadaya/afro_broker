-- Negotiation: the pack goes out to markets, and their quotes come back
-- against the structures that were quoted.

-- One row per market the pack was sent to, on this placement.
CREATE TABLE negotiation (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id UUID NOT NULL REFERENCES placement(id) ON DELETE CASCADE,
  market_id    UUID NOT NULL REFERENCES market(id),
  role         TEXT NOT NULL DEFAULT 'follow' CHECK (role IN ('lead', 'follow')),
  -- The pack version that went out, kept by id and by number: a version is
  -- immutable, so this is exactly what the market is quoting on.
  pack_id      UUID REFERENCES renewal_pack(id) ON DELETE SET NULL,
  pack_version INTEGER,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       TEXT NOT NULL DEFAULT 'SENT'
               CHECK (status IN ('SENT', 'QUOTED', 'DECLINED', 'WITHDRAWN')),
  notes        TEXT,
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (placement_id, market_id)
);

CREATE INDEX idx_negotiation_placement ON negotiation(placement_id);

-- What a market quoted on one line of one structure. A non-proportional
-- structure is quoted layer by layer; a proportional one is quoted as a whole,
-- and carries no layer index.
CREATE TABLE negotiation_quote (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negotiation_id  UUID NOT NULL REFERENCES negotiation(id) ON DELETE CASCADE,
  structure_index INTEGER NOT NULL CHECK (structure_index >= 1),
  layer_index     INTEGER CHECK (layer_index IS NULL OR layer_index >= 0),
  status          TEXT NOT NULL DEFAULT 'quoted'
                  CHECK (status IN ('quoted', 'declined')),
  rate_pct        NUMERIC(12,6),
  premium         NUMERIC(18,2),
  line_pct        NUMERIC(7,4) CHECK (line_pct IS NULL OR (line_pct >= 0 AND line_pct <= 100)),
  commission_pct  NUMERIC(7,4) CHECK (commission_pct IS NULL OR (commission_pct >= 0 AND commission_pct <= 100)),
  validity        DATE,
  notes           TEXT,
  -- Anything the board does not have a column for yet.
  terms           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One quote per market per line. NULL layer indexes are the proportional
-- structure's own terms, so they must collide with each other.
CREATE UNIQUE INDEX idx_negotiation_quote_cell
  ON negotiation_quote (negotiation_id, structure_index, COALESCE(layer_index, -1));
