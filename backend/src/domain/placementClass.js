/**
 * The placement's class string, split back into what the wizard wrote it from.
 *
 * A placement stores one string — "Property / Motor Quota Share" — that is
 * the classes of business joined by " / " followed by the Universe treaty
 * type name. The register, the renewal wizard and the pack builder all need
 * the two halves apart, so they are split here (and, from migration 050,
 * kept on the row as `treaty_type` and `class_of_business` for search).
 *
 * The treaty type is matched longest name first, so "Quota Share & Surplus"
 * is not read as a surplus; records written before the reference data carry
 * the wizard's older codes, which resolve to their Universe names.
 */

export const TREATY_TYPE_NAMES = [
  'Quota Share & Surplus', 'Quota Share', 'First Surplus', 'Second Surplus', 'Third Surplus',
  'Fac Oblig', 'Risk & CAT XL', 'Risk XL', 'CAT XL', 'Stop Loss', 'Aggregate XL',
];

export const LEGACY_TREATY_TYPES = {
  QS: 'Quota Share', Surplus: 'First Surplus', XoL: 'Risk XL', XL: 'Risk XL', Fac: 'Fac Oblig',
};

const text = (v) => (v == null ? '' : String(v).trim());

/**
 * @returns {{ treaty_type: string|null, cobs: string[] }}
 */
export function splitClass(cls, names = TREATY_TYPE_NAMES) {
  const whole = text(cls);
  const lower = whole.toLowerCase();
  const cobsOf = (head) => head.split(' / ').map((c) => c.trim()).filter(Boolean);
  const ordered = [...names].sort((a, b) => b.length - a.length);
  for (const t of ordered) {
    if (lower === t.toLowerCase() || lower.endsWith(` ${t.toLowerCase()}`)) {
      return { treaty_type: t, cobs: cobsOf(whole.slice(0, whole.length - t.length)) };
    }
  }
  const words = whole.split(/\s+/);
  const last = words[words.length - 1];
  const legacy = Object.keys(LEGACY_TREATY_TYPES).find((k) => k.toLowerCase() === (last || '').toLowerCase());
  if (legacy) {
    return { treaty_type: LEGACY_TREATY_TYPES[legacy], cobs: cobsOf(words.slice(0, -1).join(' ')) };
  }
  return { treaty_type: null, cobs: whole ? [whole] : [] };
}

/** The two search columns a class string writes to. */
export function classColumns(cls) {
  const { treaty_type, cobs } = splitClass(cls);
  return { treaty_type, class_of_business: cobs.length ? cobs.join(' / ') : null };
}
