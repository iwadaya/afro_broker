/*
 * The covering email a submission goes out on.
 *
 * Rendered once from the pack, edited by the broker, then sent as edited — so
 * this is a starting draft, not a send-time format. Per-underwriter details
 * stay as {{tokens}} in the stored body and are substituted at send, which
 * lets one reviewed-and-approved email serve every market on the list.
 */

import { HOUSE } from '../../lib/house.js';
const num = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 2 }));

/**
 * `pg` returns DATE columns as JS Date objects, so `String(d).slice(0, 10)`
 * would read "Thu Jan 01"; `toISOString()` can roll a day back west of UTC.
 * Read the local calendar fields instead.
 */
export function isoDay(value) {
  if (value == null || value === '') return '—';
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

export const TOKENS = ['{{contact_name}}', '{{market_name}}'];

/** One line of a structure, as the email lists it. */
function lineLine(line) {
  if (line.basis === 'PROP') {
    const asked = line.asked || {};
    return `    ${line.label}${line.capacity ? ` — capacity ${num(line.capacity)}` : ''}`
      + `${asked.commission_pct != null ? `, commission ${num(asked.commission_pct)}%` : ''}`
      + `${asked.epi != null ? `, EPI ${num(asked.epi)}` : ''}`;
  }
  const asked = line.asked || {};
  return `    ${line.label}: ${num(line.limit)} xs ${num(line.attachment)}`
    + `${asked.premium != null ? `, premium ${num(asked.premium)}` : ''}`
    + `${asked.rate_pct != null ? `, rate ${num(asked.rate_pct)}%` : ''}`;
}

export function renderSubject({ placement, cedant, pack }) {
  return `${cedant?.name || placement.reference} — ${placement.class} — `
    + `${isoDay(placement.inception)} to ${isoDay(placement.expiry)} — renewal pack v${pack.version}`;
}

/**
 * Build the draft covering email. `commentary` is the drafted market
 * commentary; every figure below comes from the pack and the structures, so
 * the email cannot quote something the pack does not contain.
 */
export function renderSubmissionEmail({ placement, cedant, pack, structures = [], wording, commentary, author }) {
  const ccy = placement.currency;
  const summary = pack.summary || {};

  const structureLines = structures.length
    ? structures.flatMap((s) => [
      `  ${s.label} — ${s.basis === 'PROP' ? 'proportional' : 'non-proportional'}`,
      ...(s.lines || []).map(lineLine),
    ])
    : ['  (as set out in the attached pack)'];

  return [
    'Dear {{contact_name}},',
    '',
    `RE: ${cedant?.name || placement.reference} — ${placement.class} — `
    + `${isoDay(placement.inception)} to ${isoDay(placement.expiry)} (${ccy})`,
    '',
    (commentary || '').trim(),
    '',
    'Structures to quote',
    ...structureLines,
    '',
    'Experience summary (renewal pack v' + pack.version + ')',
    `  Ceded premium: ${ccy} ${num(summary.premium_ceded)}`,
    `  Sum insured 100%: ${ccy} ${num(summary.sum_insured_100)}`,
    `  Incurred: ${ccy} ${num(summary.incurred)}`,
    `  Loss ratio: ${summary.loss_ratio_pct != null ? `${num(summary.loss_ratio_pct)}%` : '—'}`,
    '',
    'Enclosed',
    `  Renewal pack v${pack.version}${pack.status === 'approved' ? '' : ' (draft)'}`,
    `  ${wording ? `Wording: ${wording.title}${wording.status ? ` (${wording.status})` : ''}` : 'Wording: to follow'}`,
    '',
    'We look forward to your terms.',
    '',
    'Kind regards,',
    author?.name || 'The broking team',
    HOUSE,
  ].join('\n');
}

/** Substitute the per-underwriter tokens, just before the message is sent. */
export function personalise(body, { contactName, marketName } = {}) {
  return String(body)
    .replaceAll('{{contact_name}}', contactName || 'Underwriter')
    .replaceAll('{{market_name}}', marketName || 'your syndicate');
}
