/**
 * Signing-down engine — the integrity core of the placement system.
 *
 * Definitions (see design doc §2):
 *   order        = % of the risk being placed (e.g. 100, or lower if the cedant
 *                  retains a co-reinsurance share).
 *   written      = % each market has written on the layer.
 *   to_stand     = a line reserved at its written value, excluded from the
 *                  signing-down factor; the factor applies only to the remaining
 *                  lines against the residual order.
 *
 * Oversubscribed  (Σ written > order):  signed = written × (order / Σ written)
 * Undersubscribed (Σ written < order):  signed = written (shortfall carried)
 * Exactly placed  (Σ written = order):  signed = written
 *
 * Guarantees:
 *   - Σ signed === order  (to the rounding precision) when over/exactly placed.
 *   - "to stand" lines keep their written value exactly.
 *   - Rounding never loses or invents a basis point: residual rounding error is
 *     distributed by the largest-remainder method so the signed total is exact.
 */

export const PCT_DP = 4; // percentage precision (4 d.p. => basis-point/100)

const SCALE = 10 ** PCT_DP;

/** Round a percentage to PCT_DP decimal places (half-up, stable). */
export function roundPct(value) {
  // Add a tiny epsilon before rounding to avoid binary-fp half-down surprises.
  return Math.round((value + Number.EPSILON) * SCALE) / SCALE;
}

function sum(nums) {
  return nums.reduce((a, b) => a + b, 0);
}

/**
 * @typedef {Object} LineInput
 * @property {string|number} id      stable identifier for the line
 * @property {number} written        written percentage (>= 0)
 * @property {boolean} [toStand]     if true, excluded from signing-down
 *
 * @typedef {Object} SignedLine
 * @property {string|number} id
 * @property {number} written
 * @property {boolean} toStand
 * @property {number} signed         signed percentage after factor + rounding
 *
 * @typedef {Object} SigningResult
 * @property {'OVERSUBSCRIBED'|'UNDERSUBSCRIBED'|'EXACT'|'EMPTY'} state
 * @property {number} order
 * @property {number} writtenTotal
 * @property {number} signedTotal
 * @property {number} signingFactor   factor applied to non-standing lines (1 if under/exact)
 * @property {number} shortfall       order - writtenTotal when undersubscribed, else 0
 * @property {number} standingTotal   Σ written of to-stand lines
 * @property {SignedLine[]} lines
 */

/**
 * Compute signed lines for a layer.
 * @param {number} order
 * @param {LineInput[]} lines
 * @returns {SigningResult}
 */
export function computeSigning(order, lines) {
  if (!(order >= 0)) throw new Error('order must be a non-negative number');
  for (const l of lines) {
    if (!(l.written >= 0)) throw new Error(`line ${l.id} has invalid written value`);
  }

  const writtenTotal = roundPct(sum(lines.map((l) => l.written)));

  if (lines.length === 0) {
    return {
      state: 'EMPTY',
      order,
      writtenTotal: 0,
      signedTotal: 0,
      signingFactor: 1,
      shortfall: order,
      standingTotal: 0,
      lines: [],
    };
  }

  const standing = lines.filter((l) => l.toStand);
  const flexible = lines.filter((l) => !l.toStand);
  const standingTotal = roundPct(sum(standing.map((l) => l.written)));
  const flexibleWritten = roundPct(sum(flexible.map((l) => l.written)));

  // Undersubscribed or exactly placed: everyone signs their written line.
  if (writtenTotal <= order) {
    const out = lines.map((l) => ({
      id: l.id,
      written: l.written,
      toStand: !!l.toStand,
      signed: roundPct(l.written),
    }));
    return {
      state: writtenTotal === order ? 'EXACT' : 'UNDERSUBSCRIBED',
      order,
      writtenTotal,
      signedTotal: roundPct(sum(out.map((l) => l.signed))),
      signingFactor: 1,
      shortfall: roundPct(Math.max(order - writtenTotal, 0)),
      standingTotal,
      lines: out,
    };
  }

  // Oversubscribed. Standing lines keep written; factor applies to the rest
  // against the residual order (order minus the standing total).
  const residualOrder = roundPct(order - standingTotal);
  if (residualOrder < 0) {
    throw new Error('to-stand lines exceed the order; cannot sign down');
  }

  const factor = flexibleWritten > 0 ? residualOrder / flexibleWritten : 0;

  // Raw signed values, preserving order of the input array.
  const raw = lines.map((l) => {
    if (l.toStand) return { ...l, rawSigned: l.written };
    return { ...l, rawSigned: l.written * factor };
  });

  // Round each, then fix the residual so Σ signed === order exactly using the
  // largest-remainder method on the flexible lines only.
  const rounded = raw.map((l) => ({ ...l, signed: roundPct(l.rawSigned) }));
  const signedTotal = roundPct(sum(rounded.map((l) => l.signed)));
  let residual = Math.round((order - signedTotal) * SCALE); // in integer "ticks"

  if (residual !== 0) {
    // Distribute the residual ticks one at a time to the flexible lines with the
    // largest fractional remainder (or smallest, when we must remove ticks).
    const flexibleIdx = rounded
      .map((l, i) => ({ i, frac: l.rawSigned * SCALE - Math.floor(l.rawSigned * SCALE), standing: l.toStand }))
      .filter((x) => !x.standing);

    // Sort by fractional remainder: descending when adding, ascending when removing.
    const direction = residual > 0 ? 1 : -1;
    flexibleIdx.sort((a, b) => (residual > 0 ? b.frac - a.frac : a.frac - b.frac));

    let k = 0;
    while (residual !== 0 && flexibleIdx.length > 0) {
      const target = flexibleIdx[k % flexibleIdx.length];
      const next = roundPct(rounded[target.i].signed + direction / SCALE);
      if (next >= 0) {
        rounded[target.i].signed = next;
        residual -= direction;
      }
      k += 1;
      // Safety: avoid infinite loops if every flexible line is pinned at 0.
      if (k > flexibleIdx.length * (Math.abs(residual) + 2)) break;
    }
  }

  const out = rounded.map((l) => ({
    id: l.id,
    written: l.written,
    toStand: !!l.toStand,
    signed: roundPct(l.signed),
  }));

  return {
    state: 'OVERSUBSCRIBED',
    order,
    writtenTotal,
    signedTotal: roundPct(sum(out.map((l) => l.signed))),
    signingFactor: roundPct(factor),
    shortfall: 0,
    standingTotal,
    lines: out,
  };
}

/**
 * Allocate premium per market from signed percentages.
 * @param {number} premium100  gross premium for the layer at 100%
 * @param {SignedLine[]} signedLines
 * @returns {{id: string|number, signed: number, premiumSigned: number}[]}
 *
 * Premiums are rounded to 2 d.p. with largest-remainder reconciliation so the
 * allocated total equals premium100 × (signedTotal / 100) to the cent.
 */
export function allocatePremium(premium100, signedLines) {
  if (!(premium100 >= 0)) throw new Error('premium100 must be non-negative');
  const signedTotal = signedLines.reduce((a, l) => a + l.signed, 0);
  const target = Math.round(premium100 * (signedTotal / 100) * 100) / 100;

  const raw = signedLines.map((l) => ({
    id: l.id,
    signed: l.signed,
    rawPremium: premium100 * (l.signed / 100),
  }));
  const rounded = raw.map((l) => ({ ...l, premiumSigned: Math.round(l.rawPremium * 100) / 100 }));
  const allocated = Math.round(rounded.reduce((a, l) => a + l.premiumSigned, 0) * 100) / 100;

  let residual = Math.round((target - allocated) * 100); // in cents
  if (residual !== 0 && rounded.length > 0) {
    const order = rounded
      .map((l, i) => ({ i, frac: l.rawPremium * 100 - Math.floor(l.rawPremium * 100) }))
      .sort((a, b) => (residual > 0 ? b.frac - a.frac : a.frac - b.frac));
    const direction = residual > 0 ? 1 : -1;
    let k = 0;
    while (residual !== 0 && order.length > 0) {
      const t = order[k % order.length];
      const next = Math.round((rounded[t.i].premiumSigned + direction / 100) * 100) / 100;
      if (next >= 0) {
        rounded[t.i].premiumSigned = next;
        residual -= direction;
      }
      k += 1;
      if (k > order.length * (Math.abs(residual) + 2)) break;
    }
  }

  return rounded.map((l) => ({ id: l.id, signed: l.signed, premiumSigned: l.premiumSigned }));
}

/**
 * Allocate premium by signed share, in integer minor units (§2.6).
 *
 * `allocatePremium` above works in units of 1/100 and predates the money
 * rules; it is still used by the pre-spine line ledger. This is the version the
 * spine uses, and it never multiplies a currency amount by a float.
 *
 * Percentages carry PCT_DP decimals, so a signed share is exactly
 * `ticks / 10^PCT_DP` percent. The allocation is therefore
 *
 *     premium_minor x ticks / (100 x 10^PCT_DP)
 *
 * computed in BigInt: a treaty-scale premium in minor units multiplied by a
 * tick count overflows Number.MAX_SAFE_INTEGER long before it overflows the
 * currency, and silently losing the low digits of a premium is exactly the
 * failure §2.6 exists to prevent.
 *
 * Rounds down per line and distributes the remainder by largest fractional
 * part, so the allocated total equals the target to the minor unit.
 *
 * @param {number} premiumMinor  premium at 100%, integer minor units
 * @param {{id: string|number, signed: number}[]} signedLines
 * @returns {{id: string|number, signed: number, premiumSignedMinor: number}[]}
 */
export function allocatePremiumMinor(premiumMinor, signedLines) {
  if (!Number.isInteger(premiumMinor) || premiumMinor < 0) {
    throw new Error('premiumMinor must be a non-negative integer of minor units');
  }
  if (signedLines.length === 0) return [];

  const DENOM = 100n * BigInt(SCALE);
  const premium = BigInt(premiumMinor);

  const parts = signedLines.map((l) => {
    const ticks = BigInt(Math.round(l.signed * SCALE));
    const numerator = premium * ticks;
    return {
      id: l.id,
      signed: l.signed,
      floor: numerator / DENOM,
      remainder: numerator % DENOM,
    };
  });

  const totalTicks = signedLines.reduce((n, l) => n + BigInt(Math.round(l.signed * SCALE)), 0n);
  // The target rounds half-up, matching how a broker would state the total.
  const targetNumerator = premium * totalTicks;
  const target = (targetNumerator + DENOM / 2n) / DENOM;

  const allocated = parts.reduce((n, p) => n + p.floor, 0n);
  let residual = target - allocated;

  // Largest remainder first; ties broken by the order the lines came in, so the
  // result is deterministic (§2.5) rather than dependent on sort stability.
  const order = parts
    .map((p, i) => ({ i, remainder: p.remainder }))
    .sort((a, b) => (a.remainder === b.remainder ? a.i - b.i : (b.remainder > a.remainder ? 1 : -1)));

  let k = 0;
  while (residual > 0n && order.length > 0) {
    parts[order[k % order.length].i].floor += 1n;
    residual -= 1n;
    k += 1;
  }

  return parts.map((p) => ({
    id: p.id,
    signed: p.signed,
    premiumSignedMinor: Number(p.floor),
  }));
}

/**
 * Apply the cedant's signing instruction — the client dictates each market's
 * signed line, which need not follow pro-rata sign-down (relationships and
 * other economic considerations drive the allocation).
 *
 * Rules enforced:
 *   - Every instructed line must exist among the written lines.
 *   - No market may be signed above its written line (a market can only be
 *     signed up beyond its written line by re-writing the line first).
 *   - Σ signed must equal the order exactly (to PCT_DP) — the instruction
 *     allocates the whole order, no more, no less.
 *   - Written lines omitted from the instruction are signed at nought.
 *
 * @param {number} order
 * @param {LineInput[]} lines            active written lines
 * @param {{id: string|number, signed: number}[]} allocations  the instruction
 * @returns {SigningResult} with state 'INSTRUCTED'
 */
export function computeInstructedSigning(order, lines, allocations) {
  if (!(order >= 0)) throw new Error('order must be a non-negative number');
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw new Error('signing instruction must allocate at least one line');
  }

  const byId = new Map(lines.map((l) => [String(l.id), l]));
  const seen = new Set();
  for (const a of allocations) {
    const line = byId.get(String(a.id));
    if (!line) throw new Error(`instruction allocates line ${a.id} which has no written line`);
    if (seen.has(String(a.id))) throw new Error(`instruction allocates line ${a.id} twice`);
    seen.add(String(a.id));
    if (!(a.signed >= 0)) throw new Error(`line ${a.id} has an invalid signed value`);
    if (roundPct(a.signed) > roundPct(line.written)) {
      throw new Error(
        `line ${a.id} instructed at ${a.signed}% above its written line ${line.written}%; re-write the line first`,
      );
    }
  }

  const signedById = new Map(allocations.map((a) => [String(a.id), roundPct(a.signed)]));
  const out = lines.map((l) => ({
    id: l.id,
    written: l.written,
    toStand: !!l.toStand,
    signed: signedById.get(String(l.id)) ?? 0,
  }));

  const writtenTotal = roundPct(sum(lines.map((l) => l.written)));
  const signedTotal = roundPct(sum(out.map((l) => l.signed)));
  if (signedTotal !== roundPct(order)) {
    throw new Error(`instructed signed total ${signedTotal}% must equal the order ${order}%`);
  }

  return {
    state: 'INSTRUCTED',
    order,
    writtenTotal,
    signedTotal,
    signingFactor: null,
    shortfall: 0,
    standingTotal: roundPct(sum(lines.filter((l) => l.toStand).map((l) => l.written))),
    lines: out,
  };
}
