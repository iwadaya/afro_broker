-- 001: Universe reference tables, reused unchanged by the AABI broking module.
-- Column names, is_active soft-delete flag and the partial natural-key unique
-- indexes follow Universe migrations 000/005/027/029/141/150 so the lookup
-- routes and the bk_* foreign keys are identical in both codebases.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS public.country (
  country_id   uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  country_code text NOT NULL,
  country_name text NOT NULL,
  region       text,
  is_active    boolean DEFAULT true,
  created_at   timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_country_code_active ON public.country (country_code) WHERE is_active IS NOT FALSE;

CREATE TABLE IF NOT EXISTS public.currency (
  currency_id   uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  currency_code text NOT NULL,
  currency_name text,
  is_active     boolean DEFAULT true,
  created_at    timestamptz DEFAULT now(),
  CONSTRAINT currency_code_unique UNIQUE (currency_code)
);

CREATE TABLE IF NOT EXISTS public.brokers (
  broker_id   uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  broker_name text NOT NULL,
  is_active   boolean DEFAULT true,
  created_at  timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_brokers_name_active ON public.brokers (broker_name) WHERE is_active IS NOT FALSE;

-- Cedants live in `companies` (Universe naming).
CREATE TABLE IF NOT EXISTS public.companies (
  company_id   uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_name text NOT NULL,
  country_id   uuid REFERENCES public.country(country_id),
  company_type text DEFAULT 'CEDANT',
  is_active    boolean DEFAULT true,
  created_at   timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_name_active ON public.companies (company_name) WHERE is_active IS NOT FALSE;

CREATE TABLE IF NOT EXISTS public.treaty_type (
  treaty_type_id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  treaty_type    text NOT NULL,
  category       text DEFAULT 'PROPORTIONAL' CHECK (category IN ('PROPORTIONAL','NON_PROPORTIONAL')),
  is_active      boolean DEFAULT true,
  created_at     timestamptz DEFAULT now(),
  CONSTRAINT treaty_type_unique UNIQUE (treaty_type)
);

CREATE TABLE IF NOT EXISTS public.class_of_business (
  class_of_business_id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  class_of_business    text NOT NULL,
  code                 text,
  is_active            boolean DEFAULT true,
  created_at           timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_class_of_business_name_active ON public.class_of_business (class_of_business) WHERE is_active IS NOT FALSE;

-- The 11 canonical treaty types (Universe migration 029). Names are load-bearing:
-- shared/broking/calcs.js derives the treaty mode / peril mode from them.
INSERT INTO public.treaty_type (treaty_type, category) VALUES
  ('Quota Share',           'PROPORTIONAL'),
  ('Quota Share & Surplus', 'PROPORTIONAL'),
  ('First Surplus',         'PROPORTIONAL'),
  ('Second Surplus',        'PROPORTIONAL'),
  ('Third Surplus',         'PROPORTIONAL'),
  ('Fac Oblig',             'PROPORTIONAL'),
  ('Risk XL',               'NON_PROPORTIONAL'),
  ('CAT XL',                'NON_PROPORTIONAL'),
  ('Risk & CAT XL',         'NON_PROPORTIONAL'),
  ('Stop Loss',             'NON_PROPORTIONAL'),
  ('Aggregate XL',          'NON_PROPORTIONAL')
ON CONFLICT (treaty_type) DO NOTHING;
