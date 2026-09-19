/**
 * Excess-of-loss domain logic: the MDP instalment schedule and the loss /
 * reinstatement-premium arithmetic. Pure functions, mirrored by unit tests.
 *
 * Conventions:
 *   - All monetary figures are at 100% of the layer; per-market shares are cut
 *     from the 100% figure by signed line (see allocatePremium).
 *   - Reinstatement premium is pro rata to amount (not to time): each unit of
 *     limit consumed is reinstated at `reinstatement_premium_pct` of the
 *     proportional annual premium, while reinstatement capacity
 *     (reinstatements × limit) remains.
 */

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * The layer stores reinstatements as TEXT — '1'..'10', 'UNLIMITED' or NULL
 * (migration 014). Parse that to the number the arithmetic needs: a count,
 * Infinity for unlimited, 0 when the terms do not state any.
 */
export function parseReinstatements(text) {
  if (text == null || text === '') return 0;
  if (String(text).toUpperCase() === 'UNLIMITED') return Infinity;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Spread the deposit premium over equal instalments, reconciled to the cent
 * (the first instalment absorbs the rounding residual).
 * @returns {{instalment_no: number, due_date: string, amount: number}[]}
 */
export function buildMdpSchedule({ depositPremium, instalments, firstDue, frequencyMonths = 3 }) {
  if (!(depositPremium >= 0)) throw new Error('depositPremium must be non-negative');
  if (!Number.isInteger(instalments) || instalments < 1) throw new Error('instalments must be a positive integer');
  const first = new Date(firstDue);
  if (Number.isNaN(first.getTime())) throw new Error('firstDue must be a valid date');

  const base = round2(depositPremium / instalments);
  const schedule = [];
  for (let i = 0; i < instalments; i += 1) {
    const due = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i * frequencyMonths, first.getUTCDate()));
    schedule.push({
      instalment_no: i + 1,
      due_date: due.toISOString().slice(0, 10),
      amount: base,
    });
  }
  const allocated = round2(base * instalments);
  schedule[0].amount = round2(schedule[0].amount + round2(depositPremium - allocated));
  return schedule;
}

/**
 * Loss recovery and reinstatement premium for one loss event against an XoL
 * layer, given the limit already consumed by earlier losses in the period.
 *
 * @param {object} args
 * @param {number} args.grossLoss       loss from the ground up, 100% basis
 * @param {number} args.attachment      layer attachment point
 * @param {number|null} args.limit      occurrence limit (null = unlimited)
 * @param {number} args.premium100      annual premium at 100%
 * @param {number} args.reinstatements  number of reinstatements (Infinity = unlimited)
 * @param {number} args.reinstatementPremiumPct  e.g. 100 = at 100% additional premium
 * @param {number} [args.consumedBefore]  Σ recoveries of earlier losses (100% basis)
 * @returns {{lossToLayer: number, recovery: number, reinstated: number,
 *            reinstatementPremium: number, remainingAggregate: number}}
 */
export function computeXolLoss({
  grossLoss, attachment, limit, premium100,
  reinstatements = 0, reinstatementPremiumPct = 100, consumedBefore = 0,
}) {
  if (!(grossLoss >= 0)) throw new Error('grossLoss must be non-negative');
  if (!(attachment >= 0)) throw new Error('attachment must be non-negative');
  if (!(consumedBefore >= 0)) throw new Error('consumedBefore must be non-negative');

  const excess = Math.max(grossLoss - attachment, 0);
  const lossToLayer = round2(limit != null ? Math.min(excess, limit) : excess);

  // Without a finite limit there is no aggregate cap and nothing to reinstate.
  if (limit == null || limit <= 0) {
    return { lossToLayer, recovery: lossToLayer, reinstated: 0, reinstatementPremium: 0, remainingAggregate: null };
  }

  const unlimited = reinstatements === Infinity;
  const aggregateCapacity = unlimited ? Infinity : limit * (1 + reinstatements);
  const remainingBefore = Math.max(0, aggregateCapacity - consumedBefore);
  const recovery = round2(Math.min(lossToLayer, remainingBefore));

  // Reinstatement capacity is consumed in loss order; the final limit is not
  // reinstated (there is no cover left to restore). Unlimited reinstatements
  // always restore in full.
  const ripCapacity = unlimited ? Infinity : reinstatements * limit;
  const reinstatedBefore = Math.min(consumedBefore, ripCapacity);
  const reinstated = round2(Math.min(recovery, ripCapacity - reinstatedBefore));
  const reinstatementPremium = round2((reinstated / limit) * premium100 * (reinstatementPremiumPct / 100));

  return {
    lossToLayer,
    recovery,
    reinstated,
    reinstatementPremium,
    remainingAggregate: unlimited ? null : round2(Math.max(0, remainingBefore - recovery)),
  };
}
