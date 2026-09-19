/*
 * The narrative half of bordereau analysis: hand the model figures that are
 * already computed and ask it to read them like a treaty underwriter would.
 * It is told not to recompute anything — every number in the output must be
 * one it was given.
 */

import { completeJson } from '../../lib/llm.js';

/** The shape the model is constrained to. */
export const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'headline', 'portfolio_summary', 'premium_analysis', 'claims_analysis',
    'observations', 'data_quality_notes', 'questions_for_cedant', 'renewal_considerations',
  ],
  properties: {
    headline: { type: 'string', description: 'One sentence a broker could paste into an email.' },
    portfolio_summary: { type: 'string', description: 'What this book is: size, spread, exposure.' },
    premium_analysis: { type: 'string', description: 'Premium, rate and exposure commentary.' },
    claims_analysis: { type: 'string', description: 'Loss experience: severity, frequency, drivers.' },
    observations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail', 'severity'],
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'watch', 'concern'] },
        },
      },
    },
    data_quality_notes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'impact'],
        properties: {
          issue: { type: 'string' },
          impact: { type: 'string', description: 'What it means for pricing or placing.' },
        },
      },
    },
    questions_for_cedant: { type: 'array', items: { type: 'string' } },
    renewal_considerations: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM = [
  'You are a reinsurance treaty broker analysing a cedant\'s bordereaux ahead of a renewal.',
  'You are given figures that have already been computed from the bordereau rows, plus a sample of the rows themselves.',
  'Rules:',
  '- Never recompute or restate a total differently from the figures provided. If a figure is absent, say it is not available rather than estimating it.',
  '- Quote figures with their currency and use the same units as given (percentages are already percentages).',
  '- Be specific: name classes, territories, policies and causes of loss from the data.',
  '- Distinguish what the data shows from what it suggests. Flag anything that would change how the risk is priced or placed.',
  '- Data-quality notes should cover both the flags provided and anything you notice in the sample rows.',
  '- Keep each prose field to a short paragraph. Prefer plain broking English over adjectives.',
].join('\n');

/** Everything the model is allowed to reason from. */
export function buildPrompt({ placement, aggregates, sample }) {
  return JSON.stringify({
    placement: placement && {
      reference: placement.reference,
      class: placement.class,
      currency: placement.currency,
      inception: placement.inception,
      expiry: placement.expiry,
      status: placement.status,
      layers: (placement.layers || []).map((l) => ({
        name: l.name,
        type: l.type,
        attachment: l.attachment,
        limit: l.limit_amt,
        premium100: l.premium100,
        reinstatements: l.reinstatements,
        egnpi: l.egnpi,
        rate_pct: l.rate_pct,
        aad: l.aad,
      })),
    },
    computed_figures: aggregates,
    sample_rows: sample,
  }, null, 1);
}

/**
 * Produce the narrative for a set of aggregates. Returns
 * { provider, model, data, attempts }; throws LlmUnavailableError when
 * ChatGPT could not answer.
 */
export function analyseBordereaux({ placement, aggregates, sample }, clients) {
  return completeJson({
    system: SYSTEM,
    prompt: buildPrompt({ placement, aggregates, sample }),
    schema: ANALYSIS_SCHEMA,
    schemaName: 'bordereau_analysis',
    // The output is a page of prose and lists, not a document — and the
    // reading, not the writing, is where the effort goes.
    maxTokens: 8000,
    effort: 'medium',
  }, clients);
}
