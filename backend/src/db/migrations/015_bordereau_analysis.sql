-- AI analysis of a placement's bordereaux. The computed figures are stored
-- alongside the narrative so a saved analysis can be read back exactly as it
-- was produced, including which provider and model wrote it.

CREATE TABLE bordereau_analysis (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id  UUID NOT NULL REFERENCES placement(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,          -- 'anthropic' | 'openai'
  model         TEXT NOT NULL,
  aggregates    JSONB NOT NULL,
  narrative     JSONB NOT NULL,
  sources       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- bordereaux it was built from
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bordereau_analysis_placement_idx
  ON bordereau_analysis (placement_id, created_at DESC);
