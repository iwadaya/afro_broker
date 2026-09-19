-- The renewal desk's market submission.
--
-- An uploaded pack goes to market from its verified summary rather than from
-- a built renewal pack: the covering email is drafted from the summary, the
-- attachments are the cedant's own pack and the broker-verified summary, and
-- the submission is otherwise the same object — same recipients, same
-- four-eyes release, same register, same audit trail, same inbox for the
-- replies. So negotiation_submission learns a second source: pack_id becomes
-- optional and analysis_id names the uploaded pack instead. One of the two is
-- always set.
--
-- RESTRICT on the analysis: a submission that has gone to market is the record
-- of what went, and outlives the desk's wish to tidy up — the delete route
-- says so rather than failing on the constraint.
--
-- response_deadline is the date the email asks for terms by; a reminder goes
-- to every underwriter who has not replied three days before it, once —
-- reminded_at on the recipient is what makes it once.

ALTER TABLE negotiation_submission
  ALTER COLUMN pack_id DROP NOT NULL,
  ADD COLUMN analysis_id UUID REFERENCES renewal_pack_analysis(id) ON DELETE RESTRICT,
  ADD COLUMN response_deadline DATE,
  ADD CONSTRAINT negotiation_submission_source
    CHECK (pack_id IS NOT NULL OR analysis_id IS NOT NULL);

CREATE INDEX idx_negotiation_submission_analysis ON negotiation_submission(analysis_id);

ALTER TABLE negotiation_submission_recipient
  ADD COLUMN reminded_at TIMESTAMPTZ;
