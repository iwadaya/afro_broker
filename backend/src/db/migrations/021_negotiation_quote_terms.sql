-- A quote answers with the whole layer, not just its price.
--
-- An underwriter rarely accepts a layer exactly as it was sent: the rate moves,
-- the reinstatements change, an AAD appears, the cover narrows to risk only.
-- Every column of the structure is therefore quotable, and the terms as they
-- were sent are snapshotted on the quote so the two can always be read side by
-- side — the structure itself may be edited long after the quote came in, and
-- the comparison must still show what the underwriter was actually answering.

ALTER TABLE negotiation_quote
  -- Who at the reinsurer gave these terms.
  ADD COLUMN contact_id        UUID REFERENCES market_contact(id) ON DELETE SET NULL,
  -- The quoted layer, column for column with the structure it answers.
  ADD COLUMN layer_name        TEXT,
  ADD COLUMN layer_type        TEXT,
  ADD COLUMN limit_amt         NUMERIC(18,2),
  ADD COLUMN attachment        NUMERIC(18,2),
  ADD COLUMN reinstatements    TEXT,
  ADD COLUMN reinstatement_pct NUMERIC(7,4),
  ADD COLUMN egnpi             NUMERIC(18,2),
  ADD COLUMN aad               NUMERIC(18,2),
  ADD COLUMN order_pct         NUMERIC(7,4) CHECK (order_pct IS NULL OR (order_pct >= 0 AND order_pct <= 100)),
  ADD COLUMN risk_cover        BOOLEAN,
  ADD COLUMN cat_cover         BOOLEAN,
  -- The line's terms as they were sent, at the moment this quote was captured.
  ADD COLUMN original          JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX idx_negotiation_quote_contact ON negotiation_quote(contact_id);
