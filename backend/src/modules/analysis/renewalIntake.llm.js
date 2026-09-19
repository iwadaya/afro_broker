/*
 * The quick renewal pack's intake: the AI reads the cedant's uploaded pack
 * and picks out the details a broker would otherwise type on the intake
 * form — the cedant, its country, the treaty type and the classes of
 * business — says which year each upload is, and gives a line of context.
 * The broker corrects and adds; nothing here is authoritative until they
 * have (spec §2.1), which is why every pick carries where it was read and
 * how sure the model was, and why the record keeps what the model said
 * beside what the broker saved (reviewIntake).
 *
 * The country, treaty type and classes are constrained to the house
 * reference lists — the dropdowns' own rows — so a pick always lands on a
 * row the form can hold; "not in the pack" is an empty value, with the
 * cedant's own words kept in as_written. The full analysis of the pack
 * (renewalPack.llm.js) is a separate, heavier call the desk runs later;
 * this one is deliberately small and quick.
 */

import { completeJson } from '../../lib/llm.js';
import { AppError } from '../../lib/errors.js';
import { prepareDocuments, FLAG_KINDS } from './renewalPack.llm.js';

export const CONFIDENCE = ['high', 'medium', 'low'];
export const DOC_ROLES = ['expiring', 'current', 'other'];
/** The intake fields a review state is kept for — named as the create body names them. */
export const INTAKE_FIELDS = ['cedant_name', 'cedant_domicile', 'treaty_type', 'class_of_business', 'cedant_notes'];
/** What the broker did with each field the model filled. */
export const REVIEW_STATES = ['accepted', 'corrected', 'added', 'empty'];

const str = (description) => ({ type: 'string', description });
const confidence = {
  type: 'string',
  enum: CONFIDENCE,
  description: 'high = stated outright in the pack; medium = read from context; low = a reading a broker must check.',
};
const source = str('Where it was read — PDF page and section, sheet and cell range, or "not stated".');

const clean = (s) => String(s ?? '').trim();
const norm = (s) => clean(s).toLowerCase();

/** The distinct names on a reference list, as the dropdown spells them. */
export const listNames = (list) => [...new Set((list || []).map((e) => clean(e.name)).filter(Boolean))];

/** One pick off a reference list, with its provenance. */
function pick(description, values, asWritten) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'as_written', 'source', 'confidence'],
    properties: {
      value: {
        type: 'string',
        enum: ['', ...values],
        description: `${description} One entry of the house list, spelt as given, or an empty string when the pack does not say or no entry fits — never a guess.`,
      },
      as_written: str(asWritten),
      source,
      confidence,
    },
  };
}

/**
 * The shape the model is constrained to, built per call because the lists
 * are the deployment's own reference data. Structured outputs are strict:
 * every property required, every object closed.
 */
export function intakeSchema(lists) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['cedant', 'domicile', 'treaty_type', 'classes_of_business', 'notes', 'documents', 'flags'],
    properties: {
      cedant: {
        type: 'object',
        additionalProperties: false,
        required: ['value', 'source', 'confidence'],
        properties: {
          value: str('The ceding insurer — the company buying the reinsurance — in its full name as the pack writes it. Never the broker on the cover, never a reinsurer on the panel. Empty when the pack does not name it.'),
          source,
          confidence,
        },
      },
      domicile: pick(
        'The cedant\'s country of domicile.',
        listNames(lists.countries),
        'The country as the pack writes it, or empty.',
      ),
      treaty_type: pick(
        'The treaty type being renewed.',
        listNames(lists.treatyTypes),
        'The treaty type as the pack writes it — e.g. "Property Catastrophe Excess of Loss" — or empty.',
      ),
      classes_of_business: {
        type: 'object',
        additionalProperties: false,
        required: ['values', 'as_written', 'source', 'confidence'],
        properties: {
          values: {
            type: 'array',
            items: { type: 'string', enum: listNames(lists.classes) },
            description: 'Every class of business the treaty covers, each an entry of the house list spelt as given. Empty when the pack does not say.',
          },
          as_written: str('The classes as the pack writes them, or empty.'),
          source,
          confidence,
        },
      },
      notes: str('One or two sentences of context for the analyst who reads this pack next — the programme, the period, the currency, what the cedant is asking for — strictly from the pack. Empty when there is nothing to say.'),
      documents: {
        type: 'array',
        description: 'One entry per uploaded document, in the order given: which year of the renewal it is.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'role', 'year', 'reason'],
          properties: {
            index: { type: 'integer', description: 'The document\'s number as given (1-based).' },
            role: {
              type: 'string',
              enum: DOC_ROLES,
              description: 'expiring = the year now running out; current = the renewal being placed; other = an exhibit, or unclear.',
            },
            year: str('The treaty year the document covers — e.g. "2027" — or empty.'),
            reason: str('One sentence on how you told.'),
          },
        },
      },
      flags: {
        type: 'array',
        description: 'Everything a broker must check on the form before creating the record.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'claim', 'source'],
          properties: {
            kind: {
              type: 'string',
              enum: FLAG_KINDS,
              description: 'missing = the pack does not say it; conflict = the pack disagrees with itself; judgement = a reading you made that a broker should confirm; unreadable = material that could not be read.',
            },
            claim: str('The point, in one sentence.'),
            source: str('Where you looked.'),
          },
        },
      },
    },
  };
}

const SYSTEM = [
  'You are a treaty reinsurance broker\'s assistant opening a cedant\'s renewal pack for the first time.',
  'Your job is the intake only: pick out the details the broker would otherwise type on the form — the cedant, its country, the treaty type and the classes of business — say which year of the renewal each uploaded document is, and give one or two sentences of context. The full review of the pack comes later and is not your job here.',
  'Rules:',
  '- The cedant is the ceding insurer, the company buying the reinsurance. It is never the broker whose name is on the cover page and never a reinsurer on the panel or the security list.',
  '- Pick the country, the treaty type and the classes of business from the house lists given, spelt exactly as given, choosing the nearest entry when the pack uses other words (a "Property Catastrophe Excess of Loss" is a CAT XL; "Fire" is Property). Leave the value empty when the pack does not say or no entry fits, and put the pack\'s own words in as_written either way.',
  '- Record where each pick was read (page and section, or sheet and cell) and how sure you are. Anything a broker must check goes in flags, with the place you looked.',
  '- Never invent. An empty value is the right answer when the pack is silent.',
].join('\n');

/**
 * Everything the model is allowed to reason from, minus the files themselves:
 * the uploads by number, the inline text, and the lists to pick from.
 */
export function buildIntakePrompt({ documents, inline, unreadable, lists }) {
  const lines = [
    'Uploaded documents, by number:\n'
    + documents.map((d, i) => `  ${i + 1}. "${d.filename}" (${d.mime_type})`).join('\n'),
  ];
  if (unreadable.length) {
    lines.push(
      'These uploads are not machine-readable and could not be included — flag them as unreadable: '
      + unreadable.map((d) => `"${d.filename}" (${d.mime_type})`).join(', '),
    );
  }
  lines.push(...inline);
  lines.push(
    'House lists — pick from these, spelt exactly as given:\n'
    + `Countries: ${listNames(lists.countries).join('; ')}\n`
    + `Treaty types: ${(lists.treatyTypes || []).map((t) => (t.category ? `${t.name} (${t.category})` : t.name)).join('; ')}\n`
    + `Classes of business: ${listNames(lists.classes).join('; ')}`,
  );
  lines.push('Produce the intake: the cedant, its domicile, the treaty type, the classes of business, the notes, one documents entry per upload in order, and the flags.');
  return lines.join('\n\n');
}

/** The list entry a value names, spelt the list's way, or '' when none does. */
function onList(value, list) {
  const v = norm(value);
  if (!v) return '';
  const hit = (list || []).find((e) => norm(e.name) === v || (e.code && norm(e.code) === v));
  return hit ? clean(hit.name) : '';
}

const pickOf = (raw, list) => {
  const value = onList(raw?.value, list);
  const asWritten = clean(raw?.as_written) || (value ? '' : clean(raw?.value));
  return {
    value,
    as_written: asWritten,
    source: clean(raw?.source),
    confidence: CONFIDENCE.includes(raw?.confidence) ? raw.confidence : 'low',
  };
};

/**
 * The model's answer made safe to store and to fill a form from: every pick
 * on its list (the schema holds the live model to it; a test double may not
 * be), strings trimmed, one documents entry per upload, unreadable uploads
 * flagged. Pure — the routes and the tests both lean on it.
 */
export function normaliseIntake(data, { documents, lists, unreadable = [] }) {
  const classesRaw = Array.isArray(data?.classes_of_business?.values) ? data.classes_of_business.values : [];
  const classes = [...new Set(classesRaw.map((c) => onList(c, lists.classes)).filter(Boolean))];

  const byIndex = new Map();
  for (const d of Array.isArray(data?.documents) ? data.documents : []) {
    const i = Number(d?.index);
    if (Number.isInteger(i) && i >= 1 && i <= documents.length && !byIndex.has(i)) byIndex.set(i, d);
  }
  const docs = documents.map((d, i) => {
    const read = byIndex.get(i + 1);
    return {
      index: i + 1,
      filename: d.filename,
      role: DOC_ROLES.includes(read?.role) ? read.role : 'other',
      year: clean(read?.year),
      reason: clean(read?.reason) || (read ? '' : 'The model did not say which year this document is.'),
    };
  });

  const flags = (Array.isArray(data?.flags) ? data.flags : [])
    .filter((f) => FLAG_KINDS.includes(f?.kind) && clean(f?.claim))
    .map((f) => ({ kind: f.kind, claim: clean(f.claim), source: clean(f.source) }));
  for (const d of unreadable) {
    flags.push({
      kind: 'unreadable',
      claim: `"${d.filename}" (${d.mime_type}) could not be read by the AI — upload a PDF, Excel or CSV export.`,
      source: d.filename,
    });
  }

  return {
    cedant: {
      value: clean(data?.cedant?.value),
      source: clean(data?.cedant?.source),
      confidence: CONFIDENCE.includes(data?.cedant?.confidence) ? data.cedant.confidence : 'low',
    },
    domicile: pickOf(data?.domicile, lists.countries),
    treaty_type: pickOf(data?.treaty_type, lists.treatyTypes),
    classes_of_business: {
      values: classes,
      as_written: clean(data?.classes_of_business?.as_written) || (classes.length ? '' : classesRaw.map(clean).filter(Boolean).join(', ')),
      source: clean(data?.classes_of_business?.source),
      confidence: CONFIDENCE.includes(data?.classes_of_business?.confidence) ? data.classes_of_business.confidence : 'low',
    },
    notes: clean(data?.notes),
    documents: docs,
    flags,
  };
}

/**
 * Read the intake off the uploaded packs. Returns
 * { provider, model, attempts, extraction }; throws LlmUnavailableError when
 * ChatGPT cannot serve it, and a 422 when nothing uploaded can be read.
 * `clients` is the test injection point, passed straight through.
 */
export async function extractIntake({ documents, lists }, clients = {}) {
  // The uploads have no year yet — that is one of the things being read —
  // so they are labelled for the model as plain uploads.
  const uploads = documents.map((d) => ({ ...d, role: d.role || 'uploaded' }));
  const { attachments, inline, unreadable } = prepareDocuments(uploads);
  if (attachments.length === 0 && inline.length === 0) {
    throw new AppError('None of the uploaded documents are machine-readable. Upload PDFs, images, Excel workbooks or text/CSV exports.', 422, 'no_readable_documents');
  }
  const result = await completeJson({
    system: SYSTEM,
    prompt: buildIntakePrompt({ documents: uploads, inline, unreadable, lists }),
    schema: intakeSchema(lists),
    schemaName: 'renewal_pack_intake',
    // A handful of fields off the cover page: the light setting, and a
    // short answer, so the form fills in seconds rather than minutes.
    effort: 'low',
    maxTokens: 3000,
    attachments,
  }, clients);

  return {
    provider: result.provider,
    model: result.model,
    attempts: result.attempts,
    extraction: normaliseIntake(result.data, { documents: uploads, lists, unreadable }),
  };
}

/** The extraction as the create body's fields would carry it. */
export function intakeValues(extraction) {
  return {
    cedant_name: clean(extraction?.cedant?.value),
    cedant_domicile: clean(extraction?.domicile?.value),
    treaty_type: clean(extraction?.treaty_type?.value),
    class_of_business: (extraction?.classes_of_business?.values || []).map(clean).filter(Boolean),
    cedant_notes: clean(extraction?.notes),
  };
}

const classSet = (value) => new Set(
  (Array.isArray(value) ? value : String(value ?? '').split(/\s*[,;]\s*/))
    .map(norm).filter(Boolean),
);
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * What the broker did with each field the model filled, read from the two
 * sides: accepted (kept as read), corrected (changed, or cleared), added
 * (the model had nothing; the broker supplied it), or empty (neither side
 * has it). Text compares case-insensitively; the classes as a set.
 */
export function reviewIntake(extraction, saved) {
  const ai = intakeValues(extraction);
  const state = (hasAi, hasSaved, equal) => {
    if (!hasAi && !hasSaved) return 'empty';
    if (!hasAi) return 'added';
    if (!hasSaved) return 'corrected';
    return equal ? 'accepted' : 'corrected';
  };
  const text = (field) => {
    const a = norm(ai[field]);
    const s = norm(saved?.[field]);
    return state(Boolean(a), Boolean(s), a === s);
  };
  const aiClasses = classSet(ai.class_of_business);
  const savedClasses = classSet(saved?.class_of_business);
  return {
    cedant_name: text('cedant_name'),
    cedant_domicile: text('cedant_domicile'),
    treaty_type: text('treaty_type'),
    class_of_business: state(aiClasses.size > 0, savedClasses.size > 0, sameSet(aiClasses, savedClasses)),
    cedant_notes: text('cedant_notes'),
  };
}
