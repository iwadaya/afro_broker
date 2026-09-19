-- Bordereaux (premium + claims) and the versioned Renewal Pack.

CREATE TABLE bordereau (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id UUID NOT NULL REFERENCES placement(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('premium','claims')),
  source_file  TEXT,
  period_start DATE,
  period_end   DATE,
  parsed_rows  JSONB NOT NULL DEFAULT '[]'::jsonb,
  row_count    INTEGER NOT NULL DEFAULT 0,
  summary      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- totals: premium, paid, outstanding, incurred
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bordereau_placement ON bordereau(placement_id);

CREATE TABLE renewal_pack (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id  UUID NOT NULL REFERENCES placement(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  snapshot      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- structure + loss summary + exposure + technical view
  generated_doc TEXT,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  created_by    UUID REFERENCES users(id),
  approved_by   UUID REFERENCES users(id),
  approved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (placement_id, version)
);

CREATE INDEX idx_pack_placement ON renewal_pack(placement_id);
