/**
 * Occupancy classes — the "class / % of capacity" grading behind the table of
 * retentions, plus the matcher that grades a typed occupancy category into one
 * of those classes.
 *
 * A class groups occupancies of like hazard and fixes the share of the treaty
 * full limit those risks may use. The live table is maintained by an admin and
 * served from `/api/occupancy-classes`; the constant below is the grading it
 * is seeded with, and the fallback when the table cannot be read.
 *
 * Matching rules:
 *   - text is lower-cased, de-punctuated and singularised ("mills" → "mill");
 *   - a term matches only as a contiguous phrase on word boundaries, so "oil"
 *     never fires on "boiler";
 *   - longer phrases outrank shorter ones ("petrol filling station" beats a
 *     bare "station" in another class);
 *   - ties break toward the *more hazardous* class — the lower share of
 *     capacity — which is the prudent reading of a straddled description such
 *     as "chemical warehouse";
 *   - nothing recognised means no class, never a guess.
 *
 * Pure module: no React, no network. The retentions table is edited entirely
 * client-side and saved as JSON on the placement, so detection runs here.
 */

export const DEFAULT_OCCUPANCY_CLASSES = [
  {
    klass: 'A',
    name: 'Non-hazardous',
    pct: 100,
    description: 'Simple, non-industrial occupancies with no process hazard.',
    occupancies: [
      'dwelling', 'residential', 'apartment', 'flat', 'bungalow', 'office',
      'offices and retail', 'retail', 'shop', 'school', 'college', 'university',
      'church', 'mosque', 'bank', 'clinic', 'surgery', 'hostel', 'library',
      'museum', 'government building',
    ],
  },
  {
    klass: 'B',
    name: 'Light hazard',
    pct: 75,
    description: 'Commercial, storage and light-industrial risks.',
    occupancies: [
      'warehousing', 'warehouse', 'light industry', 'workshop', 'garage',
      'hotel', 'guest house', 'lodge', 'hospital', 'supermarket',
      'shopping mall', 'restaurant', 'bakery', 'laundry', 'cold store',
      'cold storage', 'showroom', 'cinema', 'printing works', 'packaging',
      'data centre', 'data center',
    ],
  },
  {
    klass: 'C',
    name: 'Heavy / hazardous',
    pct: 50,
    description: 'Heavy industry and highly combustible or flammable processes.',
    occupancies: [
      'heavy industry', 'hazardous risk', 'hazardous', 'factory',
      'manufacturing', 'mill', 'textile mill', 'flour mill', 'spinning mill',
      'ginnery', 'foundry', 'steel', 'cement works', 'chemical', 'petrol',
      'filling station', 'petrol filling station', 'fuel depot', 'refinery',
      'sawmill', 'timber yard', 'foam', 'rubber', 'tyre', 'plastics',
      'distillery', 'brewery', 'grain silo', 'explosives', 'fireworks',
      'mining', 'quarry',
    ],
  },
];

/**
 * Normalise the stored table into what the matcher reads: the code is the
 * class, and the share of capacity is a number.
 */
export function classesFromApi(rows) {
  return (rows || []).map((r) => ({
    id: r.id,
    klass: r.code,
    name: r.name,
    description: r.description || '',
    pct: Number(r.capacity_pct),
    occupancies: r.occupancies || [],
    active: r.active !== false,
  }));
}

/** Split text into comparable, singularised tokens. */
export function tokenise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(singular);
}

function singular(word) {
  let w = word;
  if (w.length > 3 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  // Fold gerunds onto their stem so "Flour Milling" meets "flour mill".
  // Terms are folded the same way, so the two sides always agree.
  // Both sides are folded identically, so a doubled stem ("shopping" →
  // "shopp") still meets its own term — no un-doubling needed, and none is
  // attempted: it would cut "milling" down to "mil".
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  return w;
}

/** True when `phrase` (already tokenised) appears contiguously in `tokens`. */
function containsPhrase(tokens, phrase) {
  if (!phrase.length || phrase.length > tokens.length) return false;
  for (let i = 0; i <= tokens.length - phrase.length; i += 1) {
    let hit = true;
    for (let j = 0; j < phrase.length; j += 1) {
      if (tokens[i + j] !== phrase[j]) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Score one class against the tokenised category. */
function scoreClass(tokens, klass) {
  const matched = [];
  let best = 0;
  let extras = 0;
  for (const term of klass.occupancies || []) {
    const phrase = tokenise(term);
    if (!containsPhrase(tokens, phrase)) continue;
    matched.push(term);
    // A term's weight grows with its length: specific beats generic.
    const weight = phrase.length ** 2;
    if (weight > best) { extras += best; best = weight; } else { extras += weight; }
  }
  return { matched, score: best === 0 ? 0 : best + 0.25 * extras };
}

/**
 * Grade an occupancy category into a class.
 *
 * @param {string} category            free text, e.g. "Textile spinning mill"
 * @param {object[]} [classes]         the class table (defaults to the seeded grading)
 * @returns {{klass: string, name: string, pct: number, confidence: number,
 *            matched: string[], candidates: object[]} | null}  null when nothing matched
 */
export function detectOccupancyClass(category, classes = DEFAULT_OCCUPANCY_CLASSES) {
  const tokens = tokenise(category);
  const candidates = classes
    .filter((k) => k.active !== false)
    .map((k) => {
      const { matched, score } = scoreClass(tokens, k);
      return { klass: k.klass, name: k.name, pct: k.pct, score: round2(score), matched };
    })
    .filter((c) => c.score > 0)
    // Best score first; on a tie prefer the more hazardous (lower) capacity.
    .sort((a, b) => b.score - a.score || a.pct - b.pct);

  if (!candidates.length) return null;

  const [winner, runnerUp] = candidates;
  // Strength grows with how specific the winning phrase was; margin measures
  // how far clear of the next class it finished.
  const strength = 1 - 1 / (1 + winner.score);
  const margin = runnerUp ? winner.score / (winner.score + runnerUp.score) : 1;

  return { ...winner, confidence: round2(strength * (0.5 + 0.5 * margin)) };
}

/** The class carrying a given code, if the table knows it. */
export function classByCode(code, classes = DEFAULT_OCCUPANCY_CLASSES) {
  const wanted = String(code || '').trim().toUpperCase();
  if (!wanted) return null;
  return classes.find((k) => k.active !== false && k.klass.toUpperCase() === wanted) || null;
}

/**
 * Fill in class and % of capacity across the retentions rows.
 *
 * A row with no class is graded from its occupancy category; a row carrying a
 * class the table knows just takes that class's standard share, so a
 * deliberate grading is never overridden. A class the table no longer carries
 * cannot supply a share, so such a row is graded from its occupancy too.
 * `overwrite` re-grades every row from its category, standard share and all.
 * Rows that are already settled (class and share both set) are left alone
 * unless overwriting, and a category the table does not recognise is left
 * alone either way.
 *
 * @returns {{rows: object[], applied: object[], considered: number}}
 */
export function autoFillClasses(rows, { overwrite = false, classes = DEFAULT_OCCUPANCY_CLASSES } = {}) {
  const applied = [];
  let considered = 0;
  const next = rows.map((row) => {
    const category = String(row.category || '').trim();
    if (!category) return row;
    const klass = String(row.klass || '').trim().toUpperCase();
    const pct = String(row.pct ?? '').trim();
    if (klass && pct && !overwrite) return row;

    considered += 1;
    // A class the table knows supplies its own share; anything else — no class,
    // a code the table no longer carries (an admin re-lettered it), or an
    // explicit re-grade — is graded from the occupancy instead.
    const known = klass ? classByCode(klass, classes) : null;
    const target = (overwrite || !known) ? detectOccupancyClass(category, classes) : known;
    if (!target) return row;
    if (target.klass === klass && String(target.pct) === pct) return row;

    applied.push({ category, klass: target.klass, pct: target.pct, confidence: target.confidence ?? null });
    return { ...row, klass: target.klass, pct: String(target.pct) };
  });
  return { rows: next, applied, considered };
}
