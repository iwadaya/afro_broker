-- Claims intake and settlement on the renewal desk.
--
-- A loss advice arrives in a watched mailbox; it is read, matched to the
-- contract it concerns — on the treaty reference, then on cedant, class and
-- period, then on the insured schedule — and held for the broker to load or
-- park. Loading creates the loss event, runs the calculation, and issues the
-- preliminary loss advice to every market with a signed line on any layer:
-- a panel-wide reserve advice, no payment requested.
--
-- The loss event gains the settlement ladder's inputs — expenses, salvage,
-- cash already funded, the reinstatement waiver — and the cedant's own
-- particulars; claim_advice records each advice issued, with the 100%
-- breakdown as sent and every recipient's share and outcome.

ALTER TABLE loss_event
  ADD COLUMN reference TEXT,
  ADD COLUMN insured TEXT,
  ADD COLUMN cause TEXT,
  ADD COLUMN paid NUMERIC(18,2),
  ADD COLUMN outstanding NUMERIC(18,2),
  ADD COLUMN lae NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (lae >= 0),
  ADD COLUMN salvage NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (salvage >= 0),
  ADD COLUMN cash_funded NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (cash_funded >= 0),
  ADD COLUMN waive_reinstatement BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN settlement JSONB;

CREATE TABLE claim_notification (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source           TEXT NOT NULL,                 -- the mailbox or channel it came from
  message_id       TEXT,                          -- the message it was, for dedupe
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  subject          TEXT,
  sender           TEXT,
  raw_body         TEXT NOT NULL,
  parsed           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- insured, date of loss, reserve, references…
  placement_id     UUID REFERENCES placement(id) ON DELETE SET NULL,
  match_basis      TEXT,                          -- what the match rested on
  match_confidence NUMERIC(4,3),
  status           TEXT NOT NULL DEFAULT 'unmatched'
                   CHECK (status IN ('unmatched', 'matched', 'loaded', 'parked')),
  loss_event_id    UUID REFERENCES loss_event(id) ON DELETE SET NULL,
  notes            TEXT,
  loaded_by        UUID REFERENCES users(id),
  loaded_at        TIMESTAMPTZ,
  parked_by        UUID REFERENCES users(id),
  parked_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_claim_notification_message ON claim_notification(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_claim_notification_placement ON claim_notification(placement_id);

CREATE TABLE claim_advice (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loss_event_id   UUID NOT NULL REFERENCES loss_event(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('preliminary', 'claim')),
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  breakdown       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- the 100% ladder as sent
  -- [{market_id, market_name, email, name, status, message_id, error, share}]
  recipients      JSONB NOT NULL DEFAULT '[]'::jsonb,
  delivered       INTEGER NOT NULL DEFAULT 0,
  notification_id UUID REFERENCES claim_notification(id) ON DELETE SET NULL,
  sent_by         UUID REFERENCES users(id),
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_claim_advice_event ON claim_advice(loss_event_id);
