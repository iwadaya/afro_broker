/*
 * The renewal desk's market email: one standard template, seeded from the
 * verified summary and edited by the broker, sent to each underwriter
 * individually with the {{contact_name}} token filled in at send. Every
 * figure in it comes from the summary the broker signed off — a line whose
 * figure the packs did not state is left out rather than sent blank.
 *
 * Also here: the response deadline and the reminder rule — three days before
 * the deadline, once, to every underwriter who has not replied.
 */

import { HOUSE } from '../../lib/house.js';
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' from a Date, a date string, or a pg DATE (a JS Date at local midnight). */
export function isoDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A calendar date as a Date at local midnight, from 'YYYY-MM-DD'. */
function atMidnight(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'Friday 20 November 2026' — how the email names the deadline. */
export function longDate(iso) {
  if (!iso) return '';
  const d = atMidnight(isoDate(iso));
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * The deadline a fresh draft proposes: fourteen days out, rolled forward off a
 * weekend so it lands on a working day.
 */
export function defaultDeadline(from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 14);
  if (d.getDay() === 6) d.setDate(d.getDate() + 2);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return isoDate(d);
}

/** How many days the reminder goes out before the deadline. */
export const REMINDER_DAYS_BEFORE = 3;

/**
 * Whether a recipient is owed the reminder now: the submission went out, the
 * deadline is within three days and not yet passed, they have not replied, and
 * they have not already been reminded.
 */
export function reminderDue({ deadline, now = new Date(), status, remindedAt, replied }) {
  if (!deadline || status !== 'sent' || remindedAt || replied) return false;
  const end = atMidnight(isoDate(deadline)).getTime() + DAY_MS; // the deadline day itself counts
  const start = end - DAY_MS * (REMINDER_DAYS_BEFORE + 1);
  const t = now.getTime();
  return t >= start && t < end;
}

const clean = (v) => String(v ?? '').trim();

/** The year the renewal incepts, from the placement, else the summary, else the calendar. */
export function renewalYear({ placement, analysis }) {
  const inception = placement?.inception && isoDate(placement.inception);
  if (inception) return inception.slice(0, 4);
  const m = /\b(20\d\d)\b/.exec(clean(analysis?.result?.programme?.inception) + ' ' + clean(analysis?.result?.programme?.treaty_name));
  return m ? m[1] : String(new Date().getFullYear() + 1);
}

/** 'Kenya Reinsurance Corporation — Risk XL 2027 — Firm Order Terms Invited' */
export function deskSubject({ analysis, placement }) {
  const treaty = clean(analysis.result?.programme?.treaty_name).replace(/\s*[—–-]\s*20\d\d\s*$/, '') || analysis.treaty_type;
  return `${analysis.cedant_name} — ${treaty} ${renewalYear({ placement, analysis })} — Firm Order Terms Invited`;
}

/** The attachments the email lists, in the order the chips show them. */
export function attachmentLines(documents = []) {
  const packs = documents.map((d) => d.filename).join(', ');
  return [
    `  1. Renewal pack as received from the cedant${packs ? ` (${packs})` : ''}`,
    '  2. Broker-verified renewal summary, 2 pages',
    '  3. Layer schedule and loss experience',
  ];
}

/**
 * The covering email, drafted from the verified summary. Lines whose figure
 * the packs did not state are omitted — the email never carries a blank or a
 * guess. `{{contact_name}}` is filled in per underwriter at send.
 */
export function renderDeskEmail({ analysis, placement, documents = [], deadline, author }) {
  const prog = analysis.result?.programme || {};
  const year = renewalYear({ placement, analysis });
  const treaty = clean(prog.treaty_name) || analysis.treaty_type;
  const inception = clean(prog.inception) || (placement?.inception ? longDate(placement.inception) : '');
  const layers = clean(prog.layer_count);
  const structure = clean(prog.structure);

  const facts = [
    ['Cedant', analysis.cedant_name],
    ['Class', analysis.class_of_business],
    ['Structure', [layers && `${layers} layer${layers === '1' ? '' : 's'}`, structure].filter(Boolean).join(' — ')],
    ['Basis', clean(prog.basis)],
    ['EPI', clean(prog.epi)],
    ['Deposit premium', clean(prog.deposit_premium)],
    ['Retention', clean(prog.retention)],
  ].filter(([, v]) => clean(v));
  const width = Math.max(...facts.map(([k]) => k.length)) + 2;

  return [
    'Dear {{contact_name}},',
    '',
    `We invite your firm order terms on the ${year} renewal of the ${analysis.cedant_name} ${treaty} programme${inception ? `, incepting ${inception}` : ''}.`,
    '',
    'PROGRAMME',
    ...facts.map(([k, v]) => `  ${k.padEnd(width)}${clean(v)}`),
    '',
    'ATTACHED',
    ...attachmentLines(documents),
    '',
    `We would be grateful for your firm order terms by layer, together with any conditions${
      deadline ? `, by close of business ${longDate(deadline)}` : ''}. Lines are invited on a signing-down basis; the order is 100% of each layer.`,
    '',
    'Kind regards,',
    '',
    author?.name || 'The broking team',
    HOUSE,
  ].join('\n');
}

/** The reminder, three days before the deadline, to an underwriter who has not replied. */
export function renderReminder({ submission, recipient, author }) {
  return [
    `Dear ${recipient.name || 'Underwriter'},`,
    '',
    `A reminder that firm order terms on the submission below are requested by close of business ${longDate(submission.response_deadline)}.`,
    '',
    `  ${submission.subject}`,
    '',
    'If your terms are already on their way, please disregard this note.',
    '',
    'Kind regards,',
    '',
    author?.name || 'The broking team',
    HOUSE,
  ].join('\n');
}
