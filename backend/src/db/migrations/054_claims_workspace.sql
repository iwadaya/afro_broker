-- Retained loss entering the NP programme, with an exact paid/reserve split.
ALTER TABLE loss_event ADD COLUMN workspace_claim BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE loss_event ADD CONSTRAINT retained_loss_split CHECK (
  NOT workspace_claim OR (paid IS NOT NULL AND outstanding IS NOT NULL
    AND paid >= 0 AND outstanding >= 0 AND paid + outstanding = gross_loss)
);
CREATE TABLE claim_workflow (
  loss_event_id UUID PRIMARY KEY REFERENCES loss_event(id) ON DELETE CASCADE,
  input JSONB NOT NULL,
  snapshot JSONB NOT NULL,
  source_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved')),
  created_by UUID NOT NULL REFERENCES users(id),
  reviewer_id UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  return_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reviewer_id IS NULL OR reviewer_id <> created_by),
  CHECK (approved_by IS NULL OR approved_by <> created_by),
  CHECK (status <> 'submitted' OR reviewer_id IS NOT NULL),
  CHECK (status <> 'approved' OR approved_by IS NOT NULL)
);
CREATE INDEX idx_claim_workflow_review ON claim_workflow(reviewer_id,status);
CREATE TABLE claim_workflow_revision (
  loss_event_id UUID NOT NULL REFERENCES claim_workflow(loss_event_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  input JSONB NOT NULL,
  snapshot JSONB NOT NULL,
  source_hash TEXT NOT NULL,
  prepared_by UUID NOT NULL REFERENCES users(id),
  approved_by UUID NOT NULL REFERENCES users(id),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(loss_event_id,revision),
  CHECK (prepared_by <> approved_by)
);
