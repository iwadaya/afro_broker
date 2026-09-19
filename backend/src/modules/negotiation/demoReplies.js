/*
 * Demo: the underwriters reply.
 *
 * For a demonstration with no mailbox connected, this has the AI play each
 * underwriter a submission went to and write back — a quote with terms, a
 * decline, a question, an acknowledgement — in the market's own voice, from
 * the covering email and the structures it asked them to price. Each reply
 * is recorded exactly as an inbox message would be (source `demo`), and
 * then read by the usual reader, so the Responses card fills the way it
 * would on a live placement. Without ChatGPT a written template stands in,
 * with figures derived from the structures, so the demo runs offline.
 */

import { query } from '../../db/pool.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { completeJson } from '../../lib/llm.js';
import { recordReply, replyContext } from './replies.js';

export const SCENARIOS = ['quote', 'question', 'decline', 'acknowledgement'];

const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body'],
  properties: {
    subject: { type: 'string', description: 'The reply subject, normally "RE: " and the original subject.' },
    body: { type: 'string', description: 'The full email reply, plain text, salutation to sign-off, as the underwriter would send it.' },
  },
};

const SYSTEM = [
  'You are a treaty reinsurance underwriter replying by email to a broker\'s renewal submission. This is a demonstration: write a realistic reply in the underwriter\'s own voice.',
  'You are given the market and underwriter you are, the broker\'s covering email, the structures you were asked to quote, and the kind of reply to write.',
  'Rules:',
  '- Plain email text: salutation, two to five short paragraphs, sign-off with the underwriter\'s name and market. No markdown, no headings.',
  '- quote: offer terms on the structures — per layer a rate (on line or on EGNPI) or premium, the line/share you offer, and one or two subjectivities; a proportional structure gets a commission and a share. Figures should be plausible against what the broker asked, a little firmer than asked. State a validity date.',
  '- decline: say clearly you cannot support this year and give one credible reason (aggregate, appetite, the experience, pricing).',
  '- question: ask two or three specific questions you need answered before you can quote, referring to what the pack shows.',
  '- acknowledgement: confirm receipt and say when you will revert.',
  '- Never quote from the broker\'s email at length, never mention that this is generated.',
].join('\n');

/** The structures as the demo underwriter sees them. */
function structuresFor(context) {
  return (context?.structures || []).map((s) => ({
    structure: s.structure, basis: s.basis, layers: s.layers,
  }));
}

/** Cycle the scenarios across the recipients, so the first always quotes. */
export function scenarioFor(index, only) {
  if (only && SCENARIOS.includes(only)) return only;
  return SCENARIOS[index % SCENARIOS.length];
}

const money = (n) => Number(n || 0).toLocaleString('en-GB', { maximumFractionDigits: 0 });
const day = (d) => d.toISOString().slice(0, 10);

/** The offline underwriter: a written reply with figures derived from the structures. */
export function templateReply({ scenario, recipient, context, subject, index = 0 }) {
  const uw = recipient.name || 'The underwriter';
  const market = recipient.market_name || 'the market';
  const cedant = context?.cedant || 'the cedant';
  const klass = context?.class || 'the programme';
  const ccy = context?.currency || '';
  const validity = new Date(Date.now() + (14 + index * 3) * 24 * 60 * 60 * 1000);
  const re = `RE: ${subject}`;
  const greeting = 'Dear Broker,';
  const signoff = `\n\nKind regards,\n${uw}\n${market}`;

  if (scenario === 'decline') {
    const reasons = [
      `our aggregate in this territory is fully deployed for the coming year`,
      `the loss experience set out in the pack does not meet our pricing at the structure proposed`,
      `${klass} is outside our appetite this renewal`,
    ];
    return {
      subject: re,
      body: `${greeting}\n\nThank you for sending us the renewal pack for ${cedant} (${klass}). We have reviewed it with interest.\n\nUnfortunately we are unable to support this programme this year, as ${reasons[index % reasons.length]}. We would be glad to look again at the next renewal.${signoff}`,
    };
  }
  if (scenario === 'question') {
    return {
      subject: re,
      body: `${greeting}\n\nThank you for the renewal pack for ${cedant}. Before we can put terms forward, could you please confirm the following?\n\n1. What is the as-at date of the loss run in the pack, and are the large losses shown on a gross or net basis?\n2. Has the cedant's retention or underwriting guideline changed since the expiring year?\n3. Could you send the CRESTA aggregates by zone, and any cat model output you hold?\n\nWe will revert with terms promptly once we have these.${signoff}`,
    };
  }
  if (scenario === 'acknowledgement') {
    return {
      subject: re,
      body: `${greeting}\n\nReceived with thanks. The ${cedant} ${klass} renewal pack has been passed to our pricing team and we will revert with terms by ${day(validity)}.${signoff}`,
    };
  }
  // quote
  const lines = [];
  for (const s of structuresFor(context)) {
    if (s.basis === 'PROP') {
      const asked = Number(s.layers?.[0]?.commissionPct ?? s.layers?.[0]?.commission_pct ?? 30);
      lines.push(`${s.structure} (proportional): we offer a ${10 + index * 5}% share at a commission of ${Math.max(asked - 2.5, 5)}%, with a profit commission to be discussed.`);
    } else {
      (s.layers || []).forEach((l, li) => {
        const askedRate = Number(l.rate_pct);
        const rate = askedRate ? (askedRate * (1.08 + index * 0.04)).toFixed(2) : (7 + li * 1.5 + index).toFixed(2);
        const premium = l.premium ? money(Number(l.premium) * (1.08 + index * 0.04)) : null;
        const line = 10 + index * 5 + li * 2.5;
        lines.push(`${s.structure}, ${l.label || `Layer ${li + 1}`}${l.limit ? ` (${ccy} ${money(l.limit)} xs ${money(l.attachment)})` : ''}: rate on line ${rate}%${premium ? `, premium ${ccy} ${premium}` : ''}, line ${line}%.`);
      });
    }
  }
  if (!lines.length) lines.push(`We offer a rate on line of ${(7.5 + index).toFixed(2)}% for a ${10 + index * 5}% line on the structure as presented.`);
  return {
    subject: re,
    body: `${greeting}\n\nThank you for the renewal pack for ${cedant} (${klass}). We have reviewed the experience and the structures to quote and are pleased to offer the following terms:\n\n${lines.map((l) => `- ${l}`).join('\n')}\n\nSubject to: no losses in excess of the attachment between now and inception, and sight of the final wording. These terms are valid until ${day(validity)}.${signoff}`,
  };
}

/** One demo reply — ChatGPT in the underwriter's voice, or the template. */
export async function draftDemoReply({ scenario, recipient, context, submission, index }, clients) {
  try {
    const { data, provider, model } = await completeJson({
      system: SYSTEM,
      prompt: JSON.stringify({
        you_are: { underwriter: recipient.name || 'the underwriter', market: recipient.market_name },
        reply_kind: scenario,
        brokers_email: { subject: submission.subject, body: String(submission.body || '').slice(0, 6000) },
        cedant: context?.cedant, class: context?.class, period: context?.period, currency: context?.currency,
        structures_to_quote: structuresFor(context),
      }, null, 1),
      schema: REPLY_SCHEMA,
      schemaName: 'demo_underwriter_reply',
      maxTokens: 3000,
      effort: 'low',
    }, clients);
    return { ...data, generated_by: 'ai', provider, model };
  } catch (err) {
    return { ...templateReply({ scenario, recipient, context, subject: submission.subject, index }), generated_by: 'template', reason: err.message };
  }
}

/**
 * Have every underwriter still awaited on this placement's sent submissions
 * reply. `only` pins every reply to one scenario; otherwise they cycle
 * quote → question → decline → acknowledgement, so the first always quotes.
 */
export async function simulateReplies(placementId, { only, clients, userId } = {}) {
  if (only && !SCENARIOS.includes(only)) throw new ValidationError(`Unknown scenario "${only}" — use ${SCENARIOS.join(', ')}`);
  const { rows: placementRows } = await query('SELECT id FROM placement WHERE id = $1', [placementId]);
  if (!placementRows[0]) throw new NotFoundError('Placement');
  const { rows: awaiting } = await query(
    `SELECT r.id AS recipient_id, r.submission_id, r.market_id, r.name, r.email, m.name AS market_name,
            s.subject, s.body
     FROM negotiation_submission_recipient r
     JOIN negotiation_submission s ON s.id = r.submission_id
     JOIN market m ON m.id = r.market_id
     WHERE s.placement_id = $1 AND s.status = 'sent' AND r.status = 'sent' AND r.reply_status = 'awaiting'
     ORDER BY s.sent_at DESC, m.name`,
    [placementId],
  );
  const replies = [];
  let index = 0;
  for (const recipient of awaiting) {
    const scenario = scenarioFor(index, only);
    const context = await replyContext(recipient.submission_id, recipient.recipient_id);
    const drafted = await draftDemoReply({
      scenario, recipient, context, index,
      submission: { subject: recipient.subject, body: recipient.body },
    }, clients);
    const { reply } = await recordReply({
      submission_id: recipient.submission_id,
      recipient_id: recipient.recipient_id,
      placement_id: placementId,
      market_id: recipient.market_id,
      from_email: recipient.email,
      from_name: recipient.name,
      subject: drafted.subject,
      body: drafted.body,
      source: 'demo',
    }, { clients, userId });
    replies.push({ ...reply, market_name: recipient.market_name, scenario, generated_by: drafted.generated_by });
    index += 1;
  }
  return { awaiting: awaiting.length, replies };
}
