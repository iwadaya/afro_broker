-- 003: AABI broking — enums, the core contract table, UMR history and classes.
-- Source: design system project/data-model.md ("Two identifiers, two jobs", "Core table").
--
-- Deviations from data-model.md, both deliberate (see docs/broking/CHANGELOG.md):
--   * org_id — the contract belongs to the broking house of the user who created it;
--     every API read/write is scoped to it (no IDOR across organisations).
--   * The header columns (country, cedant, broker, currency, treaty type, uw_year,
--     inception_date) are NULLABLE while status = 'DRAFT': the Identify step inserts
--     the row with only the UMR and business type. bk_contract_header_complete then
--     guarantees that no contract can leave DRAFT without them.

DO $$ BEGIN
  CREATE TYPE public.bk_business_type AS ENUM ('PROPORTIONAL', 'NON_PROPORTIONAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.bk_contract_status AS ENUM
    ('DRAFT', 'SUBMITTED', 'QUOTED', 'FIRM_ORDER', 'BOUND', 'SIGNED', 'NTU', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.bk_commission_mode AS ENUM ('FIXED', 'SLIDING');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.bk_contract (
  contract_id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  umr                          varchar(17) NOT NULL,
  business_type                public.bk_business_type NOT NULL,
  org_id                       uuid NOT NULL REFERENCES public.bk_org(org_id),
  parent_contract_id           uuid REFERENCES public.bk_contract(contract_id),   -- prior year (renewal)
  alt_contract_id              text,                                               -- cedant / Universe reference
  country_id                   uuid REFERENCES public.country(country_id),
  cedant_id                    uuid REFERENCES public.companies(company_id),
  broker_id                    uuid REFERENCES public.brokers(broker_id),
  currency_id                  uuid REFERENCES public.currency(currency_id),
  treaty_type_id               uuid REFERENCES public.treaty_type(treaty_type_id),
  primary_class_of_business_id uuid REFERENCES public.class_of_business(class_of_business_id),
  uw_year                      int  CHECK (uw_year BETWEEN 1900 AND 2200),
  inception_date               date,
  renewal_date                 date,
  experience_start_year        int  CHECK (experience_start_year BETWEEN 1900 AND 2200),
  contract_description         text,                                               -- generated, see Capture flow
  status                       public.bk_contract_status NOT NULL DEFAULT 'DRAFT',
  row_version                  int  NOT NULL DEFAULT 1,                            -- optimistic locking
  created_by_user_id           uuid NOT NULL REFERENCES public.uw_user(user_id),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bk_contract_umr_format CHECK (umr ~ '^B[0-9]{4}[A-Z0-9]{1,12}$'),
  CONSTRAINT bk_contract_umr_unique UNIQUE (umr),
  CONSTRAINT bk_contract_dates CHECK (renewal_date IS NULL OR renewal_date > inception_date),
  CONSTRAINT bk_contract_header_complete CHECK (
    status = 'DRAFT' OR (
      country_id IS NOT NULL AND cedant_id IS NOT NULL AND broker_id IS NOT NULL AND
      currency_id IS NOT NULL AND treaty_type_id IS NOT NULL AND uw_year IS NOT NULL AND
      inception_date IS NOT NULL
    )
  )
);
CREATE INDEX IF NOT EXISTS bk_contract_cedant_year ON public.bk_contract (cedant_id, uw_year);
CREATE INDEX IF NOT EXISTS bk_contract_org_updated ON public.bk_contract (org_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS bk_contract_umr_prefix ON public.bk_contract (umr varchar_pattern_ops);

DROP TRIGGER IF EXISTS trg_bk_contract_updated ON public.bk_contract;
CREATE TRIGGER trg_bk_contract_updated BEFORE UPDATE ON public.bk_contract
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.bk_umr_history (
  contract_id  uuid NOT NULL REFERENCES public.bk_contract(contract_id) ON DELETE CASCADE,
  old_umr      varchar(17) NOT NULL,
  new_umr      varchar(17) NOT NULL,
  changed_by   uuid NOT NULL REFERENCES public.uw_user(user_id),
  changed_at   timestamptz NOT NULL DEFAULT now(),
  reason       text NOT NULL
);
CREATE INDEX IF NOT EXISTS bk_umr_history_contract ON public.bk_umr_history (contract_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS public.bk_contract_class_of_business (
  contract_id           uuid REFERENCES public.bk_contract(contract_id) ON DELETE CASCADE,
  class_of_business_id  uuid NOT NULL REFERENCES public.class_of_business(class_of_business_id),
  sort_order            int  NOT NULL DEFAULT 0,                                   -- 0 = primary
  PRIMARY KEY (contract_id, class_of_business_id)
);
