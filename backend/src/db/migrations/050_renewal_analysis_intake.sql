-- How an uploaded pack's details came onto the record.
--
-- The intake form (cedant, country, treaty type, classes of business, notes)
-- is filled one of two ways. The full renewal pack is the manual route: a
-- broker types every field. The quick renewal pack hands the cedant's pack
-- to the AI first, which reads the same details off it and fills the form
-- for the broker to correct and add to. The mode is kept so the desk can
-- say how the details arrived, and the quick intake keeps what the model
-- read (with its source and confidence, spec §2.1) beside what the broker
-- saved — which fields were accepted as read, corrected, or added by hand.
-- That correction log is the cheapest measure of the extraction there is.

ALTER TABLE renewal_pack_analysis
  ADD COLUMN intake_mode TEXT NOT NULL DEFAULT 'full'
    CHECK (intake_mode IN ('quick', 'full')),
  ADD COLUMN intake JSONB;

COMMENT ON COLUMN renewal_pack_analysis.intake_mode IS
  'full = details typed by the broker; quick = read off the pack by the AI and corrected by the broker.';
COMMENT ON COLUMN renewal_pack_analysis.intake IS
  'Quick intake only: the model''s picks with provenance, and the broker''s review of each (accepted / corrected / added / empty).';
