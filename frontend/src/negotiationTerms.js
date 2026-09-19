/*
 * The terms a line is quoted on, and how a quote reads against what was sent.
 *
 * An underwriter rarely takes a layer exactly as it was sent: the rate moves,
 * the reinstatements change, an AAD appears, the cover narrows to risk only.
 * Every column of the structure is therefore quotable — and every one of them
 * is read back against the terms the quote was captured on, so what the
 * underwriter actually changed is never lost in the numbers.
 *
 * Shared by the board's quote form and the market-by-market capture sheet, so
 * the two cannot drift on what a column is called or when it counts as moved.
 */

export const REINSTATEMENT_OPTIONS = [
  ...Array.from({ length: 10 }, (_, i) => String(i + 1)), 'UNLIMITED',
];
export const reinstatementLabel = (v) => (v === 'UNLIMITED' ? 'Unlimited' : v || '');
export const LAYER_TYPES = ['QS', 'Surplus', 'XoL', 'Fac'];

export const str = (v) => (v == null ? '' : String(v));
export const numOrNull = (v) => (v === '' || v == null ? null : Number(v));
export const clean = (v) => String(v ?? '').replace(/[^0-9.]/g, '');
export const fmt = (n) => (n == null || n === '' || Number.isNaN(Number(n))
  ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));

/**
 * The quotable columns, in the order the structure tables show them.
 *
 * `np` / `prop` say which basis a column belongs to; `propLabel` renames it
 * where a proportional treaty calls the same figure something else — its EPI
 * is the premium, and it has no separate base to rate against.
 */
export const TERM_COLUMNS = [
  { key: 'layer_name', label: 'Name', kind: 'text', np: true, prop: false },
  { key: 'layer_type', label: 'Type', kind: 'type', np: true, prop: false },
  { key: 'limit_amt', label: 'Limit', kind: 'amount', np: true, prop: false, currency: true },
  { key: 'attachment', label: 'Attachment', kind: 'amount', np: true, prop: false, currency: true },
  { key: 'reinstatements', label: 'Reinstatements', kind: 'reinstatements', np: true, prop: false },
  { key: 'reinstatement_pct', label: 'Reinst. %', kind: 'pct', np: true, prop: false },
  { key: 'egnpi', label: 'EGNPI', kind: 'amount', np: true, prop: false, currency: true },
  { key: 'rate_pct', label: 'Rate %', kind: 'pct', np: true, prop: false },
  { key: 'commission_pct', label: 'Commission %', kind: 'pct', np: false, prop: true },
  { key: 'aad', label: 'AAD', kind: 'amount', np: true, prop: false, currency: true },
  { key: 'order_pct', label: 'Order %', kind: 'pct', np: true, prop: true },
  { key: 'premium', label: 'Premium 100%', propLabel: 'EPI', kind: 'amount', np: true, prop: true, currency: true },
  { key: 'risk_cover', label: 'Risk', kind: 'flag', np: true, prop: false },
  { key: 'cat_cover', label: 'CAT', kind: 'flag', np: true, prop: false },
];

/** The columns a line of this basis is quoted on, each under its own name. */
export const columnsFor = (basis) => TERM_COLUMNS
  .filter((c) => (basis === 'PROP' ? c.prop : c.np))
  .map((c) => (basis === 'PROP' && c.propLabel ? { ...c, label: c.propLabel } : c));

const TEXTUAL = ['text', 'type', 'reinstatements'];

/** How a term reads when shown as what it moved from. */
export function wasLabel(kind, v) {
  if (v == null || v === '') return '—';
  if (kind === 'flag') return v ? 'yes' : 'no';
  if (kind === 'pct') return `${fmt(v)}%`;
  if (TEXTUAL.includes(kind)) return String(v);
  return fmt(v);
}

/**
 * Has this column moved off what the line was sent as?
 *
 * `values` holds the form's strings, `original` the snapshot the quote is read
 * against. A flag absent from the snapshot counts as covered, which is how the
 * structure tables treat it.
 */
export function moved(col, values, original) {
  const from = original?.[col.key] ?? null;
  const to = values[col.key];
  if (col.kind === 'flag') return Boolean(from ?? true) !== Boolean(to !== false);
  if (TEXTUAL.includes(col.kind)) return str(from) !== str(to);
  const a = numOrNull(from);
  const b = numOrNull(to === '' ? null : to);
  if (a === null || b === null) return a !== b;
  // Stored at 4dp; anything finer is rounding, not a movement in terms.
  return Math.abs(a - b) >= 0.00005;
}

/** Every column of this line that moved. */
export const movedColumns = (cols, values, original) => cols.filter((c) => moved(c, values, original));

/** ROL = premium ÷ limit, the reading the structure tables give. */
export function rolOf(values) {
  const limit = Number(values.limit_amt);
  const premium = Number(values.premium);
  if (!limit || !premium || limit <= 0) return '';
  return `${((premium / limit) * 100).toFixed(2)}%`;
}

/**
 * A line's form values: what the market said where it has said anything, else
 * the terms as sent. Accepting a layer as it stands should take no typing.
 */
export function valuesFrom(sent = {}, quote = null) {
  const value = (key) => (quote && quote[key] != null ? quote[key] : sent[key] ?? null);
  const out = {};
  for (const col of TERM_COLUMNS) {
    out[col.key] = col.kind === 'flag' ? (value(col.key) ?? true) : str(value(col.key));
  }
  return out;
}

/** The terms a quote was captured against: its own snapshot, else the line. */
export const originalOf = (sent = {}, quote = null) => (
  quote?.original && Object.keys(quote.original).length ? quote.original : sent
);

/** The quoted columns, as the API takes them. */
export function termPayload(values) {
  return {
    layer_name: str(values.layer_name).trim() || null,
    layer_type: values.layer_type || null,
    limit_amt: numOrNull(values.limit_amt),
    attachment: numOrNull(values.attachment),
    reinstatements: values.reinstatements || null,
    reinstatement_pct: numOrNull(values.reinstatement_pct),
    egnpi: numOrNull(values.egnpi),
    rate_pct: numOrNull(values.rate_pct),
    commission_pct: numOrNull(values.commission_pct),
    aad: numOrNull(values.aad),
    order_pct: numOrNull(values.order_pct),
    premium: numOrNull(values.premium),
    risk_cover: values.risk_cover !== false,
    cat_cover: values.cat_cover !== false,
  };
}
