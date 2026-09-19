-- Special acceptances and endorsements: mid-term contract requests/changes
-- raised on a placement that markets must agree; tracked to resolution.

CREATE TABLE amendment (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id   UUID NOT NULL REFERENCES placement(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('special_acceptance','endorsement')),
  title          TEXT NOT NULL,
  detail         TEXT,
  effective_date DATE,
  status         TEXT NOT NULL DEFAULT 'outstanding'
                 CHECK (status IN ('outstanding','agreed','declined','withdrawn')),
  created_by     UUID NOT NULL REFERENCES users(id),
  resolved_by    UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ
);

CREATE INDEX idx_amendment_placement ON amendment(placement_id);
CREATE INDEX idx_amendment_status ON amendment(status);
