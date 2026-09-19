-- Risk/Cat cover indicators on layers, and per-structure class-of-business
-- limits (with layer participation) stored on the placement.

ALTER TABLE layer
  ADD COLUMN risk_cover BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN cat_cover  BOOLEAN NOT NULL DEFAULT TRUE;

-- { "expiring": [{cob, limit, layers:[bool,...]}], "quote": [...] }
ALTER TABLE placement
  ADD COLUMN structure_cobs JSONB NOT NULL DEFAULT '{}'::jsonb;
