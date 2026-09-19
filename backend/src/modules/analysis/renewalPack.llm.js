/*
 * The AI half of renewal pack analysis: the broker's uploaded packs — usually
 * the expiring and the current submissions — go to the model whole (PDFs and
 * images as attachments, text/CSV inlined, Excel workbooks parsed sheet by
 * sheet and inlined), together with the cedant, class of business and treaty
 * type the broker entered. The model reviews each pack, compares the two
 * years change by change, and reports for a broking audience.
 *
 * Everything goes to ChatGPT (lib/llm.js) — PDFs and images ride as native
 * file/image inputs on the Responses API, so there is no fallback provider
 * and no upload shape that needs one.
 */

import { completeJson } from '../../lib/llm.js';
import { AppError } from '../../lib/errors.js';
import { parseXlsx } from '../../lib/tabular.js';

/**
 * The house renewal pack skeleton — the same ten sections the pack builder
 * carries, refreshes or omits (frontend `views/RenewalPack.jsx`, SECTIONS).
 *
 * An uploaded cedant submission arrives in whatever shape the cedant sends
 * it. Normalising it onto this list is what makes an uploaded pack and a
 * manually built one the same object to a broker — and the sections the
 * cedant did not supply are as useful as the ones they did.
 *
 * Keep in step with the builder's list; a rename here is a rename there.
 */
export const STANDARD_SECTIONS = [
  'Cover letter & submission',
  'Programme structure',
  'Exposure summary by band',
  'Claims experience, 10 years',
  'Large loss listing',
  'Rate change history',
  'Cat model output',
  'Contract wording',
  'Reinsurer panel & signed lines',
  'Cedant financials & ESG',
];

const str = (description) => ({ type: 'string', description });
/** A figure as the pack states it — never estimated; empty where the pack is silent. */
const figure = (description) => ({
  type: 'string',
  description: `${description} As written in the pack, with currency and units. An empty string when the packs do not state it — never an estimate.`,
});
const labelValue = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'value'],
  properties: { label: { type: 'string' }, value: { type: 'string' } },
};

/** What a flag for broker review can be. */
export const FLAG_KINDS = ['missing', 'conflict', 'judgement', 'unreadable'];

/**
 * The shape the model is constrained to. Structured outputs are strict, so
 * every property is required and every object closed; "not in the pack" is
 * an empty string plus a flag, never an absent key.
 */
export const RENEWAL_PACK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'programme', 'layers', 'experience', 'experience_note', 'flags', 'trace',
    'executive_summary', 'standard_pack', 'pack_reviews', 'changes',
    'detailed_analysis', 'recommendations', 'data_quality',
  ],
  properties: {
    programme: {
      type: 'object',
      additionalProperties: false,
      description:
        'The current (renewal) programme as the packs state it — the summary\'s header and fact grid. Every value is an empty string where the packs are silent.',
      required: [
        'treaty_name', 'structure', 'basis', 'inception', 'expiry', 'currency',
        'layer_count', 'epi', 'deposit_premium', 'retention', 'prose',
      ],
      properties: {
        treaty_name: str('The treaty as the cedant names it, with the year — e.g. "Risk Excess of Loss — 2027".'),
        structure: figure('The programme in one expression — e.g. "82.5m xs 2.5m", or "45% quota share" for a proportional treaty.'),
        basis: figure('Losses occurring, risks attaching, or the proportional basis.'),
        inception: figure('Inception date.'),
        expiry: figure('Expiry date.'),
        currency: figure('Currency of the programme.'),
        layer_count: figure('Number of layers, or of sections for a proportional treaty.'),
        epi: figure('Estimated premium income for the renewal year.'),
        deposit_premium: figure('Total deposit / minimum premium across the programme.'),
        retention: figure('The cedant\'s retention.'),
        prose: str('One paragraph on the programme for a broking audience — structure, basis, retention, top of programme, EPI and its movement on expiring — strictly from the packs.'),
      },
    },
    layers: {
      type: 'array',
      description: 'The layer schedule of the current programme — one row per layer or section, in order. Empty when the packs carry no schedule.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'cover', 'deposit_premium', 'rol', 'reinstatements', 'expiring_line'],
        properties: {
          name: str('"Layer 1", "Section A", …'),
          cover: figure('Limit and attachment — e.g. "2.5m xs 2.5m" — or the cession for a proportional section.'),
          deposit_premium: figure('Deposit / minimum premium for the layer.'),
          rol: figure('Rate on line, or the rate for a proportional section.'),
          reinstatements: figure('Reinstatement terms — e.g. "2 @ 100%".'),
          expiring_line: figure('The expiring year\'s terms or line for this layer, where the expiring pack states them.'),
        },
      },
    },
    experience: {
      type: 'array',
      description: 'Loss experience by year as the packs state it — up to the last five years, oldest first.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['year', 'premium', 'incurred', 'loss_ratio'],
        properties: {
          year: str('The underwriting or accident year.'),
          premium: figure('Premium for the year.'),
          incurred: figure('Incurred losses for the year.'),
          loss_ratio: figure('Loss ratio for the year.'),
        },
      },
    },
    experience_note: str('A sentence or two on the experience — burning cost, the losses that drive it, how high they reached. Empty when the packs carry no experience.'),
    flags: {
      type: 'array',
      description: 'Everything a broker must check before the summary leaves the desk.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'claim', 'source'],
        properties: {
          kind: {
            type: 'string',
            enum: FLAG_KINDS,
            description: 'missing = the packs do not say it; conflict = the packs disagree with themselves; judgement = a reading you made that a broker should confirm; unreadable = material that could not be read.',
          },
          claim: str('The point, in one sentence.'),
          source: str('Where you looked — sheet and cell range, PDF page and section, or "pack silent — checked …".'),
        },
      },
    },
    trace: {
      type: 'array',
      description: 'Where every figure on the summary came from — one entry per figure in programme, layers and experience.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'value', 'source'],
        properties: {
          field: str('The figure — "EPI", "Layer structure", "5-year experience", …'),
          value: str('The value as extracted.'),
          source: str('Sheet and cell range ("Programme B4:H11") or PDF page and section ("PDF p.4 §3.2").'),
        },
      },
    },
    standard_pack: {
      type: 'array',
      description:
        'The uploaded packs mapped onto the house renewal pack skeleton — one entry per section, in the order given, every section present exactly once.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'status', 'summary', 'key_figures', 'gap'],
        properties: {
          section: { type: 'string', enum: STANDARD_SECTIONS },
          status: {
            type: 'string',
            enum: ['supplied', 'partial', 'missing'],
            description: 'supplied = the packs cover this section fully; partial = some of it is there; missing = the packs do not cover it at all.',
          },
          summary: {
            type: 'string',
            description: 'What the packs say for this section, in a sentence or two. Empty string when the status is missing.',
          },
          key_figures: { type: 'array', items: labelValue },
          gap: {
            type: 'string',
            description: 'What a broker would still have to obtain for this section before the pack goes to market. Empty string when nothing is outstanding.',
          },
        },
      },
    },
    executive_summary: { type: 'string', description: 'A short paragraph a broker could paste into an email.' },
    pack_reviews: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['document', 'role', 'commentary', 'key_figures'],
        properties: {
          document: { type: 'string', description: 'The uploaded filename.' },
          role: { type: 'string', description: 'expiring, current or other.' },
          commentary: { type: 'string', description: 'What this pack shows: structure, exposure, premium, losses, terms.' },
          key_figures: { type: 'array', items: labelValue },
        },
      },
    },
    changes: {
      type: 'array',
      description: 'Material changes between the expiring and current packs, quantified where the documents allow.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['area', 'change', 'direction', 'significance', 'commentary'],
        properties: {
          area: { type: 'string', description: 'e.g. Structure, Exposure, Premium, Loss experience, Terms & conditions.' },
          change: { type: 'string' },
          direction: { type: 'string', enum: ['improved', 'deteriorated', 'unchanged', 'unclear'] },
          significance: { type: 'string', enum: ['high', 'medium', 'low'] },
          commentary: { type: 'string' },
        },
      },
    },
    detailed_analysis: { type: 'string', description: 'The full analysis, in paragraphs.' },
    recommendations: { type: 'array', items: { type: 'string' } },
    data_quality: { type: 'array', items: { type: 'string' }, description: 'Gaps, inconsistencies, unreadable material.' },
  },
};

const SYSTEM = [
  'You are a senior treaty reinsurance broking analyst reviewing renewal packs for a broker.',
  'You are given the cedant, class of business and treaty type, plus the uploaded renewal pack documents — usually the expiring pack and the current (renewal) pack, but possibly only one, or additional exhibits.',
  'Rules:',
  '- Map the uploaded material onto the house renewal pack skeleton in standard_pack: one entry per section, every section listed exactly once, in the order given, whether or not the packs cover it. Mark a section missing when the packs do not cover it and supplied only when they cover it properly — a broker relies on this to see what still has to be obtained from the cedant, so do not report a section as supplied on thin evidence.',
  '- Review each document on its own: programme structure, exposure, premium, loss experience, terms and conditions.',
  '- Where an expiring and a current pack are both present, compare them and identify every material change, quantifying movements wherever the documents allow.',
  '- Judge each change from the reinsurer\'s perspective: improved means more attractive to markets, deteriorated means harder to place or deserving of a price correction.',
  '- Fill programme, layers and experience strictly from the packs — every figure as written, with currency and units. Where a pack is silent leave the string empty and add a flag of kind missing; never estimate.',
  '- Record in trace where each figure on the summary came from — sheet and cell range, or PDF page and section — and put everything a broker must check in flags with the place you looked: gaps (missing), disagreements between sheets or documents (conflict), readings you had to make (judgement), material you could not read (unreadable).',
  '- Base every statement strictly on the supplied documents; data_quality lists anything unreadable or inconsistent that the flags do not already carry.',
  '- Write for a professional broking audience: precise, quantified, and candid about weaknesses in the submission.',
].join('\n');

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_TYPES = new Set(['application/json', 'application/csv']);
const EXCEL_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
  'application/vnd.ms-excel.sheet.macroEnabled.12', // .xlsm
]);
const EXCEL_EXTENSIONS = /\.(xlsx|xls|xlsm)$/i; // browsers upload these as octet-stream at times
const MAX_ATTACHMENT_BYTES = 28 * 1024 * 1024; // headroom under the API's 32MB request cap

const isTextLike = (mime) => mime.startsWith('text/') || TEXT_TYPES.has(mime);
const isExcel = (d) => EXCEL_TYPES.has(d.mime_type) || EXCEL_EXTENSIONS.test(d.filename || '');
const label = (d) => `Document "${d.filename}" — ${d.role} pack (${d.mime_type})`;

/** Render a parsed workbook sheet by sheet as delimited text the model can read. */
function workbookText(tables) {
  return tables
    .map((t) => [
      `Sheet "${t.name}" (${t.row_count} row${t.row_count === 1 ? '' : 's'})`,
      t.headers.join(' | '),
      ...t.rows.map((r) => t.headers.map((h) => r[h] ?? '').join(' | ')),
    ].join('\n'))
    .join('\n\n');
}

/**
 * Split uploads into what the model can read: PDFs/images become attachments,
 * text-like files are inlined, Excel workbooks are parsed and inlined as
 * sheet tables, anything else is reported as unreadable.
 */
export function prepareDocuments(documents) {
  const attachments = [];
  const inline = [];
  const unreadable = [];
  let bytes = 0;

  for (const d of documents) {
    if (d.mime_type === 'application/pdf' || IMAGE_TYPES.has(d.mime_type)) {
      bytes += d.content.length;
      attachments.push({
        filename: d.filename,
        media_type: d.mime_type,
        data: d.content.toString('base64'),
        label: label(d),
      });
    } else if (isExcel(d)) {
      let text = null;
      try {
        const tables = parseXlsx(d.content);
        // SheetJS decodes junk bytes as a header-only sheet rather than
        // throwing, so an all-empty workbook counts as unreadable too.
        if (tables.some((t) => t.row_count > 0)) text = workbookText(tables);
      } catch {
        // A corrupt or unreadable workbook is flagged, not fatal.
      }
      if (text) inline.push(`${label(d)}\n--- BEGIN CONTENT ---\n${text}\n--- END CONTENT ---`);
      else unreadable.push(d);
    } else if (isTextLike(d.mime_type) && d.text_content) {
      inline.push(`${label(d)}\n--- BEGIN CONTENT ---\n${d.text_content}\n--- END CONTENT ---`);
    } else {
      unreadable.push(d);
    }
  }
  if (bytes > MAX_ATTACHMENT_BYTES) {
    // An AppError, so the route answers 422 rather than a bare 500.
    throw new AppError('Uploaded packs exceed the AI request size limit (~28MB total). Remove or split a document and re-run.', 422, 'packs_too_large');
  }
  return { attachments, inline, unreadable };
}

/** Everything the model is allowed to reason from, minus the files themselves. */
export function buildPrompt({ analysis, documents, inline, unreadable }) {
  const lines = [
    `Cedant: ${analysis.cedant_name}${analysis.cedant_domicile ? ` (${analysis.cedant_domicile})` : ''}`,
    `Class(es) of business: ${analysis.class_of_business}`,
    `Treaty type: ${analysis.treaty_type}`,
  ];
  if (analysis.cedant_notes) lines.push(`Broker notes on the cedant: ${analysis.cedant_notes}`);
  lines.push(`Uploaded packs: ${documents.map((d) => `"${d.filename}" (${d.role})`).join(', ')}`);
  if (unreadable.length) {
    lines.push(
      'These uploads are not machine-readable and could not be included — flag them under data_quality: '
      + unreadable.map((d) => `"${d.filename}" (${d.mime_type})`).join(', '),
    );
  }
  lines.push(...inline);
  lines.push(
    'House renewal pack skeleton — map the uploaded material onto these sections, in this order:\n'
    + STANDARD_SECTIONS.map((s, i) => `  ${String(i + 1).padStart(2, '0')}. ${s}`).join('\n'),
  );
  lines.push('Produce the full renewal pack analysis: the programme with its layer schedule, loss experience and extraction trace, the flags for broker review, the standardised pack, commentary on each pack, the change comparison, detailed analysis and recommendations.');
  return lines.join('\n\n');
}

/**
 * Run the analysis. Returns { provider, model, data, attempts }; throws
 * LlmUnavailableError when ChatGPT cannot serve it. `clients` is the test
 * injection point, passed straight through to completeJson.
 */
export async function analyseRenewalPacks({ analysis, documents }, clients = {}) {
  const { attachments, inline, unreadable } = prepareDocuments(documents);
  if (attachments.length === 0 && inline.length === 0) {
    throw new AppError('None of the uploaded documents are machine-readable. Upload PDFs, images, Excel workbooks or text/CSV exports.', 422, 'no_readable_documents');
  }
  const result = await completeJson({
    system: SYSTEM,
    prompt: buildPrompt({ analysis, documents, inline, unreadable }),
    schema: RENEWAL_PACK_SCHEMA,
    schemaName: 'renewal_pack_analysis',
    effort: 'high',
    attachments,
  }, clients);

  for (const d of unreadable) {
    result.data.data_quality.push(`"${d.filename}" (${d.mime_type}) could not be read by the AI — upload a PDF, Excel or CSV export.`);
  }
  return result;
}
