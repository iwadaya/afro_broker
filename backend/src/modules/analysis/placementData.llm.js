/*
 * The Data screen's reading: everything entered on the placement's screens —
 * treaty detail, expiring structure, structures to quote, retentions and the
 * modelling screens — read by the model against the year it renews (the
 * prior placement in the book) or against the expiring renewal pack uploaded
 * for a placement new to the house, in whatever format the other broker
 * wrote it. The figures are handed over already computed; the model reads,
 * compares and comments, and never recalculates.
 */

import { completeJson } from '../../lib/llm.js';
import { prepareDocuments } from './renewalPack.llm.js';

export const DATA_ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'headline', 'programme', 'exposure_and_experience', 'retentions_and_terms',
    'comparison', 'gaps', 'questions_for_cedant', 'recommendations',
  ],
  properties: {
    headline: { type: 'string', description: 'One sentence a broker could paste into an email.' },
    programme: { type: 'string', description: 'The programme as the screens describe it: treaty type, classes, structures to quote and their layers or proportional terms.' },
    exposure_and_experience: { type: 'string', description: 'What the modelling screens say — triangles, losses, profiles, exposure — and what stands out.' },
    retentions_and_terms: { type: 'string', description: 'The table of retentions and the terms asked for, and anything unusual in them.' },
    comparison: {
      type: 'array',
      description: 'Every material change between this year and the basis of comparison, quantified where the data allows. Empty when there is nothing to compare with.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['area', 'change', 'direction', 'significance', 'commentary'],
        properties: {
          area: { type: 'string', description: 'Structure, Retentions, Exposure, Experience, Terms, Treaty detail…' },
          change: { type: 'string' },
          direction: { type: 'string', enum: ['improved', 'deteriorated', 'unchanged', 'unclear'] },
          significance: { type: 'string', enum: ['high', 'medium', 'low'] },
          commentary: { type: 'string' },
        },
      },
    },
    gaps: { type: 'array', items: { type: 'string' }, description: 'Screens with no data, thin data, or figures that do not reconcile.' },
    questions_for_cedant: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM = [
  'You are a senior treaty reinsurance broker reading everything a broker has entered for a placement ahead of building its renewal pack.',
  'You are given the placement\'s screens as structured data — treaty detail, expiring structure, structures to quote, table of retentions, modelling screens — plus, where one exists, the basis of comparison: the prior year\'s placement from the book, or the expiring renewal pack uploaded from another broker (in whatever format it came).',
  'Rules:',
  '- Never recompute or restate a figure differently from the data given. Where a figure is absent say so; never estimate.',
  '- Quote figures with their currency and units; percentages are already percentages.',
  '- Compare this year against the basis wherever both say something about the same thing — structure, limits, attachments, premiums and rates, commissions, retentions, exposure, experience — and quantify each movement.',
  '- Judge each change from the reinsurer\'s side: improved means easier to place or more attractive to markets, deteriorated means harder to place or deserving a price correction.',
  '- An uploaded expiring pack from another broker is in that broker\'s own layout: read it for what it says and map it onto the screens here rather than expecting the same headings.',
  '- Be specific and candid: name the screens with no data as gaps, and list the questions the cedant would have to answer before the pack goes to market.',
].join('\n');

/**
 * The prompt: this year's digest, the computed comparison, and the basis —
 * the prior year's digest or the uploaded pack (its earlier AI reading where
 * one exists, and the documents themselves inlined or attached).
 */
export function buildDataPrompt({ digest, computed, comparison, inline = [], unreadable = [] }) {
  const parts = [
    `Placement ${digest.placement.reference} — ${digest.placement.cedant || 'cedant unknown'}; ${digest.placement.class}; ${digest.placement.currency}; ${digest.placement.inception} to ${digest.placement.expiry}.`,
    'THIS YEAR — the placement\'s screens, as structured data:',
    JSON.stringify(digest, null, 1),
  ];
  if (comparison.basis === 'prior_year') {
    parts.push(`BASIS OF COMPARISON — the prior year's placement ${comparison.prior.placement.reference} (${comparison.prior.placement.inception} to ${comparison.prior.placement.expiry}), from the book:`);
    parts.push(JSON.stringify(comparison.prior, null, 1));
  } else if (comparison.basis === 'expiring_pack') {
    parts.push(`BASIS OF COMPARISON — the expiring renewal pack uploaded for this placement (${comparison.documents.map((d) => `"${d.filename}"`).join(', ')}), written by another broker in its own format.`);
    if (comparison.extracted) {
      parts.push('An earlier AI reading of that pack (programme, layers, experience, as extracted):');
      parts.push(JSON.stringify(comparison.extracted, null, 1));
    }
    if (unreadable.length) {
      parts.push(`These uploads could not be read and must be listed under gaps: ${unreadable.map((d) => `"${d.filename}" (${d.mime_type})`).join(', ')}`);
    }
    parts.push(...inline);
  } else {
    parts.push('BASIS OF COMPARISON — none: this is new business with no expiring pack uploaded and no prior year in the book. Leave comparison empty and say what the screens show.');
  }
  if (computed?.changes?.length) {
    parts.push('Computed movements between this year and the basis (from the figures, before any reading):');
    parts.push(JSON.stringify(computed.changes, null, 1));
  }
  parts.push('Write the analysis for a broking audience: the programme, exposure and experience, retentions and terms, the comparison change by change, the gaps, the questions for the cedant and the recommendations.');
  return parts.join('\n\n');
}

/**
 * Run the reading. Returns { provider, model, data, attempts }; throws
 * LlmUnavailableError when ChatGPT cannot serve it. `clients` is the test
 * injection point.
 */
export async function analysePlacementData({ digest, computed, comparison }, clients = {}) {
  let attachments = [];
  let inline = [];
  let unreadable = [];
  if (comparison.basis === 'expiring_pack' && comparison.raw_documents?.length) {
    ({ attachments, inline, unreadable } = prepareDocuments(comparison.raw_documents));
  }
  const result = await completeJson({
    system: SYSTEM,
    prompt: buildDataPrompt({ digest, computed, comparison, inline, unreadable }),
    schema: DATA_ANALYSIS_SCHEMA,
    schemaName: 'placement_data_analysis',
    effort: 'high',
    attachments,
  }, clients);
  for (const d of unreadable) {
    result.data.gaps.push(`"${d.filename}" (${d.mime_type}) could not be read by the AI — upload a PDF, Excel or CSV export.`);
  }
  return result;
}
