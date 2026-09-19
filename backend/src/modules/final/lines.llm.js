/*
 * Reading written and signed lines out of an underwriter's email.
 *
 * Once the firm order terms are out, what comes back is a line: "we will
 * write 12.5% of layer 1", "please sign us for 10% across the programme",
 * or a decline. The model reads the email against the lines of the final
 * terms and says, per line, what share the reinsurer is writing — a
 * *reading* the broker sees marked as the AI's and can override, never a
 * booking the broker cannot undo. With no key configured a keyword read
 * stands in, so the flow works offline and in tests.
 */

import { completeJson } from '../../lib/llm.js';

export const LINE_KINDS = ['written', 'signed', 'decline', 'other'];

export const LINES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'summary', 'lines'],
  properties: {
    kind: {
      type: 'string',
      enum: LINE_KINDS,
      description: 'written when the email offers or confirms a written line; signed when it confirms a signed line; decline when the market will not write; other otherwise.',
    },
    summary: { type: 'string', description: 'One sentence, in the underwriter\'s own terms, of what the email says.' },
    lines: {
      type: 'array',
      description: 'One item per line of the final terms the email speaks to. A share the email does not state is null; a share stated for the whole programme is repeated on every line it applies to.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term_key', 'written_pct', 'signed_pct', 'declined', 'evidence'],
        properties: {
          term_key: { type: ['string', 'null'], description: 'The key of the line of the final terms this applies to, from the list given; null when the email does not say which.' },
          written_pct: { type: ['number', 'null'], description: 'The written line as a percentage of the order (12.5 for 12.5%).' },
          signed_pct: { type: ['number', 'null'], description: 'A signed line the email states, as a percentage; null unless stated.' },
          declined: { type: 'boolean' },
          evidence: { type: 'string', description: 'The words of the email that say so.' },
        },
      },
    },
  },
};

const SYSTEM = [
  'You are a reinsurance treaty broker\'s assistant reading a reinsurer\'s email after the firm order terms went out.',
  'You are given the lines of the final terms — each with a key — and the email.',
  'Rules:',
  '- Report only what the email states. A share it does not state is null; never infer a line from silence.',
  '- Percentages as percentages: "12.5%" is 12.5. A share stated "across the programme" or "on all layers" applies to every line given.',
  '- Name the line by its key when the email names the layer or structure; leave term_key null when it does not say.',
  '- A decline is declined: true with written_pct null.',
  '- Quoted text from the broker\'s own email, signatures and disclaimers are not the reply.',
].join('\n');

function buildPrompt(email, context) {
  return JSON.stringify({
    placement: {
      reference: context.reference || null,
      cedant: context.cedant || null,
      class: context.class || null,
      currency: context.currency || null,
      lines: (context.terms || []).map((t) => ({
        term_key: t.key, structure: t.structure_label, line: t.label, basis: t.basis,
        limit: t.limit ?? null, attachment: t.attachment ?? null,
      })),
    },
    email: {
      from: email.from_name ? `${email.from_name} <${email.from_email}>` : email.from_email,
      market: email.market_name || null,
      subject: email.subject || null,
      received_at: email.received_at || null,
      body: String(email.body || '').slice(0, 12000),
    },
  }, null, 1);
}

const num = (m) => (m ? Number(String(m[1]).replace(/,/g, '')) : null);

/**
 * The offline read: keyword rules and the percentage beside them. One line
 * for the whole programme when nothing names a layer; per layer when the
 * email says "layer 1 … %".
 */
export function heuristicLines(text, terms = []) {
  const raw = String(text || '');
  const t = raw.toLowerCase();
  const declined = /\b(decline|declining|unable to (support|write|participate)|not (able|in a position) to (support|write|participate)|will not be (participating|supporting|writing))\b/.test(t);
  const signedHit = /\b(signed (line|share|for|at|down)|sign us (for|at)|signed at)\b/.test(t);
  const writtenHit = /\b(write|writing|written|line of|our line|share of|participate (with|for)|take|support)\b/.test(t);
  const kind = declined ? 'decline' : signedHit ? 'signed' : writtenHit ? 'written' : 'other';
  const firstLines = raw.split('\n').map((l) => l.trim()).filter((l) => l && !/^(dear|hi|hello)\b/i.test(l) && !/^>/.test(l));
  const summary = firstLines.slice(0, 2).join(' ').slice(0, 240) || raw.slice(0, 240);

  const lines = [];
  if (kind === 'decline') {
    for (const term of terms) lines.push({ term_key: term.key, written_pct: null, signed_pct: null, declined: true, evidence: summary });
    return { kind, summary, lines };
  }
  // "layer 1 … 12.5%" / "12.5% on layer 2" / "structure 2 … 10%"
  const named = [];
  const re = /(?:layer|structure)\s*(\d+)[^%\n]{0,60}?([\d.,]+)\s*%|([\d.,]+)\s*%[^%\n]{0,40}?(?:layer|structure)\s*(\d+)/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const idx = Number(m[1] || m[4]);
    const pct = num([null, m[2] || m[3]]);
    if (idx && pct != null) named.push({ idx, pct });
  }
  const pctOf = (item) => ({ written_pct: kind === 'signed' ? null : item.pct, signed_pct: kind === 'signed' ? item.pct : null });
  if (named.length) {
    for (const item of named) {
      const term = terms.find((x) => x.layer_index != null && x.layer_index + 1 === item.idx)
        || terms.find((x) => x.structure_index === item.idx);
      lines.push({ term_key: term?.key || null, ...pctOf(item), declined: false, evidence: raw.slice(Math.max(0, raw.toLowerCase().indexOf(String(item.pct))), 120) });
    }
    return { kind, summary, lines };
  }
  const share = num(/(?:line|share|write|writing|written|sign(?:ed)?(?: us)?(?: for| at)?|participat\w+(?: with| for)?|take)\D{0,20}?([\d.,]+)\s*%/i.exec(raw))
    ?? num(/([\d.,]+)\s*%\s*(?:line|share|written|signed|participation|of the (?:order|programme|program))/i.exec(raw));
  if (share != null) {
    for (const term of terms) lines.push({ term_key: term.key, ...pctOf({ pct: share }), declined: false, evidence: summary });
  }
  return { kind, summary, lines };
}

/** Read one email — ChatGPT when configured, the keyword read otherwise. */
export async function readLines(email, context, clients) {
  try {
    const { provider, model, data } = await completeJson({
      system: SYSTEM,
      prompt: buildPrompt(email, context),
      schema: LINES_SCHEMA,
      schemaName: 'reinsurer_lines',
      maxTokens: 3000,
      effort: 'low',
    }, clients);
    return { ...data, source: 'ai', provider, model, read_at: new Date().toISOString() };
  } catch (err) {
    return {
      ...heuristicLines(email.body, context.terms || []),
      source: 'fallback', provider: null, model: null, reason: err.message, read_at: new Date().toISOString(),
    };
  }
}
