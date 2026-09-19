/*
 * The market commentary that opens a submission.
 *
 * The model is handed figures that are already computed — the pack summary and
 * the structures the market is being asked to quote — and writes the covering
 * paragraphs a broker would write. It never prices, never invents a loss, and
 * leaves a [bracketed] placeholder wherever the judgement is the broker's.
 *
 * Whatever comes back is a *draft*: the negotiation tab makes the broker read
 * and edit it, and a second pair of eyes releases the send. When ChatGPT is
 * not configured (or the request fails) the deterministic draft below stands
 * in, so the flow works offline and in tests.
 */

import { completeJson } from '../../lib/llm.js';
import { isoDay } from './submissionEmail.js';

export const COMMENTARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['offer', 'experience', 'ask'],
  properties: {
    offer: {
      type: 'string',
      description: 'What is being offered: cedant, class, period, and how the structure is put up.',
    },
    experience: {
      type: 'string',
      description: 'What the experience and exposure figures show, using only the figures given.',
    },
    ask: {
      type: 'string',
      description: 'What the underwriter is being asked for: terms, line, subjectivities, timing.',
    },
  },
};

const SYSTEM = [
  'You are a reinsurance treaty broker writing the covering email that takes a renewal pack to market.',
  'You are given the placement, the pack summary figures, the structures the market is being asked to quote, and the wording on offer.',
  'Rules:',
  '- Three short paragraphs, one per field. Plain broking English, no headings, no bullet lists, no salutation and no sign-off — those are added around you.',
  '- Use only the figures you are given, with their currency and units as given (percentages are already percentages). If a figure is absent, say so rather than estimating it.',
  '- Never quote or imply a price, rate or commission the broker has not given you, and never promise terms.',
  '- No superlatives and no selling: state what the risk is and what is being asked for.',
  '- Where a judgement is the broker\'s — how the structure has moved year on year, why the experience reads as it does, the quote deadline — leave a short [bracketed] instruction to the broker instead of guessing.',
].join('\n');

/** Everything the model is allowed to reason from. */
export function buildPrompt({ placement, cedant, pack, structures, wording }) {
  return JSON.stringify({
    placement: {
      reference: placement.reference,
      cedant: cedant?.name || null,
      class: placement.class,
      currency: placement.currency,
      inception: placement.inception,
      expiry: placement.expiry,
    },
    renewal_pack: {
      version: pack.version,
      status: pack.status,
      basis: pack.summary?.basis || pack.snapshot?.summary?.basis || null,
      computed_figures: pack.summary || pack.snapshot?.loss_summary || {},
    },
    structures_to_quote: (structures || []).map((s) => ({
      label: s.label,
      basis: s.basis,
      lines: (s.lines || []).map((l) => ({
        label: l.label,
        limit: l.limit ?? null,
        attachment: l.attachment ?? null,
        capacity: l.capacity ?? null,
        asked: l.asked || null,
      })),
    })),
    wording: wording ? { title: wording.title, status: wording.status, clauses: wording.clause_count ?? null } : null,
  }, null, 1);
}

/**
 * Draft the commentary. Returns `{ paragraphs, commentary, source, provider,
 * model }` — `source` is 'ai' when ChatGPT answered and 'fallback' when the
 * deterministic draft stood in.
 */
export async function draftCommentary(context, clients) {
  try {
    const { provider, model, data } = await completeJson({
      system: SYSTEM,
      prompt: buildPrompt(context),
      schema: COMMENTARY_SCHEMA,
      schemaName: 'market_commentary',
      // Three paragraphs of prose: the reading is the work, not the writing —
      // but the cap covers the model's reasoning tokens too, so leave headroom.
      maxTokens: 8000,
      effort: 'medium',
    }, clients);
    const paragraphs = [data.offer, data.experience, data.ask].map((p) => String(p || '').trim()).filter(Boolean);
    if (!paragraphs.length) throw new Error('empty commentary');
    return {
      paragraphs,
      commentary: paragraphs.join('\n\n'),
      source: 'ai',
      provider,
      model,
      generated_at: new Date().toISOString(),
    };
  } catch (err) {
    const paragraphs = fallbackParagraphs(context);
    return {
      paragraphs,
      commentary: paragraphs.join('\n\n'),
      source: 'fallback',
      provider: null,
      model: null,
      reason: err.message,
      generated_at: new Date().toISOString(),
    };
  }
}

// A figure the pack does not have is not a figure: `0` here means the pack has
// nothing to say, and the commentary says so rather than asserting a zero.
const money = (ccy, v) => (v == null || Number(v) === 0
  ? null
  : `${ccy} ${Number(v).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`);

/**
 * The offline draft. Deliberately thin: it states what the pack already says
 * and hands every judgement back to the broker in brackets.
 */
export function fallbackParagraphs({ placement, cedant, pack, structures, wording }) {
  const ccy = placement.currency;
  const summary = pack.summary || {};
  const shape = (structures || []).length
    ? (structures || []).map((s) => `${s.label} (${s.basis === 'PROP' ? 'proportional' : `non-proportional, ${(s.lines || []).length} layer${(s.lines || []).length === 1 ? '' : 's'}`})`).join(' and ')
    : 'the structure set out in the attached pack';

  const premium = money(ccy, summary.premium_ceded);
  const incurred = money(ccy, summary.incurred);
  const experience = premium && incurred
    ? `The pack shows ceded premium of ${premium} against incurred of ${incurred}${summary.loss_ratio_pct != null ? `, a loss ratio of ${summary.loss_ratio_pct}%` : ''}.`
    : 'The premium and claims experience is set out in the attached pack.';

  return [
    `We are pleased to offer you the ${placement.class} programme of ${cedant?.name || placement.reference} `
    + `incepting ${isoDay(placement.inception)}. We are seeking terms on ${shape}. `
    + '[Confirm how the structure has moved year on year, and anything the market should know about the cedant.]',

    `${experience} [Add your commentary on what drives the experience, and on any change in exposure or `
    + 'portfolio mix since the last renewal.]',

    'We would welcome your terms on the basis set out in the pack, together with your indicated line and any '
    + `subjectivities${wording ? `, on ${wording.title}` : ''}. [State the quote deadline and the lead you are seeking.] `
    + 'Any questions on the pack, please come back to us and we will revert promptly.',
  ];
}
