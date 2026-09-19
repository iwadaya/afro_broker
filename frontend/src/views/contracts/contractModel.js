import { entryOf } from '../../RefData.jsx';
import { parseClass, treatyTypeOf } from '../../refData.js';
import { defaultRenewalDate } from './calcs.js';
import { emptyPropTerms, upgradePropTerms } from './propTerms.jsx';

/* A contract is a placement: the record the renewal calendar, the portfolio
   and the market intelligence all read. The Universe contract details map
   onto it — the cedant, the class string ("Property / Motor Quota Share":
   the classes of business and the treaty type), the currency, the
   inception and the renewal date (its expiry) — and the broker, the
   experience start year, the alternative contract id and the free notes
   fold into its notes, as the placement page always kept them. */

/** The cedant dropdown's "register a new cedant" choice. */
export const NEW_CEDANT = '__new__';

/** A lookup list to read the class string with: the live rows, or — while
    they are still loading, or failed to — the canonical seed the parsers
    fall back to. */
const listOf = (list) => (list && list.length ? list : undefined);

/** Pull the broker / experience-start-year / alt id facts back out of the notes fold. */
export function parseNotes(notes) {
  const out = { broker: '', expStartYear: '', altContractId: '', rest: [] };
  for (const part of (notes || '').split(' · ')) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith('Broker: ')) out.broker = t.slice(8);
    else if (/^Experience from \d{4}$/.test(t)) out.expStartYear = t.slice(-4);
    else if (t.startsWith('Alt. Contract ID: ')) out.altContractId = t.slice(18);
    else out.rest.push(t);
  }
  return { broker: out.broker, expStartYear: out.expStartYear, altContractId: out.altContractId, rest: out.rest.join(' · ') };
}

/** The notes fold: broker, experience start, alt id, free notes. */
export function buildNotes({ brokerName, expStartYear, altContractId, notes }) {
  const parts = [];
  if (brokerName) parts.push(`Broker: ${brokerName}`);
  if (expStartYear) parts.push(`Experience from ${expStartYear}`);
  if (altContractId && altContractId.trim()) parts.push(`Alt. Contract ID: ${altContractId.trim()}`);
  if (notes && notes.trim()) parts.push(notes.trim());
  return parts.join(' · ') || undefined;
}

/** The class string a placement stores: the classes of business, then the treaty type. */
export function classStringOf(cobNames, treatyTypeName) {
  return `${(cobNames || []).join(' / ')} ${treatyTypeName || ''}`.trim();
}

/**
 * Proportional or non-proportional: the treaty type's category in the
 * reference data, read from the class string; a record whose type is not
 * on the list falls back to its stored structure, then its layers.
 */
export function basisOfPlacement(pd, treatyTypes) {
  const list = listOf(treatyTypes);
  const { treatyType } = parseClass(pd?.class, list);
  const row = treatyTypeOf(treatyType, list);
  if (row?.category === 'PROPORTIONAL') return 'PROP';
  if (row?.category === 'NON_PROPORTIONAL') return 'NP';
  const s1 = (pd?.quote_structures || [])[0];
  if (s1?.basis === 'PROP') return 'PROP';
  if (s1?.basis) return 'NP';
  const layers = pd?.layers || [];
  if (layers.length && layers.every((l) => l.type === 'QS' || l.type === 'Surplus')) return 'PROP';
  return 'NP';
}

export const BASIS_LABEL = { PROP: 'Proportional', NP: 'Non-proportional' };
export const basisPath = (basis) => (basis === 'PROP' ? 'proportional' : 'non-proportional');

/** Where a contract opens: its basis page. */
export function contractPath(pd, treatyTypes) {
  return `/contracts/${basisPath(basisOfPlacement(pd, treatyTypes))}/${pd.id}`;
}

/** The proportional terms stored on the placement, or an empty set. */
export function propTermsOf(pd) {
  const st = (pd?.quote_structures || []).find((s) => s && s.basis === 'PROP');
  return st ? upgradePropTerms(st.prop) : emptyPropTerms();
}

/** The placement's structures with the proportional one replaced (or added first). */
export function withPropStructure(pd, structure) {
  const existing = (pd?.quote_structures || []).filter(Boolean);
  const idx = existing.findIndex((s) => s.basis === 'PROP');
  return idx >= 0 ? existing.map((s, i) => (i === idx ? structure : s)) : [structure, ...existing];
}

/**
 * The editable contract details, hydrated from a placement: the stored
 * class, currency and broker resolve to their lookup rows; a value the
 * lookups do not carry is held as the stored text. Country is left blank
 * until edited — the cedant's domicile shows through — so a reload never
 * drops a saved cedant. The renewal date follows inception + 12 months
 * until it has been set by hand (a saved renewal that is not inception + 12
 * months was).
 */
export function headerFromPlacement(pd, ref) {
  const types = listOf(ref.treatyTypes);
  const cls = parseClass(pd?.class, types);
  const n = parseNotes(pd?.notes);
  const inception = pd?.inception ? String(pd.inception).slice(0, 10) : '';
  const renewal = pd?.expiry ? String(pd.expiry).slice(0, 10) : '';
  return {
    treatyTypeId: treatyTypeOf(cls.treatyType, types)?.id || cls.treatyType || '',
    classIds: cls.cobs.map((c) => entryOf(ref.classes, c)?.id || c),
    brokerId: entryOf(ref.brokers, n.broker)?.id || n.broker,
    expStartYear: n.expStartYear,
    altContractId: n.altContractId,
    notes: n.rest,
    currencyId: entryOf(ref.currencies, pd?.currency || 'USD')?.id || pd?.currency || 'USD',
    inception,
    renewal,
    renewalManual: !!(inception && renewal && defaultRenewalDate(inception) !== renewal),
    countryId: '',
    cedantId: pd?.cedant_id || '',
    cedantName: '',
    contactName: '',
    contactEmail: '',
  };
}
