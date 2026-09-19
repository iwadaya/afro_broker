-- Reference data behind the Treaty Detail dropdowns — country, treaty type,
-- class of business, broker and currency — kept the way the Universe
-- modelling tool keeps its ref data (one seeded table, read through a
-- ref-data API) rather than as constants in the frontend. Everyone reads it;
-- an admin maintains it. The seed is the list that shipped hard-coded in the
-- placement wizard, with the countries carrying the modelling tool's ISO
-- codes and placement territories.

CREATE TABLE ref_data (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which dropdown the entry belongs to.
  kind       TEXT NOT NULL CHECK (kind IN ('country', 'treaty_type', 'cob', 'broker', 'currency')),
  -- The value the app stores: an ISO code for a country or currency, the
  -- treaty-type code written into a placement's class ("QS"), the name
  -- itself for a broker or class of business.
  code       TEXT NOT NULL,
  -- What the dropdown shows.
  name       TEXT NOT NULL,
  -- Optional grouping: a country's placement territory, a treaty type's basis.
  group_name TEXT,
  -- Other spellings that mean this entry ("UK", "XL"), so stored free text
  -- such as a cedant's domicile still resolves to it.
  aliases    TEXT[] NOT NULL DEFAULT '{}',
  position   INTEGER NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Two entries of one kind answering to the same code would make a stored
-- value ambiguous.
CREATE UNIQUE INDEX idx_ref_data_kind_code ON ref_data (kind, upper(code));
CREATE INDEX idx_ref_data_kind ON ref_data (kind, position);

-- Countries: the modelling tool's list plus the domiciles Broker IQ's own
-- register already uses. The group is the placement territory.
INSERT INTO ref_data (kind, code, name, group_name, aliases, position) VALUES
  ('country', 'AE', 'United Arab Emirates', 'Middle East', ARRAY['UAE'], 1),
  ('country', 'SA', 'Saudi Arabia', 'Middle East', '{}', 2),
  ('country', 'KW', 'Kuwait', 'Middle East', '{}', 3),
  ('country', 'BH', 'Bahrain', 'Middle East', '{}', 4),
  ('country', 'OM', 'Oman', 'Middle East', '{}', 5),
  ('country', 'QA', 'Qatar', 'Middle East', '{}', 6),
  ('country', 'JO', 'Jordan', 'Middle East', '{}', 7),
  ('country', 'LB', 'Lebanon', 'Middle East', '{}', 8),
  ('country', 'EG', 'Egypt', 'Africa', '{}', 9),
  ('country', 'MA', 'Morocco', 'Africa', '{}', 10),
  ('country', 'TN', 'Tunisia', 'Africa', '{}', 11),
  ('country', 'DZ', 'Algeria', 'Africa', '{}', 12),
  ('country', 'ZA', 'South Africa', 'Africa', '{}', 13),
  ('country', 'NG', 'Nigeria', 'Africa', '{}', 14),
  ('country', 'KE', 'Kenya', 'Africa', '{}', 15),
  ('country', 'GB', 'United Kingdom', 'Europe', ARRAY['UK', 'Great Britain'], 16),
  ('country', 'FR', 'France', 'Europe', '{}', 17),
  ('country', 'DE', 'Germany', 'Europe', '{}', 18),
  ('country', 'IT', 'Italy', 'Europe', '{}', 19),
  ('country', 'ES', 'Spain', 'Europe', '{}', 20),
  ('country', 'CH', 'Switzerland', 'Europe', '{}', 21),
  ('country', 'NL', 'Netherlands', 'Europe', '{}', 22),
  ('country', 'BE', 'Belgium', 'Europe', '{}', 23),
  ('country', 'TR', 'Turkey', 'Europe', '{}', 24),
  ('country', 'IN', 'India', 'Asia', '{}', 25),
  ('country', 'PK', 'Pakistan', 'Asia', '{}', 26),
  ('country', 'LK', 'Sri Lanka', 'Asia', '{}', 27),
  ('country', 'BD', 'Bangladesh', 'Asia', '{}', 28),
  ('country', 'MY', 'Malaysia', 'Asia', '{}', 29),
  ('country', 'SG', 'Singapore', 'Asia', '{}', 30),
  ('country', 'JP', 'Japan', 'Asia', '{}', 31),
  ('country', 'CN', 'China', 'Asia', '{}', 32),
  ('country', 'KR', 'South Korea', 'Asia', '{}', 33),
  ('country', 'TH', 'Thailand', 'Asia', '{}', 34),
  ('country', 'ID', 'Indonesia', 'Asia', '{}', 35),
  ('country', 'PH', 'Philippines', 'Asia', '{}', 36),
  ('country', 'AU', 'Australia', 'Oceania', '{}', 37),
  ('country', 'NZ', 'New Zealand', 'Oceania', '{}', 38),
  ('country', 'US', 'United States', 'Americas', ARRAY['USA', 'United States of America'], 39),
  ('country', 'CA', 'Canada', 'Americas', '{}', 40),
  ('country', 'MX', 'Mexico', 'Americas', '{}', 41),
  ('country', 'BR', 'Brazil', 'Americas', '{}', 42),
  ('country', 'CL', 'Chile', 'Americas', '{}', 43),
  ('country', 'CO', 'Colombia', 'Americas', '{}', 44),
  ('country', 'AR', 'Argentina', 'Americas', '{}', 45),
  ('country', 'BM', 'Bermuda', 'Americas', '{}', 46),
  ('country', 'DK', 'Denmark', 'Europe', '{}', 47),
  ('country', 'IE', 'Ireland', 'Europe', '{}', 48),
  ('country', 'MU', 'Mauritius', 'Africa', '{}', 49),
  ('country', 'NO', 'Norway', 'Europe', '{}', 50),
  ('country', 'ZW', 'Zimbabwe', 'Africa', '{}', 51);

-- Treaty types: the placement vocabulary (the code is what a placement's
-- class and its layers carry), grouped by basis as the modelling tool groups
-- its list. Older records spell excess-of-loss "XL".
INSERT INTO ref_data (kind, code, name, group_name, aliases, position) VALUES
  ('treaty_type', 'QS', 'Quota Share', 'Proportional', '{}', 1),
  ('treaty_type', 'Surplus', 'Surplus', 'Proportional', '{}', 2),
  ('treaty_type', 'XoL', 'Excess of Loss', 'Non-proportional', ARRAY['XL'], 3),
  ('treaty_type', 'Fac', 'Facultative', 'Non-proportional', '{}', 4);

-- Classes of business: the line-of-business picker. The name is the value.
INSERT INTO ref_data (kind, code, name, position) VALUES
  ('cob', 'Property', 'Property', 1),
  ('cob', 'Property Cat', 'Property Cat', 2),
  ('cob', 'Casualty', 'Casualty', 3),
  ('cob', 'Motor', 'Motor', 4),
  ('cob', 'Marine', 'Marine', 5),
  ('cob', 'Marine Cargo', 'Marine Cargo', 6),
  ('cob', 'Energy', 'Energy', 7),
  ('cob', 'Engineering', 'Engineering', 8),
  ('cob', 'Agriculture', 'Agriculture', 9),
  ('cob', 'Aviation', 'Aviation', 10),
  ('cob', 'Credit & Surety', 'Credit & Surety', 11),
  ('cob', 'Liability', 'Liability', 12),
  ('cob', 'Health', 'Health', 13),
  ('cob', 'Life', 'Life', 14);

-- Brokers: the intermediaries a placement may come through. The name is the value.
INSERT INTO ref_data (kind, code, name, position) VALUES
  ('broker', 'Universe Broking', 'Universe Broking', 1),
  ('broker', 'Aon Re', 'Aon Re', 2),
  ('broker', 'Guy Carpenter', 'Guy Carpenter', 3),
  ('broker', 'Gallagher Re', 'Gallagher Re', 4),
  ('broker', 'Howden Re', 'Howden Re', 5),
  ('broker', 'Lockton Re', 'Lockton Re', 6),
  ('broker', 'Direct', 'Direct', 7);

-- Currencies: ISO 4217 codes.
INSERT INTO ref_data (kind, code, name, position) VALUES
  ('currency', 'USD', 'US Dollar', 1),
  ('currency', 'EUR', 'Euro', 2),
  ('currency', 'GBP', 'Pound Sterling', 3),
  ('currency', 'CHF', 'Swiss Franc', 4),
  ('currency', 'JPY', 'Japanese Yen', 5),
  ('currency', 'AUD', 'Australian Dollar', 6),
  ('currency', 'CAD', 'Canadian Dollar', 7),
  ('currency', 'ZAR', 'South African Rand', 8),
  ('currency', 'SGD', 'Singapore Dollar', 9),
  ('currency', 'AED', 'UAE Dirham', 10);
