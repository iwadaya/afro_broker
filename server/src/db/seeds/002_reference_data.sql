-- Seed 002: reference data (ported from Universe seeds/002_reference_data.sql with
-- the African markets the broking desk works). Idempotent on the natural keys.
INSERT INTO public.class_of_business (class_of_business, code) VALUES
  ('Property', 'PROP'), ('Motor', 'MOT'), ('Marine', 'MAR'), ('Engineering', 'ENG'),
  ('Liability', 'LIA'), ('Medical', 'MED'), ('Aviation', 'AVI'), ('Energy', 'ENE'),
  ('Agriculture', 'AGR'), ('Credit & Surety', 'CS'), ('Miscellaneous', 'MISC'),
  ('Life', 'LIFE'), ('Group Life', 'GL'), ('Workers Compensation', 'WC'), ('Fire', 'FIRE')
ON CONFLICT (class_of_business) WHERE is_active IS NOT FALSE DO NOTHING;

INSERT INTO public.country (country_code, country_name, region) VALUES
  ('KE', 'Kenya', 'Africa'), ('ZA', 'South Africa', 'Africa'), ('NG', 'Nigeria', 'Africa'),
  ('GH', 'Ghana', 'Africa'), ('TZ', 'Tanzania', 'Africa'), ('UG', 'Uganda', 'Africa'),
  ('EG', 'Egypt', 'Africa'), ('MA', 'Morocco', 'Africa'), ('MU', 'Mauritius', 'Africa'),
  ('SA', 'Saudi Arabia', 'Middle East'), ('AE', 'United Arab Emirates', 'Middle East'),
  ('BH', 'Bahrain', 'Middle East'), ('KW', 'Kuwait', 'Middle East'), ('OM', 'Oman', 'Middle East'),
  ('QA', 'Qatar', 'Middle East'), ('JO', 'Jordan', 'Middle East'), ('LB', 'Lebanon', 'Middle East'),
  ('IN', 'India', 'Asia'), ('PK', 'Pakistan', 'Asia'), ('TR', 'Turkey', 'Europe'),
  ('GB', 'United Kingdom', 'Europe'), ('FR', 'France', 'Europe'), ('DE', 'Germany', 'Europe'),
  ('US', 'United States', 'Americas')
ON CONFLICT (country_code) WHERE is_active IS NOT FALSE DO NOTHING;

INSERT INTO public.currency (currency_code, currency_name) VALUES
  ('USD', 'US Dollar'), ('KES', 'Kenyan Shilling'), ('ZAR', 'South African Rand'),
  ('NGN', 'Nigerian Naira'), ('GHS', 'Ghanaian Cedi'), ('TZS', 'Tanzanian Shilling'),
  ('UGX', 'Ugandan Shilling'), ('EGP', 'Egyptian Pound'), ('MAD', 'Moroccan Dirham'),
  ('MUR', 'Mauritian Rupee'), ('SAR', 'Saudi Riyal'), ('AED', 'UAE Dirham'),
  ('GBP', 'British Pound'), ('EUR', 'Euro'), ('BHD', 'Bahraini Dinar'), ('KWD', 'Kuwaiti Dinar'),
  ('OMR', 'Omani Rial'), ('QAR', 'Qatari Riyal'), ('INR', 'Indian Rupee'), ('TRY', 'Turkish Lira')
ON CONFLICT (currency_code) DO NOTHING;

INSERT INTO public.brokers (broker_name) VALUES
  ('Afro-Asian Re Brokers'), ('Aon'), ('Marsh'), ('Willis Towers Watson'), ('Guy Carpenter'),
  ('Gallagher Re'), ('Lockton Re'), ('Ed Broking'), ('BMS Group'), ('UIB'), ('Howden'), ('Direct')
ON CONFLICT (broker_name) WHERE is_active IS NOT FALSE DO NOTHING;

INSERT INTO public.companies (company_name, country_id)
SELECT v.company_name, c.country_id
FROM (VALUES
  ('Kenya Re',                     'KE'), ('Jubilee Insurance',             'KE'), ('CIC Insurance Group', 'KE'),
  ('Sanlam Re',                    'ZA'), ('Santam',                        'ZA'), ('Old Mutual Insure',   'ZA'),
  ('Continental Re',               'NG'), ('Leadway Assurance',             'NG'), ('AIICO Insurance',     'NG'),
  ('Ghana Re',                     'GH'), ('SIC Insurance',                 'GH'),
  ('Tan Re',                       'TZ'), ('Uganda Re',                     'UG'),
  ('Misr Insurance',               'EG'), ('GIG Egypt',                     'EG'),
  ('Tawuniya',                     'SA'), ('Bupa Arabia',                   'SA'),
  ('Orient Insurance',             'AE'), ('Abu Dhabi National Insurance',  'AE'),
  ('GIG Bahrain',                  'BH'), ('Gulf Insurance Group',          'KW'),
  ('Dhofar Insurance',             'OM'), ('Qatar Insurance Company',       'QA')
) AS v(company_name, country_code)
JOIN LATERAL (SELECT country_id FROM public.country WHERE country_code = v.country_code AND is_active IS NOT FALSE LIMIT 1) c ON true
ON CONFLICT (company_name) WHERE is_active IS NOT FALSE DO NOTHING;
