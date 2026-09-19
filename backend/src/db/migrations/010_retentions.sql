-- Table of retentions by occupancy category: cedant net retention and
-- surplus lines per category, driving occupancy capacity in renewal packs.

ALTER TABLE placement
  ADD COLUMN retentions JSONB NOT NULL DEFAULT '[]'::jsonb;
