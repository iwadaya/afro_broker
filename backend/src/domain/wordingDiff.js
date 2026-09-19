/**
 * Wording comparison — pure logic, no I/O.
 *
 * Two jobs:
 *   1. `diffWords` — a word-level diff of two clause bodies, so a reviewer can
 *      see exactly what a reinsurer changed in a clause we already know.
 *   2. `alignClauseSets` — match the clauses of one wording against another's
 *      (by market reference, then title, then similarity) and classify each as
 *      identical / changed / only on one side. That is the comparison a broker
 *      actually needs: "what has Swiss Re added, dropped and reworded relative
 *      to our standard wording?"
 *
 * Clause bodies are prose of a few hundred words, so an O(n·m) LCS is cheap.
 * `MAX_TOKENS` guards the pathological case (a whole wording pasted into one
 * clause) by falling back to a paragraph-level diff.
 */

const MAX_TOKENS = 4000;

/** Split prose into comparable tokens: words/numbers, and punctuation runs. */
export function tokenize(text) {
  if (!text) return [];
  return String(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*|[^\s\p{L}\p{N}]+/gu) || [];
}

/** Comparison form of a token: case- and curly-quote-insensitive. */
function fold(token) {
  return token.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
}

/**
 * Normalised body text — what "identical" means here. Whitespace, case and
 * quote style are drafting noise, not a change of terms.
 */
export function normaliseBody(text) {
  return tokenize(text).map(fold).join(' ');
}

/** Split into paragraphs, used as tokens when a body is too large to word-diff. */
function paragraphs(text) {
  return String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

/**
 * Longest common subsequence of two token arrays, returned as ops.
 * Classic dynamic-programming LCS; the table is (n+1)·(m+1) small integers.
 */
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  const fa = a.map(fold);
  const fb = b.map(fold);
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = fa[i] === fb[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (fa[i] === fb[j]) {
      ops.push({ op: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: 'del', text: a[i] });
      i += 1;
    } else {
      ops.push({ op: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < n) { ops.push({ op: 'del', text: a[i] }); i += 1; }
  while (j < m) { ops.push({ op: 'add', text: b[j] }); j += 1; }
  return { ops, common: dp[0][0] };
}

/**
 * Re-join tokens into prose: a space before every token except closing
 * punctuation, and none after an opening bracket or quote. Without this a diff
 * reads "removing debris , dismantling" instead of "removing debris,
 * dismantling".
 */
function joinToken(text, token) {
  if (!text) return token;
  if (/^[,.;:!?%)\]}»’”]/.test(token)) return text + token;
  if (/[([{«‘“]$/.test(text)) return text + token;
  return `${text} ${token}`;
}

/** Merge adjacent ops of the same kind into readable runs. */
function coalesce(ops, joiner) {
  const out = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && last.op === op.op) {
      last.text = joiner === ' ' ? joinToken(last.text, op.text) : last.text + joiner + op.text;
    } else {
      out.push({ op: op.op, text: op.text });
    }
  }
  return out;
}

/**
 * Word-level diff of two clause bodies.
 * Returns `[{ op: 'same' | 'add' | 'del', text }]` — `del` is text only in
 * `left`, `add` is text only in `right`.
 */
export function diffWords(left, right) {
  const a = tokenize(left);
  const b = tokenize(right);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return coalesce(lcsOps(paragraphs(left), paragraphs(right)).ops, '\n\n');
  }
  return coalesce(lcsOps(a, b).ops, ' ');
}

/**
 * How alike two bodies are, 0..1 (Dice coefficient over the common tokens).
 * 1 means identical once normalised; 0 means nothing in common.
 */
export function similarity(left, right) {
  const a = tokenize(left);
  const b = tokenize(right);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const long = Math.max(a.length, b.length);
  if (long > MAX_TOKENS) {
    const pa = paragraphs(left);
    const pb = paragraphs(right);
    const { common } = lcsOps(pa, pb);
    return round4((2 * common) / (pa.length + pb.length));
  }
  const { common } = lcsOps(a, b);
  return round4((2 * common) / (a.length + b.length));
}

function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}

/** Comparison key for a clause title: case and punctuation noise removed. */
export function titleKey(title) {
  return tokenize(title).map(fold).filter((t) => /[\p{L}\p{N}]/u.test(t)).join(' ');
}

function refKey(ref) {
  return ref ? String(ref).toLowerCase().replace(/[\s.\-_/]/g, '') : '';
}

/**
 * Below this, two clauses are different clauses rather than one reworded.
 * Set high deliberately: this threshold only governs the fallback pass, where
 * neither the clause reference nor the title matched, so it should pair only a
 * clause that has kept most of its drafting. Two different exclusions sharing
 * boilerplate framing ("This Agreement excludes all loss ... arising out of X")
 * must stay reported as one dropped and one added, not as a reword.
 */
const MATCH_THRESHOLD = 0.6;

/**
 * Align the clauses of two wordings.
 *
 * Matching runs in three passes, strongest signal first, because a clause can
 * be retitled without changing its terms and reworded without changing its
 * title:
 *   1. market clause reference (LMA/NMA numbers and the like);
 *   2. normalised title, within the same category;
 *   3. best remaining body similarity within the same category, above
 *      `MATCH_THRESHOLD`.
 *
 * Every clause ends up in exactly one row. Rows are returned in reading order:
 * matched rows keep the left wording's order, right-only clauses follow.
 *
 * `clauses` on each side are `{ id, title, clause_ref, category, body, ... }`;
 * anything else on them is passed through untouched.
 */
export function alignClauseSets(leftClauses = [], rightClauses = [], { withDiff = true } = {}) {
  const left = leftClauses.map((c, i) => ({ clause: c, index: i, taken: false }));
  const right = rightClauses.map((c, i) => ({ clause: c, index: i, taken: false }));
  const pairs = [];

  const pair = (l, r) => {
    l.taken = true;
    r.taken = true;
    pairs.push({ l, r });
  };

  // Pass 1 — market clause reference.
  const byRef = new Map();
  for (const r of right) {
    const key = refKey(r.clause.clause_ref);
    if (key && !byRef.has(key)) byRef.set(key, r);
  }
  for (const l of left) {
    const key = refKey(l.clause.clause_ref);
    const r = key && byRef.get(key);
    if (r && !r.taken) pair(l, r);
  }

  // Pass 2 — normalised title within the same category.
  const byTitle = new Map();
  for (const r of right) {
    if (r.taken) continue;
    const key = `${r.clause.category}|${titleKey(r.clause.title)}`;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(r);
  }
  for (const l of left) {
    if (l.taken) continue;
    const key = `${l.clause.category}|${titleKey(l.clause.title)}`;
    const candidate = (byTitle.get(key) || []).find((r) => !r.taken);
    if (candidate) pair(l, candidate);
  }

  // Pass 3 — best body similarity within the same category. Greedy over the
  // strongest available match, so a near-identical pair is never stolen by a
  // weaker one earlier in the list.
  const scored = [];
  for (const l of left) {
    if (l.taken) continue;
    for (const r of right) {
      if (r.taken || r.clause.category !== l.clause.category) continue;
      const score = similarity(l.clause.body, r.clause.body);
      if (score >= MATCH_THRESHOLD) scored.push({ l, r, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.l.index - b.l.index || a.r.index - b.r.index);
  for (const { l, r } of scored) {
    if (l.taken || r.taken) continue;
    pair(l, r);
  }

  // Build rows in left order, then the right-only remainder.
  const rows = [];
  const pairByLeft = new Map(pairs.map((p) => [p.l.index, p.r]));
  for (const l of left) {
    const r = pairByLeft.get(l.index);
    if (!r) {
      rows.push(row('only_left', l.clause, null, withDiff));
    } else {
      const same = normaliseBody(l.clause.body) === normaliseBody(r.clause.body);
      rows.push(row(same ? 'identical' : 'changed', l.clause, r.clause, withDiff));
    }
  }
  for (const r of right) {
    if (!r.taken) rows.push(row('only_right', null, r.clause, withDiff));
  }

  const summary = {
    identical: rows.filter((x) => x.status === 'identical').length,
    changed: rows.filter((x) => x.status === 'changed').length,
    only_left: rows.filter((x) => x.status === 'only_left').length,
    only_right: rows.filter((x) => x.status === 'only_right').length,
  };
  summary.total = rows.length;
  // Share of the comparison that agrees: a changed clause counts for how much
  // of its text survived, so a light reword scores far better than a rewrite.
  const agreement = rows.reduce((acc, x) => {
    if (x.status === 'identical') return acc + 1;
    if (x.status === 'changed') return acc + x.similarity;
    return acc;
  }, 0);
  summary.match_pct = summary.total ? round4((agreement / summary.total) * 100) : 0;
  return { rows, summary };
}

function row(status, leftClause, rightClause, withDiff) {
  const base = leftClause || rightClause;
  const score = leftClause && rightClause
    ? similarity(leftClause.body, rightClause.body)
    : 0;
  return {
    status,
    category: base.category,
    title: (leftClause || rightClause).title,
    clause_ref: leftClause?.clause_ref || rightClause?.clause_ref || null,
    similarity: status === 'identical' ? 1 : score,
    left: leftClause || null,
    right: rightClause || null,
    // Only reworded clauses need a diff — identical ones have nothing to show
    // and one-sided ones are the whole body.
    diff: withDiff && status === 'changed' ? diffWords(leftClause.body, rightClause.body) : null,
  };
}
