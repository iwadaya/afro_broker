-- Confirmed header→canonical-field mappings from past bordereau imports.
-- These are the training set for the supervised side of the ML column
-- mapper: every import a broker confirms teaches the classifier.
CREATE TABLE mapping_example (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bdx_type TEXT NOT NULL CHECK (bdx_type IN ('premium', 'claims')),
  header TEXT NOT NULL,
  field TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mapping_example_uniq
  ON mapping_example (bdx_type, lower(header), field);
