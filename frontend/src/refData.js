// Reference data behind the Treaty Detail dropdowns — country, currency,
// broker, treaty type and class of business — held exactly as the Universe
// modelling tool holds it: its tables (migration 035), its boot-time
// ensureReferenceData, and its lookups API (GET /api/brokers, /treaty-types,
// /class-of-business, /ref/lists/country/items, /ref/lists/currency/items),
// each answering { id, name, code? } rows that the dropdowns bind by id.
//
// This module is the tool's canonical seed as data (its
// server/src/startup/ensureReferenceData.js plus the countries its region
// mapping adds), for the parts of the app that classify stored free text
// without a round trip — the dashboard's territory grouping, the register's
// domicile normalisation — and for the backend test that pins the migration
// against it. It stays React-free; `RefData.jsx` holds the live loader.

export const COUNTRIES = [
  { name: 'United Arab Emirates', code: 'AE', region: 'GCC' },
  { name: 'Saudi Arabia', code: 'SA', region: 'GCC' },
  { name: 'Kuwait', code: 'KW', region: 'GCC' },
  { name: 'Bahrain', code: 'BH', region: 'GCC' },
  { name: 'Oman', code: 'OM', region: 'GCC' },
  { name: 'Qatar', code: 'QA', region: 'GCC' },
  { name: 'Jordan', code: 'JO', region: 'Levant' },
  { name: 'Lebanon', code: 'LB', region: 'Levant' },
  { name: 'Egypt', code: 'EG', region: 'North Africa' },
  { name: 'Morocco', code: 'MA', region: 'North Africa' },
  { name: 'Tunisia', code: 'TN', region: 'North Africa' },
  { name: 'Algeria', code: 'DZ', region: 'North Africa' },
  { name: 'South Africa', code: 'ZA', region: 'Sub-Saharan Africa' },
  { name: 'Nigeria', code: 'NG', region: 'Sub-Saharan Africa' },
  { name: 'Kenya', code: 'KE', region: 'Sub-Saharan Africa' },
  { name: 'United Kingdom', code: 'GB', region: 'Europe' },
  { name: 'France', code: 'FR', region: 'Europe' },
  { name: 'Germany', code: 'DE', region: 'Europe' },
  { name: 'Italy', code: 'IT', region: 'Europe' },
  { name: 'Spain', code: 'ES', region: 'Europe' },
  { name: 'Switzerland', code: 'CH', region: 'Europe' },
  { name: 'Netherlands', code: 'NL', region: 'Europe' },
  { name: 'Belgium', code: 'BE', region: 'Europe' },
  { name: 'Turkey', code: 'TR', region: 'Europe' },
  { name: 'India', code: 'IN', region: 'South Asia' },
  { name: 'Pakistan', code: 'PK', region: 'South Asia' },
  { name: 'Sri Lanka', code: 'LK', region: 'South Asia' },
  { name: 'Bangladesh', code: 'BD', region: 'South Asia' },
  { name: 'Malaysia', code: 'MY', region: 'Southeast Asia' },
  { name: 'Singapore', code: 'SG', region: 'Southeast Asia' },
  { name: 'Thailand', code: 'TH', region: 'Southeast Asia' },
  { name: 'Indonesia', code: 'ID', region: 'Southeast Asia' },
  { name: 'Philippines', code: 'PH', region: 'Southeast Asia' },
  { name: 'Japan', code: 'JP', region: 'East Asia & Pacific' },
  { name: 'China', code: 'CN', region: 'East Asia & Pacific' },
  { name: 'South Korea', code: 'KR', region: 'East Asia & Pacific' },
  { name: 'Australia', code: 'AU', region: 'East Asia & Pacific' },
  { name: 'New Zealand', code: 'NZ', region: 'East Asia & Pacific' },
  { name: 'United States', code: 'US', region: 'Americas' },
  { name: 'Canada', code: 'CA', region: 'Americas' },
  { name: 'Mexico', code: 'MX', region: 'Americas' },
  { name: 'Brazil', code: 'BR', region: 'Americas' },
  { name: 'Chile', code: 'CL', region: 'Americas' },
  { name: 'Colombia', code: 'CO', region: 'Americas' },
  { name: 'Argentina', code: 'AR', region: 'Americas' },
  // The countries the tool's region mapping (its migration 045) adds.
  { name: 'Iraq', code: 'IQ', region: 'Levant' },
  { name: 'Syria', code: 'SY', region: 'Levant' },
  { name: 'Palestine', code: 'PS', region: 'Levant' },
  { name: 'Libya', code: 'LY', region: 'North Africa' },
  { name: 'Sudan', code: 'SD', region: 'North Africa' },
  { name: 'Ghana', code: 'GH', region: 'Sub-Saharan Africa' },
  { name: 'Ethiopia', code: 'ET', region: 'Sub-Saharan Africa' },
  { name: 'Tanzania', code: 'TZ', region: 'Sub-Saharan Africa' },
  { name: 'Uganda', code: 'UG', region: 'Sub-Saharan Africa' },
  { name: 'Zimbabwe', code: 'ZW', region: 'Sub-Saharan Africa' },
  { name: 'Zambia', code: 'ZM', region: 'Sub-Saharan Africa' },
  { name: 'Mozambique', code: 'MZ', region: 'Sub-Saharan Africa' },
  { name: 'Angola', code: 'AO', region: 'Sub-Saharan Africa' },
  { name: 'Sweden', code: 'SE', region: 'Europe' },
  { name: 'Norway', code: 'NO', region: 'Europe' },
  { name: 'Denmark', code: 'DK', region: 'Europe' },
  { name: 'Finland', code: 'FI', region: 'Europe' },
  { name: 'Austria', code: 'AT', region: 'Europe' },
  { name: 'Portugal', code: 'PT', region: 'Europe' },
  { name: 'Greece', code: 'GR', region: 'Europe' },
  { name: 'Ireland', code: 'IE', region: 'Europe' },
  { name: 'Poland', code: 'PL', region: 'Europe' },
  { name: 'Russia', code: 'RU', region: 'Europe' },
  { name: 'Nepal', code: 'NP', region: 'South Asia' },
  { name: 'Vietnam', code: 'VN', region: 'Southeast Asia' },
  { name: 'Hong Kong', code: 'HK', region: 'East Asia & Pacific' },
  { name: 'Taiwan', code: 'TW', region: 'East Asia & Pacific' },
  { name: 'Peru', code: 'PE', region: 'Americas' },
  { name: 'Ecuador', code: 'EC', region: 'Americas' },
  { name: 'Venezuela', code: 'VE', region: 'Americas' },
];

export const CURRENCIES = [
  ['USD', 'US Dollar'], ['EUR', 'Euro'], ['GBP', 'British Pound'], ['AED', 'UAE Dirham'],
  ['SAR', 'Saudi Riyal'], ['KWD', 'Kuwaiti Dinar'], ['BHD', 'Bahraini Dinar'],
  ['OMR', 'Omani Rial'], ['QAR', 'Qatari Riyal'], ['JOD', 'Jordanian Dinar'],
  ['EGP', 'Egyptian Pound'], ['MAD', 'Moroccan Dirham'], ['ZAR', 'South African Rand'],
  ['NGN', 'Nigerian Naira'], ['KES', 'Kenyan Shilling'], ['INR', 'Indian Rupee'],
  ['PKR', 'Pakistani Rupee'], ['LKR', 'Sri Lankan Rupee'], ['MYR', 'Malaysian Ringgit'],
  ['SGD', 'Singapore Dollar'], ['JPY', 'Japanese Yen'], ['CNY', 'Chinese Yuan'],
  ['KRW', 'South Korean Won'], ['THB', 'Thai Baht'], ['IDR', 'Indonesian Rupiah'],
  ['AUD', 'Australian Dollar'], ['NZD', 'New Zealand Dollar'], ['CAD', 'Canadian Dollar'],
  ['CHF', 'Swiss Franc'], ['TRY', 'Turkish Lira'], ['BRL', 'Brazilian Real'], ['MXN', 'Mexican Peso'],
];

export const BROKERS = [
  'Aon', 'Marsh', 'Willis Towers Watson', 'Guy Carpenter', 'Gallagher Re',
  'Lockton Re', 'Ed Broking', 'BMS Group', 'UIB', 'Howden', 'Direct',
];

export const TREATY_TYPES = [
  ['Quota Share', 'PROPORTIONAL'], ['Quota Share & Surplus', 'PROPORTIONAL'],
  ['First Surplus', 'PROPORTIONAL'], ['Second Surplus', 'PROPORTIONAL'],
  ['Third Surplus', 'PROPORTIONAL'], ['Fac Oblig', 'PROPORTIONAL'],
  ['Risk XL', 'NON_PROPORTIONAL'], ['CAT XL', 'NON_PROPORTIONAL'],
  ['Risk & CAT XL', 'NON_PROPORTIONAL'], ['Stop Loss', 'NON_PROPORTIONAL'],
  ['Aggregate XL', 'NON_PROPORTIONAL'],
];

export const CLASSES = [
  ['Property', 'PROP'], ['Motor', 'MOT'], ['Marine', 'MAR'], ['Engineering', 'ENG'],
  ['Liability', 'LIA'], ['Medical', 'MED'], ['Aviation', 'AVI'], ['Energy', 'ENE'],
  ['Agriculture', 'AGR'], ['Credit & Surety', 'CS'], ['Miscellaneous', 'MISC'],
  ['Life', 'LIFE'], ['Group Life', 'GL'], ['Workers Compensation', 'WC'],
];

/** The tool's category labels, as the treaty-type dropdown groups them. */
export const CATEGORY_LABELS = { PROPORTIONAL: 'Proportional', NON_PROPORTIONAL: 'Non-proportional' };

// ── Stored free text → reference entries ────────────────────────────────────
//
// Broker IQ stores names and codes on its records (a cedant's domicile, a
// placement's class and currency), so what is stored has to find its way
// back to the reference row. Records written before the reference data
// carried the wizard's own vocabulary; these maps resolve it.

/** Other spellings a cedant's domicile may be stored under. */
export const DOMICILE_ALIASES = {
  UK: 'GB', 'GREAT BRITAIN': 'GB', USA: 'US', 'UNITED STATES OF AMERICA': 'US', UAE: 'AE',
};

/** The wizard's treaty-type codes before the reference data, and the
    Universe type each reads as. */
export const LEGACY_TREATY_TYPES = {
  QS: 'Quota Share', Surplus: 'First Surplus', XoL: 'Risk XL', XL: 'Risk XL', Fac: 'Fac Oblig',
};

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** Does a stored free-text domicile refer to this country ({ name, code })? */
export function domicileMatches(domicile, country) {
  if (!domicile || !country) return false;
  const d = String(domicile).trim();
  const alias = DOMICILE_ALIASES[d.toUpperCase()];
  return norm(d) === norm(country.code) || norm(d) === norm(country.name) || (alias && alias === country.code);
}

/** The country a free-text domicile refers to, or null if unrecognised. */
export function countryOfDomicile(domicile, countries = COUNTRIES) {
  return (countries || []).find((c) => domicileMatches(domicile, c)) || null;
}

/** The region a free-text domicile falls into, or null. */
export function regionOfDomicile(domicile, countries = COUNTRIES) {
  return countryOfDomicile(domicile, countries)?.region || null;
}

/** The treaty type ({ name, category }) a stored name or legacy code refers to. */
export function treatyTypeOf(value, treatyTypes) {
  if (!value) return null;
  const list = treatyTypes || TREATY_TYPES.map(([name, category]) => ({ name, category }));
  const name = LEGACY_TREATY_TYPES[value] || value;
  return list.find((t) => norm(t.name) === norm(name)) || null;
}

/** The layer type Broker IQ's layers carry (QS / Surplus / XoL) for a treaty type. */
export function layerTypeOf(treatyType) {
  if (!treatyType) return 'XoL';
  if (treatyType.category === 'NON_PROPORTIONAL') return 'XoL';
  return /surplus/i.test(treatyType.name) && !/quota share/i.test(treatyType.name) ? 'Surplus' : 'QS';
}

/** Split a stored class string ("Property / Motor Quota Share") back into
    COB names + treaty type name — the inverse of how the wizard writes
    `class`. Longest name first, so "Quota Share & Surplus" is not read as a
    surplus; the wizard's older codes resolve to their Universe names. */
export function parseClass(cls, treatyTypes) {
  const whole = String(cls || '').trim();
  const lower = whole.toLowerCase();
  const names = (treatyTypes || TREATY_TYPES.map(([name]) => ({ name }))).map((t) => t.name)
    .sort((a, b) => b.length - a.length);
  const cobsOf = (head) => head.split(' / ').map((c) => c.trim()).filter(Boolean);
  for (const name of names) {
    if (lower === name.toLowerCase() || lower.endsWith(` ${name.toLowerCase()}`)) {
      return { treatyType: name, cobs: cobsOf(whole.slice(0, whole.length - name.length)) };
    }
  }
  const words = whole.split(/\s+/);
  const last = words[words.length - 1];
  const legacy = Object.keys(LEGACY_TREATY_TYPES).find((k) => k.toLowerCase() === (last || '').toLowerCase());
  if (legacy) return { treatyType: LEGACY_TREATY_TYPES[legacy], cobs: cobsOf(words.slice(0, -1).join(' ')) };
  return { treatyType: '', cobs: whole ? [whole] : [] };
}
