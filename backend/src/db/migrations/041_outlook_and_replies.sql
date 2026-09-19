-- The pack goes to market from a connected Outlook mailbox, and the replies
-- come back into the negotiation.
--
-- mail_account holds the one mailbox the submissions are sent from and read
-- into (the broker's Outlook, connected once through Microsoft's sign-in;
-- tokens are refreshed as they expire). Every recipient of a sent submission
-- carries the message and conversation ids the send produced, so a reply can
-- be tied back to the underwriter it came from. negotiation_reply is each
-- reply — read from the inbox, or logged by hand — with the AI's reading of
-- it: what kind of answer it is, the terms it carries, the questions it asks.

CREATE TABLE mail_account (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        TEXT NOT NULL DEFAULT 'outlook' CHECK (provider IN ('outlook')),
  address         TEXT NOT NULL,
  display_name    TEXT,
  access_token    TEXT NOT NULL,
  refresh_token   TEXT,
  expires_at      TIMESTAMPTZ,
  scopes          TEXT,
  connected_by    UUID REFERENCES users(id),
  connected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_cursor     TIMESTAMPTZ,          -- newest receivedDateTime read so far
  last_sync_at    TIMESTAMPTZ,
  last_sync_error TEXT
);

-- A short reference carried in the subject, so a reply that loses its
-- threading still finds its submission.
ALTER TABLE negotiation_submission ADD COLUMN reference_tag TEXT;
CREATE INDEX idx_negotiation_submission_tag ON negotiation_submission(reference_tag);

ALTER TABLE negotiation_submission_recipient
  ADD COLUMN internet_message_id TEXT,
  ADD COLUMN conversation_id     TEXT,
  ADD COLUMN reply_status        TEXT NOT NULL DEFAULT 'awaiting'
                                 CHECK (reply_status IN ('awaiting', 'replied')),
  ADD COLUMN reply_count         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN replied_at          TIMESTAMPTZ;

CREATE TABLE negotiation_reply (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id   UUID NOT NULL REFERENCES negotiation_submission(id) ON DELETE CASCADE,
  recipient_id    UUID REFERENCES negotiation_submission_recipient(id) ON DELETE SET NULL,
  placement_id    UUID NOT NULL REFERENCES placement(id) ON DELETE CASCADE,
  market_id       UUID REFERENCES market(id) ON DELETE SET NULL,
  from_email      TEXT NOT NULL,
  from_name       TEXT,
  subject         TEXT,
  body            TEXT NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  message_id      TEXT,                 -- the internet message id, when read from the inbox
  conversation_id TEXT,
  source          TEXT NOT NULL DEFAULT 'outlook' CHECK (source IN ('outlook', 'manual')),
  -- The AI's reading: kind, summary, terms, questions, deadline, next action.
  kind            TEXT NOT NULL DEFAULT 'unread'
                  CHECK (kind IN ('unread', 'quote', 'decline', 'question', 'acknowledgement', 'other')),
  ai_read         JSONB NOT NULL DEFAULT '{}'::jsonb,
  handled         BOOLEAN NOT NULL DEFAULT FALSE,
  handled_by      UUID REFERENCES users(id),
  handled_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_negotiation_reply_placement ON negotiation_reply(placement_id, received_at DESC);
CREATE INDEX idx_negotiation_reply_submission ON negotiation_reply(submission_id);
-- One row per inbox message, however many times the inbox is read.
CREATE UNIQUE INDEX uq_negotiation_reply_message ON negotiation_reply(message_id) WHERE message_id IS NOT NULL;
