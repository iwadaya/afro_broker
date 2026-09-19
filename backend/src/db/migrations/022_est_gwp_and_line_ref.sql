-- Book-level estimated GWP on a placement, and the market's own reference for
-- its written line. The contract-wording domain lives in the wordings module
-- (010_wording_library, 012_wording_provenance).

ALTER TABLE placement ADD COLUMN est_gwp NUMERIC(18,2);

-- The market's own reference for its written line (shown on the lines table).
ALTER TABLE line ADD COLUMN market_ref TEXT;

COMMENT ON COLUMN placement.est_gwp IS
  'Estimated gross written premium for the placement, 100% basis — the book view''s sizing.';
COMMENT ON COLUMN line.market_ref IS
  'The reinsurer''s own reference for the line, as quoted on their signing.';
