/**
 * Slip wording parser — pure logic, no I/O.
 *
 * A slip arrives as prose: a run of clauses, each introduced by a heading. The
 * job here is to find those headings and cut the text into `{ title, body }`
 * clauses that `alignClauseSets` can match against the library.
 *
 * Slips are drafted by hand in many houses, so headings come in several
 * shapes. The ones worth recognising:
 *
 *   1. ARTICLE 4 — ULTIMATE NET LOSS      numbered, capitalised
 *   2. 7.  Hours Clause                   numbered, title case
 *   3. EXCLUSIONS                         bare capitalised heading
 *   4. Territorial Scope:                 title case ending in a colon
 *   5. LMA5400 Cyber Exclusion            a market reference leading the line
 *
 * Body text is everything up to the next heading. A line that merely *starts*
 * a sentence in title case is not a heading, so the rules below all require
 * something stronger: numbering, capitalisation, a trailing colon, or a
 * recognised clause reference.
 */

/** Market clause references: LMA5400, NMA2962, LSW1001, CL370, BRMA 35B. */
const REF = /\b((?:LMA|NMA|LSW|CL|JC|BRMA)\s?\d{2,5}[A-Z]?)\b/i;

/** `4.`, `4)`, `4.2`, `(iv)`, `ARTICLE 4`, `CLAUSE 12 -`, `SECTION 3:` */
const NUMBERING = new RegExp(
  '^(?:' +
    '(?:article|clause|section|part|schedule)\\s+(?:\\d+|[ivxlc]+)\\b' +
    '|\\(?\\d{1,2}(?:\\.\\d{1,2})*\\)?[.):\\-]?' +
    '|\\(?[ivxlc]{1,5}\\)[.):\\-]?' +
  ')[\\s\u2014\u2013\\-:.]+',
  'i',
);

const MAX_HEADING_WORDS = 12;
const MAX_HEADING_CHARS = 90;

/** Strip the numbering/reference prefix and any trailing punctuation. */
function cleanTitle(line) {
  let t = line.replace(NUMBERING, '').trim();
  t = t.replace(/^[—–\-:.\s]+/, '').replace(/[:.\s]+$/, '').trim();
  return t;
}

/** Letters only, to judge how much of a line is capitalised. */
function letters(text) {
  return text.replace(/[^A-Za-z]/g, '');
}

function isMostlyUpper(text) {
  const l = letters(text);
  if (l.length < 3) return false;
  const upper = l.replace(/[^A-Z]/g, '').length;
  return upper / l.length >= 0.8;
}

/** Title Case: most words capitalised, ignoring the small joining words. */
const SMALL_WORDS = new Set(['and', 'or', 'of', 'the', 'to', 'in', 'for', 'a', 'an', 'on', 'at', 'by', 'as']);
function isTitleCase(text) {
  const words = text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (words.length === 0) return false;
  const significant = words.filter((w) => !SMALL_WORDS.has(w.toLowerCase()));
  if (significant.length === 0) return false;
  return significant.every((w) => /^[^A-Za-z]*[A-Z]/.test(w));
}

/**
 * Does this line introduce a clause?
 * Returns the heading title, or null when the line is body text.
 */
export function headingOf(rawLine) {
  const line = rawLine.trim();
  if (!line || line.length > MAX_HEADING_CHARS) return null;
  // A line ending in a sentence full stop is prose, unless it is numbered
  // ("4. Ultimate Net Loss" keeps its numbering dot, which cleanTitle removes).
  const numbered = NUMBERING.test(line);
  const refLed = REF.test(line.slice(0, 24));
  const colonEnded = /:\s*$/.test(line);

  const title = cleanTitle(line);
  if (!title || letters(title).length < 3) return null;
  if (title.split(/\s+/).length > MAX_HEADING_WORDS) return null;

  // Numbering alone is not enough — "10 days notice shall be given" opens with
  // a number too. What follows must read as a title, not a sentence.
  const titleish = isMostlyUpper(title) || isTitleCase(title) || colonEnded;
  if ((numbered || refLed) && titleish) return title;
  // Unnumbered: needs capitalisation or a trailing colon to stand out.
  if (isMostlyUpper(title)) return title;
  if (colonEnded && isTitleCase(title)) return title;
  return null;
}

/**
 * Split slip text into clauses.
 * @param {string} text
 * @returns {{ title: string, clause_ref: string|null, body: string, position: number }[]}
 *
 * Text before the first heading becomes a `Preamble` clause when it carries
 * enough substance to be worth comparing; a page header or a stray reference
 * line is dropped.
 */
export function parseSlipClauses(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let current = null;
  let preamble = [];

  for (const line of lines) {
    const title = headingOf(line);
    if (title) {
      if (current) sections.push(current);
      const refMatch = line.match(REF);
      current = { title, clause_ref: refMatch ? refMatch[1].toUpperCase().replace(/\s+/, '') : null, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push(current);

  const clauses = sections
    .map((s) => ({
      title: s.title,
      clause_ref: s.clause_ref,
      body: s.lines.join('\n').trim(),
    }))
    // A heading with no text under it is a table-of-contents entry, not a clause.
    .filter((c) => c.body.length > 0);

  const preambleBody = preamble.join('\n').trim();
  if (preambleBody.split(/\s+/).length >= 25) {
    clauses.unshift({ title: 'Preamble', clause_ref: null, body: preambleBody });
  }

  return clauses.map((c, i) => ({ ...c, position: i + 1 }));
}

/**
 * Guess a category for an extracted clause from its title, so alignment can
 * match within a category the way the library's own clauses do.
 */
const CATEGORY_HINTS = [
  ['exclusion', /exclusion|excluded|excluding/i],
  ['definition', /definition|meaning of|interpretation/i],
  ['extension', /extension|write-?back|buy-?back|additional cover/i],
  ['coverage', /cover|reinsuring|indemnit|business covered|scope/i],
];

export function guessCategory(title) {
  for (const [category, re] of CATEGORY_HINTS) {
    if (re.test(title)) return category;
  }
  // Everything else in a slip is a condition: hours, reinstatements, premium,
  // claims handling, arbitration, cancellation.
  return 'condition';
}
