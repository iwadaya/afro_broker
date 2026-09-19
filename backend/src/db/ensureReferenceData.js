// backend/src/db/ensureReferenceData.js — the Universe modelling tool's
// server/src/startup/ensureReferenceData.js, carried over so both products
// hold the same reference data: on every boot the canonical countries,
// currencies, brokers, treaty types and classes of business are asserted
// into their tables (idempotent — every insert is guarded by its natural key)
// and non-canonical treaty types are soft-deactivated so they leave the
// dropdowns without anything being deleted.
//
// The cedants the tool holds (its `companies` table: the canonical list its
// boot asserts plus the ones its reference seed adds) are carried into
// Broker IQ's cedant register too, each under its country and with its
// entry on the Insurers tab of the market register — so the placement
// page's Cedant Name dropdown offers, for a country, the cedants Universe
// offers. The tool's reinsurers stay Broker IQ's own market register.
import { query } from './pool.js';

export const countries = [
  ['United Arab Emirates','AE'],['Saudi Arabia','SA'],['Kuwait','KW'],['Bahrain','BH'],
  ['Oman','OM'],['Qatar','QA'],['Jordan','JO'],['Lebanon','LB'],['Egypt','EG'],
  ['Morocco','MA'],['Tunisia','TN'],['Algeria','DZ'],['South Africa','ZA'],
  ['Nigeria','NG'],['Kenya','KE'],['United Kingdom','GB'],['France','FR'],
  ['Germany','DE'],['Italy','IT'],['Spain','ES'],['Switzerland','CH'],
  ['Netherlands','NL'],['Belgium','BE'],['Turkey','TR'],['India','IN'],
  ['Pakistan','PK'],['Sri Lanka','LK'],['Bangladesh','BD'],['Malaysia','MY'],
  ['Singapore','SG'],['Japan','JP'],['China','CN'],['South Korea','KR'],
  ['Thailand','TH'],['Indonesia','ID'],['Philippines','PH'],['Australia','AU'],
  ['New Zealand','NZ'],['United States','US'],['Canada','CA'],['Mexico','MX'],
  ['Brazil','BR'],['Chile','CL'],['Colombia','CO'],['Argentina','AR'],
];

export const currencies = [
  ['USD','US Dollar'],['EUR','Euro'],['GBP','British Pound'],['AED','UAE Dirham'],
  ['SAR','Saudi Riyal'],['KWD','Kuwaiti Dinar'],['BHD','Bahraini Dinar'],
  ['OMR','Omani Rial'],['QAR','Qatari Riyal'],['JOD','Jordanian Dinar'],
  ['EGP','Egyptian Pound'],['MAD','Moroccan Dirham'],['ZAR','South African Rand'],
  ['NGN','Nigerian Naira'],['KES','Kenyan Shilling'],['INR','Indian Rupee'],
  ['PKR','Pakistani Rupee'],['LKR','Sri Lankan Rupee'],['MYR','Malaysian Ringgit'],
  ['SGD','Singapore Dollar'],['JPY','Japanese Yen'],['CNY','Chinese Yuan'],
  ['KRW','South Korean Won'],['THB','Thai Baht'],['IDR','Indonesian Rupiah'],
  ['AUD','Australian Dollar'],['NZD','New Zealand Dollar'],['CAD','Canadian Dollar'],
  ['CHF','Swiss Franc'],['TRY','Turkish Lira'],['BRL','Brazilian Real'],['MXN','Mexican Peso'],
];

export const brokers = [
  'Aon','Marsh','Willis Towers Watson','Guy Carpenter','Gallagher Re',
  'Lockton Re','Ed Broking','BMS Group','UIB','Howden','Direct',
];

export const treatyTypes = [
  ['Quota Share','PROPORTIONAL'],['Quota Share & Surplus','PROPORTIONAL'],
  ['First Surplus','PROPORTIONAL'],['Second Surplus','PROPORTIONAL'],
  ['Third Surplus','PROPORTIONAL'],['Fac Oblig','PROPORTIONAL'],
  ['Risk XL','NON_PROPORTIONAL'],['CAT XL','NON_PROPORTIONAL'],
  ['Risk & CAT XL','NON_PROPORTIONAL'],['Stop Loss','NON_PROPORTIONAL'],
  ['Aggregate XL','NON_PROPORTIONAL'],
];

export const classes = [
  ['Property','PROP'],['Motor','MOT'],['Marine','MAR'],['Engineering','ENG'],
  ['Liability','LIA'],['Medical','MED'],['Aviation','AVI'],['Energy','ENE'],
  ['Agriculture','AGR'],['Credit & Surety','CS'],['Miscellaneous','MISC'],
  ['Life','LIFE'],['Group Life','GL'],['Workers Compensation','WC'],
];

/* The tool's cedants by country code — server/src/startup/ensureReferenceData.js
   companySeedsByCountry, plus server/src/db/seeds/002_reference_data.sql. */
export const cedantsByCountry = {
  SA: ['Tawuniya', 'Bupa Arabia', 'Malath Insurance', 'Al Rajhi Takaful', 'Walaa Insurance', 'Gulf Union Insurance',
    'MEDGULF', 'SALAMA'],
  AE: ['Abu Dhabi National Insurance', 'ADNIC', 'Orient Insurance', 'Oman Insurance', 'Dubai Insurance',
    'Salama Islamic Insurance', 'Oman Insurance Co', 'Sukoon Insurance'],
  KW: ['Kuwait Insurance', 'Gulf Insurance Group', 'Warba Insurance', 'Kuwait Insurance Co'],
  BH: ['GIG Bahrain', 'Solidarity Bahrain'],
  OM: ['Dhofar Insurance', 'National Life & General'],
  EG: ['Misr Insurance', 'GIG Egypt', 'Allianz Egypt'],
  GB: ['Aviva', 'AXA UK', 'RSA Insurance', 'Zurich UK'],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a batch of upsert-style inserts. Returns the number of rows processed
 * (not necessarily inserted — most are no-ops on a converged database).
 * A missing table (42P01) returns 0 gracefully: migrations may not have run
 * yet, and the data is seeded on the next boot once they have.
 */
async function tryInsertMany(label, sql, rows, runner) {
  let count = 0;
  try {
    for (const row of rows) {
      await runner.query(sql, row);
      count++;
    }
  } catch (err) {
    if (err.code === '42P01') {
      console.warn(`ensureReferenceData: ${label} table missing, will retry on next boot`);
      return 0;
    }
    console.warn(`ensureReferenceData: unexpected error seeding ${label}: ${err.message.split('\n')[0]}`);
    return count;
  }
  return count;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function ensureReferenceData(runner = { query }) {
  await tryInsertMany(
    'countries',
    'INSERT INTO public.country (country_name, country_code) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM public.country WHERE country_code = $2)',
    countries, runner,
  );

  await tryInsertMany(
    'currencies',
    'INSERT INTO public.currency (currency_code, currency_name) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM public.currency WHERE currency_code = $1)',
    currencies, runner,
  );

  await tryInsertMany(
    'brokers',
    'INSERT INTO public.brokers (broker_name) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM public.brokers WHERE broker_name = $1)',
    brokers.map((v) => [v]), runner,
  );

  // Seed canonical treaty types into the singular table
  await tryInsertMany(
    'treaty_type',
    'INSERT INTO public.treaty_type (treaty_type, category) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM public.treaty_type WHERE treaty_type = $1)',
    treatyTypes, runner,
  );

  // Soft-deactivate non-canonical treaty types so they disappear from the
  // reference dropdowns (lookups filter `is_active IS NOT FALSE`) without
  // destroying anything. Boot must never delete reference rows. Only ACTIVE
  // rows are touched, so rows already soft-deleted are left exactly as they
  // are and the statement is a no-op on an already-converged database.
  let deactivated = 0;
  try {
    const canonicalNames = treatyTypes.map(([name]) => name);
    const res = await runner.query(
      `UPDATE public.treaty_type
          SET is_active = false
        WHERE treaty_type <> ALL($1::text[])
          AND is_active IS DISTINCT FROM false`,
      [canonicalNames],
    );
    deactivated = res.rowCount;
    if (deactivated > 0) console.log(`ensureReferenceData: deactivated ${deactivated} non-canonical treaty types`);
  } catch (e) {
    console.warn(`ensureReferenceData: treaty_type deactivation failed: ${e.message?.split('\n')[0]}`);
  }

  await tryInsertMany(
    'class_of_business',
    'INSERT INTO public.class_of_business (class_of_business, code) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM public.class_of_business WHERE class_of_business = $1)',
    classes, runner,
  );

  // The tool's cedants, under their country: the domicile is the country's
  // name (what the register stores for a cedant added there), the register
  // entry on the Insurers tab carries the country's region. Guarded by name,
  // so a cedant renamed or re-domiciled by hand is left as it is.
  let cedantsAdded = 0;
  try {
    for (const [code, names] of Object.entries(cedantsByCountry)) {
      const { rows: [country] } = await runner.query(
        'SELECT country_name, region FROM public.country WHERE country_code = $1 LIMIT 1',
        [code],
      );
      if (!country) continue;
      for (const name of names) {
        const { rows: existing } = await runner.query('SELECT 1 FROM cedant WHERE name = $1 LIMIT 1', [name]);
        if (existing.length) continue;
        const { rows: [market] } = await runner.query(
          `INSERT INTO market (name, domicile, type, region)
           VALUES ($1, $2, 'insurer', $3)
           ON CONFLICT (type, name, domicile) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [name, country.country_name, country.region || null],
        );
        await runner.query(
          `INSERT INTO cedant (name, domicile, market_id) VALUES ($1, $2, $3)
           ON CONFLICT (name, domicile) DO NOTHING`,
          [name, country.country_name, market?.id || null],
        );
        cedantsAdded++;
      }
    }
    if (cedantsAdded > 0) console.log(`ensureReferenceData: added ${cedantsAdded} Universe cedants`);
  } catch (e) {
    if (e.code === '42P01') console.warn('ensureReferenceData: cedant table missing, will retry on next boot');
    else console.warn(`ensureReferenceData: unexpected error seeding cedants: ${e.message?.split('\n')[0]}`);
  }

  return { deactivated, cedantsAdded };
}
