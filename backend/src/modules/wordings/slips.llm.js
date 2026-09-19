/*
 * The AI reading of a slip comparison. The deterministic clause table
 * (slips.service.js) says where the text moved; this asks ChatGPT to say
 * which of those movements matter — and, what clause alignment cannot do,
 * to pull the commercial terms out of the slips themselves and check them:
 * limits, attachments, reinstatements and their cost, aggregates, premium
 * and rate, brokerage, period, territory. Those terms usually live in the
 * slip schedule rather than in a clause, so the model reads the full slip
 * text, not just the aligned clauses.
 *
 * Nothing here is stored: the commentary is a reading aid on the comparison
 * screen, regenerated on demand.
 */

import { completeJson } from '../../lib/llm.js';

/** The shape the model is constrained to. */
export const SLIP_COMMENTARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'wording_commentary', 'key_terms', 'concerns', 'questions_for_market'],
  properties: {
    summary: {
      type: 'string',
      description: 'A short paragraph a broker could paste into an email: what this slip (or these slips) would change, wording and commercial terms together.',
    },
    wording_commentary: {
      type: 'string',
      description: 'Reading of the clause comparison: which non-standard movements matter and why, what the additional clauses do, which missing clauses need restoring before signing.',
    },
    key_terms: {
      type: 'array',
      description: 'The commercial terms as the slips state them — limits, attachments/deductibles, reinstatements and their cost, aggregates/AADs, premium and rate, brokerage, period, territorial scope. One row per term found, plus a row for any term a treaty of this type should state but the slip does not.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'category', 'slip_a', 'slip_b', 'status', 'commentary'],
        properties: {
          term: { type: 'string', description: 'e.g. "Limit — Layer 1", "Reinstatements", "Rate on line", "Brokerage".' },
          category: {
            type: 'string',
            enum: ['limit', 'attachment', 'reinstatements', 'aggregate', 'premium', 'brokerage', 'period', 'territory', 'other'],
          },
          slip_a: { type: ['string', 'null'], description: 'The term exactly as slip A states it, units and currency as written; null when slip A does not state it.' },
          slip_b: { type: ['string', 'null'], description: 'The same for slip B when two slips are compared; null otherwise.' },
          status: {
            type: 'string',
            enum: ['stated', 'differs', 'missing', 'unclear'],
            description: 'stated: present and consistent; differs: the slips state it differently; missing: not stated anywhere it should be; unclear: stated ambiguously or self-contradictory.',
          },
          commentary: { type: 'string', description: 'What it means for the placement; an empty string where the figure speaks for itself.' },
        },
      },
    },
    concerns: {
      type: 'array',
      description: 'What would change how this is signed or priced: onerous wording movements, missing or inconsistent terms, reinstatement provisions that do not match the schedule, and the like.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'detail'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          detail: { type: 'string' },
        },
      },
    },
    questions_for_market: {
      type: 'array',
      items: { type: 'string' },
      description: 'What to put back to the market(s) before agreeing the wording.',
    },
  },
};

const SYSTEM = [
  'You are a senior treaty reinsurance broker reviewing slip wordings that have come back from markets.',
  'You are given the full text of one or two slips, plus a computed clause-by-clause comparison against the broker\'s standard wording (flags: standard, non_standard, additional, missing).',
  'Rules:',
  '- The comparison flags are computed — do not recompute them. Read them and say which movements matter commercially and which are cosmetic.',
  '- Check the commercial terms in the slip text itself — limits, attachments/deductibles, reinstatements (number and cost), annual aggregates and AADs, premium, rates, brokerage, period, territorial scope — including where they sit in the schedule rather than in a clause.',
  '- Quote every figure exactly as the slip states it, currency and units as written. Never compute, convert or estimate a number.',
  '- With two slips, line their terms up against each other and flag every difference.',
  '- Where a term a treaty of this type should state is absent, report it as missing rather than guessing at it.',
  '- Flag internal inconsistencies: a schedule figure contradicted by a clause, a reinstatement clause with no reinstatement provision in the schedule, a limit that does not tie to the layering, and the like.',
  '- Write for a professional broking audience: precise, quantified, and candid.',
].join('\n');

// A slip is a contract, not a book — but scanned PDFs can extract long.
// Cap what goes to the model and say so, rather than failing the request.
const MAX_SLIP_CHARS = 60_000;

/** Everything the model is allowed to reason from. */
export function buildPrompt({ comparison, slips }) {
  const lines = [
    `Standard wording set: ${comparison.standard.label} (${comparison.standard.clause_count} clauses).`,
    comparison.mode === 'slip_vs_slip'
      ? 'Two slips are compared: against the standard wording, and against each other.'
      : 'One slip is checked against the standard wording.',
    `Clause comparison summary (computed): ${JSON.stringify(comparison.summary)}`,
    [
      'Clause flags (computed):',
      ...comparison.rows.map((r) => `- ${r.title}${r.clause_ref ? ` [${r.clause_ref}]` : ''} (${r.category}): ${r.flag}${r.slip_match ? `; slips ${r.slip_match}` : ''}`),
    ].join('\n'),
  ];
  slips.forEach((s, i) => {
    const letter = i === 0 ? 'A' : 'B';
    const text = s.text.length > MAX_SLIP_CHARS
      ? `${s.text.slice(0, MAX_SLIP_CHARS)}\n[slip truncated at ${MAX_SLIP_CHARS} characters]`
      : s.text;
    lines.push(`Slip ${letter} — "${s.name}":\n--- BEGIN SLIP ---\n${text}\n--- END SLIP ---`);
  });
  lines.push('Produce the commentary: the summary, the wording commentary, the key commercial terms check (limits, attachments, reinstatements, aggregates, premium, brokerage, period, territory), the concerns, and the questions for the market.');
  return lines.join('\n\n');
}

/**
 * Run the commentary. `slips` is [{ name, text }] in the same order as the
 * comparison. Returns { provider, model, data, attempts }; throws
 * LlmUnavailableError when ChatGPT cannot serve it. `clients` is the test
 * injection point, passed straight through to completeJson.
 */
export function analyseSlipComparison({ comparison, slips }, clients) {
  return completeJson({
    system: SYSTEM,
    prompt: buildPrompt({ comparison, slips }),
    schema: SLIP_COMMENTARY_SCHEMA,
    schemaName: 'slip_comparison_commentary',
    maxTokens: 12000,
    effort: 'high',
  }, clients);
}
