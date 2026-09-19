import { ValidationError } from '../lib/errors.js';
import { fromMinor } from '../lib/money.js';

/**
 * Cross-field term rules (§1.3, §2.5).
 *
 * These are the reconciliations JSON Schema cannot express: draft-07 has no
 * arithmetic across fields and no way to say "these bands must tile a range".
 * They live in code, keyed by treaty type, while the field-level schema stays
 * data in `term_schema`.
 *
 * Every rule here guards a failure that is *quiet*. If an aggregate limit and a
 * reinstatement schedule disagree, the recovery calculation and the
 * reinstatement calculation will each be internally consistent and jointly
 * wrong; nothing surfaces until someone reconciles a year-end statement by
 * hand. A gap between sliding-scale bands produces a loss ratio with no
 * commission at all, and the first sign of it is a number nobody can explain.
 *
 * So these are errors, not warnings. Warnings are for things that are unusual
 * but real — see `structureWarnings` for layer contiguity, which is exactly
 * that case and deliberately not enforced here.
 *
 * All money arrives as integer minor units (§2.6), so every comparison below is
 * exact integer arithmetic. No tolerances, no float drift.
 */

/** Total reinstatements, or null when any entry is unlimited. */
export function reinstatementCount(reinstatements) {
  if (!Array.isArray(reinstatements)) return null;
  if (reinstatements.some((r) => r?.unlimited)) return null;
  return reinstatements.reduce((n, r) => n + (r?.count ?? 0), 0);
}

function propertyCatXlRules(terms, fail) {
  const { limit, aggregate_limit: agg, reinstatements, mdp, mdp_instalments: instalments } = terms;

  // Aggregate limit must reconcile with the reinstatement schedule.
  // agg = limit x (1 + reinstatements): the limit itself plus one full limit
  // per reinstatement. Stated independently and left to disagree, the recovery
  // and reinstatement calculations each stay internally consistent and are
  // jointly wrong.
  if (agg != null && Array.isArray(reinstatements) && reinstatements.length > 0) {
    const count = reinstatementCount(reinstatements);
    if (count === null) {
      // Unlimited reinstatements and a finite aggregate are contradictory
      // statements about the same cover.
      fail('aggregate_limit',
        'Unlimited reinstatements cannot sit under a finite aggregate limit — state one or the other');
    } else {
      const expected = limit * (1 + count);
      if (expected !== agg) {
        fail('aggregate_limit',
          `Aggregate limit ${money(agg, terms)} does not reconcile with ${count} reinstatement(s) `
          + `on a limit of ${money(limit, terms)}: expected ${money(expected, terms)} `
          + '(limit x (1 + reinstatements))');
      }
    }
  }

  // Deposit instalments must sum to the deposit premium.
  if (mdp != null && Array.isArray(instalments) && instalments.length > 0) {
    const total = instalments.reduce((n, i) => n + (i?.amount ?? 0), 0);
    if (total !== mdp) {
      fail('mdp_instalments',
        `Instalments total ${money(total, terms)} but the minimum and deposit premium is `
        + `${money(mdp, terms)}`);
    }
  }
}

function propertySurplusRules(terms, fail) {
  const { retention, lines_ceded: lines, max_cession: maxCession, sliding_scale: scale } = terms;

  // Maximum cession must reconcile with retention and lines: a surplus cedes in
  // multiples of the cedant's retained line. The same trap as the aggregate
  // limit above — two independently stated numbers describing one quantity.
  if (maxCession != null && retention != null && lines != null) {
    const expected = Math.round(retention * lines);
    if (expected !== maxCession) {
      fail('max_cession',
        `Maximum cession ${money(maxCession, terms)} does not reconcile with ${lines} line(s) `
        + `of ${money(retention, terms)}: expected ${money(expected, terms)} (retention x lines)`);
    }
  }

  if (scale) slidingScaleRules(scale, fail);
}

/**
 * The sliding scale is the one worth checking hardest. A gap between bands
 * means a loss ratio landing in it has no commission at all, and nothing
 * surfaces until year-end adjustment produces a number nobody can explain.
 */
function slidingScaleRules(scale, fail) {
  const { min_pct: min, max_pct: max, provisional_pct: provisional, bands } = scale;

  if (min != null && max != null && min > max) {
    fail('sliding_scale.min_pct', `Minimum commission ${min}% exceeds the maximum ${max}%`);
  }
  if (provisional != null && min != null && max != null && (provisional < min || provisional > max)) {
    fail('sliding_scale.provisional_pct',
      `Provisional commission ${provisional}% must fall between the minimum ${min}% and maximum ${max}%`);
  }

  if (!Array.isArray(bands) || bands.length === 0) return;

  const sorted = [...bands].sort((a, b) => a.loss_ratio_from_pct - b.loss_ratio_from_pct);

  // Each band's commission must lie within the scale's own bounds.
  for (const band of sorted) {
    if (min != null && max != null
        && (band.commission_pct < min || band.commission_pct > max)) {
      fail('sliding_scale.bands',
        `Band ${bandLabel(band)} pays ${band.commission_pct}%, outside the scale's `
        + `${min}%–${max}% range`);
    }
  }

  // The bottom tail: a loss ratio below the first band has no commission.
  if (sorted[0].loss_ratio_from_pct !== 0) {
    fail('sliding_scale.bands',
      `The first band starts at ${sorted[0].loss_ratio_from_pct}%, so a loss ratio below that `
      + 'falls outside every band — bands must start at 0%');
  }

  // Contiguous and non-overlapping: each band ends exactly where the next
  // begins. Anything else is either a gap or a double-count.
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const to = sorted[i].loss_ratio_to_pct;
    const nextFrom = sorted[i + 1].loss_ratio_from_pct;
    if (to == null) {
      fail('sliding_scale.bands',
        `Band ${bandLabel(sorted[i])} is open-ended but is not the last band`);
    } else if (to < nextFrom) {
      fail('sliding_scale.bands',
        `Gap between ${to}% and ${nextFrom}%: a loss ratio in that range would earn no commission`);
    } else if (to > nextFrom) {
      fail('sliding_scale.bands',
        `Bands overlap between ${nextFrom}% and ${to}%: a loss ratio there has two commissions`);
    }
  }

  // The top tail: a loss ratio can exceed any finite bound, so the last band
  // must be open-ended or high loss ratios fall off the end of the scale.
  const last = sorted[sorted.length - 1];
  if (last.loss_ratio_to_pct != null) {
    fail('sliding_scale.bands',
      `The last band ends at ${last.loss_ratio_to_pct}%, so a loss ratio above that earns no `
      + 'commission — the final band must be open-ended (loss_ratio_to_pct: null)');
  }
}

function bandLabel(band) {
  const to = band.loss_ratio_to_pct == null ? 'and above' : `–${band.loss_ratio_to_pct}%`;
  return `${band.loss_ratio_from_pct}%${to}`;
}

function money(minor, terms) {
  try {
    return `${terms.currency} ${fromMinor(minor, terms.currency)}`;
  } catch {
    return String(minor);
  }
}

const RULES = {
  PROPERTY_CAT_XL: propertyCatXlRules,
  PROPERTY_SURPLUS: propertySurplusRules,
};

/**
 * Apply the cross-field rules for a treaty type. Collects every failure before
 * throwing, so a broker fixing a slip sees the whole picture in one pass.
 */
export function applyTermRules(terms, termSchema) {
  const rules = RULES[termSchema.treaty_type];
  if (!rules) return terms;

  const failures = [];
  rules(terms, (path, message) => failures.push({ path, message }));

  if (failures.length > 0) {
    throw new ValidationError(
      `Terms are internally inconsistent for ${termSchema.treaty_type}`,
      { termErrors: failures },
    );
  }
  return terms;
}

/**
 * Placement-level warnings that span sibling structures (§1.3 — structures are
 * siblings under one ContractYear).
 *
 * Layer contiguity — layer 2 attaching where layer 1 ends — is checked here and
 * NOT as a schema rule, because a non-contiguous tower is a real thing a broker
 * may place deliberately. It is worth surfacing and wrong to forbid.
 */
export function structureWarnings(structures) {
  const warnings = [];

  const layers = structures
    .filter((s) => s.basis === 'NP')
    .map((s) => ({ structure: s, terms: s.latest_version?.terms }))
    .filter((l) => l.terms && typeof l.terms.deductible === 'number' && typeof l.terms.limit === 'number')
    .sort((a, b) => a.terms.deductible - b.terms.deductible);

  for (let i = 0; i < layers.length - 1; i += 1) {
    const below = layers[i];
    const above = layers[i + 1];
    const top = below.terms.deductible + below.terms.limit;
    if (top === above.terms.deductible) continue;

    warnings.push({
      code: top < above.terms.deductible ? 'LAYER_GAP' : 'LAYER_OVERLAP',
      structures: [below.structure.id, above.structure.id],
      message: top < above.terms.deductible
        ? `"${below.structure.label}" tops out at ${money(top, below.terms)} but `
          + `"${above.structure.label}" attaches at ${money(above.terms.deductible, above.terms)} — `
          + 'a gap in the tower, which may be deliberate'
        : `"${below.structure.label}" tops out at ${money(top, below.terms)}, above where `
          + `"${above.structure.label}" attaches (${money(above.terms.deductible, above.terms)}) — `
          + 'the layers overlap',
    });
  }

  return warnings;
}

/**
 * Completeness at FOT promotion (M8).
 *
 * "FOT promotion is the point where terms must be complete and validated
 * against the JSON Schema — the claims and premium engine reads from here."
 *
 * Earlier versions are legitimately partial: a quoting market is not asked for
 * the deposit premium instalments. So the field schema stays permissive and the
 * completeness bar is applied here, once, at the point where M11 starts
 * depending on the answer.
 *
 * `fot_required` entries are a field name, or an array of names meaning "at
 * least one of these".
 */
export function assertCompleteForFot(terms, termSchema) {
  const required = termSchema.fot_required ?? [];
  const missing = [];

  for (const entry of required) {
    if (Array.isArray(entry)) {
      if (!entry.some((f) => present(terms[f]))) {
        missing.push({
          path: entry.join(' | '),
          message: `Firm order terms must state one of: ${entry.join(', ')}`,
        });
      }
    } else if (!present(terms[entry])) {
      missing.push({
        path: entry,
        message: `Firm order terms must state ${entry} — the claims and premium engine reads from here`,
      });
    }
  }

  if (missing.length > 0) {
    throw new ValidationError(
      `Terms are not complete enough to be firm order terms for ${termSchema.treaty_type}`,
      { termErrors: missing },
    );
  }
  return terms;
}

function present(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}
