-- §1.1 — the top of the spine: Cedant → Contract → ContractYear.
--
-- The system currently models a treaty programme and its annual renewal as one
-- `placement` row, with `renewal_of` linking one year's placement to the last.
-- §1 separates the two: a Contract is the programme ("Property Surplus"), a
-- ContractYear is one renewal of it, and ContractYear links to its predecessor.
--
-- This migration introduces both tables and gives `placement` a nullable link
-- to a contract year, so a placement can be attached to the spine without
-- disturbing anything that already works. Existing placements are deliberately
-- NOT backfilled: deriving a programme from (cedant, class) would invent a
-- domain rule — one cedant may well run two Property programmes — and §8 says
-- to ask rather than guess. See the note at the foot of this file.

-- ---------------------------------------------------------------------------
-- Contract — the treaty programme. Renews annually.
-- ---------------------------------------------------------------------------
CREATE TABLE contract (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cedant_id  UUID NOT NULL REFERENCES cedant(id),
  name       TEXT NOT NULL,
  -- `cob` follows the wording library's naming (migration 010) rather than
  -- `placement.class`, since this is the same concept the clause corpus indexes.
  cob        TEXT NOT NULL,
  territory  TEXT,
  notes      TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cedant_id, name)
);

CREATE INDEX idx_contract_cedant ON contract(cedant_id);
CREATE INDEX idx_contract_cob ON contract(cob);

-- Deliberately no treaty type or basis here. §1.3: "A single placement may
-- carry proportional and non-proportional structures together — they are
-- siblings under the same ContractYear." Basis belongs to the structure, which
-- is Phase 2, and the existing negotiation structures already carry it.
COMMENT ON TABLE contract IS
  '§1.1 — a treaty programme. A cedant has many contracts; a contract renews annually into contract years.';

-- ---------------------------------------------------------------------------
-- ContractYear — one annual renewal, linked to its predecessor.
-- ---------------------------------------------------------------------------
CREATE TABLE contract_year (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id            UUID NOT NULL REFERENCES contract(id),
  year_label             TEXT NOT NULL,        -- '2026'
  inception              DATE NOT NULL,
  expiry                 DATE NOT NULL,
  currency               TEXT NOT NULL,
  prior_contract_year_id UUID,
  notes                  TEXT,
  created_by             UUID REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (contract_id, year_label),
  -- Supports the composite foreign key below.
  UNIQUE (id, contract_id),

  CONSTRAINT contract_year_period_check CHECK (expiry > inception),
  CONSTRAINT contract_year_not_own_prior CHECK (prior_contract_year_id IS DISTINCT FROM id),

  -- The predecessor must belong to the SAME contract. In the schema rather than
  -- in a service, because a cross-contract link would silently corrupt all
  -- three things §1.1 says this link buys: the expiring/current slip diff (M1),
  -- the "was on the expiring panel" flag (M9), and the expiring structures
  -- shown alongside those being quoted (M5).
  CONSTRAINT contract_year_prior_same_contract
    FOREIGN KEY (prior_contract_year_id, contract_id)
    REFERENCES contract_year (id, contract_id)
);

-- Renewal is a chain, not a tree: a year has at most one successor.
CREATE UNIQUE INDEX idx_contract_year_one_successor
  ON contract_year(prior_contract_year_id)
  WHERE prior_contract_year_id IS NOT NULL;

CREATE INDEX idx_contract_year_contract ON contract_year(contract_id);
CREATE INDEX idx_contract_year_inception ON contract_year(inception);

COMMENT ON COLUMN contract_year.prior_contract_year_id IS
  '§1.1 — renewal as a linked chain, never a copied record.';

-- ---------------------------------------------------------------------------
-- Attach a placement to its contract year.
-- ---------------------------------------------------------------------------
-- Nullable, so nothing that exists today breaks and adoption can be
-- incremental. One placement per contract year: the placement IS the work of
-- placing that year.
ALTER TABLE placement ADD COLUMN contract_year_id UUID REFERENCES contract_year(id);

CREATE UNIQUE INDEX idx_placement_contract_year
  ON placement(contract_year_id) WHERE contract_year_id IS NOT NULL;

COMMENT ON COLUMN placement.contract_year_id IS
  'Links a placement to its ContractYear (§1.1). Nullable during adoption; `renewal_of` remains the link for placements not yet attached.';

-- Backfill note: attaching the existing book needs a decision on how placements
-- group into programmes — one contract per (cedant, class) is a guess, and a
-- wrong grouping corrupts the renewal chain it is meant to create. The API
-- added alongside this migration lets a broker create the contract and attach
-- placements explicitly, which is the safe order to do it in.
