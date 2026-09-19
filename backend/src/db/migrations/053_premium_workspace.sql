-- Non-proportional premium accounting. Financial approval and delivery are
-- separate: a transport outage cannot undo an approved, numbered note.
CREATE TABLE premium_workflow (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id UUID NOT NULL REFERENCES placement(id),
  kind TEXT NOT NULL CHECK (kind IN ('mdp','adjustment')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','issued')),
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  snapshot JSONB,
  source_hash TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  reviewer_id UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  return_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (placement_id,kind),
  CHECK (reviewer_id IS NULL OR reviewer_id <> created_by),
  CHECK (approved_by IS NULL OR approved_by <> created_by),
  CHECK (status <> 'submitted' OR (reviewer_id IS NOT NULL AND snapshot IS NOT NULL)),
  CHECK (status <> 'issued' OR (approved_by IS NOT NULL AND snapshot IS NOT NULL))
);
CREATE INDEX idx_premium_workflow_review ON premium_workflow(reviewer_id,status);
CREATE SEQUENCE premium_note_number;
CREATE TABLE premium_note (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES premium_workflow(id),
  note_number TEXT NOT NULL UNIQUE,
  layer_key TEXT NOT NULL,
  market_id UUID NOT NULL REFERENCES market(id),
  kind TEXT NOT NULL CHECK (kind IN ('debit','credit')),
  currency TEXT NOT NULL,
  instalment_no INTEGER NOT NULL,
  due_date DATE NOT NULL,
  gross_amount NUMERIC(18,2) NOT NULL,
  brokerage_amount NUMERIC(18,2) NOT NULL,
  net_amount NUMERIC(18,2) NOT NULL,
  detail JSONB NOT NULL,
  pdf BYTEA NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'queued'
    CHECK (delivery_status IN ('queued','sending','sent','failed','uncertain','simulated')),
  delivery_error TEXT,
  message_id TEXT,
  attempted_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workflow_id,layer_key,market_id,instalment_no),
  CHECK ((kind='debit' AND gross_amount>0) OR (kind='credit' AND gross_amount<0))
);
CREATE INDEX idx_premium_note_delivery ON premium_note(delivery_status);
