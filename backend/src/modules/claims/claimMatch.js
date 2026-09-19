/*
 * Matching an inbound loss advice to the contract it concerns. Pure, so it
 * is tested without an inbox: the parsed notice against the contracts the
 * desk can see, in order of how sure a basis is — the treaty reference,
 * then cedant, class and period, then the insured schedule. A match below
 * the threshold is never loaded on its own; it waits for triage.
 */

export const MATCH_THRESHOLD = 0.75;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (s) => new Set(norm(s).split(' ').filter((t) => t.length > 2));
const dateOf = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * @param {object} parsed  the read notice (treaty_reference, references, cedant_name, class, date_of_loss, insured)
 * @param {object[]} candidates  [{ placement_id, reference, cedant_name, class, inception, expiry, insureds: [] }]
 * @returns {{ candidate, basis, confidence, evidence, status }}
 */
export function matchNotification(parsed, candidates, { threshold = MATCH_THRESHOLD } = {}) {
  const refs = new Set([parsed.treaty_reference, ...(parsed.references || [])].filter(Boolean).map(norm));
  const dol = dateOf(parsed.date_of_loss);
  const insured = norm(parsed.insured);
  const cedant = norm(parsed.cedant_name);
  const classTokens = tokens(parsed.class);

  let best = null;
  for (const c of candidates) {
    const evidence = [];
    const inception = dateOf(c.inception);
    const expiry = dateOf(c.expiry);
    const within = Boolean(dol && inception && expiry && dol >= inception && dol <= expiry);
    const refHit = Boolean(c.reference && refs.has(norm(c.reference)));
    const cedantHit = Boolean(cedant && c.cedant_name && (norm(c.cedant_name).includes(cedant) || cedant.includes(norm(c.cedant_name))));
    const classHit = classTokens.size > 0 && [...classTokens].some((t) => tokens(c.class).has(t));
    const insuredHit = Boolean(insured && (c.insureds || []).some((i) => {
      const n = norm(i);
      return n && (n === insured || n.includes(insured) || insured.includes(n));
    }));

    let confidence = 0;
    if (refHit) {
      evidence.push('treaty reference');
      confidence = 0.9;
    } else if (cedantHit && within && classHit) {
      evidence.push('cedant', 'class', 'period');
      confidence = 0.85;
    } else if (cedantHit && within) {
      evidence.push('cedant', 'period');
      confidence = 0.7;
    } else if (insuredHit && within) {
      confidence = 0.8;
    } else if (insuredHit) {
      confidence = 0.6;
    } else {
      continue;
    }
    if (insuredHit) evidence.push('insured schedule');
    if (within && !evidence.includes('period')) evidence.push('date of loss');
    if (refHit) confidence += (insuredHit ? 0.05 : 0) + (within ? 0.05 : 0);
    else if (evidence.includes('class') && insuredHit) confidence += 0.05;
    confidence = Math.min(1, Math.round(confidence * 1000) / 1000);

    if (!best || confidence > best.confidence) best = { candidate: c, evidence, confidence };
  }

  if (!best) return { candidate: null, basis: null, evidence: [], confidence: 0, status: 'unmatched' };
  const e = best.evidence;
  const basis = e.length <= 1 ? e.join('') : `${e.slice(0, -1).join(', ')} and ${e[e.length - 1]}`;
  return { ...best, basis, status: best.confidence >= threshold ? 'matched' : 'unmatched' };
}
