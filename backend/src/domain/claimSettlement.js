/**
 * The settlement ladder of a non-proportional claim, and each reinsurer's
 * share of it. Pure functions over what the XoL engine already computed
 * (loss to layer and reinstatement premium per layer, and every market's
 * share of each by signed line), mirrored by unit tests.
 *
 *   gross loss to layer
 *   + loss adjustment expenses
 *   - salvage and recoveries
 *   - reinstatement premium   (waivable; pro rata to amount, 100% as to time)
 *   - cash call already funded
 *   = net amount due from reinsurers
 *
 * The reinstatement premium is offset against the claim — there is no
 * separate reinstatement invoice.
 */

import { allocatePremium } from './signingDown.js';

const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (v == null || v === '' ? 0 : Number(v));

/** The ladder at 100% of the layers the loss reaches. */
export function settlementLadder({ event, recoveries }) {
  const reached = recoveries.filter((r) => num(r.loss_to_layer) > 0);
  const gross = round2(recoveries.reduce((t, r) => t + num(r.loss_to_layer), 0));
  const ripFull = round2(recoveries.reduce((t, r) => t + num(r.reinstatement_premium), 0));
  const waived = Boolean(event.waive_reinstatement);
  const lae = round2(num(event.lae));
  const salvage = round2(num(event.salvage));
  const cash = round2(num(event.cash_funded));
  const rip = waived ? 0 : ripFull;

  const layers = recoveries.map((r) => {
    const limit = r.detail?.limit != null ? Number(r.detail.limit) : null;
    const reinstated = num(r.detail?.reinstated);
    return {
      layer_id: r.layer_id,
      layer_name: r.layer_name,
      limit,
      loss_to_layer: round2(num(r.loss_to_layer)),
      erosion_pct: limit ? round2((num(r.loss_to_layer) / limit) * 100) : null,
      reinstated,
      reinstated_pct: limit ? round2((reinstated / limit) * 100) : null,
      reinstatement_premium: round2(num(r.reinstatement_premium)),
    };
  });
  const attaching = layers.find((l) => l.loss_to_layer > 0) || null;

  return {
    gross_to_layer: gross,
    lae,
    salvage,
    reinstatement_premium_full: ripFull,
    reinstatement_premium: rip,
    reinstatement_waived: waived,
    reinstated_pct: attaching?.reinstated_pct ?? null,
    reinstatement_basis: 'pro rata amount, 100% as to time',
    cash_funded: cash,
    net_due: round2(gross + lae - salvage - rip - cash),
    attaching_layer: attaching ? { id: attaching.layer_id, name: attaching.layer_name } : null,
    layers_reached: reached.length,
    layers,
  };
}

/**
 * Each reinsurer's share of the ladder. Gross and reinstatement premium are
 * the engine's own shares by signed line on each layer reached; expenses,
 * salvage and cash are apportioned on each market's share of the gross, by
 * largest remainder, so every column sums to the ladder to the cent.
 */
export function marketBreakdown({ ladder, recoveries }) {
  const markets = new Map();
  for (const r of recoveries) {
    for (const m of r.detail?.markets || []) {
      const entry = markets.get(m.market_id) || {
        market_id: m.market_id, market_name: m.market_name, lines: [], gross: 0, reinstatement_premium_full: 0,
      };
      entry.lines.push({
        layer_id: r.layer_id,
        layer_name: r.layer_name,
        signed_pct: num(m.signed_pct),
        recovery: round2(num(m.recovery)),
        reinstatement_premium: round2(num(m.reinstatement_premium)),
      });
      entry.gross = round2(entry.gross + num(m.recovery));
      entry.reinstatement_premium_full = round2(entry.reinstatement_premium_full + num(m.reinstatement_premium));
      markets.set(m.market_id, entry);
    }
  }
  const list = [...markets.values()];
  const total = round2(list.reduce((t, m) => t + m.gross, 0));
  const weights = list.map((m) => ({ id: m.market_id, signed: total > 0 ? (m.gross / total) * 100 : 0 }));
  const spread = (amount) => {
    if (!amount || total <= 0) return Object.fromEntries(list.map((m) => [m.market_id, 0]));
    return Object.fromEntries(allocatePremium(amount, weights).map((a) => [a.id, a.premiumSigned]));
  };
  const laeBy = spread(ladder.lae);
  const salvageBy = spread(ladder.salvage);
  const cashBy = spread(ladder.cash_funded);

  return list.map((m) => {
    const lae = laeBy[m.market_id] || 0;
    const salvage = salvageBy[m.market_id] || 0;
    const cash = cashBy[m.market_id] || 0;
    const rip = ladder.reinstatement_waived ? 0 : m.reinstatement_premium_full;
    const reached = m.lines.filter((l) => l.recovery > 0);
    return {
      market_id: m.market_id,
      market_name: m.market_name,
      lines: m.lines,
      // The line the advice quotes: the one on the attaching layer, else the first.
      signed_pct: (reached[0] || m.lines[0])?.signed_pct ?? null,
      gross: m.gross,
      lae,
      salvage,
      expenses_net: round2(lae - salvage),
      reinstatement_premium: rip,
      cash_funded: cash,
      net_due: round2(m.gross + lae - salvage - rip - cash),
    };
  }).sort((a, b) => b.net_due - a.net_due || a.market_name.localeCompare(b.market_name));
}

/** The ladder and the breakdown together — what the advice and the workspace read. */
export function settlementFor({ event, recoveries }) {
  const ladder = settlementLadder({ event, recoveries });
  return { ladder, markets: marketBreakdown({ ladder, recoveries }) };
}
