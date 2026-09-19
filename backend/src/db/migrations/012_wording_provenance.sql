-- Provenance for library clauses.
--
-- The library ships with two kinds of text: authentic market-standard clauses
-- (LMA / Institute / BRMA forms, published by their bodies for market use) and
-- illustrative drafting written for this repository where no single published
-- standard exists. A broker putting a clause on a slip must be able to tell
-- which is which, and follow the reference back to its publisher.

ALTER TABLE wording_clause
  ADD COLUMN provenance TEXT NOT NULL DEFAULT 'illustrative'
             CHECK (provenance IN ('market_standard', 'illustrative')),
  ADD COLUMN source_org  TEXT,
  ADD COLUMN source_url  TEXT,
  ADD COLUMN source_note TEXT;

CREATE INDEX idx_wording_clause_provenance ON wording_clause(provenance);

COMMENT ON COLUMN wording_clause.provenance IS
  'market_standard = the authentic published market form; illustrative = drafting written for this repo as a placeholder.';
COMMENT ON COLUMN wording_clause.source_note IS
  'Copyright/usage note for the publishing body, shown beside the clause text.';
