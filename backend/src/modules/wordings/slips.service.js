import { alignClauseSets, diffWords, normaliseBody, titleKey } from '../../domain/wordingDiff.js';
import { parseSlipClauses, guessCategory } from '../../domain/slipParser.js';
import { extractDocumentText } from '../../lib/tabular.js';
import { ValidationError } from '../../lib/errors.js';
import { resolveWordingSet } from './wordings.service.js';

/**
 * Slip comparison — what a broker does with a wording that has come back from
 * a market: read what it says, and see how far it has drifted from the form we
 * put out.
 *
 * Every row carries a `flag` against the standard set:
 *   standard      the slip says what the standard wording says
 *   non_standard  the clause is there, but the text has moved
 *   additional    the slip adds a clause the standard set does not have
 *   missing       the standard set has a clause the slip does not carry
 *
 * With two slips the rows also compare A against B directly, so a broker can
 * see both "how does this differ from our form" and "how do these two markets
 * differ from each other" in one table.
 */

/** A slip's clauses, from an upload or from pasted text. */
export async function readSlip({ name, filename, content_base64, text }) {
  let body = text;
  if (!body && content_base64) body = await extractDocumentText(filename, content_base64);
  if (!body || !body.trim()) throw new ValidationError('The slip is empty — upload a file or paste its text');

  const clauses = parseSlipClauses(body).map((c) => ({
    ...c,
    category: guessCategory(c.title),
  }));
  if (clauses.length === 0) {
    throw new ValidationError(
      'No clauses could be read from this slip — it may be a scan without a text layer',
    );
  }
  return {
    name: name || filename || 'Slip',
    filename: filename || null,
    clause_count: clauses.length,
    clauses,
  };
}

/** The shape alignClauseSets and the UI both expect. */
const shape = (c) => ({
  id: c.id ?? null,
  title: c.title,
  clause_ref: c.clause_ref || null,
  category: c.category,
  body: c.body,
  market_name: c.market_name || null,
  provenance: c.provenance ?? null,
  source_org: c.source_org ?? null,
});

const FLAG_BY_STATUS = {
  identical: 'standard',
  changed: 'non_standard',
  only_left: 'missing',    // in the standard set, not in the slip
  only_right: 'additional', // in the slip, not in the standard set
};

/** Key a clause the way alignClauseSets matches them, for joining passes. */
const keyOf = (c) => (c.clause_ref
  ? `ref|${String(c.clause_ref).toUpperCase().replace(/\s+/g, '')}`
  : `title|${c.category}|${titleKey(c.title)}`);

/**
 * A slip names its clauses but does not categorise them, and clauses only pair
 * up within a category. So take the category from the library clause the slip
 * clause corresponds to — matched on market reference, then on title — and
 * keep the guess from the title only where the library has nothing to say.
 */
function categoriseAgainst(standard, slipClauses) {
  const byRef = new Map();
  const byTitle = new Map();
  for (const c of standard) {
    if (c.clause_ref) byRef.set(String(c.clause_ref).toUpperCase().replace(/\s+/g, ''), c);
    const k = titleKey(c.title);
    if (!byTitle.has(k)) byTitle.set(k, c);
  }
  return slipClauses.map((c) => {
    const ref = c.clause_ref && String(c.clause_ref).toUpperCase().replace(/\s+/g, '');
    const match = (ref && byRef.get(ref)) || byTitle.get(titleKey(c.title));
    return match ? { ...c, category: match.category } : c;
  });
}

/**
 * Compare one or two slips against the standard market wording.
 *
 * @param {{slips: object[], cob?: string, treaty_type?: string}} input
 */
export async function compareSlips({ slips, cob, treaty_type }) {
  if (!slips?.length || slips.length > 2) {
    throw new ValidationError('Upload one slip to check against the market standard, or two to compare');
  }

  const standardClauses = (await resolveWordingSet({ cob, treaty_type })).map(shape);
  const read = slips.map((s) => ({
    ...s,
    clauses: categoriseAgainst(standardClauses, s.clauses.map(shape)),
  }));

  const rows = read.length === 1
    ? oneSlipRows(standardClauses, read[0])
    : twoSlipRows(standardClauses, read[0], read[1]);

  return {
    mode: read.length === 1 ? 'against_standard' : 'slip_vs_slip',
    standard: {
      label: [cob, treaty_type].filter(Boolean).join(' · ') || 'Market standard wording',
      clause_count: standardClauses.length,
    },
    slips: read.map((s) => ({ name: s.name, filename: s.filename ?? null, clause_count: s.clauses.length })),
    summary: summarise(rows, read.length),
    rows,
  };
}

/** One slip: the standard set on the left, the slip on the right. */
function oneSlipRows(standard, slip) {
  const { rows } = alignClauseSets(standard, slip.clauses);
  return rows.map((r) => ({
    title: r.right?.title || r.left?.title,
    clause_ref: r.right?.clause_ref || r.left?.clause_ref || null,
    category: r.right?.category || r.left?.category,
    flag: FLAG_BY_STATUS[r.status],
    similarity: r.similarity ?? null,
    standard_body: r.left?.body ?? null,
    slips: [{ body: r.right?.body ?? null, present: Boolean(r.right) }],
    diff: r.status === 'changed' ? r.diff ?? diffWords(r.left.body, r.right.body) : null,
  }))
    .sort((x, y) => FLAG_ORDER.indexOf(x.flag) - FLAG_ORDER.indexOf(y.flag)
      || (x.title || '').localeCompare(y.title || ''))
    .map((r, i) => ({ ...r, position: i + 1 }));
}

/**
 * Two slips: align each against the standard set so every row keeps its
 * standard flag, then pair up whatever neither matched so the additional
 * clauses still line up A against B.
 */
function twoSlipRows(standard, a, b) {
  const againstA = alignClauseSets(standard, a.clauses).rows;
  const againstB = alignClauseSets(standard, b.clauses).rows;

  // Standard clause -> its counterpart in each slip.
  const bySide = new Map();
  const note = (rowsForSide, side) => {
    for (const r of rowsForSide) {
      if (!r.left) continue; // only_right handled as leftovers below
      const k = keyOf(r.left);
      if (!bySide.has(k)) bySide.set(k, { standard: r.left, a: null, b: null });
      bySide.get(k)[side] = r.right || null;
    }
  };
  note(againstA, 'a');
  note(againstB, 'b');

  const rows = [];
  for (const { standard: std, a: ca, b: cb } of bySide.values()) {
    rows.push(buildRow(std, ca, cb));
  }

  // Clauses the standard set does not have: pair the two slips' leftovers.
  const leftoverA = againstA.filter((r) => !r.left).map((r) => r.right);
  const leftoverB = againstB.filter((r) => !r.left).map((r) => r.right);
  for (const r of alignClauseSets(leftoverA, leftoverB).rows) {
    rows.push(buildRow(null, r.left, r.right));
  }

  return rows
    // What the slip got wrong first, then what it adds, then what it drops,
    // and only then the clauses that agree.
    .sort((x, y) => FLAG_ORDER.indexOf(x.flag) - FLAG_ORDER.indexOf(y.flag)
      || (x.title || '').localeCompare(y.title || ''))
    .map((r, i) => ({ ...r, position: i + 1 }));
}

const FLAG_ORDER = ['non_standard', 'additional', 'missing', 'standard'];

function buildRow(std, ca, cb) {
  const present = [ca, cb].filter(Boolean);
  const flag = flagFor(std, present);
  const ref = ca?.clause_ref || cb?.clause_ref || std?.clause_ref || null;
  return {
    title: ca?.title || cb?.title || std?.title,
    clause_ref: ref,
    category: ca?.category || cb?.category || std?.category,
    flag,
    // Do the two slips agree with each other?
    slip_match: ca && cb
      ? (normaliseBody(ca.body) === normaliseBody(cb.body) ? 'same' : 'differs')
      : (ca || cb ? 'one_only' : 'neither'),
    standard_body: std?.body ?? null,
    slips: [
      { body: ca?.body ?? null, present: Boolean(ca) },
      { body: cb?.body ?? null, present: Boolean(cb) },
    ],
    diff: ca && cb && normaliseBody(ca.body) !== normaliseBody(cb.body)
      ? diffWords(ca.body, cb.body)
      : null,
    // How the slip departs from our form. Worth having even when the two
    // slips agree with each other — that is the case where both have moved.
    standard_diff: std && flag === 'non_standard' && present.length
      ? diffWords(std.body, present[0].body)
      : null,
  };
}

function flagFor(std, present) {
  if (!std) return 'additional';
  if (present.length === 0) return 'missing';
  // Standard only when every slip carrying the clause says what the form says.
  return present.every((c) => normaliseBody(c.body) === normaliseBody(std.body))
    ? 'standard'
    : 'non_standard';
}

function summarise(rows, slipCount) {
  const count = (flag) => rows.filter((r) => r.flag === flag).length;
  const summary = {
    total: rows.length,
    standard: count('standard'),
    non_standard: count('non_standard'),
    additional: count('additional'),
    missing: count('missing'),
  };
  if (slipCount === 2) {
    summary.slips_agree = rows.filter((r) => r.slip_match === 'same').length;
    summary.slips_differ = rows.filter((r) => r.slip_match === 'differs').length;
    summary.one_slip_only = rows.filter((r) => r.slip_match === 'one_only').length;
  }
  return summary;
}
