-- Renewal pack approval by a Senior Broker.
--
-- Once a renewal pack is created it goes for approval: the broker submits
-- the version, a Senior Broker (a new role — everything a broker can do,
-- plus this) checks it and approves it or returns it with a note. Only an
-- approved version unlocks the Negotiation tab and can go to market.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('broker', 'senior_broker', 'underwriter', 'admin'));

ALTER TABLE renewal_pack DROP CONSTRAINT IF EXISTS renewal_pack_status_check;
ALTER TABLE renewal_pack
  ADD CONSTRAINT renewal_pack_status_check
  CHECK (status IN ('draft', 'submitted', 'approved'));

ALTER TABLE renewal_pack
  ADD COLUMN submitted_by   UUID REFERENCES users(id),
  ADD COLUMN submitted_at   TIMESTAMPTZ,
  ADD COLUMN rejected_by    UUID REFERENCES users(id),
  ADD COLUMN rejected_at    TIMESTAMPTZ,
  ADD COLUMN rejection_note TEXT;

COMMENT ON COLUMN renewal_pack.status IS
  'draft → submitted (for Senior Broker approval) → approved; a return goes back to draft with rejection_note.';
