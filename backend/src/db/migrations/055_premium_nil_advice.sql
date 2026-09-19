-- A final adjustment that moves no premium still tells every reinsurer so:
-- a numbered nil-adjustment advice, stored and delivered exactly like a
-- note, carrying no amount and nothing to settle.
ALTER TABLE premium_note DROP CONSTRAINT premium_note_kind_check;
ALTER TABLE premium_note ADD CONSTRAINT premium_note_kind_check
  CHECK (kind IN ('debit','credit','advice'));
ALTER TABLE premium_note DROP CONSTRAINT premium_note_check;
ALTER TABLE premium_note ADD CONSTRAINT premium_note_check
  CHECK ((kind='debit' AND gross_amount>0) OR (kind='credit' AND gross_amount<0)
      OR (kind='advice' AND gross_amount=0 AND brokerage_amount=0 AND net_amount=0));
