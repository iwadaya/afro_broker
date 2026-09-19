-- Sending the pack to market: who it goes to, what it says, and the second
-- pair of eyes that releases it.
--
-- The board records that a market holds the pack (018). This adds the step
-- before that: a covering email, carrying AI-drafted commentary the broker
-- must read and edit, addressed to named underwriters, released by someone
-- other than the broker who wrote it.

-- Named underwriters at a market, with the address a submission goes to.
CREATE TABLE market_contact (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id  UUID NOT NULL REFERENCES market(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  role       TEXT,                                  -- underwriter, analyst, …
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_market_contact_market ON market_contact(market_id);
-- One row per address at a market, however it was capitalised on the way in.
CREATE UNIQUE INDEX uq_market_contact_email ON market_contact(market_id, lower(email));

-- One covering email, on its way to (or already with) the market.
CREATE TABLE negotiation_submission (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id    UUID NOT NULL REFERENCES placement(id) ON DELETE CASCADE,
  -- The pack version being offered, held by id and number: a version is
  -- immutable, so this is exactly what the market is being asked to quote.
  pack_id         UUID NOT NULL REFERENCES renewal_pack(id) ON DELETE RESTRICT,
  pack_version    INTEGER,
  wording_id      UUID REFERENCES wording_draft(id) ON DELETE SET NULL,
  lead_market_id  UUID REFERENCES market(id) ON DELETE SET NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,                       -- what the broker sends
  ai_commentary   TEXT,                                -- the draft as generated
  ai_meta         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- provider, model, attempts
  attach_pack     BOOLEAN NOT NULL DEFAULT TRUE,
  broker_reviewed BOOLEAN NOT NULL DEFAULT FALSE,      -- the broker read it
  reviewed_by     UUID REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'pending_approval', 'sent', 'cancelled')),
  reject_reason   TEXT,
  created_by      UUID NOT NULL REFERENCES users(id),
  approved_by     UUID REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Four-eyes: whoever releases it is never whoever drafted it.
  CONSTRAINT negotiation_submission_four_eyes
    CHECK (approved_by IS NULL OR approved_by <> created_by)
);

CREATE INDEX idx_negotiation_submission_placement ON negotiation_submission(placement_id);
CREATE INDEX idx_negotiation_submission_status ON negotiation_submission(status);

-- One row per underwriter the covering email goes to, carrying the outcome.
CREATE TABLE negotiation_submission_recipient (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES negotiation_submission(id) ON DELETE CASCADE,
  market_id     UUID NOT NULL REFERENCES market(id) ON DELETE CASCADE,
  contact_id    UUID REFERENCES market_contact(id) ON DELETE SET NULL,
  name          TEXT,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'follow' CHECK (role IN ('lead', 'follow')),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sent', 'failed')),
  message_id    TEXT,
  error         TEXT,
  sent_at       TIMESTAMPTZ,
  UNIQUE (submission_id, email)
);

CREATE INDEX idx_negotiation_submission_recipient
  ON negotiation_submission_recipient(submission_id);

-- Four-eyes (006) now also covers releasing a submission to market.
ALTER TABLE approval DROP CONSTRAINT IF EXISTS approval_action_type_check;
ALTER TABLE approval ADD CONSTRAINT approval_action_type_check
  CHECK (action_type IN ('fot_authorise', 'bind', 'submission_send'));
