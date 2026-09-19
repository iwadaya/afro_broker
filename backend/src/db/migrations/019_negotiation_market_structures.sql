-- A market — usually the lead — may quote a structure other than the one it
-- was sent. That counter-structure belongs to the market that proposed it, and
-- is quoted line by line just like a sent one.

CREATE TABLE negotiation_structure (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negotiation_id UUID NOT NULL REFERENCES negotiation(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  basis          TEXT NOT NULL CHECK (basis IN ('NP', 'PROP')),
  -- Same shape as the placement's quote_structures entries: layers for a
  -- non-proportional structure, prop terms for a proportional one.
  structure      JSONB NOT NULL DEFAULT '{}'::jsonb,
  position       INTEGER NOT NULL DEFAULT 0,
  notes          TEXT,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_negotiation_structure_negotiation ON negotiation_structure(negotiation_id);

-- A quote now answers either a structure that was sent (by its index) or the
-- market's own counter-structure — exactly one of the two.
ALTER TABLE negotiation_quote
  ALTER COLUMN structure_index DROP NOT NULL,
  ADD COLUMN market_structure_id UUID REFERENCES negotiation_structure(id) ON DELETE CASCADE,
  ADD CONSTRAINT negotiation_quote_target CHECK (
    (structure_index IS NOT NULL AND market_structure_id IS NULL)
    OR (structure_index IS NULL AND market_structure_id IS NOT NULL)
  );

-- One answer per line, whichever structure the line belongs to.
DROP INDEX idx_negotiation_quote_cell;

CREATE UNIQUE INDEX idx_negotiation_quote_sent_cell
  ON negotiation_quote (negotiation_id, structure_index, COALESCE(layer_index, -1))
  WHERE structure_index IS NOT NULL;

CREATE UNIQUE INDEX idx_negotiation_quote_market_cell
  ON negotiation_quote (market_structure_id, COALESCE(layer_index, -1))
  WHERE market_structure_id IS NOT NULL;
