-- The Shares step under Contracts — the page after Documents on both
-- workflows: who takes what of the programme. The broker share (this desk,
-- and a co-broker where the order is split) and the reinsurer shares, each
-- with the written share — the line put down — and the signed share — what
-- it was signed down to — as percentages of the programme.

CREATE TABLE contract_share (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id  UUID NOT NULL REFERENCES placement(id) ON DELETE CASCADE,
  party         TEXT NOT NULL CHECK (party IN ('broker','reinsurer')),
  market_id     UUID REFERENCES market(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'follow' CHECK (role IN ('lead','follow')),
  written_pct   NUMERIC(9,4) CHECK (written_pct IS NULL OR (written_pct >= 0 AND written_pct <= 100)),
  signed_pct    NUMERIC(9,4) CHECK (signed_pct IS NULL OR (signed_pct >= 0 AND signed_pct <= 100)),
  reference     TEXT,
  note          TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contract_share_placement ON contract_share(placement_id, party, position);
