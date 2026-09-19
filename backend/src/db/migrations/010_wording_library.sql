-- Wording library: reusable contract clauses (standard coverages, extensions
-- and market exclusions) held by class of business, plus the house wordings of
-- individual reinsurers, plus draft wordings assembled from them.

-- One clause of a treaty/policy wording. `cob` NULL means "applies to every
-- class" (the general treaty conditions and market exclusions); `market_id` is
-- set only for a named reinsurer's house version of a clause.
CREATE TABLE wording_clause (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  clause_ref  TEXT,
  category    TEXT NOT NULL
              CHECK (category IN ('coverage', 'extension', 'exclusion', 'condition', 'definition')),
  cob         TEXT,
  treaty_type TEXT,
  source      TEXT NOT NULL DEFAULT 'standard'
              CHECK (source IN ('standard', 'market', 'house')),
  market_id   UUID REFERENCES market(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  summary     TEXT,
  tags        TEXT[] NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('draft', 'active', 'archived')),
  version     INTEGER NOT NULL DEFAULT 1,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A market clause names its reinsurer; standard/house clauses never do.
  CONSTRAINT wording_clause_market_source CHECK ((source = 'market') = (market_id IS NOT NULL))
);

CREATE INDEX idx_wording_clause_cob ON wording_clause(cob);
CREATE INDEX idx_wording_clause_category ON wording_clause(category);
CREATE INDEX idx_wording_clause_market ON wording_clause(market_id);
-- The library is keyed on "this clause, for this class, from this source", so
-- re-seeding and re-importing update in place instead of duplicating. NULLS
-- NOT DISTINCT so the general (cob IS NULL) and standard (market_id IS NULL)
-- rows are deduplicated too.
CREATE UNIQUE INDEX uq_wording_clause_identity
  ON wording_clause (title, category, cob, source, market_id) NULLS NOT DISTINCT;

-- Prior versions of a clause body, written on every edit, so a wording can be
-- compared against what the library said last renewal.
CREATE TABLE wording_clause_revision (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clause_id  UUID NOT NULL REFERENCES wording_clause(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  changed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (clause_id, version)
);

-- A draft wording assembled from the library. Clause bodies are snapshotted
-- into the draft, so editing a draft never mutates the library (and the
-- snapshot is what a later library change is compared against).
CREATE TABLE wording_draft (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title          TEXT NOT NULL,
  cob            TEXT,
  treaty_type    TEXT,
  placement_id   UUID REFERENCES placement(id) ON DELETE SET NULL,
  layer_id       UUID REFERENCES layer(id) ON DELETE SET NULL,
  base_market_id UUID REFERENCES market(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'review', 'issued', 'archived')),
  version        INTEGER NOT NULL DEFAULT 1,
  notes          TEXT,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wording_draft_placement ON wording_draft(placement_id);

CREATE TABLE wording_draft_clause (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id         UUID NOT NULL REFERENCES wording_draft(id) ON DELETE CASCADE,
  clause_id        UUID REFERENCES wording_clause(id) ON DELETE SET NULL,
  position         INTEGER NOT NULL,
  category         TEXT NOT NULL
                   CHECK (category IN ('coverage', 'extension', 'exclusion', 'condition', 'definition')),
  title            TEXT NOT NULL,
  clause_ref       TEXT,
  body             TEXT NOT NULL,
  -- The library text as it stood when the clause was pulled in. NULL for
  -- clauses typed straight into the draft.
  source_body      TEXT,
  source_market_id UUID REFERENCES market(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wording_draft_clause_draft ON wording_draft_clause(draft_id, position);
