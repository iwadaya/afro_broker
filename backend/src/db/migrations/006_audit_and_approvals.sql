-- Audit trail and four-eyes approval requests.

CREATE TABLE audit_event (
  id          BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  action      TEXT NOT NULL,
  user_id     UUID REFERENCES users(id),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_entity ON audit_event(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_event(created_at);

-- Four-eyes: a sensitive action (FOT authorise, bind) is proposed by one user
-- and must be approved by a different user with sufficient authority.
CREATE TABLE approval (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type TEXT NOT NULL CHECK (action_type IN ('fot_authorise','bind')),
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','rejected')),
  proposed_by UUID NOT NULL REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  -- approver must differ from proposer
  CHECK (approved_by IS NULL OR approved_by <> proposed_by)
);

CREATE INDEX idx_approval_entity ON approval(entity_type, entity_id);
CREATE INDEX idx_approval_status ON approval(status);

-- Only one pending approval per (action, entity) at a time.
CREATE UNIQUE INDEX idx_approval_one_pending
  ON approval(action_type, entity_type, entity_id) WHERE status = 'pending';
