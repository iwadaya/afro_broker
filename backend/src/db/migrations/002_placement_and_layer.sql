-- Placement (the object that moves through the market) and its Layers.

CREATE TABLE placement (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference   TEXT NOT NULL UNIQUE,
  cedant_id   UUID NOT NULL REFERENCES cedant(id),
  class       TEXT NOT NULL,
  inception   DATE NOT NULL,
  expiry      DATE NOT NULL,
  currency    TEXT NOT NULL,
  renewal_of  UUID REFERENCES placement(id),
  status      TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                'DRAFT','DATA','PACK','LEAD_MARKETING','QUOTED','FOT_AGREED',
                'FOLLOW_MARKETING','LINES_WRITTEN','SIGNED','BOUND',
                'DECLINED','NTU','LAPSED','INCOMPLETE')),
  notes       TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expiry > inception)
);

CREATE INDEX idx_placement_cedant ON placement(cedant_id);
CREATE INDEX idx_placement_status ON placement(status);
CREATE INDEX idx_placement_renewal ON placement(renewal_of);

CREATE TABLE layer (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id  UUID NOT NULL REFERENCES placement(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('QS','Surplus','XoL','Fac')),
  attachment    NUMERIC(18,2) NOT NULL DEFAULT 0,
  limit_amt     NUMERIC(18,2),
  section_pct   NUMERIC(7,4) NOT NULL DEFAULT 100 CHECK (section_pct >= 0 AND section_pct <= 100),
  order_pct     NUMERIC(7,4) NOT NULL DEFAULT 100 CHECK (order_pct >= 0 AND order_pct <= 100),
  premium100    NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (premium100 >= 0),
  currency      TEXT NOT NULL,
  technical_ref TEXT,            -- link to Universe modelled output
  status        TEXT NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN','FOT_AGREED','SIGNED','BOUND','CLOSED')),
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_layer_placement ON layer(placement_id);
