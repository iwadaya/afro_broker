import { ValidationError } from '../lib/errors.js';

/**
 * Dashboard brokerage (D2, M10).
 *
 * D2 fixes where brokerage lives — in the structure terms, versioning with the
 * structure — and gives the dashboard number:
 *
 *     Σ over signed lines: premium × signed_pct × structure.brokerage_pct
 *
 * A line's premium_signed_minor already IS premium × signed_pct, allocated
 * exactly by the signing engine, so the figure here is premium_signed_minor ×
 * brokerage_pct per line, summed. Computing from the stored allocation rather
 * than re-deriving it means the dashboard cannot disagree with the bordereau.
 *
 * Arithmetic is BigInt on integer minor units (§2.6): the percentage is carried
 * as ticks of 1/10000 of a percent, every line contributes an exact integer
 * numerator, and each currency is divided and rounded ONCE at the end (half-up).
 * Summing per-line rounded figures would drift by up to half a minor unit per
 * line; rounding once cannot.
 *
 * Currencies never mix. The book holds no FX rates, so the answer is a figure
 * per currency, not a total that pretends to be one number.
 */

const PCT_SCALE = 10000n;        // percentage ticks: 4 dp, matching PCT_DP
const DENOM = 100n * PCT_SCALE;  // minor × pctTicks / (100 × 10^4)

/**
 * @param {{premiumSignedMinor: number|null, brokeragePct: number, currency: string}[]} lines
 * @returns {{currency: string, brokerageMinor: number}[]} sorted by currency
 */
export function brokerageByCurrency(lines) {
  const numerators = new Map();

  for (const line of lines) {
    if (line.premiumSignedMinor == null) continue; // written but not yet signed
    if (!Number.isInteger(line.premiumSignedMinor) || line.premiumSignedMinor < 0) {
      throw new ValidationError('premiumSignedMinor must be a non-negative integer of minor units');
    }
    if (!(line.brokeragePct >= 0 && line.brokeragePct <= 100)) {
      throw new ValidationError(`brokeragePct must be between 0 and 100, got ${line.brokeragePct}`);
    }
    if (!line.currency) {
      throw new ValidationError('a premium without its currency is unusable (§2.6)');
    }

    const ticks = BigInt(Math.round(line.brokeragePct * Number(PCT_SCALE)));
    const numerator = BigInt(line.premiumSignedMinor) * ticks;
    numerators.set(line.currency, (numerators.get(line.currency) ?? 0n) + numerator);
  }

  return [...numerators.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, numerator]) => ({
      currency,
      brokerageMinor: Number((numerator + DENOM / 2n) / DENOM),
    }));
}
