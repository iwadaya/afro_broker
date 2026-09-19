-- Link an uploaded renewal pack to the placement it belongs to.
--
-- Analyses stay standalone by default — a cedant's pack is routinely read
-- before anyone has decided to place it, which is why 030 kept the table off
-- the placement spine. The link is therefore nullable and set later, once the
-- placement exists: it is what lets the pack builder carry an uploaded pack's
-- section coverage into the pack it cuts.
--
-- ON DELETE SET NULL, not CASCADE: the analysis owns its uploaded files and
-- its AI review, and outlives a placement that is deleted.

ALTER TABLE renewal_pack_analysis
  ADD COLUMN placement_id UUID REFERENCES placement(id) ON DELETE SET NULL;

CREATE INDEX idx_rpa_placement ON renewal_pack_analysis(placement_id);

-- Which uploaded pack a built pack was composed from, when one drove it.
-- Nullable: packs built by hand from a prior year carry no analysis.
ALTER TABLE renewal_pack
  ADD COLUMN source_analysis_id UUID REFERENCES renewal_pack_analysis(id) ON DELETE SET NULL;
