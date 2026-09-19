-- §2.2 — the audit log records before AND after.
-- D7 — four-eyes gets its mandatory break-glass override.

-- ---------------------------------------------------------------------------
-- §2.2: "Record actor, timestamp, before, after."
-- ---------------------------------------------------------------------------
-- `detail` stays, so every existing audit() call site keeps working untouched.
-- New call sites pass the pair. KYC status and security ratings are the fields
-- §2.2 singles out — the ones people later need to prove the state of — and an
-- after-only log cannot answer "what was it before?".
ALTER TABLE audit_event
  ADD COLUMN before_state JSONB,
  ADD COLUMN after_state  JSONB;

COMMENT ON COLUMN audit_event.before_state IS
  'Entity state prior to the write; NULL on create.';
COMMENT ON COLUMN audit_event.after_state IS
  'Entity state after the write; NULL on delete.';

-- "Append-only" as a property of the table rather than a convention.
CREATE OR REPLACE FUNCTION audit_event_is_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_event_append_only ON audit_event;
CREATE TRIGGER trg_audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();

-- ---------------------------------------------------------------------------
-- D7 — break-glass.
-- ---------------------------------------------------------------------------
-- "Not because it should be used, but because a control with no legitimate
-- escape hatch at 11pm on 31 December gets bypassed with a shared login — and
-- then you have neither the control nor the audit trail."
ALTER TABLE approval DROP CONSTRAINT IF EXISTS approval_status_check;
ALTER TABLE approval ADD CONSTRAINT approval_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'overridden'));

ALTER TABLE approval
  ADD COLUMN overridden_by   UUID REFERENCES users(id),
  ADD COLUMN overridden_at   TIMESTAMPTZ,
  ADD COLUMN override_reason TEXT;

-- An override without a stated reason is not reportable, and an unreportable
-- override is not a control.
ALTER TABLE approval ADD CONSTRAINT approval_override_complete CHECK (
  status <> 'overridden'
  OR (overridden_by IS NOT NULL
      AND overridden_at IS NOT NULL
      AND override_reason IS NOT NULL
      AND length(btrim(override_reason)) >= 10)
);

ALTER TABLE approval ADD CONSTRAINT approval_approver_present
  CHECK (status <> 'approved' OR approved_by IS NOT NULL);

CREATE INDEX idx_approval_overridden
  ON approval(overridden_at) WHERE status = 'overridden';
