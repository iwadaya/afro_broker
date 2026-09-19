-- Alternative structures to quote: count-driven sections, each proportional
-- or non-proportional, stored as JSON on the placement.

ALTER TABLE placement
  ADD COLUMN quote_structures JSONB NOT NULL DEFAULT '[]'::jsonb;
