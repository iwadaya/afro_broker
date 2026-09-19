-- The counterparty register: reinsurers, insurers and brokers, each with
-- compliance (KYC + security rating) and a group profile (market position,
-- latest news, five-year financials) that is either keyed in by the broker or
-- gathered from the internet by the market-intel integration.

-- ---- Market becomes the counterparty register ----
ALTER TABLE market
  ADD COLUMN type TEXT NOT NULL DEFAULT 'reinsurer'
              CHECK (type IN ('reinsurer', 'insurer', 'broker')),
  ADD COLUMN group_name      TEXT,
  ADD COLUMN region          TEXT,
  ADD COLUMN website         TEXT,
  -- `domicile` (migration 001) is the country of domicile and stays the
  -- country field; `region` groups countries into placement territories.
  ADD COLUMN rating_agency   TEXT,
  ADD COLUMN rating_outlook  TEXT
              CHECK (rating_outlook IS NULL
                     OR rating_outlook IN ('positive', 'stable', 'negative', 'developing')),
  ADD COLUMN rating_as_of    DATE,
  ADD COLUMN kyc_status      TEXT NOT NULL DEFAULT 'not_started'
              CHECK (kyc_status IN ('not_started', 'in_progress', 'approved', 'expired', 'rejected')),
  ADD COLUMN kyc_reviewed_at DATE,
  ADD COLUMN kyc_expires_at  DATE,
  ADD COLUMN kyc_reviewed_by UUID REFERENCES users(id),
  ADD COLUMN kyc_notes       TEXT,
  ADD COLUMN updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();

-- Uniqueness is per counterparty type: the same group may appear once as an
-- insurer (cedant side) and once as a reinsurer (capacity side).
ALTER TABLE market DROP CONSTRAINT IF EXISTS market_name_domicile_key;
ALTER TABLE market ADD CONSTRAINT market_type_name_domicile_key
  UNIQUE (type, name, domicile);

CREATE INDEX idx_market_type ON market(type);
CREATE INDEX idx_market_region ON market(region);
CREATE INDEX idx_market_domicile ON market(domicile);

-- ---- Group profile: one row per counterparty ----
CREATE TABLE market_profile (
  market_id       UUID PRIMARY KEY REFERENCES market(id) ON DELETE CASCADE,
  overview        TEXT,          -- what the group is
  market_position TEXT,          -- where it sits in the market
  strategy        TEXT,          -- appetite / direction of travel
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai')),
  -- Citations backing an AI-gathered profile: [{ title, url }].
  citations       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 'unverified' until a human signs the AI-gathered content off.
  verified        BOOLEAN NOT NULL DEFAULT FALSE,
  verified_by     UUID REFERENCES users(id),
  verified_at     TIMESTAMPTZ,
  gathered_at     TIMESTAMPTZ,   -- when the AI gather ran
  updated_by      UUID REFERENCES users(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Latest news ----
CREATE TABLE market_news (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id    UUID NOT NULL REFERENCES market(id) ON DELETE CASCADE,
  headline     TEXT NOT NULL,
  summary      TEXT,
  url          TEXT,
  published_at DATE,
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai')),
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_market_news_market ON market_news(market_id, published_at DESC NULLS LAST);

-- ---- Five-year financials (one row per financial year) ----
CREATE TABLE market_financial (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id           UUID NOT NULL REFERENCES market(id) ON DELETE CASCADE,
  year                INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2200),
  currency            TEXT NOT NULL DEFAULT 'USD',
  gwp                 NUMERIC(18,2),   -- gross written premium
  nwp                 NUMERIC(18,2),   -- net written premium
  net_income          NUMERIC(18,2),
  shareholders_equity NUMERIC(18,2),
  total_assets        NUMERIC(18,2),
  loss_ratio          NUMERIC(7,3),    -- percentage points
  expense_ratio       NUMERIC(7,3),
  combined_ratio      NUMERIC(7,3),
  roe                 NUMERIC(7,3),
  note                TEXT,
  source              TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai')),
  updated_by          UUID REFERENCES users(id),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (market_id, year)
);

CREATE INDEX idx_market_financial_market ON market_financial(market_id, year DESC);

-- ---- Cedants are the insurer side of the same register ----
-- A cedant is an insurer we place business *for*; the register entry carries
-- its compliance and group profile, so link the two rather than duplicating.
ALTER TABLE cedant ADD COLUMN market_id UUID REFERENCES market(id);

INSERT INTO market (name, domicile, type, security_status)
SELECT c.name, c.domicile, 'insurer', 'approved' FROM cedant c
ON CONFLICT (type, name, domicile) DO NOTHING;

UPDATE cedant c SET market_id = (
  SELECT m.id FROM market m
  WHERE m.type = 'insurer'
    AND m.name = c.name
    AND m.domicile IS NOT DISTINCT FROM c.domicile
  ORDER BY m.created_at
  LIMIT 1
)
WHERE c.market_id IS NULL;

CREATE INDEX idx_cedant_market ON cedant(market_id);
