-- The courtesy note to a market that declined joins the final placement's
-- emails: the placement is complete, their answer is on the record, and the
-- door is open for next year. Sent through the same path as the firm order
-- terms and the confirmations, recorded the same way.

ALTER TABLE final_placement_email DROP CONSTRAINT final_placement_email_kind_check;
ALTER TABLE final_placement_email
  ADD CONSTRAINT final_placement_email_kind_check CHECK (kind IN ('fot', 'confirmation', 'declinature'));
