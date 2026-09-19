-- §1.2 — Structure and StructureVersion, the critical entity.
--
-- A structure is quoted, counter-quoted, negotiated and firmed. The naive shape
-- is a table per state — expiring / quoted / alternative / negotiated / FOT.
-- This is one versioned entity instead, so that diffing any two states is one
-- generic function over `terms`, the negotiation history IS the version chain,
-- and M6's future ML dataset is a query rather than an ETL job.
--
-- Structures hang off contract_year (§1), not off placement: a single year may
-- carry proportional and non-proportional structures together as siblings
-- (§1.3). The existing negotiation_structure rows are untouched and keep
-- working; this is the model they will move onto, not a replacement of them.

-- ---------------------------------------------------------------------------
-- Term schemas, stored as data (§1.3)
-- ---------------------------------------------------------------------------
-- "a JSON Schema per (treaty_type × class_of_business) for validation".
-- As rows rather than as code, so adding a treaty type is a config change.
-- Versioned, because a structure must validate against the schema in force when
-- it was written — a later tightening must not retroactively invalidate history.
CREATE TABLE term_schema (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  treaty_type TEXT NOT NULL,
  cob         TEXT NOT NULL,
  version     INTEGER NOT NULL,
  basis       TEXT NOT NULL CHECK (basis IN ('NP', 'PROP')),
  schema      JSONB NOT NULL,
  -- Money fields are named here rather than inferred, so canonicalisation to
  -- integer minor units (§2.6) never has to guess which numbers are amounts.
  money_paths TEXT[] NOT NULL DEFAULT '{}',
  retired_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (treaty_type, cob, version)
);

-- One schema in force per (treaty type, class of business) at a time.
CREATE UNIQUE INDEX idx_term_schema_current
  ON term_schema(treaty_type, cob) WHERE retired_at IS NULL;

COMMENT ON TABLE term_schema IS
  '§1.3 — typed terms validated per (treaty_type x cob). D9 ships exactly two: Property Cat XL and Property Surplus.';

-- ---------------------------------------------------------------------------
-- Structure — what is being placed: a layer, or a proportional section.
-- ---------------------------------------------------------------------------
CREATE TABLE structure (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_year_id UUID NOT NULL REFERENCES contract_year(id) ON DELETE CASCADE,
  label            TEXT NOT NULL,
  -- 'NP' | 'PROP', the same vocabulary negotiation_structure already uses.
  basis            TEXT NOT NULL CHECK (basis IN ('NP', 'PROP')),
  treaty_type      TEXT NOT NULL,
  cob              TEXT NOT NULL,
  position         INTEGER NOT NULL DEFAULT 0,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contract_year_id, label),
  -- Supports the composite foreign key on structure_version.
  UNIQUE (id, contract_year_id)
);

CREATE INDEX idx_structure_contract_year ON structure(contract_year_id);

-- ---------------------------------------------------------------------------
-- StructureVersion — one entity, not five tables (§1.2).
-- ---------------------------------------------------------------------------
CREATE TABLE structure_version (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  structure_id      UUID NOT NULL REFERENCES structure(id) ON DELETE CASCADE,
  version_no        INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN (
                      'EXPIRING', 'SUBMITTED', 'QUOTED', 'ALTERNATIVE',
                      'NEGOTIATED', 'FOT', 'BOUND')),
  origin            TEXT NOT NULL CHECK (origin IN ('BROKER', 'REINSURER', 'CEDANT')),
  -- Which reinsurer proposed it. `market` is this system's counterparty
  -- register; NULL when the broker or the cedant authored the version.
  origin_party_id   UUID REFERENCES market(id),
  parent_version_id UUID,
  terms             JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The schema this version was validated against, so a version can be
  -- re-validated years later against the rules that actually applied to it.
  term_schema_id    UUID REFERENCES term_schema(id),
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (structure_id, version_no),
  -- Supports the composite foreign key below.
  UNIQUE (id, structure_id),

  -- §1.2: origin_party_id says *which reinsurer* proposed it, and is null if
  -- broker or cedant. A REINSURER version with no party is unattributable, and
  -- a BROKER version with one is a contradiction; neither is allowed to exist.
  CONSTRAINT structure_version_party_matches_origin CHECK (
    (origin = 'REINSURER' AND origin_party_id IS NOT NULL)
    OR (origin IN ('BROKER', 'CEDANT') AND origin_party_id IS NULL)
  ),

  CONSTRAINT structure_version_not_own_parent
    CHECK (parent_version_id IS DISTINCT FROM id),

  -- A version is derived from another version OF THE SAME STRUCTURE. Enforced
  -- in the schema because the version chain is the negotiation history (§1.2)
  -- and a chain that wanders between structures is not a history of anything.
  CONSTRAINT structure_version_parent_same_structure
    FOREIGN KEY (parent_version_id, structure_id)
    REFERENCES structure_version (id, structure_id)
);

CREATE INDEX idx_structure_version_structure ON structure_version(structure_id);
CREATE INDEX idx_structure_version_status ON structure_version(status);
CREATE INDEX idx_structure_version_origin_party ON structure_version(origin_party_id)
  WHERE origin_party_id IS NOT NULL;

COMMENT ON TABLE structure_version IS
  '§1.2 — one versioned entity covering expiring, submitted, quoted, alternative, negotiated, FOT and bound states.';
COMMENT ON COLUMN structure_version.terms IS
  '§1.3 — typed terms. Money is integer minor units (§2.6) with terms.currency naming the currency.';
