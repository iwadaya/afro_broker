import { ValidationError } from '../lib/errors.js';
import { amount, allocateSigned, dateOnly, roundMoney, validDate } from './premiumAccounting.js';
import { computeXolLoss } from './xol.js';

export function claimMoney(value, label) {
  const n = amount(value, label);
  if (n > 1e12 || Math.abs(n - roundMoney(n)) > 1e-7) throw new ValidationError(`${label} must have at most two decimal places and be no more than 1 trillion`);
  return roundMoney(n);
}

export function validateClaim(input, placement) {
  const retained = claimMoney(input.retained_loss, 'Retained loss');
  const paid = claimMoney(input.paid, 'Paid loss');
  const outstanding = claimMoney(input.outstanding, 'Outstanding loss');
  if (Math.round(paid * 100) + Math.round(outstanding * 100) !== Math.round(retained * 100)) throw new ValidationError('Paid plus outstanding must equal the retained loss at 100%');
  const lossDate = validDate(input.loss_date);
  if (lossDate < dateOnly(placement.inception) || lossDate > dateOnly(placement.expiry)) throw new ValidationError('The loss date must fall within the selected contract period');
  if (!String(input.name || '').trim()) throw new ValidationError('Enter a claim or event name');
  return { ...input, name: input.name.trim(), retained_loss: retained, paid, outstanding, loss_date: lossDate, cat_event: !!input.cat_event };
}

function countOf(value) {
  if (value == null || value === '') return 0;
  if (String(value).toUpperCase() === 'UNLIMITED') return Infinity;
  if (!/^\d+$/.test(String(value)) || Number(value) > 100) throw new ValidationError('Record reinstatements as a whole number from 0 to 100 or UNLIMITED in the structure');
  return Number(value);
}

// Split an already-rounded signed account into paid and outstanding. Capping
// paid cents at its total avoids a negative reserve from largest-remainder ties.
function splitSigned(total, paid, lines) {
  const full = allocateSigned(total, lines);
  const paidShares = allocateSigned(paid, lines);
  const rows = full.map((r, i) => ({ ...r, cents: Math.round(r.gross_amount * 100), paidCents: Math.min(Math.round(r.gross_amount * 100), Math.round(paidShares[i].gross_amount * 100)) }));
  let remainder = paidShares.reduce((s, r) => s + Math.round(r.gross_amount * 100), 0) - rows.reduce((s, r) => s + r.paidCents, 0);
  for (const r of rows.slice().sort((a, b) => a.market_id.localeCompare(b.market_id))) {
    const extra = Math.min(remainder, r.cents - r.paidCents); r.paidCents += extra; remainder -= extra;
  }
  return rows.map(r => ({ market_id: r.market_id, total: r.cents / 100, paid: r.paidCents / 100, outstanding: (r.cents - r.paidCents) / 100 }));
}

export function calculateClaim({ placement, layers, previous = [], input }) {
  const claim = validateClaim(input, placement);
  const totals = { recovery: 0, paid_recovery: 0, outstanding_recovery: 0, reinstatement_premium: 0, paid_reinstatement_premium: 0, outstanding_reinstatement_premium: 0, net: 0, net_paid: 0, net_outstanding: 0 };
  const markets = new Map();
  const output = layers.map(layer => {
    const excluded = layer.currency !== placement.currency ? `Recorded loss is in ${placement.currency}; no currency conversion applied` : (claim.cat_event ? layer.cat_cover === false : layer.risk_cover === false) ? 'This layer does not cover this event type' : null;
    if (excluded) return { ...layer, excluded, calculation: null };
    const attachment = claimMoney(layer.attachment, `${layer.name}: deductible`);
    const limit = claimMoney(layer.limit_amt, `${layer.name}: limit`);
    if (!limit) throw new ValidationError(`${layer.name}: a positive occurrence limit is required`);
    const reinstatements = countOf(layer.reinstatements);
    const pct = layer.reinstatement_pct == null ? 100 : amount(layer.reinstatement_pct, 'Reinstatement premium %');
    const premium = reinstatements && pct ? claimMoney(layer.premium100, `${layer.name}: annual premium`) : 0;
    const aad = layer.aad == null ? 0 : claimMoney(layer.aad, `${layer.name}: annual aggregate deductible`);
    let consumed = 0, subjectConsumed = 0;
    const subject = loss => roundMoney(Math.min(Math.max(loss - attachment, 0), limit));
    const calc = (loss, used, deductibleLeft) => computeXolLoss({ grossLoss: Math.max(0, subject(loss) - deductibleLeft), attachment: 0, limit, premium100: premium, reinstatements, reinstatementPremiumPct: pct, consumedBefore: used });
    for (const e of previous) {
      if (e.currency !== placement.currency || (e.cat_event ? layer.cat_cover === false : layer.risk_cover === false)) continue;
      const r = calc(Number(e.gross_loss), consumed, Math.max(0, aad - subjectConsumed));
      consumed = roundMoney(consumed + r.recovery); subjectConsumed = roundMoney(subjectConsumed + subject(Number(e.gross_loss)));
    }
    const aadLeft = Math.max(0, aad - subjectConsumed);
    const total = calc(claim.retained_loss, consumed, aadLeft);
    const paid = calc(claim.paid, consumed, aadLeft);
    const c = {
      recovery: total.recovery, paid_recovery: paid.recovery, outstanding_recovery: roundMoney(total.recovery - paid.recovery),
      reinstatement_premium: total.reinstatementPremium, paid_reinstatement_premium: paid.reinstatementPremium,
      outstanding_reinstatement_premium: roundMoney(total.reinstatementPremium - paid.reinstatementPremium),
      net: roundMoney(total.recovery - total.reinstatementPremium), net_paid: roundMoney(paid.recovery - paid.reinstatementPremium),
      net_outstanding: roundMoney(total.recovery - paid.recovery - total.reinstatementPremium + paid.reinstatementPremium),
      consumed_before: consumed, remaining_aggregate: total.remainingAggregate, aad_remaining_before: aadLeft,
      aad_applied: roundMoney(Math.min(subject(claim.retained_loss), aadLeft)), reinstated: total.reinstated,
    };
    const recovery = splitSigned(c.recovery, c.paid_recovery, layer.lines);
    const rip = splitSigned(c.reinstatement_premium, c.paid_reinstatement_premium, layer.lines);
    const allocations = layer.lines.map((line, i) => ({ ...line,
      recovery: recovery[i].total, paid_recovery: recovery[i].paid, outstanding_recovery: recovery[i].outstanding,
      reinstatement_premium: rip[i].total, paid_reinstatement_premium: rip[i].paid, outstanding_reinstatement_premium: rip[i].outstanding,
      net: roundMoney(recovery[i].total - rip[i].total), net_paid: roundMoney(recovery[i].paid - rip[i].paid), net_outstanding: roundMoney(recovery[i].outstanding - rip[i].outstanding),
    }));
    for (const key of Object.keys(totals)) totals[key] = roundMoney(totals[key] + c[key]);
    for (const line of allocations) {
      const m = markets.get(line.market_id) || { market_id: line.market_id, market_name: line.market_name, ...Object.fromEntries(Object.keys(totals).map(k => [k, 0])), layers: [] };
      for (const key of Object.keys(totals)) m[key] = roundMoney(m[key] + line[key]);
      m.layers.push({ layer_key: layer.key, layer_name: layer.name, ...line }); markets.set(line.market_id, m);
    }
    return { ...layer, excluded: null, calculation: { ...c, markets: allocations } };
  });
  if (!output.some(l => l.calculation)) throw new ValidationError('No placed layer covers this event type in the contract currency');
  const placed = Object.fromEntries(Object.keys(totals).map(k => [k, roundMoney([...markets.values()].reduce((s, m) => s + m[k], 0))]));
  return { placement, claim, layers: output, totals, placed_totals: placed, markets: [...markets.values()], preceding_claims: previous.length, reinstatement_basis: 'Pro rata to amount, 100% as to time', paid_basis: 'Paid loss through the deductible and limit; outstanding is the balance of the incurred recovery' };
}
