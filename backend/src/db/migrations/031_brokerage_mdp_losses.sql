-- Finalization on the layer ledger: brokerage, the cedant's signing
-- instruction, MDP debit notes (XoL premium schedule per market) and
-- post-bind loss events with reinstatement premiums. Reinstatement terms
-- themselves already live on the layer (014: reinstatements TEXT,
-- reinstatement_pct) — the loss engine reads those.

-- Brokerage on the layer's premium; the signing method records whether signed
-- lines came from pro-rata sign-down or the cedant's signing instruction.
ALTER TABLE layer
  ADD COLUMN brokerage_pct NUMERIC(7,4) NOT NULL DEFAULT 0
    CHECK (brokerage_pct >= 0 AND brokerage_pct <= 100),
  ADD COLUMN signing_method TEXT
    CHECK (signing_method IN ('pro_rata', 'client_instruction'));

-- Brokerage earned on each signed line (premium_signed × brokerage_pct).
ALTER TABLE line
  ADD COLUMN brokerage_amount NUMERIC(18,2);

-- Risk-profile bordereaux (sum-insured banding) alongside premium and claims.
ALTER TABLE bordereau DROP CONSTRAINT bordereau_type_check;
ALTER TABLE bordereau ADD CONSTRAINT bordereau_type_check
  CHECK (type IN ('premium', 'claims', 'risk_profile'));

-- Generated MDP schedules and loss advices appear in the document worklist.
ALTER TABLE document DROP CONSTRAINT document_type_check;
ALTER TABLE document ADD CONSTRAINT document_type_check
  CHECK (type IN ('mrc_slip', 'cover_note', 'signing_slip', 'closing',
                  'mdp_schedule', 'loss_advice'));

-- Minimum & deposit premium terms for a signed/bound XoL layer. Immutable
-- once issued; a change is a new version that supersedes the prior one.
CREATE TABLE mdp (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id            UUID NOT NULL REFERENCES layer(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  minimum_premium     NUMERIC(18,2) NOT NULL CHECK (minimum_premium >= 0),
  deposit_premium     NUMERIC(18,2) NOT NULL CHECK (deposit_premium >= 0),
  adjustment_rate_pct NUMERIC(12,6),          -- rate applied to subject premium at adjustment
  instalments         INTEGER NOT NULL DEFAULT 4 CHECK (instalments BETWEEN 1 AND 12),
  frequency_months    INTEGER NOT NULL DEFAULT 3 CHECK (frequency_months BETWEEN 1 AND 12),
  first_due           DATE NOT NULL,
  status              TEXT NOT NULL DEFAULT 'issued'
                      CHECK (status IN ('issued', 'superseded')),
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (layer_id, version)
);

CREATE INDEX idx_mdp_layer ON mdp(layer_id);

-- One issued MDP per layer at a time.
CREATE UNIQUE INDEX idx_mdp_one_issued ON mdp(layer_id) WHERE status = 'issued';

-- Per-market, per-instalment debit notes generated from an MDP: the market's
-- signed share of each deposit instalment, with brokerage carved out.
CREATE TABLE mdp_debit_note (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mdp_id           UUID NOT NULL REFERENCES mdp(id) ON DELETE CASCADE,
  layer_id         UUID NOT NULL REFERENCES layer(id) ON DELETE CASCADE,
  market_id        UUID NOT NULL REFERENCES market(id),
  instalment_no    INTEGER NOT NULL CHECK (instalment_no >= 1),
  due_date         DATE NOT NULL,
  signed_pct       NUMERIC(7,4) NOT NULL,
  gross_amount     NUMERIC(18,2) NOT NULL,   -- market share of the instalment
  brokerage_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_amount       NUMERIC(18,2) NOT NULL,   -- gross - brokerage (remitted to market)
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'sent', 'paid')),
  sent_at          TIMESTAMPTZ,
  paid_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mdp_id, market_id, instalment_no)
);

CREATE INDEX idx_mdp_note_mdp ON mdp_debit_note(mdp_id);
CREATE INDEX idx_mdp_note_layer ON mdp_debit_note(layer_id);

-- A loss event on a (bound) placement, advised from the ground up at 100%.
CREATE TABLE loss_event (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id UUID NOT NULL REFERENCES placement(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  loss_date    DATE NOT NULL,
  cat_event    BOOLEAN NOT NULL DEFAULT FALSE,
  description  TEXT,
  gross_loss   NUMERIC(18,2) NOT NULL CHECK (gross_loss >= 0),
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'advised', 'settled')),
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_loss_event_placement ON loss_event(placement_id);

-- Computed recovery of a loss event against one layer: loss to the layer,
-- reinstatement premium (both at 100%) and the per-market breakdown by
-- signed line, snapshotted at calculation time.
CREATE TABLE loss_recovery (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loss_event_id         UUID NOT NULL REFERENCES loss_event(id) ON DELETE CASCADE,
  layer_id              UUID NOT NULL REFERENCES layer(id) ON DELETE CASCADE,
  loss_to_layer         NUMERIC(18,2) NOT NULL,
  reinstatement_premium NUMERIC(18,2) NOT NULL DEFAULT 0,
  detail                JSONB NOT NULL DEFAULT '{}'::jsonb,  -- per-market shares + calc context
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (loss_event_id, layer_id)
);

CREATE INDEX idx_loss_recovery_layer ON loss_recovery(layer_id);
