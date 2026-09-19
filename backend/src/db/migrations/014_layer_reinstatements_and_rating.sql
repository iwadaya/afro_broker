-- Non-proportional layer terms: reinstatements (count or unlimited) and their
-- premium %, plus the rating basis — EGNPI, rate and the annual aggregate
-- deductible. All optional: proportional layers leave them null.

ALTER TABLE layer
  ADD COLUMN reinstatements    TEXT,             -- '1'..'10' or 'UNLIMITED'
  ADD COLUMN reinstatement_pct NUMERIC(7,4),     -- % of layer premium per reinstatement
  ADD COLUMN egnpi             NUMERIC(18,2),    -- estimated gross net premium income
  ADD COLUMN rate_pct          NUMERIC(9,4),     -- rate applied to EGNPI
  ADD COLUMN aad               NUMERIC(18,2);    -- annual aggregate deductible
