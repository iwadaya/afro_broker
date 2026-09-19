/*
 * Reading an inbound loss advice: the fields the desk needs to match it to a
 * contract and load it as a loss event. ChatGPT when configured, constrained
 * to the shape below; the keyword read otherwise — the same convention as
 * the underwriters' replies. Nothing is invented: a figure the notice does
 * not state is 0, a string it does not state is empty.
 */

import { completeJson } from '../../lib/llm.js';

const str = (description) => ({ type: 'string', description });

export const CLAIM_NOTICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'treaty_reference', 'references', 'cedant_name', 'cedant_reference', 'insured', 'cause',
    'date_of_loss', 'advised_reserve', 'paid', 'outstanding', 'currency', 'class', 'attaching_layer', 'summary',
  ],
  properties: {
    treaty_reference: str('The treaty or placement reference the advice is made under, exactly as written; empty if none.'),
    references: { type: 'array', items: { type: 'string' }, description: 'Every reference-like token in the notice (treaty, contract, claim, policy).' },
    cedant_name: str('The cedant (the reinsured) advising the loss; empty if not stated.'),
    cedant_reference: str('The cedant\'s own claim reference; empty if none.'),
    insured: str('The original insured or the event; empty if not stated.'),
    cause: str('The cause or peril, in a few words; empty if not stated.'),
    date_of_loss: str('The date of loss as YYYY-MM-DD; empty if not stated.'),
    advised_reserve: { type: 'number', description: 'The reserve or incurred amount advised, at 100%, as a plain number; 0 if not stated.' },
    paid: { type: 'number', description: 'Paid to date, at 100%; 0 if not stated.' },
    outstanding: { type: 'number', description: 'Outstanding reserve, at 100%; 0 if not stated.' },
    currency: str('ISO currency of the amounts; empty if not stated.'),
    class: str('The class of business the loss falls under; empty if not stated.'),
    attaching_layer: str('The layer the cedant says the loss attaches to, e.g. "Layer 2"; empty if not stated.'),
    summary: str('One sentence on what the notice advises.'),
  },
};

const SYSTEM = [
  'You read loss advices sent to a reinsurance broker by cedants and their claims departments.',
  'Extract the fields exactly as the notice states them. Amounts are at 100% and plain numbers — "USD 4.2m" is 4200000.',
  'Never invent: a figure the notice does not state is 0, a string it does not state is an empty string.',
].join('\n');

function buildPrompt(message) {
  return [
    `Source: ${message.source || 'inbox'}`,
    `From: ${message.sender || ''}`,
    `Subject: ${message.subject || ''}`,
    `Received: ${message.received_at || ''}`,
    '',
    '--- BEGIN NOTICE ---',
    message.body,
    '--- END NOTICE ---',
    '',
    'Extract the loss advice.',
  ].join('\n');
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const pad = (n) => String(n).padStart(2, '0');

/** '02 Sep 2026', 'September 2, 2026', '2026-09-02', '2/9/2026' → '2026-09-02'; '' when unreadable. */
export function parseDate(text) {
  const s = String(text || '').trim();
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[A-Za-z]*\.?,?\s+(\d{4})/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()] != null) return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()] + 1)}-${pad(m[1])}`;
  m = /([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()] != null) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()] + 1)}-${pad(m[2])}`;
  m = /(\d{1,2})[/.](\d{1,2})[/.](\d{4})/.exec(s);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return '';
}

/** 'USD 4.2m', '4,200,000', '650k', 'USD 1.5 million' → a plain number; 0 when unreadable. */
export function parseAmount(text) {
  const s = String(text || '').toLowerCase().replace(/,/g, '');
  const m = /(\d+(?:\.\d+)?)\s*(bn|billion|m|mn|million|k|thousand)?/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2] || '';
  if (/^(bn|billion)$/.test(unit)) return n * 1e9;
  if (/^(m|mn|million)$/.test(unit)) return n * 1e6;
  if (/^(k|thousand)$/.test(unit)) return n * 1e3;
  return n;
}

const field = (text, labels) => {
  for (const label of labels) {
    const m = new RegExp(`${label}\\s*[:\\-–—]\\s*([^\\n]+)`, 'i').exec(text);
    if (m) return m[1].trim().replace(/[.;]\s*$/, '');
  }
  return '';
};

/**
 * The keyword read, for a deployment with no AI key or a call that failed:
 * labelled lines and the reference-like tokens in the subject and body.
 */
export function heuristicNotice(message) {
  const text = `${message.subject || ''}\n${message.body || ''}`;
  const references = [...new Set((text.match(/\b[A-Z]{2,6}(?:-[A-Z0-9]{2,})+\b/g) || []).concat(text.match(/\b[A-Z]{2,6}(?:\/[A-Z0-9]{2,})+\b/g) || []))];
  const treaty = field(text, ['treaty reference', 'treaty ref', 'contract reference', 'contract ref', 'placement reference', 'treaty', 'contract']);
  const reserveText = field(text, ['advised reserve', 'reserve advised', 'reserve', 'incurred', 'estimated loss', 'loss estimate']);
  const currency = (/\b(USD|EUR|GBP|KES|ZAR|NGN|AED|CHF|JPY|AUD|CAD)\b/.exec(text) || [])[1] || '';
  const dol = parseDate(field(text, ['date of loss', 'loss date', 'dol', 'date of occurrence']));
  let insured = field(text, ['insured', 'original insured', 'reinsured', 'name of insured']);
  if (!insured) {
    const m = /loss advice\s*[—–-]\s*([^—–\-\n]+?)\s*[—–-]/i.exec(message.subject || '');
    if (m) insured = m[1].trim();
  }
  return {
    treaty_reference: /^[A-Z0-9/-]+$/i.test(treaty) ? treaty : (references[0] || ''),
    references,
    cedant_name: field(text, ['cedant', 'ceding company', 'reinsured company', 'from cedant']),
    cedant_reference: field(text, ['claim reference', 'claim ref', 'your reference', 'our reference', 'cedant reference', 'claim no', 'claim number']),
    insured,
    cause: field(text, ['cause', 'cause of loss', 'peril', 'nature of loss']),
    date_of_loss: dol,
    advised_reserve: parseAmount(reserveText.replace(/^[A-Z]{3}\s*/i, '')),
    paid: parseAmount(field(text, ['paid to date', 'paid']).replace(/^[A-Z]{3}\s*/i, '')),
    outstanding: parseAmount(field(text, ['outstanding', 'os reserve', 'o/s']).replace(/^[A-Z]{3}\s*/i, '')),
    currency,
    class: field(text, ['class of business', 'class', 'line of business']),
    attaching_layer: field(text, ['attaching layer', 'attaches to', 'layer']),
    summary: (message.subject || '').trim(),
  };
}

/** Read one notice — ChatGPT when configured, the keyword read otherwise. */
export async function readClaimNotice(message, clients) {
  try {
    const { provider, model, data } = await completeJson({
      system: SYSTEM,
      prompt: buildPrompt(message),
      schema: CLAIM_NOTICE_SCHEMA,
      schemaName: 'claim_notice',
      maxTokens: 3000,
      effort: 'low',
    }, clients);
    const heuristic = heuristicNotice(message);
    return {
      ...data,
      references: [...new Set([...(data.references || []), ...heuristic.references])],
      date_of_loss: data.date_of_loss ? parseDate(data.date_of_loss) || data.date_of_loss : '',
      source: 'ai', provider, model, read_at: new Date().toISOString(),
    };
  } catch (err) {
    return { ...heuristicNotice(message), source: 'fallback', provider: null, model: null, reason: err.message, read_at: new Date().toISOString() };
  }
}
