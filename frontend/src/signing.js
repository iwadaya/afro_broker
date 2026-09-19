/**
 * Client-side mirror of the backend signing-down engine
 * (backend/src/domain/signingDown.js) so the worksheet and the layer
 * workspace recompute live as stands are toggled — signed values are derived,
 * never stored. The server remains the source of truth on apply; the preview
 * endpoint accepts the same provisional stand set for parity checks.
 */
export const PCT_DP = 4;
const SCALE = 10 ** PCT_DP;

export function roundPct(value) {
  return Math.round((value + Number.EPSILON) * SCALE) / SCALE;
}

const sum = (nums) => nums.reduce((a, b) => a + b, 0);

/**
 * @param {number} order  the layer's order %
 * @param {{id: string|number, written: number, toStand?: boolean}[]} lines
 */
export function computeSigning(order, lines) {
  const writtenTotal = roundPct(sum(lines.map((l) => l.written)));
  if (lines.length === 0) {
    return {
      state: 'EMPTY', order, writtenTotal: 0, signedTotal: 0, signingFactor: 1,
      rawFactor: 1, shortfall: order, standingTotal: 0, lines: [],
    };
  }

  const standing = lines.filter((l) => l.toStand);
  const flexible = lines.filter((l) => !l.toStand);
  const standingTotal = roundPct(sum(standing.map((l) => l.written)));
  const flexibleWritten = roundPct(sum(flexible.map((l) => l.written)));

  if (writtenTotal <= order) {
    const out = lines.map((l) => ({
      id: l.id, written: l.written, toStand: !!l.toStand, signed: roundPct(l.written),
    }));
    return {
      state: writtenTotal === order ? 'EXACT' : 'UNDERSUBSCRIBED',
      order, writtenTotal,
      signedTotal: roundPct(sum(out.map((l) => l.signed))),
      signingFactor: 1, rawFactor: 1,
      shortfall: roundPct(Math.max(order - writtenTotal, 0)),
      standingTotal, lines: out,
    };
  }

  const residualOrder = roundPct(order - standingTotal);
  const factor = flexibleWritten > 0 ? residualOrder / flexibleWritten : 0;

  const raw = lines.map((l) => ({
    ...l, rawSigned: l.toStand ? l.written : l.written * factor,
  }));
  const rounded = raw.map((l) => ({ ...l, signed: roundPct(l.rawSigned) }));
  const signedTotal = roundPct(sum(rounded.map((l) => l.signed)));
  let residual = Math.round((order - signedTotal) * SCALE);

  if (residual !== 0) {
    const flexibleIdx = rounded
      .map((l, i) => ({ i, frac: l.rawSigned * SCALE - Math.floor(l.rawSigned * SCALE), standing: l.toStand }))
      .filter((x) => !x.standing);
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
      if (k > flexibleIdx.length * (Math.abs(residual) + 2)) break;
    }
  }

  const out = rounded.map((l) => ({
    id: l.id, written: l.written, toStand: !!l.toStand, signed: roundPct(l.signed),
  }));
  return {
    state: 'OVERSUBSCRIBED', order, writtenTotal,
    signedTotal: roundPct(sum(out.map((l) => l.signed))),
    signingFactor: roundPct(factor),
    rawFactor: factor, // full precision, for 6-dp display
    shortfall: 0, standingTotal, lines: out,
  };
}

/** Allocate premium per line from signed %, reconciling to the cent. */
export function allocatePremium(premium100, signedLines) {
  const signedTotal = signedLines.reduce((a, l) => a + l.signed, 0);
  const target = Math.round(premium100 * (signedTotal / 100) * 100) / 100;
  const raw = signedLines.map((l) => ({
    id: l.id, signed: l.signed, rawPremium: premium100 * (l.signed / 100),
  }));
  const rounded = raw.map((l) => ({ ...l, premiumSigned: Math.round(l.rawPremium * 100) / 100 }));
  const allocated = Math.round(rounded.reduce((a, l) => a + l.premiumSigned, 0) * 100) / 100;
  let residual = Math.round((target - allocated) * 100);
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
