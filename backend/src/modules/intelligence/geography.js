import { query } from '../../db/pool.js';

/**
 * The geography Market intelligence works in: the reference country list
 * (public.country — the rows behind the placement page's Country dropdown),
 * each country in its region. A country is the finer scope, a region the
 * coarser. A cedant belongs to a country through its domicile, which the
 * register holds as free text — a code, a name, or one of the spellings the
 * list answers to — so it is resolved here rather than joined.
 */

/** Other spellings a domicile is stored under, and the code each one means. */
export const DOMICILE_ALIASES = {
  UK: 'GB', 'GREAT BRITAIN': 'GB', ENGLAND: 'GB',
  USA: 'US', 'UNITED STATES OF AMERICA': 'US',
  UAE: 'AE', KSA: 'SA',
};

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** Every active country on the reference list: { code, name, region }. */
export async function loadCountries() {
  const { rows } = await query(
    `SELECT country_code AS code, country_name AS name, region
       FROM public.country
      WHERE is_active IS NOT FALSE AND country_code IS NOT NULL
      ORDER BY region, country_name`,
  );
  return rows;
}

/** The country ({ code, name, region }) a stored domicile refers to, or null. */
export function countryOfDomicile(domicile, countries) {
  if (!domicile) return null;
  const d = String(domicile).trim();
  if (!d) return null;
  const alias = DOMICILE_ALIASES[d.toUpperCase()];
  return countries.find((c) => norm(c.code) === norm(d) || norm(c.name) === norm(d) || (alias && c.code === alias))
    || null;
}

/** The regions, each with its countries, alphabetically. */
export function regionsOf(countries) {
  const m = new Map();
  for (const c of countries) {
    const r = c.region || 'Unassigned';
    if (!m.has(r)) m.set(r, { region: r, countries: [] });
    m.get(r).countries.push(c);
  }
  return [...m.values()].sort((a, b) => a.region.localeCompare(b.region));
}

/**
 * Resolve a scope — `('country', 'GB')` or `('region', 'Europe')` — against
 * the list: `{ type, key, label, region, countries }`, with the key spelt as
 * the list spells it. Null when the key is not on the list.
 */
export function resolveScope(type, key, countries) {
  if (type === 'country') {
    const c = countryOfDomicile(key, countries);
    if (!c) return null;
    return { type, key: c.code, label: c.name, region: c.region || null, countries: [c] };
  }
  if (type === 'region') {
    const members = countries.filter((c) => norm(c.region) === norm(key) && norm(key));
    if (!members.length) return null;
    return { type, key: members[0].region, label: members[0].region, region: members[0].region, countries: members };
  }
  return null;
}
