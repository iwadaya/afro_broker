-- The Quoting Stage: every market approached is a lead market, and a quote is
-- a lead quote or an indication.
--
-- 1. The pack goes out for lead quotes, so a reinsurer on the board carries no
--    lead / follow choice any more: the role defaults to lead, and the rows
--    already there read the same way. The column stays — the portfolio and
--    the final placement read the lead approaches through it — but nothing
--    at the Quoting Stage sets or shows it.
-- 2. What a reinsurer gives back on a structure is either a lead quote —
--    terms the placement can be built on — or an indication, a steer that
--    must not be mistaken for one. The kind is kept on every quoted line, and
--    the screens toggle it per structure.

ALTER TABLE negotiation ALTER COLUMN role SET DEFAULT 'lead';
UPDATE negotiation SET role = 'lead' WHERE role <> 'lead';

ALTER TABLE negotiation_submission_recipient ALTER COLUMN role SET DEFAULT 'lead';
UPDATE negotiation_submission_recipient SET role = 'lead' WHERE role <> 'lead';

ALTER TABLE negotiation_quote
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'lead' CHECK (kind IN ('lead', 'indicative'));

COMMENT ON COLUMN negotiation_quote.kind IS
  'lead: a lead quote the placement can be built on; indicative: an indication only, kept apart from the lead quotes.';
