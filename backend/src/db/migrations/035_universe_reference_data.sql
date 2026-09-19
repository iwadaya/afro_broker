-- Reference data behind the Treaty Detail dropdowns, held exactly as the
-- Universe modelling tool holds it (modelling_tool server/src/db/migrations
-- 005_ref_data, 027_treaty_type_singular_alias, 045_country_region_mapping,
-- 141_ref_data_is_active, 150_reference_data_natural_keys): one table per
-- list with the tool's column names, its is_active soft-delete flag, its
-- natural-key uniques, and its canonical seed. The lookups API serves them
-- as the tool's lookups.js does; ensureReferenceData re-asserts the canonical
-- rows on every boot as the tool's startup does.
--
-- Supersedes the interim single-table ref_data of migration 034.

DROP TABLE IF EXISTS ref_data;

-- Country table
CREATE TABLE IF NOT EXISTS public.country (
  country_id   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  country_name TEXT NOT NULL,
  country_code TEXT,
  region       TEXT,
  is_active    BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- Currency table
CREATE TABLE IF NOT EXISTS public.currency (
  currency_id   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  currency_code TEXT NOT NULL,
  currency_name TEXT,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT currency_code_unique UNIQUE (currency_code)
);

-- Generic ref_list system
CREATE TABLE IF NOT EXISTS public.ref_list (
  list_id    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  list_key   TEXT NOT NULL,
  list_name  TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT ref_list_key_unique UNIQUE (list_key)
);

CREATE TABLE IF NOT EXISTS public.ref_list_item (
  item_id    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  list_id    UUID REFERENCES public.ref_list(list_id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  code       TEXT,
  sort_order INT DEFAULT 0,
  is_active  BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Brokers table
CREATE TABLE IF NOT EXISTS public.brokers (
  broker_id   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  broker_name TEXT NOT NULL,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Treaty types (the tool's canonical singular table)
CREATE TABLE IF NOT EXISTS public.treaty_type (
  treaty_type_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  treaty_type    TEXT NOT NULL,
  category       TEXT DEFAULT 'PROPORTIONAL',
  is_active      BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT treaty_type_unique UNIQUE (treaty_type)
);

-- Class of business
CREATE TABLE IF NOT EXISTS public.class_of_business (
  class_of_business_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  class_of_business    TEXT NOT NULL,
  code                 TEXT,
  is_active            BOOLEAN DEFAULT true
);

-- Natural keys (tool migration 150): partial, over the rows the app treats as
-- active, so a soft-deleted row may share a name with its live replacement.
CREATE UNIQUE INDEX IF NOT EXISTS uq_country_code_active
  ON public.country (country_code) WHERE is_active IS NOT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_class_of_business_name_active
  ON public.class_of_business (class_of_business) WHERE is_active IS NOT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_brokers_name_active
  ON public.brokers (broker_name) WHERE is_active IS NOT FALSE;

-- ═══════════════════════════════════════════════════════════════════
-- Countries (tool 005 seed + 045 region mapping and additions)
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.country (country_name, country_code, region)
SELECT * FROM (VALUES
  ('United Arab Emirates', 'AE', 'GCC'), ('Saudi Arabia', 'SA', 'GCC'), ('Kuwait', 'KW', 'GCC'),
  ('Bahrain', 'BH', 'GCC'), ('Oman', 'OM', 'GCC'), ('Qatar', 'QA', 'GCC'),
  ('Jordan', 'JO', 'Levant'), ('Lebanon', 'LB', 'Levant'),
  ('Egypt', 'EG', 'North Africa'), ('Morocco', 'MA', 'North Africa'), ('Tunisia', 'TN', 'North Africa'),
  ('Algeria', 'DZ', 'North Africa'),
  ('South Africa', 'ZA', 'Sub-Saharan Africa'), ('Nigeria', 'NG', 'Sub-Saharan Africa'), ('Kenya', 'KE', 'Sub-Saharan Africa'),
  ('United Kingdom', 'GB', 'Europe'), ('France', 'FR', 'Europe'), ('Germany', 'DE', 'Europe'), ('Italy', 'IT', 'Europe'),
  ('Spain', 'ES', 'Europe'), ('Switzerland', 'CH', 'Europe'), ('Netherlands', 'NL', 'Europe'), ('Belgium', 'BE', 'Europe'),
  ('Turkey', 'TR', 'Europe'),
  ('India', 'IN', 'South Asia'), ('Pakistan', 'PK', 'South Asia'), ('Sri Lanka', 'LK', 'South Asia'),
  ('Bangladesh', 'BD', 'South Asia'),
  ('Malaysia', 'MY', 'Southeast Asia'), ('Singapore', 'SG', 'Southeast Asia'), ('Thailand', 'TH', 'Southeast Asia'),
  ('Indonesia', 'ID', 'Southeast Asia'), ('Philippines', 'PH', 'Southeast Asia'),
  ('Japan', 'JP', 'East Asia & Pacific'), ('China', 'CN', 'East Asia & Pacific'), ('South Korea', 'KR', 'East Asia & Pacific'),
  ('Australia', 'AU', 'East Asia & Pacific'), ('New Zealand', 'NZ', 'East Asia & Pacific'),
  ('United States', 'US', 'Americas'), ('Canada', 'CA', 'Americas'), ('Mexico', 'MX', 'Americas'), ('Brazil', 'BR', 'Americas'),
  ('Chile', 'CL', 'Americas'), ('Colombia', 'CO', 'Americas'), ('Argentina', 'AR', 'Americas'),
  -- MENA/GCC and other countries the tool's region mapping adds
  ('Iraq', 'IQ', 'Levant'), ('Syria', 'SY', 'Levant'), ('Palestine', 'PS', 'Levant'),
  ('Libya', 'LY', 'North Africa'), ('Sudan', 'SD', 'North Africa'),
  ('Ghana', 'GH', 'Sub-Saharan Africa'), ('Ethiopia', 'ET', 'Sub-Saharan Africa'), ('Tanzania', 'TZ', 'Sub-Saharan Africa'),
  ('Uganda', 'UG', 'Sub-Saharan Africa'), ('Zimbabwe', 'ZW', 'Sub-Saharan Africa'), ('Zambia', 'ZM', 'Sub-Saharan Africa'),
  ('Mozambique', 'MZ', 'Sub-Saharan Africa'), ('Angola', 'AO', 'Sub-Saharan Africa'),
  ('Sweden', 'SE', 'Europe'), ('Norway', 'NO', 'Europe'), ('Denmark', 'DK', 'Europe'), ('Finland', 'FI', 'Europe'),
  ('Austria', 'AT', 'Europe'), ('Portugal', 'PT', 'Europe'), ('Greece', 'GR', 'Europe'), ('Ireland', 'IE', 'Europe'),
  ('Poland', 'PL', 'Europe'), ('Russia', 'RU', 'Europe'),
  ('Nepal', 'NP', 'South Asia'), ('Vietnam', 'VN', 'Southeast Asia'),
  ('Hong Kong', 'HK', 'East Asia & Pacific'), ('Taiwan', 'TW', 'East Asia & Pacific'),
  ('Peru', 'PE', 'Americas'), ('Ecuador', 'EC', 'Americas'), ('Venezuela', 'VE', 'Americas')
) AS v(n, c, r)
WHERE NOT EXISTS (SELECT 1 FROM public.country WHERE country_code = v.c);

-- ═══════════════════════════════════════════════════════════════════
-- Currencies
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.currency (currency_code, currency_name)
SELECT * FROM (VALUES
  ('USD', 'US Dollar'), ('EUR', 'Euro'), ('GBP', 'British Pound'),
  ('AED', 'UAE Dirham'), ('SAR', 'Saudi Riyal'), ('KWD', 'Kuwaiti Dinar'),
  ('BHD', 'Bahraini Dinar'), ('OMR', 'Omani Rial'), ('QAR', 'Qatari Riyal'),
  ('JOD', 'Jordanian Dinar'), ('EGP', 'Egyptian Pound'), ('MAD', 'Moroccan Dirham'),
  ('ZAR', 'South African Rand'), ('NGN', 'Nigerian Naira'), ('KES', 'Kenyan Shilling'),
  ('INR', 'Indian Rupee'), ('PKR', 'Pakistani Rupee'), ('LKR', 'Sri Lankan Rupee'),
  ('MYR', 'Malaysian Ringgit'), ('SGD', 'Singapore Dollar'), ('JPY', 'Japanese Yen'),
  ('CNY', 'Chinese Yuan'), ('KRW', 'South Korean Won'), ('THB', 'Thai Baht'),
  ('IDR', 'Indonesian Rupiah'), ('AUD', 'Australian Dollar'), ('NZD', 'New Zealand Dollar'),
  ('CAD', 'Canadian Dollar'), ('CHF', 'Swiss Franc'), ('TRY', 'Turkish Lira'),
  ('BRL', 'Brazilian Real'), ('MXN', 'Mexican Peso')
) AS v(code, nm)
WHERE NOT EXISTS (SELECT 1 FROM public.currency WHERE currency_code = v.code);

-- ═══════════════════════════════════════════════════════════════════
-- Brokers
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.brokers (broker_name)
SELECT v.n FROM (VALUES
  ('Aon'), ('Marsh'), ('Willis Towers Watson'), ('Guy Carpenter'),
  ('Gallagher Re'), ('Lockton Re'), ('Ed Broking'), ('BMS Group'),
  ('UIB'), ('Howden'), ('Direct')
) AS v(n)
WHERE NOT EXISTS (SELECT 1 FROM public.brokers WHERE broker_name = v.n);

-- ═══════════════════════════════════════════════════════════════════
-- Treaty types (the tool's 11 canonical rows)
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.treaty_type (treaty_type, category)
SELECT * FROM (VALUES
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
) AS v(tt, cat)
WHERE NOT EXISTS (SELECT 1 FROM public.treaty_type WHERE treaty_type = v.tt);

-- ═══════════════════════════════════════════════════════════════════
-- Class of business (the tool's canonical taxonomy)
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.class_of_business (class_of_business, code)
SELECT * FROM (VALUES
  ('Property', 'PROP'), ('Motor', 'MOT'), ('Marine', 'MAR'),
  ('Engineering', 'ENG'), ('Liability', 'LIA'), ('Medical', 'MED'),
  ('Aviation', 'AVI'), ('Energy', 'ENE'), ('Agriculture', 'AGR'),
  ('Credit & Surety', 'CS'), ('Miscellaneous', 'MISC'), ('Life', 'LIFE'),
  ('Group Life', 'GL'), ('Workers Compensation', 'WC')
) AS v(n, c)
WHERE NOT EXISTS (SELECT 1 FROM public.class_of_business WHERE class_of_business = v.n);
