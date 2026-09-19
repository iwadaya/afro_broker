-- M3 (distribution and market approach) and M9 (lines and placement
-- completion), on StructureVersion.
--
-- Both exist today against `negotiation_submission` and `line`, which hang off
-- `placement` and `layer`. Those are untouched and keep working; this is the
-- model they move onto. A send is now tied to the ContractYear and the exact
-- versions that went out (M3), and a line is a participation in a specific
-- version's terms rather than in a layer (§1).

-- ---------------------------------------------------------------------------
-- §1.4 — the order: the share the broker is mandated to place.
-- ---------------------------------------------------------------------------
-- On the structure rather than in the terms: §1.3's term lists do not include
-- it, and it is a fact about the mandate to place this structure rather than
-- about what is being placed.
ALTER TABLE structure ADD COLUMN order_pct NUMERIC(7,4) NOT NULL DEFAULT 100
  CHECK (order_pct > 0 AND order_pct <= 100);

COMMENT ON COLUMN structure.order_pct IS
  '§1.4 — the share the broker is mandated to place, e.g. 50 for 50% of 100%. Placement completion is signed against this.';

-- ---------------------------------------------------------------------------
-- M3 — distribution. Two stages, one engine.
-- ---------------------------------------------------------------------------
CREATE TABLE distribution (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_year_id UUID NOT NULL REFERENCES contract_year(id) ON DELETE CASCADE,
  -- "1. Pack to quoting markets for terms. 2. Once FOT is set, pack + FOT to
  -- follow markets for follow shares." One table, because the difference is
  -- which stage it is and what went with it, not how sending works.
  stage            TEXT NOT NULL CHECK (stage IN ('QUOTING', 'FOLLOW')),
  subject          TEXT NOT NULL,
  body             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SENT')),
  -- D5 — plus-addressed reply-to carrying the placement id, so a reply can be
  -- attached to the right placement later without guessing.
  reply_to         TEXT,
  approval_id      UUID REFERENCES approval(id),
  sent_at          TIMESTAMPTZ,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- D7 — nothing goes to a market on one person's authority.
  CONSTRAINT distribution_sent_has_approval CHECK (
    status = 'DRAFT' OR (sent_at IS NOT NULL AND approval_id IS NOT NULL)
  )
);

CREATE INDEX idx_distribution_year ON distribution(contract_year_id);

-- "Every send is a logged record tied to the ContractYear and the version
-- sent." The version, not the structure: what a market was asked to quote is a
-- fixed set of terms, and it is the thing their response attaches to (M6).
CREATE TABLE distribution_version (
  distribution_id      UUID NOT NULL REFERENCES distribution(id) ON DELETE CASCADE,
  structure_version_id UUID NOT NULL REFERENCES structure_version(id),
  PRIMARY KEY (distribution_id, structure_version_id)
);

CREATE TABLE distribution_recipient (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  distribution_id UUID NOT NULL REFERENCES distribution(id) ON DELETE CASCADE,
  reinsurer_id    UUID NOT NULL REFERENCES market(id),
  contact_id      UUID REFERENCES market_contact(id),
  name            TEXT,
  email           TEXT NOT NULL,
  -- M3 asks for sent, delivered, opened (if available), responded. Each is a
  -- timestamp rather than only a status, because "when" is the question asked
  -- of a submission that has gone quiet.
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'SENT', 'DELIVERED', 'OPENED', 'RESPONDED', 'BOUNCED', 'FAILED')),
  message_id      TEXT,
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  opened_at       TIMESTAMPTZ,
  responded_at    TIMESTAMPTZ,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (distribution_id, reinsurer_id, email)
);

CREATE INDEX idx_distribution_recipient_dist ON distribution_recipient(distribution_id);
CREATE INDEX idx_distribution_recipient_reinsurer ON distribution_recipient(reinsurer_id);

-- ---------------------------------------------------------------------------
-- M9 — lines. A reinsurer's participation in a structure version (§1).
-- ---------------------------------------------------------------------------
CREATE TABLE structure_line (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The firm order version being written. Lines are taken against terms that
  -- are firm, so this is normally the FOT version.
  structure_version_id UUID NOT NULL REFERENCES structure_version(id) ON DELETE CASCADE,
  reinsurer_id         UUID NOT NULL REFERENCES market(id),

  -- §1.4 — "Store written_pct and signed_pct separately and never overwrite
  -- one with the other."
  written_pct          NUMERIC(7,4) NOT NULL CHECK (written_pct >= 0),
  signed_pct           NUMERIC(7,4) CHECK (signed_pct IS NULL OR signed_pct >= 0),
  signing_factor       NUMERIC(12,8),
  -- The per-line override §1.4 requires: a reinsurer may refuse to sign down or
  -- hold a guaranteed line, so the factor is not applied blindly to every line.
  to_stand             BOOLEAN NOT NULL DEFAULT FALSE,

  premium_signed_minor BIGINT,
  premium_currency     CHAR(3),

  status               TEXT NOT NULL DEFAULT 'WRITTEN'
                       CHECK (status IN ('WRITTEN', 'SIGNED', 'DECLINED')),
  written_at           DATE,
  bound_date           DATE,
  -- Which approach produced this line, where there was one. Provenance from
  -- the send (M3) through to the participation.
  distribution_recipient_id UUID REFERENCES distribution_recipient(id),

  created_by           UUID REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (structure_version_id, reinsurer_id),
  CONSTRAINT structure_line_premium_currency CHECK (
    (premium_signed_minor IS NULL) = (premium_currency IS NULL)
  )
);

CREATE INDEX idx_structure_line_version ON structure_line(structure_version_id);
CREATE INDEX idx_structure_line_reinsurer ON structure_line(reinsurer_id);

COMMENT ON TABLE structure_line IS
  '§1.4 — written and signed participations. Placement completion is the sum of signed against structure.order_pct.';

-- ---------------------------------------------------------------------------
-- M9 — written lines advised to the cedant incrementally.
-- ---------------------------------------------------------------------------
-- "Written lines sent to the cedant incrementally as they arrive from follow
-- markets — not one final send."
CREATE TABLE written_line_advice (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_year_id UUID NOT NULL REFERENCES contract_year(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SENT')),
  approval_id      UUID REFERENCES approval(id),
  sent_at          TIMESTAMPTZ,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- D7 again: an advice is outbound.
  CONSTRAINT written_line_advice_sent_has_approval CHECK (
    status = 'DRAFT' OR (sent_at IS NOT NULL AND approval_id IS NOT NULL)
  )
);

CREATE INDEX idx_written_line_advice_year ON written_line_advice(contract_year_id);

-- What the cedant was actually told, as at that advice. The percentage is
-- copied rather than joined: an advice is a statement made on a date, and a
-- line that moves afterwards must not rewrite what was said.
CREATE TABLE written_line_advice_line (
  advice_id        UUID NOT NULL REFERENCES written_line_advice(id) ON DELETE CASCADE,
  structure_line_id UUID NOT NULL REFERENCES structure_line(id),
  written_pct      NUMERIC(7,4) NOT NULL,
  PRIMARY KEY (advice_id, structure_line_id)
);
