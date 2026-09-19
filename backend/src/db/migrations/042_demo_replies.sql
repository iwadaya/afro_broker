-- Demo replies: the AI playing the underwriters, recorded as replies so the
-- negotiation can be demonstrated with no mailbox connected.
ALTER TABLE negotiation_reply DROP CONSTRAINT IF EXISTS negotiation_reply_source_check;
ALTER TABLE negotiation_reply
  ADD CONSTRAINT negotiation_reply_source_check CHECK (source IN ('outlook', 'manual', 'demo'));
