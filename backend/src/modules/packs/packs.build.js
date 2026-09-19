/*
 * Building a renewal pack version.
 *
 * Every section in the template for the placement's basis is built, in order.
 * A builder returns rows/figures or nothing; nothing means the section is
 * marked `empty` and carries the template's note about what would fill it. No
 * section is ever dropped — a market opening v3 sees the same running order it
 * saw in v1, gaps included.
 */

import { splitClass } from '../../domain/placementClass.js';
import { aggregateBordereaux, num } from '../analysis/analysis.service.js';
import { PACK_SECTIONS, TEMPLATE_VERSION, sectionKeys, templateGroups } from './packs.template.js';

const round2 = (n) => Math.round(n * 100) / 100;
const text = (v) => String(v ?? '').trim();

/** Losses at or above this share of the ceded premium count as "large". */
const LARGE_LOSS_SHARE = 0.05;
const CAT_PERILS = /\b(cat|catastrophe|flood|storm|cyclone|hurricane|typhoon|earthquake|quake|hail|windstorm|tsunami|tornado|drought|riot|strike|civil commotion|ssmd)\b/i;

/** Sum-insured bands for the risk profile, in the treaty currency. */
const BANDS = [
  [0, 100_000], [100_000, 500_000], [500_000, 1_000_000], [1_000_000, 5_000_000],
  [5_000_000, 10_000_000], [10_000_000, 25_000_000], [25_000_000, 50_000_000],
  [50_000_000, Infinity],
];

const bandLabel = ([lo, hi]) => (hi === Infinity
  ? `${lo.toLocaleString('en-US')}+`
  : `${lo.toLocaleString('en-US')} – ${hi.toLocaleString('en-US')}`);

/* ── Bordereau field aliases ───────────────────────────────────────────
   Ingested bordereaux carry canonical column names; cedant files pasted
   through looser paths use their own. Read both so the standard pack fills
   either way. */
const firstOf = (r, keys) => {
  for (const k of keys) {
    if (r[k] != null && r[k] !== '') return r[k];
  }
  return null;
};
const yearOf = (r) => {
  const y = firstOf(r, ['uy', 'uw_year', 'underwriting_year', 'year', 'treaty_year']);
  if (y != null && /^\d{4}$/.test(String(y).trim())) return String(y).trim();
  const d = text(firstOf(r, ['inception', 'date_of_loss', 'loss_date', 'date']) || '');
  return /^\d{4}/.test(d) ? d.slice(0, 4) : null;
};
const classOf = (r) => text(firstOf(r, ['class_of_business', 'class', 'cob', 'line_of_business'])) || '(unstated)';
const premiumOf = (r) => num(firstOf(r, ['premium_ceded', 'premium', 'gross_premium_100']));
const paidOf = (r) => num(firstOf(r, ['paid', 'claims_paid', 'paid_amount']));
const osOf = (r) => num(firstOf(r, ['outstanding', 'os', 'os_claims', 'outstanding_amount']));
const incurredOfRow = (r) => {
  const i = num(r.incurred);
  return i || paidOf(r) + osOf(r);
};
const siOf = (r) => num(firstOf(r, ['sum_insured_100', 'tsi', 'si', 'sum_insured']));
const occupancyOf = (r) => text(firstOf(r, ['occupancy', 'occupancy_category', 'occupancy_class', 'occ']));
const regionOf = (r) => text(firstOf(r, ['territory', 'region', 'country']));
const zoneOf = (r) => text(firstOf(r, ['cresta', 'cresta_zone', 'zone']));
const causeOf = (r) => text(firstOf(r, ['cause_of_loss', 'peril', 'cause', 'event']));

/** Sum a measure per underwriting year across rows; null when no year data. */
function byYear(rows, measure) {
  const years = new Map();
  for (const r of rows) {
    const y = yearOf(r);
    if (!y) continue;
    const cur = years.get(y) || { year: y, count: 0, amount: 0 };
    cur.count += 1;
    cur.amount = round2(cur.amount + measure(r));
    years.set(y, cur);
  }
  return years.size ? [...years.values()].sort((a, b) => a.year.localeCompare(b.year)) : null;
}

/** UW year × as-at development matrix from successive bordereau snapshots. */
const isoDay = (v) => {
  if (!v) return '';
  return (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
};
function triangulate(bordereaux, type, measure) {
  const snaps = (bordereaux || [])
    .filter((b) => b.type === type && (b.parsed_rows || []).length)
    .map((b) => ({
      label: isoDay(b.period_end || b.created_at) || 'as ingested',
      rows: b.parsed_rows,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (!snaps.length) return null;
  // Two bordereaux cut to the same date keep distinct columns.
  const seen = new Map();
  for (const s of snaps) {
    const n = (seen.get(s.label) || 0) + 1;
    seen.set(s.label, n);
    if (n > 1) s.label = `${s.label} (${n})`;
  }

  const years = new Set();
  const perSnap = snaps.map((s) => {
    const m = new Map();
    for (const r of s.rows) {
      const y = yearOf(r);
      if (!y) continue;
      years.add(y);
      m.set(y, round2((m.get(y) || 0) + measure(r)));
    }
    return m;
  });
  if (!years.size) return null;

  const ordered = [...years].sort();
  return {
    columns: snaps.map((s) => s.label),
    rows: ordered.map((y) => ({
      year: y,
      values: perSnap.map((m) => (m.has(y) ? m.get(y) : null)),
    })),
  };
}

/** Group rows into per-class buckets, preserving the running order. */
function groupByClass(rows) {
  const classes = new Map();
  for (const r of rows) {
    const k = classOf(r);
    if (!classes.has(k)) classes.set(k, []);
    classes.get(k).push(r);
  }
  return [...classes.entries()];
}

/** The basis a pack runs on: the placement's structure 1, defaulting to NP. */
export function packBasis(placement) {
  const structure = (placement.quote_structures || [])[0];
  if (structure?.basis === 'PROP') return 'PROP';
  if (structure?.basis === 'NP') return 'NP';
  // No structure yet — fall back to the expiring basis, then to the treaty
  // type on the class string.
  if (placement.expiring_structure?.basis === 'PROP') return 'PROP';
  return /\b(qs|quota|surplus|proportional)\b/i.test(placement.class || '') ? 'PROP' : 'NP';
}


/* ── Section builders ──────────────────────────────────────────────────
   Each takes the assembled context and returns the section's data, or null
   when there is nothing behind it. */

/** The class string split into COBs + treaty type, as the wizard writes it —
    the shared splitter in domain/placementClass.js, re-exported for the
    callers that read it from here. */
export { splitClass };

/** One line per structure, so the info page can say what is being quoted. */
function structureSummary(placement, layers) {
  const out = [];
  (placement.quote_structures || []).forEach((s, i) => {
    if (s.basis === 'PROP') {
      const p = s.prop || {};
      out.push(`Structure ${i + 1}: ${p.treatyType || 'Proportional'}${p.qsLimit ? ` · limit ${Number(p.qsLimit).toLocaleString('en-US')}` : ''}${p.commissionPct !== '' && p.commissionPct != null ? ` · ${p.commissionPct}% commission` : ''}`);
    } else {
      out.push(`Structure ${i + 1}: Non-proportional · ${(s.layers || []).length} layer${(s.layers || []).length === 1 ? '' : 's'}`);
    }
  });
  if (!out.length && layers.length) out.push(`${layers.length} layer${layers.length === 1 ? '' : 's'} on the placement`);
  return out;
}

const builders = {
  info_page: ({ placement, cedant, layers, expiringLeader }) => (placement.reference ? {
    reference: placement.reference,
    cedant: cedant?.name || null,
    domicile: cedant?.domicile || null,
    inception: placement.inception,
    renewal_date: placement.expiry,
    classes_of_business: splitClass(placement.class).cobs,
    treaty_type: splitClass(placement.class).treaty_type,
    currency: placement.currency,
    treaty_structure: structureSummary(placement, layers),
    expiring_leader: expiringLeader || null,
    status: placement.status,
    renewal_of: placement.renewal_of,
    notes: placement.notes || null,
  } : null),

  historical_epi: ({ premiumRows, placement }) => {
    const years = byYear(premiumRows, premiumOf);
    const structures = placement.quote_structures || [];
    const epi = structures.find((s) => s.basis === 'PROP' && s.prop?.epi !== '' && s.prop?.epi != null)?.prop?.epi;
    const expiring = placement.expiring_structure?.prop?.epi;
    if (!years && epi == null && expiring == null) return null;
    return {
      years: (years || []).map((y) => ({ year: y.year, risks: y.count, epi: y.amount })),
      epi_to_market: epi == null ? null : Number(epi),
      expiring_epi: expiring == null || expiring === '' ? null : Number(expiring),
    };
  },

  // The ceding criteria, read off what the placement already says: how each
  // structure cedes (a quota share's retention, limit and surplus lines; an
  // excess of loss's retention and layers), the underwriting limit per class,
  // and the table of retentions by occupancy.
  ceding_criteria: ({ placement }) => {
    const money = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 0 }));
    const pct = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : `${Number(v)}%`);
    const ccy = placement.currency || '';
    const lines = [];
    (placement.quote_structures || []).forEach((s, i) => {
      if (s.basis === 'PROP') {
        const p = s.prop || {};
        const parts = [];
        if (pct(p.retentionPct)) parts.push(`the cedant retains ${pct(p.retentionPct)} of every risk`);
        if (money(p.qsLimit)) parts.push(`cession up to ${ccy} ${money(p.qsLimit)} per risk`);
        if (money(p.surplusMaxRetention) && Number(p.numLines) > 0) parts.push(`${Number(p.numLines)} surplus lines on a maximum retention of ${ccy} ${money(p.surplusMaxRetention)}`);
        if (money(p.eventLimit)) parts.push(`event limit ${ccy} ${money(p.eventLimit)}`);
        if (parts.length) lines.push(`Structure ${i + 1} — ${p.treatyType || 'proportional'}: ${parts.join('; ')}.`);
      } else {
        const layers = (s.layers || []).filter((l) => l.attachment !== '' && l.attachment != null);
        if (layers.length) {
          const first = layers[0];
          lines.push(`Structure ${i + 1} — ${s.npTreatyType || 'excess of loss'}: the cedant retains the first ${ccy} ${money(first.attachment)} of every loss; `
            + `${layers.length} layer${layers.length === 1 ? '' : 's'} to ${ccy} ${money(layers.reduce((m, l) => Math.max(m, Number(l.attachment) + Number(l.limit || 0)), 0))}`
            + `${layers.some((l) => l.reinstatements) ? `, reinstatements ${layers.map((l) => l.reinstatements || '—').join(' / ')}` : ''}.`);
        }
      }
      for (const c of s.cobs || []) {
        if (money(c.limit)) lines.push(`Underwriting limit, ${c.cob}: ${ccy} ${money(c.limit)} any one risk.`);
      }
    });
    const stored = placement.retentions;
    const rows = (Array.isArray(stored) ? stored : stored?.rows || []).filter((r) => r.category && r.pct !== '' && r.pct != null);
    if (rows.length) {
      lines.push(`Retention by occupancy${money(stored?.limit) ? ` (treaty full limit ${ccy} ${money(stored.limit)})` : ''}: `
        + rows.map((r) => `${r.category}${r.klass ? ` (class ${r.klass})` : ''} ${pct(r.pct)}`).join('; ') + '.');
    }
    return lines.length ? { text: lines.join('\n') } : null;
  },

  triangulation_premium: ({ bordereaux }) => triangulate(bordereaux, 'premium', premiumOf),
  triangulation_paid: ({ bordereaux }) => triangulate(bordereaux, 'claims', paidOf),
  triangulation_os: ({ bordereaux }) => triangulate(bordereaux, 'claims', osOf),

  straight_premium: ({ premiumRows }) => {
    const years = byYear(premiumRows, premiumOf);
    return years ? { rows: years.map((y) => ({ year: y.year, risks: y.count, premium: y.amount })) } : null;
  },
  straight_paid: ({ claimsRows }) => {
    const years = byYear(claimsRows, paidOf);
    return years ? { rows: years.map((y) => ({ year: y.year, claims: y.count, paid: y.amount })) } : null;
  },
  straight_os: ({ claimsRows }) => {
    const years = byYear(claimsRows, osOf);
    return years ? { rows: years.map((y) => ({ year: y.year, claims: y.count, outstanding: y.amount })) } : null;
  },

  commissions: ({ placement }) => {
    const rows = [];
    const terms = (label, p) => {
      if (!p) return;
      const any = ['commissionPct', 'profitCommissionPct', 'mgmtExpensesPct', 'brokeragePct', 'lpvPct']
        .some((k) => p[k] !== '' && p[k] != null);
      if (!any) return;
      const n = (v) => (v === '' || v == null ? null : Number(v));
      rows.push({
        source: label,
        treaty_type: p.treatyType || null,
        commission_pct: n(p.commissionPct),
        profit_commission_pct: n(p.profitCommissionPct),
        mgmt_expenses_pct: n(p.mgmtExpensesPct),
        brokerage_pct: n(p.brokeragePct),
        lpv_pct: n(p.lpvPct),
      });
    };
    if (placement.expiring_structure?.prop) terms('Expiring', placement.expiring_structure.prop);
    (placement.quote_structures || []).forEach((s, i) => {
      if (s.basis === 'PROP') terms(`Structure ${i + 1}`, s.prop);
    });
    return rows.length ? { rows } : null;
  },

  stats_ratios: (ctx) => {
    const { premiumRows, claimsRows, placement } = ctx;
    const premium = byYear(premiumRows, premiumOf);
    const incurred = byYear(claimsRows, incurredOfRow);
    if (!premium || !incurred) return null;
    const commission = (() => {
      const p = (placement.quote_structures || []).find((s) => s.basis === 'PROP')?.prop
        || placement.expiring_structure?.prop;
      const v = p?.commissionPct;
      return v === '' || v == null ? null : Number(v);
    })();
    const incurredByYear = new Map(incurred.map((y) => [y.year, y.amount]));
    const years = premium.map((p) => {
      const inc = incurredByYear.get(p.year) ?? 0;
      const lossRatio = p.amount > 0 ? round2((inc / p.amount) * 100) : null;
      return {
        year: p.year,
        premium: p.amount,
        incurred: round2(inc),
        loss_ratio_pct: lossRatio,
        commission_ratio_pct: commission,
        combined_ratio_pct: lossRatio == null || commission == null ? null : round2(lossRatio + commission),
      };
    });
    return { rows: years, commission_basis: commission == null ? 'no commission on the terms' : 'flat commission from the terms' };
  },

  large_losses_by_class: ({ claimsRows, premiumRows, aggregates }) => {
    // The canonical aggregate misses loosely-named premium columns; fall back
    // to the alias-aware sum so the threshold still means something.
    const ceded = aggregates.premium.premium_ceded
      || round2(premiumRows.reduce((a, r) => a + premiumOf(r), 0));
    const threshold = round2(ceded * LARGE_LOSS_SHARE);
    if (!claimsRows.length || threshold <= 0) return null;
    const large = claimsRows.filter((r) => incurredOfRow(r) >= threshold);
    if (!large.length) return null;
    const classes = groupByClass(large).map(([klass, rows]) => ({
      class: klass,
      losses: rows
        .sort((a, b) => incurredOfRow(b) - incurredOfRow(a))
        .map((r) => ({
          claim_ref: text(r.claim_ref),
          insured: text(firstOf(r, ['insured', 'risk', 'name']) || ''),
          date_of_loss: text(firstOf(r, ['date_of_loss', 'loss_date', 'date']) || ''),
          cause_of_loss: causeOf(r),
          paid: round2(paidOf(r)),
          outstanding: round2(osOf(r)),
          incurred: round2(incurredOfRow(r)),
        })),
      incurred: round2(rows.reduce((a, r) => a + incurredOfRow(r), 0)),
    }));
    return { threshold, basis: `${LARGE_LOSS_SHARE * 100}% of ceded premium`, classes };
  },

  cat_losses_by_class: ({ claimsRows }) => {
    const cat = claimsRows.filter((r) => CAT_PERILS.test(causeOf(r)));
    if (!cat.length) return null;
    const classes = groupByClass(cat).map(([klass, rows]) => ({
      class: klass,
      losses: rows
        .sort((a, b) => incurredOfRow(b) - incurredOfRow(a))
        .map((r) => ({
          claim_ref: text(r.claim_ref),
          date_of_loss: text(firstOf(r, ['date_of_loss', 'loss_date', 'date']) || ''),
          cause_of_loss: causeOf(r),
          incurred: round2(incurredOfRow(r)),
        })),
      incurred: round2(rows.reduce((a, r) => a + incurredOfRow(r), 0)),
    }));
    return { classes, incurred: round2(cat.reduce((a, r) => a + incurredOfRow(r), 0)) };
  },

  risk_profile_by_class: ({ premiumRows }) => {
    if (!premiumRows.length) return null;
    const classes = groupByClass(premiumRows).map(([klass, rows]) => {
      const bands = BANDS.map((band) => ({
        band: bandLabel(band), risks: 0, sum_insured_100: 0, premium_ceded: 0,
      }));
      for (const r of rows) {
        const si = siOf(r);
        const i = BANDS.findIndex(([lo, hi]) => si >= lo && si < hi);
        if (i === -1) continue;
        bands[i].risks += 1;
        bands[i].sum_insured_100 = round2(bands[i].sum_insured_100 + si);
        bands[i].premium_ceded = round2(bands[i].premium_ceded + premiumOf(r));
      }
      return { class: klass, bands: bands.filter((b) => b.risks > 0) };
    }).filter((c) => c.bands.length);
    return classes.length ? { classes } : null;
  },

  aggregates_by_class: ({ premiumRows }) => {
    const agg = (keyOf) => {
      const rows = premiumRows.filter((r) => keyOf(r));
      if (!rows.length) return [];
      const m = new Map();
      for (const r of rows) {
        const key = `${classOf(r)} · ${keyOf(r)}`;
        const cur = m.get(key) || { class: classOf(r), zone: keyOf(r), risks: 0, sum_insured_100: 0, premium_ceded: 0 };
        cur.risks += 1;
        cur.sum_insured_100 = round2(cur.sum_insured_100 + siOf(r));
        cur.premium_ceded = round2(cur.premium_ceded + premiumOf(r));
        m.set(key, cur);
      }
      return [...m.values()].sort((a, b) => a.class.localeCompare(b.class) || b.sum_insured_100 - a.sum_insured_100);
    };
    const regions = agg(regionOf);
    const cresta = agg(zoneOf);
    return regions.length || cresta.length ? { regions, cresta } : null;
  },

  top_risks: ({ premiumRows }) => {
    const ranked = premiumRows
      .filter((r) => siOf(r) > 0)
      .sort((a, b) => siOf(b) - siOf(a))
      .slice(0, 20)
      .map((r, i) => ({
        rank: i + 1,
        insured: text(firstOf(r, ['insured', 'risk', 'name']) || ''),
        policy_ref: text(r.policy_ref),
        class: classOf(r),
        territory: regionOf(r) || null,
        sum_insured_100: round2(siOf(r)),
        premium_ceded: round2(premiumOf(r)),
      }));
    return ranked.length ? { rows: ranked, note: 'Top 20 by sum insured — the top 10 are ranks 1–10.' } : null;
  },

  occupancy_profile: ({ premiumRows }) => {
    const rows = premiumRows.filter((r) => occupancyOf(r));
    if (!rows.length) return null;
    const m = new Map();
    for (const r of rows) {
      const k = occupancyOf(r);
      const cur = m.get(k) || { occupancy: k, risks: 0, sum_insured_100: 0, premium_ceded: 0 };
      cur.risks += 1;
      cur.sum_insured_100 = round2(cur.sum_insured_100 + siOf(r));
      cur.premium_ceded = round2(cur.premium_ceded + premiumOf(r));
      m.set(k, cur);
    }
    return { rows: [...m.values()].sort((a, b) => b.sum_insured_100 - a.sum_insured_100) };
  },

  special_acceptances: ({ specialAcceptances }) => ((specialAcceptances || []).length ? {
    rows: specialAcceptances.map((a) => ({
      type: a.type === 'special_acceptance' ? 'Special acceptance' : 'Endorsement',
      title: a.title,
      explanation: a.detail || null,
      effective_date: a.effective_date,
      status: a.status,
    })),
  } : null),

  treaty_detail: ({ placement, cedant }) => (placement.reference ? {
    reference: placement.reference,
    cedant: cedant?.name || null,
    domicile: cedant?.domicile || null,
    class: placement.class,
    currency: placement.currency,
    inception: placement.inception,
    expiry: placement.expiry,
    status: placement.status,
    renewal_of: placement.renewal_of,
    notes: placement.notes || null,
  } : null),

  documents: ({ documents }) => (documents.length ? {
    documents: documents.map((d) => ({
      type: d.type, version: d.version, layer_id: d.layer_id, created_at: d.created_at,
    })),
  } : null),

  expiring_structure: ({ placement }) => {
    const exp = placement.expiring_structure;
    if (!exp?.basis) return null;
    // BOTH carries a proportional section and a non-proportional one, so
    // either side having content is enough to show the section.
    const propFilled = Object.values(exp.prop || {}).some((v) => v !== '' && v != null);
    const layersFilled = (exp.layers || []).length > 0;
    const hasContent = exp.basis === 'PROP' ? propFilled
      : exp.basis === 'BOTH' ? (propFilled || layersFilled)
        : layersFilled;
    return hasContent ? { basis: exp.basis, prop: exp.prop || null, layers: exp.layers || [] } : null;
  },

  structure_to_quote: ({ placement, layers }) => {
    const structures = placement.quote_structures || [];
    if (!structures.length && !layers.length) return null;
    return {
      structures: structures.map((s, i) => ({
        index: i + 1, basis: s.basis, prop: s.basis === 'PROP' ? s.prop : null,
        layers: s.basis === 'PROP' ? [] : (s.layers || []),
        cobs: s.cobs || [],
      })),
      placed_layers: layers.map((l) => ({
        name: l.name, type: l.type, attachment: l.attachment, limit: l.limit_amt,
        order_pct: l.order_pct, premium100: l.premium100, status: l.status,
      })),
    };
  },

  premiums_table: ({ layers }) => {
    const rows = layers
      .filter((l) => l.egnpi != null || l.rate_pct != null || Number(l.premium100) > 0)
      .map((l) => ({
        layer: l.name,
        egnpi: l.egnpi == null ? null : Number(l.egnpi),
        rate_pct: l.rate_pct == null ? null : Number(l.rate_pct),
        premium100: Number(l.premium100) || 0,
        reinstatements: l.reinstatements,
        reinstatement_pct: l.reinstatement_pct == null ? null : Number(l.reinstatement_pct),
        aad: l.aad == null ? null : Number(l.aad),
      }));
    return rows.length ? { layers: rows } : null;
  },

  retentions: ({ placement }) => {
    const stored = placement.retentions;
    const rows = Array.isArray(stored) ? stored : stored?.rows || [];
    const real = rows.filter((r) => text(r.category) && r.pct !== '' && r.pct != null);
    return real.length ? { limit: stored?.limit ?? null, rows: real } : null;
  },

  premium_experience: ({ aggregates }) => (aggregates.premium.risks ? {
    risks: aggregates.premium.risks,
    distinct_policies: aggregates.premium.distinct_policies,
    sum_insured_100: aggregates.premium.sum_insured_100,
    si_ceded: aggregates.premium.si_ceded,
    gross_premium_100: aggregates.premium.gross_premium_100,
    premium_ceded: aggregates.premium.premium_ceded,
    ceded_rate_pct: aggregates.premium.ceded_rate_pct,
    period: aggregates.premium.period,
    by_class: aggregates.premium.by_class,
    by_territory: aggregates.premium.by_territory,
  } : null),

  claims_experience: ({ aggregates }) => (aggregates.claims.claims ? {
    claims: aggregates.claims.claims,
    paid: aggregates.claims.paid,
    outstanding: aggregates.claims.outstanding,
    incurred: aggregates.claims.incurred,
    open_claims: aggregates.claims.open_claims,
    closed_claims: aggregates.claims.closed_claims,
    period: aggregates.claims.period,
    by_class: aggregates.claims.by_class,
  } : null),

  historical_performance: (ctx) => {
    const { aggregates } = ctx;
    if (aggregates.combined.loss_ratio_pct != null) {
      return {
        premium_ceded: aggregates.premium.premium_ceded,
        gross_premium_100: aggregates.premium.gross_premium_100,
        paid: aggregates.claims.paid,
        outstanding: aggregates.claims.outstanding,
        incurred: aggregates.claims.incurred,
        loss_ratio_pct: aggregates.combined.loss_ratio_pct,
        incurred_per_claim: aggregates.combined.incurred_per_claim,
        premium_per_risk: aggregates.combined.premium_per_risk,
      };
    }
    return null;
  },

  large_loss_list: ({ claimsRows, aggregates }) => {
    const threshold = round2((aggregates.premium.premium_ceded || 0) * LARGE_LOSS_SHARE);
    if (!claimsRows.length) return null;
    const incurredOf = (r) => (num(r.incurred) || num(r.paid) + num(r.outstanding));
    const large = claimsRows
      .filter((r) => threshold > 0 && incurredOf(r) >= threshold)
      .sort((a, b) => incurredOf(b) - incurredOf(a))
      .map((r) => ({
        claim_ref: text(r.claim_ref), policy_ref: text(r.policy_ref), insured: text(r.insured),
        date_of_loss: text(r.date_of_loss), cause_of_loss: text(r.cause_of_loss),
        paid: round2(num(r.paid)), outstanding: round2(num(r.outstanding)), incurred: round2(incurredOf(r)),
      }));
    return large.length ? { threshold, basis: `${LARGE_LOSS_SHARE * 100}% of ceded premium`, losses: large } : null;
  },

  large_loss_selection: (ctx) => {
    const list = builders.large_loss_list(ctx);
    if (!list) return null;
    const total = round2(list.losses.reduce((a, l) => a + (Number(l.incurred) || 0), 0));
    const claimsIncurred = ctx.aggregates.claims.incurred || 0;
    return {
      threshold: list.threshold,
      selected: list.losses.length,
      selected_incurred: total,
      // What is left once the selected losses come out — the attritional base.
      attritional_incurred: claimsIncurred ? round2(claimsIncurred - total) : null,
      note: 'All losses above the threshold are selected by default; deselect on the pack before it goes out.',
    };
  },

  cat_loss_list: ({ claimsRows }) => {
    const incurredOf = (r) => (num(r.incurred) || num(r.paid) + num(r.outstanding));
    const cat = claimsRows
      .filter((r) => CAT_PERILS.test(text(r.cause_of_loss)))
      .sort((a, b) => incurredOf(b) - incurredOf(a))
      .map((r) => ({
        claim_ref: text(r.claim_ref), date_of_loss: text(r.date_of_loss),
        cause_of_loss: text(r.cause_of_loss), incurred: round2(incurredOf(r)),
      }));
    return cat.length ? { losses: cat, incurred: round2(cat.reduce((a, l) => a + l.incurred, 0)) } : null;
  },

  risk_profile: ({ premiumRows }) => {
    if (!premiumRows.length) return null;
    const bands = BANDS.map((band) => ({
      band: bandLabel(band), from: band[0], to: band[1] === Infinity ? null : band[1],
      risks: 0, sum_insured_100: 0, premium_ceded: 0,
    }));
    for (const r of premiumRows) {
      const si = num(r.sum_insured_100);
      const i = BANDS.findIndex(([lo, hi]) => si >= lo && si < hi);
      if (i === -1) continue;
      bands[i].risks += 1;
      bands[i].sum_insured_100 = round2(bands[i].sum_insured_100 + si);
      bands[i].premium_ceded = round2(bands[i].premium_ceded + num(r.premium_ceded));
    }
    return { bands: bands.filter((b) => b.risks > 0) };
  },

  claims_profile: ({ aggregates }) => (aggregates.claims.claims ? {
    by_cause: aggregates.claims.by_cause,
    by_class: aggregates.claims.by_class,
    largest_losses: aggregates.claims.largest_losses,
  } : null),

  // Neither of these comes from a bordereau — they arrive from a cat model or
  // a zoned aggregate the cedant supplies, so they stay empty until then.
  cresta_aggregates: ({ premiumRows }) => {
    const zoned = premiumRows.filter((r) => text(r.cresta) || text(r.cresta_zone) || text(r.zone));
    if (!zoned.length) return null;
    const byZone = new Map();
    for (const r of zoned) {
      const key = text(r.cresta) || text(r.cresta_zone) || text(r.zone);
      const cur = byZone.get(key) || { zone: key, risks: 0, sum_insured_100: 0 };
      cur.risks += 1;
      cur.sum_insured_100 = round2(cur.sum_insured_100 + num(r.sum_insured_100));
      byZone.set(key, cur);
    }
    return { zones: [...byZone.values()].sort((a, b) => b.sum_insured_100 - a.sum_insured_100) };
  },

  // The cat vendor's event loss table, entered on the Event Loss Tables
  // screen (placement-wide, or per class of business).
  event_loss_tables: ({ modelling }) => {
    const entries = Object.entries(modelling || {})
      .filter(([k]) => k === 'event_loss_tables' || k.startsWith('event_loss_tables:'))
      .sort(([a], [b]) => a.length - b.length);
    for (const [, d] of entries) {
      const rows = (Array.isArray(d?.rows) ? d.rows : [])
        .filter((r) => text(r.eventId) || text(r.peril) || num(r.grossLoss) || num(r.ultimateNetLoss));
      if (!rows.length) continue;
      const run = [d.vendor, d.modelVersion].filter((v) => text(v)).join(' ');
      return {
        note: [run, text(d.perilSet)].filter(Boolean).join(' · ') || null,
        rows: rows.map((r) => ({
          event_id: text(r.eventId) || null, peril: text(r.peril) || null, region: text(r.region) || null,
          return_period: r.returnPeriod === '' || r.returnPeriod == null ? null : num(r.returnPeriod),
          gross_loss: num(r.grossLoss), net_qs: num(r.netQs), net_xl: num(r.netXl), ultimate_net_loss: num(r.ultimateNetLoss),
          comment: text(r.comment) || null,
        })),
      };
    }
    return null;
  },

  pricing: ({ quotes, technical }) => (quotes.length || technical.length ? {
    technical_view: technical,
    quotes: quotes.map((q) => ({
      layer_id: q.layer_id, market: q.market_name, type: q.type, status: q.status,
      rate_on_line: q.rate_on_line == null ? null : Number(q.rate_on_line),
      premium: q.premium100 == null ? null : Number(q.premium100),
      validity: q.validity,
    })),
  } : null),

  wording: ({ wording }) => (wording ? {
    id: wording.id, title: wording.title, status: wording.status,
    reinsurer: wording.reinsurer_name || null, clauses: wording.clause_count ?? null,
  } : null),
};

/**
 * Build every section for the basis. Returns the ordered section list plus a
 * count of what is filled — the pack's own completeness measure.
 */
export function buildSections(basis, ctx) {
  const sections = sectionKeys(basis).map((key) => {
    const spec = PACK_SECTIONS[key];
    let data = null;
    try {
      data = builders[key] ? builders[key](ctx) : null;
    } catch {
      // A malformed bordereau row must not take the whole pack down; the
      // section reports as empty and the rest of the pack still builds.
      data = null;
    }
    const source = data ? 'derived' : null;
    return {
      key,
      title: spec.title,
      blurb: spec.blurb,
      required: !!spec.required,
      status: data ? 'filled' : 'empty',
      source,
      note: data ? null : spec.empty_note,
      data,
    };
  });
  const required = sections.filter((s) => s.required);
  return {
    sections,
    filled: sections.filter((s) => s.status === 'filled').length,
    total: sections.length,
    // The tracker: which required sections still stand between the pack and
    // going to market.
    required_filled: required.filter((s) => s.status === 'filled').length,
    required_total: required.length,
    missing_required: required.filter((s) => s.status === 'empty').map((s) => s.title),
  };
}

/** The pack snapshot: template, sections and the headline figures. */
export function buildPack(ctx) {
  const basis = packBasis(ctx.placement);
  const {
    sections, filled, total, required_filled, required_total, missing_required,
  } = buildSections(basis, ctx);
  const { treaty_type, cobs } = splitClass(ctx.placement.class);

  // Headline figures, from the bordereau aggregates.
  const premiumCeded = ctx.aggregates.premium.premium_ceded || null;
  const incurred = ctx.aggregates.claims.incurred || null;
  const lossRatio = premiumCeded > 0 && incurred != null
    ? round2((incurred / premiumCeded) * 100)
    : null;
  const sumInsured = ctx.aggregates.premium.sum_insured_100 || null;
  return {
    template_version: TEMPLATE_VERSION,
    basis,
    groups: templateGroups(basis),
    generated_at: ctx.generated_at,
    placement: {
      reference: ctx.placement.reference,
      class: ctx.placement.class,
      // The standard page header: every rendered page names the cedant, the
      // class of business, the treaty type and the currency of the data.
      cedant: ctx.cedant?.name || null,
      cob: cobs.join(' / ') || ctx.placement.class,
      treaty_type,
      currency: ctx.placement.currency,
      inception: ctx.placement.inception,
      expiry: ctx.placement.expiry,
    },
    summary: {
      basis,
      sections_filled: filled,
      sections_total: total,
      required_filled,
      required_total,
      missing_required,
      premium_ceded: premiumCeded,
      sum_insured_100: sumInsured,
      incurred,
      loss_ratio_pct: lossRatio,
      layers: ctx.layers.length,
      bordereaux: ctx.aggregates.sources.length,
    },
    sections,
    // Where the data came from when this placement had no bordereaux of its
    // own: the ancestor placement in the renewal chain they were inherited
    // from, so the pack says whose year it is reading.
    bordereaux_source: ctx.bordereaux_source || null,
    // The bordereaux themselves, not just the figures derived from them: a
    // version has to stand on its own if the source is later restated or the
    // placement's bordereaux are replaced.
    bordereaux: (ctx.bordereaux || []).map((b) => ({
      id: b.id,
      type: b.type,
      source_file: b.source_file,
      period_start: b.period_start,
      period_end: b.period_end,
      row_count: b.row_count ?? (b.parsed_rows || []).length,
      summary: b.summary || {},
      rows: b.parsed_rows || [],
      ingested_at: b.created_at,
      inherited_from: b.inherited_from || null,
    })),
    // Kept for the pre-template packs' readers.
    loss_summary: {
      premium: premiumCeded,
      incurred,
      loss_ratio_pct: lossRatio,
    },
    technical_view: ctx.technical,
  };
}

/** What changed between two versions, section by section. */
export function diffSections(previous, current) {
  const before = new Map((previous?.sections || []).map((s) => [s.key, s]));
  const changes = [];
  for (const s of current.sections || []) {
    const was = before.get(s.key);
    if (!was) { changes.push({ key: s.key, title: s.title, change: 'added' }); continue; }
    if (was.status !== s.status) {
      changes.push({ key: s.key, title: s.title, change: s.status === 'filled' ? 'filled' : 'emptied' });
    } else if (JSON.stringify(was.data) !== JSON.stringify(s.data)) {
      changes.push({ key: s.key, title: s.title, change: 'updated' });
    }
  }
  for (const [key, s] of before) {
    if (!(current.sections || []).some((c) => c.key === key)) {
      changes.push({ key, title: s.title, change: 'removed' });
    }
  }
  return changes;
}

export { aggregateBordereaux };
