-- Expiring structure & terms: proportional or non-proportional, mirroring a
-- structure to quote. Kept on the placement so manually-entered (new business)
-- expiring terms survive the wizard; renewals still read the prior year
-- contract when nothing is stored here.

ALTER TABLE placement
  ADD COLUMN expiring_structure JSONB NOT NULL DEFAULT '{}'::jsonb;
