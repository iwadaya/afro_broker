/*
 * The emails of the final placement.
 *
 * Two of them, rendered from the final terms so nothing in them can disagree
 * with what was placed: the firm order terms (with the renewal pack summary)
 * that go to the reinsurers and underwriters who will write the placement,
 * and the confirmation each underwriter is sent once the shares are
 * finalised, carrying their written and signed line. Both are drafts the
 * broker edits before sending; per-underwriter details stay as {{tokens}}
 * and are substituted at send.
 */

import { isoDay } from '../negotiation/submissionEmail.js';
import { HOUSE } from '../../lib/house.js';

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 2 }));
const pct = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '—' : `${Number(v).toLocaleString('en-GB', { maximumFractionDigits: 4 })}%`);

/** One line of the final terms, as the email lists it. */
export function termLine(t, ccy) {
  if (t.basis === 'PROP') {
    return `    ${t.label}: ${t.treaty_type ? `${t.treaty_type}, ` : ''}commission ${pct(t.commission_pct)}`
      + `${t.capacity != null ? `, capacity ${ccy} ${num(t.capacity)}` : ''}`
      + `${t.premium != null ? `, EPI ${ccy} ${num(t.premium)}` : ''}`;
  }
  return `    ${t.label}: ${ccy} ${num(t.limit)} xs ${ccy} ${num(t.attachment)}`
    + `${t.premium != null ? `, premium ${ccy} ${num(t.premium)}` : ''}`
    + `${t.rate_pct != null ? `, rate ${pct(t.rate_pct)}` : ''}`;
}

/** The final terms grouped by structure. */
function termsBlock(final, ccy) {
  const groups = new Map();
  for (const t of final.terms || []) {
    const g = t.structure_label || `Structure ${t.structure_index || ''}`.trim();
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  if (!groups.size) return ['  (as set out in the attached pack)'];
  return [...groups.entries()].flatMap(([g, lines]) => [`  ${g}`, ...lines.map((t) => termLine(t, ccy))]);
}

export function renderFotSubject({ placement, cedant }) {
  return `Firm order terms — ${cedant?.name || placement.reference} — ${placement.class} — `
    + `${isoDay(placement.inception)} to ${isoDay(placement.expiry)}`;
}

/** The firm order terms, to the underwriters asked to write the placement. */
export function renderFotEmail({ placement, cedant, final, pack, author }) {
  const ccy = placement.currency;
  const summary = pack?.summary || {};
  return [
    'Dear {{contact_name}},',
    '',
    `RE: ${cedant?.name || placement.reference} — ${placement.class} — `
    + `${isoDay(placement.inception)} to ${isoDay(placement.expiry)} (${ccy}) — firm order terms`,
    '',
    `Further to the negotiation, we are pleased to confirm the firm order terms on which the ${placement.class} programme of `
    + `${cedant?.name || placement.reference} is being placed${final.lead_reinsurer_name ? `, led by ${final.lead_reinsurer_name}` : ''}`
    + `${final.lead_won ? '' : ` with ${final.lead_broker || 'the lead broker'} as lead broker`}. `
    + 'We would be grateful for your written line on these terms.',
    '',
    'Firm order terms',
    ...termsBlock(final, ccy),
    ...(final.treaty_type ? ['', `Type of treaty: ${final.treaty_type}`] : []),
    ...(final.notes ? ['', final.notes] : []),
    '',
    ...(pack ? [
      `Experience summary (renewal pack v${pack.version})`,
      `  Ceded premium: ${ccy} ${num(summary.premium_ceded)}`,
      `  Sum insured 100%: ${ccy} ${num(summary.sum_insured_100)}`,
      `  Incurred: ${ccy} ${num(summary.incurred)}`,
      `  Loss ratio: ${summary.loss_ratio_pct != null ? pct(summary.loss_ratio_pct) : '—'}`,
      '',
      'Enclosed',
      `  Renewal pack v${pack.version}`,
      '',
    ] : []),
    'Please confirm the line you are able to write, and any subjectivities, by return. [State the date written lines are needed by.]',
    '',
    'Kind regards,',
    author?.name || 'The broking team',
    HOUSE,
  ].join('\n');
}

export function renderConfirmationSubject({ placement, cedant }) {
  return `Signed line confirmation — ${cedant?.name || placement.reference} — ${placement.class} — `
    + `${isoDay(placement.inception)} to ${isoDay(placement.expiry)}`;
}

/** The confirmation of an underwriter's written and signed lines. {{lines}} is
    filled per market at send with their own lines. */
export function renderConfirmationEmail({ placement, cedant, final, author }) {
  const ccy = placement.currency;
  return [
    'Dear {{contact_name}},',
    '',
    `RE: ${cedant?.name || placement.reference} — ${placement.class} — `
    + `${isoDay(placement.inception)} to ${isoDay(placement.expiry)} (${ccy}) — confirmation of signed lines`,
    '',
    `Thank you for your support of the ${placement.class} programme of ${cedant?.name || placement.reference}. `
    + 'The placement is now complete and the shares have been finalised. We confirm the line signed to {{market_name}} as follows:',
    '',
    '{{lines}}',
    '',
    'Firm order terms',
    ...termsBlock(final, ccy),
    '',
    'Signing slips and closings will follow. Please let us know at once if anything above does not match your records.',
    '',
    'Kind regards,',
    author?.name || 'The broking team',
    HOUSE,
  ].join('\n');
}

export function renderDeclinatureSubject({ placement, cedant }) {
  return `With thanks — ${cedant?.name || placement.reference} — ${placement.class} — `
    + `${isoDay(placement.inception)} to ${isoDay(placement.expiry)}`;
}

/**
 * The courtesy note to a market that declined: the placement is complete,
 * their answer is on the record, and the door is open for next year. No
 * line of anyone else's is in it.
 */
export function renderDeclinatureEmail({ placement, cedant, author }) {
  const ccy = placement.currency;
  return [
    'Dear {{contact_name}},',
    '',
    `RE: ${cedant?.name || placement.reference} — ${placement.class} — `
    + `${isoDay(placement.inception)} to ${isoDay(placement.expiry)} (${ccy})`,
    '',
    `Thank you for considering the ${placement.class} programme of ${cedant?.name || placement.reference}. `
    + 'The placement is now complete, and we have noted that {{market_name}} was not able to support it this year.',
    '',
    'We would be glad to bring the programme to you again at the next renewal, and to discuss before then what would make it writable for you.',
    '',
    'Kind regards,',
    author?.name || 'The broking team',
    HOUSE,
  ].join('\n');
}

/** The lines block for one market: written and signed per line of the terms. */
export function linesBlock(lines, terms) {
  const label = (key) => terms.find((t) => t.key === key)?.label || key;
  return lines.map((l) => `  ${label(l.term_key)}: written ${pct(l.written_pct)}, signed ${pct(l.signed_pct ?? l.written_pct)}`).join('\n');
}

/** Substitute the per-underwriter tokens just before a message is sent. */
export function personaliseFinal(body, { contactName, marketName, lines } = {}) {
  return String(body)
    .replaceAll('{{contact_name}}', contactName || 'Underwriter')
    .replaceAll('{{market_name}}', marketName || 'your company')
    .replaceAll('{{lines}}', lines || '  (no lines recorded)');
}
