-- Market intelligence — what the desk knows about a market, by country and
-- by region of the reference country list, from three sources: the brief the
-- AI gathers from the internet (market dynamics, the cedants, regulatory
-- change, dated developments), the brokers' own market visits with what each
-- one cost, and the notes they keep on a cedant, a country or a region —
-- which the next gather folds in.

-- ---- The brief: one current brief per scope, replaced on each gather ----
CREATE TABLE market_intel_brief (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type      TEXT NOT NULL CHECK (scope_type IN ('country', 'region')),
  scope_key       TEXT NOT NULL,   -- the country code ('GB') or the region ('Europe')
  scope_label     TEXT NOT NULL,   -- the country's or region's name as shown
  headline        TEXT,            -- the market in a paragraph
  market_dynamics JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ topic, detail }]
  cedants         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ name, overview, reinsurance, url }]
  regulatory      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ headline, summary, regulator, effective_date, url }]
  developments    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ headline, summary, url, published_at }]
  opportunities   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ title, rationale }]
  from_the_desk   TEXT,            -- what the brokers' own notes and visits added
  citations       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ title, url }]
  notes_used      INTEGER NOT NULL DEFAULT 0,  -- desk notes folded into the gather
  visits_used     INTEGER NOT NULL DEFAULT 0,  -- market visits folded into the gather
  provider        TEXT,
  model           TEXT,
  gathered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  gathered_by     UUID REFERENCES users(id),
  -- Unverified until a person has checked it against the sources.
  verified        BOOLEAN NOT NULL DEFAULT FALSE,
  verified_by     UUID REFERENCES users(id),
  verified_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_key)
);

-- ---- Market visits: a broker's trip, what it cost, and whom they met ----
CREATE TABLE market_visit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),  -- the broker who travelled
  country_code  TEXT NOT NULL,
  country_name  TEXT NOT NULL,
  region        TEXT,               -- the country's region on the reference list
  city          TEXT,
  purpose       TEXT,
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL CHECK (end_date >= start_date),
  cost_amount   NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (cost_amount >= 0),
  cost_currency TEXT NOT NULL DEFAULT 'USD',
  notes         TEXT,               -- the trip report
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_market_visit_country ON market_visit(country_code, start_date DESC);
CREATE INDEX idx_market_visit_region ON market_visit(region, start_date DESC);
CREATE INDEX idx_market_visit_user ON market_visit(user_id, start_date DESC);

-- The cedants met on the trip: the accounts a visit's return is read from.
CREATE TABLE market_visit_cedant (
  visit_id  UUID NOT NULL REFERENCES market_visit(id) ON DELETE CASCADE,
  cedant_id UUID NOT NULL REFERENCES cedant(id) ON DELETE CASCADE,
  PRIMARY KEY (visit_id, cedant_id)
);

-- ---- Notes: on a cedant, a country or a region; on a visit or on their own ----
CREATE TABLE market_note (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  -- A trip's notes go with the trip.
  visit_id        UUID REFERENCES market_visit(id) ON DELETE CASCADE,
  level           TEXT NOT NULL CHECK (level IN ('cedant', 'country', 'region')),
  cedant_id       UUID REFERENCES cedant(id) ON DELETE CASCADE,
  -- A cedant note carries its cedant's country and region, a country note
  -- its region, so every note rolls up into the scopes above it.
  country_code    TEXT,
  country_name    TEXT,
  region          TEXT,
  noted_on        DATE NOT NULL DEFAULT CURRENT_DATE,  -- when the observation was made
  title           TEXT,
  body            TEXT NOT NULL,
  attachment_name TEXT,   -- the uploaded file the body was read from, if any
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((level = 'cedant' AND cedant_id IS NOT NULL)
      OR (level = 'country' AND country_code IS NOT NULL)
      OR (level = 'region' AND region IS NOT NULL))
);
CREATE INDEX idx_market_note_cedant ON market_note(cedant_id, noted_on DESC);
CREATE INDEX idx_market_note_country ON market_note(country_code, noted_on DESC);
CREATE INDEX idx_market_note_region ON market_note(region, noted_on DESC);
CREATE INDEX idx_market_note_visit ON market_note(visit_id);
