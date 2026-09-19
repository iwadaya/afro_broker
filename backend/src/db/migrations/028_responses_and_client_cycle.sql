-- M6 (quote response tracking) and M8 (quote-to-client cycle), on StructureVersion.
--
-- Both modules exist today against `quote` / `negotiation_quote` / `fot`, which
-- predate the spine. Those tables are untouched and keep working; this is the
-- model they move onto. What changes is that a response is now recorded against
-- the *version that was submitted*, and an alternative quote becomes a version
-- rather than a row in a parallel table.

-- ---------------------------------------------------------------------------
-- Decline reasons — a coded enum plus free text (M6).
-- ---------------------------------------------------------------------------
-- A reference table rather than a CHECK constraint, following occupancy_class:
-- the vocabulary of why a market says no is a business list that will be edited,
-- and a list that needs a migration to extend is a list that stops being used.
CREATE TABLE decline_reason (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- M6 — one response per reinsurer per submitted structure version.
-- ---------------------------------------------------------------------------
CREATE TABLE structure_response (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What the reinsurer was asked to quote. Responses attach to the version,
  -- not the structure: "they quoted on the terms as they stood then" is the
  -- only reading of a response that survives a re-quote.
  structure_version_id UUID NOT NULL REFERENCES structure_version(id) ON DELETE CASCADE,
  reinsurer_id         UUID NOT NULL REFERENCES market(id),

  outcome              TEXT NOT NULL CHECK (outcome IN (
                         'QUOTED', 'DECLINED', 'ALTERNATIVE_QUOTED', 'NO_RESPONSE', 'ABSTAINED')),

  -- Terms offered, when they offered any.
  quoted_rate_pct      NUMERIC(12,6),
  quoted_line_pct      NUMERIC(7,4),
  quoted_premium_minor BIGINT,
  quoted_currency      CHAR(3),
  validity             DATE,

  -- An alternative quote IS a structure version (M6), origin REINSURER and
  -- status ALTERNATIVE, linked back to what was submitted. This column points
  -- at it so the response and the counter-proposal are one record, not two.
  alternative_version_id UUID REFERENCES structure_version(id),

  decline_reason_id    UUID REFERENCES decline_reason(id),
  decline_note         TEXT,

  -- The ML dataset (M6): "reinsurer, class of business, treaty type, territory,
  -- cedant rating, layer attributes, rate, market conditions at the time,
  -- outcome, all as structured fields."
  --
  -- Snapshotted at response time on purpose. A cedant's rating and the state of
  -- the market both move, and a model trained on today's rating against a
  -- three-year-old decision learns the wrong thing. This is not the
  -- denormalisation M10 warns against — that is about dashboard counters, which
  -- are derivable; these are point-in-time facts that are not.
  snapshot_cob              TEXT,
  snapshot_treaty_type      TEXT,
  snapshot_basis            TEXT,
  snapshot_territory        TEXT,
  snapshot_cedant_rating    TEXT,
  snapshot_inception        DATE,
  snapshot_currency         CHAR(3),
  snapshot_deductible_minor BIGINT,
  snapshot_limit_minor      BIGINT,
  snapshot_terms            JSONB,
  -- Reserved. M6 asks for market conditions at the time; nothing in this system
  -- knows them yet, so the column exists and stays null rather than being
  -- filled with a guess. Populating it needs a source, not a migration.
  market_conditions         JSONB,

  responded_at  DATE,
  recorded_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (structure_version_id, reinsurer_id),

  -- An alternative quote without the version it proposed is a dead end, and any
  -- other outcome carrying one is a contradiction.
  CONSTRAINT structure_response_alternative_has_version CHECK (
    (outcome = 'ALTERNATIVE_QUOTED' AND alternative_version_id IS NOT NULL)
    OR (outcome <> 'ALTERNATIVE_QUOTED' AND alternative_version_id IS NULL)
  ),

  -- D4: a decline is one click plus a reason code. Without the code the
  -- negative examples the model depends on carry no signal.
  CONSTRAINT structure_response_decline_has_reason CHECK (
    outcome <> 'DECLINED' OR decline_reason_id IS NOT NULL
  ),

  -- §2.6 — an amount without its currency is unusable.
  CONSTRAINT structure_response_premium_currency CHECK (
    (quoted_premium_minor IS NULL) = (quoted_currency IS NULL)
  )
);

CREATE INDEX idx_structure_response_version ON structure_response(structure_version_id);
-- The per-reinsurer history across placements (M6) reads on this.
CREATE INDEX idx_structure_response_reinsurer ON structure_response(reinsurer_id, outcome);
CREATE INDEX idx_structure_response_alternative ON structure_response(alternative_version_id)
  WHERE alternative_version_id IS NOT NULL;

COMMENT ON TABLE structure_response IS
  'M6 — outcome per reinsurer per submitted structure version, with the point-in-time context the future model needs.';

-- ---------------------------------------------------------------------------
-- M8 — threaded comments against a structure version.
-- ---------------------------------------------------------------------------
CREATE TABLE structure_comment (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  structure_version_id UUID NOT NULL REFERENCES structure_version(id) ON DELETE CASCADE,
  parent_comment_id    UUID,
  -- Who a comment is for. A thread that cannot tell an internal note from
  -- something said to the client is one internal note away from an incident.
  audience             TEXT NOT NULL DEFAULT 'INTERNAL'
                       CHECK (audience IN ('INTERNAL', 'CEDANT')),
  body                 TEXT NOT NULL CHECK (length(btrim(body)) > 0),
  created_by           UUID REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (id, structure_version_id),
  CONSTRAINT structure_comment_not_own_parent CHECK (parent_comment_id IS DISTINCT FROM id),
  -- A reply stays in the thread it replies to.
  CONSTRAINT structure_comment_parent_same_version
    FOREIGN KEY (parent_comment_id, structure_version_id)
    REFERENCES structure_comment (id, structure_version_id)
);

CREATE INDEX idx_structure_comment_version ON structure_comment(structure_version_id);

-- ---------------------------------------------------------------------------
-- M8 — the client stage: quotes out to the cedant, and what came back.
-- ---------------------------------------------------------------------------
CREATE TABLE cedant_quote_send (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_year_id    UUID NOT NULL REFERENCES contract_year(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT', 'SENT', 'TAKEN_UP', 'NOT_TAKEN_UP')),
  sent_at             TIMESTAMPTZ,
  outcome_at          TIMESTAMPTZ,
  not_taken_up_reason TEXT,
  -- D7: the approval that permitted the send. Recorded so the outbound act and
  -- its authorisation are one record.
  approval_id         UUID REFERENCES approval(id),
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cedant_quote_send_sent_has_approval CHECK (
    status = 'DRAFT' OR (sent_at IS NOT NULL AND approval_id IS NOT NULL)
  ),
  CONSTRAINT cedant_quote_send_not_taken_up_reason CHECK (
    status <> 'NOT_TAKEN_UP' OR length(btrim(coalesce(not_taken_up_reason, ''))) > 0
  )
);

CREATE INDEX idx_cedant_quote_send_year ON cedant_quote_send(contract_year_id);

-- Which versions went out in that send. The version, not the structure: what
-- the cedant saw is a fixed set of terms.
CREATE TABLE cedant_quote_send_version (
  send_id              UUID NOT NULL REFERENCES cedant_quote_send(id) ON DELETE CASCADE,
  structure_version_id UUID NOT NULL REFERENCES structure_version(id),
  PRIMARY KEY (send_id, structure_version_id)
);

-- ---------------------------------------------------------------------------
-- Terms that must be complete at FOT (M8).
-- ---------------------------------------------------------------------------
-- "FOT promotion is the point where terms must be complete and validated
-- against the JSON Schema — the claims and premium engine reads from here."
-- Earlier versions may legitimately be partial: a quote need not state the
-- deposit premium. These are the fields M11 cannot compute without.
--
-- An entry is a field name, or an array of names meaning "at least one of".
ALTER TABLE term_schema ADD COLUMN fot_required JSONB NOT NULL DEFAULT '[]'::jsonb;

-- A rating without its agency is not a rating: "A-" from two agencies is two
-- different statements. §2.2 makes the same point about proving ratings later.
ALTER TABLE structure_response ADD COLUMN snapshot_cedant_rating_agency TEXT;

-- ---------------------------------------------------------------------------
-- D7 — the outbound actions that need a second user.
-- ---------------------------------------------------------------------------
-- The constraint currently admits fot_authorise, bind and submission_send.
-- D7 covers everything that leaves the system: quotes to the cedant, the FOT
-- release to follow markets, written-line advices and claim calculations. The
-- gate is only as wide as the vocabulary it can name.
ALTER TABLE approval DROP CONSTRAINT IF EXISTS approval_action_type_check;
ALTER TABLE approval ADD CONSTRAINT approval_action_type_check CHECK (action_type IN (
  -- Outbound (D7).
  'submission_send',
  'quote_to_cedant',
  'fot_send',
  'written_line_advice',
  'claim_calculation',
  -- Not outbound, equally irreversible.
  'clause_promotion',
  'kyc_hard_delete',
  -- Pre-spine flows, retained so they keep working.
  'fot_authorise',
  'bind'
));
