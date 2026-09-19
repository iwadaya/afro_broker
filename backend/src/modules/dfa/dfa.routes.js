// Dynamic financial analysis — the what-if surface over the book.
//
// GET  /dfa/portfolio  assembles the analysable book: per-placement
//                      calibration read from bordereau experience, the
//                      current reinsurance structure read from the layers,
//                      the combined view for a selection, the signed panel
//                      (whose ratings seed the reinsurer-default assumption)
//                      and the defaults a standalone model starts from.
// POST /dfa/run        runs the simulation engine (domain/dfa.js) for the
//                      named structures over identical gross trials, so a
//                      changed structure shows its impact on capital,
//                      performance and the economics of the purchase without
//                      sampling noise in the comparison. Extra `variants` are
//                      summarised compactly for the efficient-frontier chart;
//                      `scenarios` (the CAS Handbook's adverse and favourable
//                      cases) re-run the same seed with the inputs moved; a
//                      `domicile` reads the capital against that country's
//                      regime.
// GET  /dfa/regimes    the capital regimes by country (Solvency II, RBC, a
//                      solvency margin, a minimum capital) for the domicile
//                      picker, and /dfa/regimes/:code one regime in full.
// POST /dfa/structuring  the treaty-structuring sweep: the structure families
//                      (excess of loss, quota share, surplus, a blend) built
//                      across a range of retentions from one grid, every
//                      candidate applied to the same trials as the current
//                      programme and re-run under the stresses, then read
//                      against the stated risk appetite — which fit, the
//                      defensible range family by family, and the pick.
//
// Everything here is decision support at 100% of the portfolio: the engine
// never writes anything back to the placement.
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';
import { aggregateExperience, DEFAULT_LARGE_LOSS_THRESHOLD } from '../../domain/experience.js';
import { parseReinstatements } from '../../domain/xol.js';
import {
  runDfa, runStructuring, DFA_DEFAULTS, reinsurerDefaultPdPct, STANDARD_SCENARIOS, SCENARIO_KEYS,
} from '../../domain/dfa.js';
import {
  buildCandidates, assessStructuring, FAMILIES, FAMILY_KEYS, GRID_DEFAULTS, DEFAULT_APPETITE, DEFAULT_STRESSES,
} from '../../domain/structuring.js';
import { listRegimes, regimeFor, domicileCode, REGIME_FAMILIES, AS_AT } from '../../domain/capitalRegimes.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';

const router = Router();
router.use(authenticate);

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// Fallbacks for a placement with no usable experience. All of them are shown
// in the UI and editable — they seed the analysis, they never decide it.
const FALLBACK = {
  loss_ratio_pct: 65,
  large_frequency: 3,
  severity_multiple: 2,   // × threshold
  cat_frequency: 0.2,
  cat_severity_multiple: 10, // × threshold
};

/**
 * At most `max` bands: a longer profile is folded into geometric buckets
 * between its smallest and largest sum insured, each bucket the
 * premium-weighted sum insured of what fell in it.
 */
function collapseBands(bands, max = 12) {
  const list = bands.filter((b) => b.sum_insured > 0 && b.premium_pct > 0).sort((a, b) => a.sum_insured - b.sum_insured);
  if (list.length <= max) return list.map((b) => ({ sum_insured: round2(b.sum_insured), premium_pct: round2(b.premium_pct) }));
  const lo = list[0].sum_insured;
  const hi = list[list.length - 1].sum_insured;
  const ratio = (hi / lo) ** (1 / max);
  const buckets = Array.from({ length: max }, () => ({ si: 0, premium: 0 }));
  for (const b of list) {
    const i = Math.min(max - 1, Math.max(0, Math.floor(Math.log(b.sum_insured / lo) / Math.log(ratio))));
    buckets[i].si += b.sum_insured * b.premium_pct;
    buckets[i].premium += b.premium_pct;
  }
  return buckets.filter((b) => b.premium > 0)
    .map((b) => ({ sum_insured: round2(b.si / b.premium), premium_pct: round2(b.premium) }));
}

/**
 * The book's risk profile from the modelling pack (the Profiles screen's
 * sum-insured bands, per class): every band read as a typical sum insured —
 * the total over the count, else the band's midpoint — and its share of the
 * premium. Null when the pack carries no usable band.
 */
export function riskProfileFrom(modelling) {
  const bands = [];
  for (const cls of Object.values(modelling || {})) {
    for (const b of cls?.bands || []) {
      const premium = Number(b?.gross_premium) || 0;
      if (!(premium > 0)) continue;
      const count = Number(b.no_of_risks) || 0;
      const totalSi = Number(b.total_sum_insured) || 0;
      const from = Number(b.from_amt) || 0;
      const to = Number(b.to_amt) || 0;
      const si = count > 0 && totalSi > 0 ? totalSi / count : (to > from ? (from + to) / 2 : from);
      if (!(si > 0)) continue;
      bands.push({ sum_insured: si, premium });
    }
  }
  if (!bands.length) return null;
  const total = bands.reduce((a, b) => a + b.premium, 0);
  return collapseBands(bands.map((b) => ({ sum_insured: b.sum_insured, premium_pct: (b.premium / total) * 100 })));
}

/**
 * Calibration inputs for one placement, read from its bordereau experience.
 * Every derived figure names its source so the UI can say where a number
 * came from rather than presenting a guess as data.
 */
function calibrationFor(placement, experience, riskProfile = null) {
  const layers = placement.layers || [];
  // The experience aggregate is built on the ingest default threshold, so the
  // attritional/large boundary matches what the large-loss table counted.
  const threshold = DEFAULT_LARGE_LOSS_THRESHOLD;

  // Subject premium (GNPI): the rating base when a layer records one, the
  // estimated GWP otherwise, then the latest bordereau premium year, and as
  // a last resort the reinsurance premium itself.
  const egnpi = Math.max(0, ...layers.map((l) => Number(l.egnpi) || 0));
  const latestYearPremium = [...(experience?.by_year || [])]
    .filter((y) => y.year != null && y.premium > 0)
    .sort((a, b) => b.year - a.year)[0]?.premium || 0;
  const layerPremium = layers.reduce((a, l) => a + (Number(l.premium100) || 0), 0);
  let subjectPremium = egnpi;
  let premiumSource = 'layer EGNPI';
  if (!(subjectPremium > 0)) { subjectPremium = Number(placement.est_gwp) || 0; premiumSource = 'estimated GWP'; }
  if (!(subjectPremium > 0)) { subjectPremium = latestYearPremium; premiumSource = 'latest bordereau year'; }
  if (!(subjectPremium > 0)) { subjectPremium = layerPremium; premiumSource = 'sum of layer premium'; }

  const years = (experience?.by_year || [])
    .filter((y) => y.year != null && (y.premium > 0 || y.incurred > 0)).length || 0;
  const yearsDivisor = Math.max(1, years);

  const largeTable = experience?.large_losses || [];
  const nonCat = largeTable.filter((l) => !l.cat);
  const catRows = largeTable.filter((l) => l.cat);
  const largeCount = Math.max(experience?.large_loss_count || 0, largeTable.length) - catRows.length;

  const hasExperience = (experience?.premium || 0) > 0 && (experience?.incurred || 0) >= 0;

  const largeSeverityMean = nonCat.length
    ? nonCat.reduce((a, l) => a + l.incurred, 0) / nonCat.length
    : threshold * FALLBACK.severity_multiple;
  const catCount = experience?.cat?.count || 0;
  // No cat history: default the event severity to the larger of a threshold
  // multiple and 15% of the subject premium, so a big book gets a cat load
  // its tower is actually built for rather than a flat small-book figure.
  const catSeverityMean = catCount > 0
    ? (experience.cat.incurred || 0) / catCount
    : Math.max(threshold * FALLBACK.cat_severity_multiple, subjectPremium * 0.15);

  // Parameter uncertainty: the literature's point is that a few years of
  // experience pin the loss ratio and the event rates loosely. Fewer years
  // observed ⇒ a wider mixing factor (capped where the defaults sit).
  const parameterUncertainty = years >= 8 ? DFA_DEFAULTS.parameter_uncertainty_pct
    : Math.min(25, DFA_DEFAULTS.parameter_uncertainty_pct + (8 - years) * 2);
  const catFrequencyCv = catCount >= 5 ? DFA_DEFAULTS.cat_frequency_cv_pct
    : Math.min(50, DFA_DEFAULTS.cat_frequency_cv_pct + (5 - catCount) * 6);

  return {
    subject_premium: round2(subjectPremium),
    premium_source: subjectPremium > 0 ? premiumSource : null,
    expected_loss_ratio_pct: hasExperience && experience.loss_ratio_pct != null
      ? experience.loss_ratio_pct : FALLBACK.loss_ratio_pct,
    loss_ratio_source: hasExperience && experience.loss_ratio_pct != null
      ? (years > 0 ? `${years}y bordereau experience` : 'bordereau experience') : 'market default',
    large_loss_threshold: threshold,
    large_frequency: years > 0
      ? round2(Math.max(0, largeCount) / yearsDivisor) : FALLBACK.large_frequency,
    large_severity_mean: round2(Math.max(threshold * 1.2, largeSeverityMean)),
    cat_frequency: years > 0
      ? round2(Math.min(3, catCount / yearsDivisor)) : FALLBACK.cat_frequency,
    cat_severity_mean: round2(Math.max(threshold * 2, catSeverityMean)),
    attritional_cv_pct: DFA_DEFAULTS.attritional_cv_pct,
    parameter_uncertainty_pct: round2(parameterUncertainty),
    cat_frequency_cv_pct: round2(catFrequencyCv),
    // Prior-year reserves: the outstanding on the claims bordereaux is the
    // reserve the year opens with; how it runs off is an assumption.
    opening_reserves: round2(experience?.outstanding || 0),
    reserves_source: (experience?.outstanding || 0) > 0 ? 'bordereau outstanding' : null,
    reserve_development_pct: DFA_DEFAULTS.reserve_development_pct,
    reserve_cv_pct: DFA_DEFAULTS.reserve_cv_pct,
    // The sums insured the book is written on, for a surplus treaty: the
    // modelling pack's profile when the placement carries one, else the
    // engine assumes one from the large-loss calibration and says so.
    risk_profile: riskProfile,
    risk_profile_source: riskProfile ? 'modelling pack risk profile' : null,
    years_observed: years,
    experience: hasExperience ? {
      premium: experience.premium,
      incurred: experience.incurred,
      loss_ratio_pct: experience.loss_ratio_pct,
      large_loss_count: experience.large_loss_count,
      cat: experience.cat,
    } : null,
  };
}

/**
 * The reinsurance structure the placement already carries, in the engine's
 * terms. XoL/Fac layers map directly; proportional layers (QS/Surplus) have
 * no explicit cession on the book, so the cession is inferred from treaty
 * premium over subject premium — shown as an assumption, editable in the UI.
 */
function structureFor(placement, subjectPremium) {
  const layers = placement.layers || [];
  const xol = layers
    .filter((l) => ['XoL', 'Fac'].includes(l.type) && Number(l.limit_amt) > 0)
    .map((l) => ({
      name: l.name,
      attachment: Number(l.attachment) || 0,
      limit: Number(l.limit_amt),
      premium100: Number(l.premium100) || 0,
      reinstatements: l.reinstatements == null || l.reinstatements === ''
        ? 0
        : (parseReinstatements(l.reinstatements) === Infinity ? 'UNLIMITED' : parseReinstatements(l.reinstatements)),
      reinstatement_pct: l.reinstatement_pct != null ? Number(l.reinstatement_pct) : 100,
      placed_pct: l.signed_share > 0 ? round2(Math.min(100, l.signed_share))
        : (l.written_share > 0 ? round2(Math.min(100, l.written_share)) : 100),
      aggregate_deductible: 0,
    }));

  const propPremium = layers
    .filter((l) => ['QS', 'Surplus'].includes(l.type))
    .reduce((a, l) => a + (Number(l.premium100) || 0), 0);
  const quotaShare = propPremium > 0 && subjectPremium > 0
    ? {
      cession_pct: round2(Math.min(90, (propPremium / subjectPremium) * 100)),
      commission_pct: 25,
      inferred: true,
    }
    : null;

  return { quota_share: quotaShare, xol_layers: xol, aggregate_cover: null };
}

/** Premium-weighted combination of the selected placements' calibrations. */
function combine(rows) {
  const picked = rows.filter((r) => r.calibration.subject_premium > 0);
  if (!picked.length) return null;
  const premium = picked.reduce((a, r) => a + r.calibration.subject_premium, 0);
  const wavg = (f) => round2(picked.reduce(
    (a, r) => a + f(r.calibration) * r.calibration.subject_premium, 0,
  ) / premium);
  const largeFrequency = round2(picked.reduce((a, r) => a + r.calibration.large_frequency, 0));
  const catFrequency = round2(picked.reduce((a, r) => a + r.calibration.cat_frequency, 0));
  const freqWavg = (freqOf, sevOf) => {
    const totalFreq = picked.reduce((a, r) => a + freqOf(r.calibration), 0);
    if (!(totalFreq > 0)) return wavg(sevOf);
    return round2(picked.reduce((a, r) => a + sevOf(r.calibration) * freqOf(r.calibration), 0) / totalFreq);
  };

  const calibration = {
    subject_premium: round2(premium),
    expected_loss_ratio_pct: wavg((c) => c.expected_loss_ratio_pct),
    large_loss_threshold: Math.min(...picked.map((r) => r.calibration.large_loss_threshold)),
    large_frequency: largeFrequency,
    large_severity_mean: freqWavg((c) => c.large_frequency, (c) => c.large_severity_mean),
    cat_frequency: catFrequency,
    cat_severity_mean: freqWavg((c) => c.cat_frequency, (c) => c.cat_severity_mean),
    attritional_cv_pct: DFA_DEFAULTS.attritional_cv_pct,
    parameter_uncertainty_pct: wavg((c) => c.parameter_uncertainty_pct),
    cat_frequency_cv_pct: freqWavg((c) => c.cat_frequency, (c) => c.cat_frequency_cv_pct),
    opening_reserves: round2(picked.reduce((a, r) => a + (r.calibration.opening_reserves || 0), 0)),
    reserve_development_pct: DFA_DEFAULTS.reserve_development_pct,
    reserve_cv_pct: DFA_DEFAULTS.reserve_cv_pct,
  };
  // The profile of the placements that carry one, each band weighted by
  // its placement's share of the premium; none, and the engine assumes one.
  const profileParts = picked.flatMap((r) => (r.calibration.risk_profile || []).map((b) => ({
    sum_insured: b.sum_insured,
    premium_pct: b.premium_pct * (r.calibration.subject_premium / premium),
  })));
  calibration.risk_profile = profileParts.length ? collapseBands(profileParts) : null;
  calibration.risk_profile_source = profileParts.length
    ? `modelling pack risk profile · ${picked.filter((r) => r.calibration.risk_profile).length} of ${picked.length} placements`
    : null;

  // Combined structure: every placement's layers, labelled by their
  // placement so a multi-programme tower stays readable. In a combined run
  // each layer responds to portfolio-wide events — an approximation the UI
  // states when more than one placement is selected.
  const structure = {
    quota_share: null,
    xol_layers: picked.flatMap((r) => r.structure.xol_layers.map((l) => ({
      ...l,
      name: picked.length > 1 ? `${r.reference} · ${l.name}` : l.name,
    }))),
    aggregate_cover: null,
  };
  const qsParts = picked.map((r) => r.structure.quota_share).filter(Boolean);
  if (qsParts.length) {
    const qsPremiums = picked
      .filter((r) => r.structure.quota_share)
      .reduce((a, r) => a + r.calibration.subject_premium * (r.structure.quota_share.cession_pct / 100), 0);
    structure.quota_share = {
      cession_pct: round2(Math.min(90, (qsPremiums / premium) * 100)),
      commission_pct: round2(qsParts.reduce((a, q) => a + q.commission_pct, 0) / qsParts.length),
      inferred: true,
    };
  }

  return { calibration, structure };
}

/**
 * The analysable book. `?placements=id,id` narrows the combined view (and
 * the signed-lines panel) to a selection; every placement is always listed.
 */
router.get(
  '/dfa/portfolio',
  asyncHandler(async (req, res) => {
    const { rows: placements } = await query(
      `SELECT p.id, p.reference, p.class, p.currency, p.inception, p.expiry,
              p.status, p.est_gwp, c.name AS cedant_name, c.domicile AS cedant_domicile,
              COALESCE(ly.layers, '[]'::json) AS layers
       FROM placement p
       JOIN cedant c ON c.id = p.cedant_id
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'id', l.id, 'name', l.name, 'type', l.type,
                  'attachment', l.attachment, 'limit_amt', l.limit_amt,
                  'premium100', l.premium100, 'egnpi', l.egnpi,
                  'reinstatements', l.reinstatements,
                  'reinstatement_pct', l.reinstatement_pct,
                  'signed_share', sh.signed_share, 'written_share', sh.written_share
                ) ORDER BY l.position) AS layers
         FROM layer l
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(li.signed_pct) FILTER (WHERE li.status = 'SIGNED'), 0) AS signed_share,
                  COALESCE(SUM(li.written_pct) FILTER (WHERE li.status IN ('WRITTEN','SIGNED')), 0) AS written_share
           FROM line li WHERE li.layer_id = l.id
         ) sh ON TRUE
         WHERE l.placement_id = p.id
       ) ly ON TRUE
       WHERE p.status NOT IN ('DECLINED','NTU','LAPSED')
       ORDER BY p.reference`,
    );

    const { rows: bdx } = await query(
      'SELECT placement_id, type, summary FROM bordereau ORDER BY created_at',
    );
    const byPlacement = new Map();
    for (const b of bdx) {
      const list = byPlacement.get(b.placement_id) || [];
      list.push({ type: b.type, summary: b.summary });
      byPlacement.set(b.placement_id, list);
    }
    const { rows: profiles } = await query(
      "SELECT placement_id, data FROM placement_modelling WHERE section = 'risk_profile'",
    );
    const profileByPlacement = new Map(profiles.map((r) => [r.placement_id, r.data]));

    const blocks = placements.map((p) => {
      const experience = aggregateExperience(byPlacement.get(p.id) || []);
      const calibration = calibrationFor(p, experience, riskProfileFrom(profileByPlacement.get(p.id)));
      return {
        id: p.id,
        reference: p.reference,
        cedant_name: p.cedant_name,
        cedant_domicile: p.cedant_domicile || null,
        domicile_code: domicileCode(p.cedant_domicile),
        class: p.class,
        currency: p.currency,
        status: p.status,
        inception: p.inception,
        expiry: p.expiry,
        calibration,
        structure: structureFor(p, calibration.subject_premium),
      };
    });

    const requested = String(req.query.placements || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const selectable = blocks.filter((b) => b.calibration.subject_premium > 0);
    const selected = requested.length
      ? blocks.filter((b) => requested.includes(b.id))
      : selectable;
    const currencies = [...new Set(selected.map((b) => b.currency))];
    // The domicile the capital is read against: the one country every
    // selected cedant sits in, else nothing — a mixed book has no regime.
    const domiciles = [...new Set(selected.map((b) => b.domicile_code).filter(Boolean))];
    const domicile = domiciles.length === 1 && selected.every((b) => b.domicile_code) ? domiciles[0] : null;

    // Who holds the signed paper on the selection — the panel the reinsurer
    // returns are cut across, pro rata to signed premium. Their ratings seed
    // the reinsurer-default assumption of the run.
    const ids = selected.map((b) => b.id);
    const { rows: panel } = ids.length ? await query(
      `SELECT m.id, m.name, m.rating, COALESCE(SUM(li.premium_signed), 0) AS signed_premium,
              COUNT(DISTINCT li.layer_id)::int AS layers
       FROM line li
       JOIN layer l ON l.id = li.layer_id
       JOIN market m ON m.id = li.market_id
       WHERE li.status = 'SIGNED' AND l.placement_id = ANY($1)
       GROUP BY m.id, m.name, m.rating
       ORDER BY signed_premium DESC, m.name`,
      [ids],
    ) : { rows: [] };
    const panelTotal = panel.reduce((a, r) => a + Number(r.signed_premium), 0);
    const panelPd = panelTotal > 0
      ? round2(panel.reduce((a, r) => a + reinsurerDefaultPdPct(r.rating) * (Number(r.signed_premium) / panelTotal), 0))
      : DFA_DEFAULTS.credit_pd_pct;

    res.json({
      placements: blocks,
      // The ids the read was asked for, so a screen can tell this book from
      // one it asked for earlier; `selected` is what that came to.
      requested,
      selected: ids,
      combined: combine(selected),
      mixed_currency: currencies.length > 1,
      currencies,
      domicile: domicile ? {
        code: domicile,
        regime: regimeFor(domicile)?.regime || null,
        source: 'the cedant\'s domicile on the register',
      } : null,
      panel: panel.map((r) => ({
        market_id: r.id,
        name: r.name,
        rating: r.rating,
        default_pd_pct: reinsurerDefaultPdPct(r.rating),
        layers: r.layers,
        signed_premium: round2(r.signed_premium),
        share_pct: panelTotal > 0 ? round2((Number(r.signed_premium) / panelTotal) * 100) : null,
      })),
      defaults: {
        trials: DFA_DEFAULTS.trials,
        seed: DFA_DEFAULTS.seed,
        expense_ratio_pct: DFA_DEFAULTS.expense_ratio_pct,
        reinsurer_expense_pct: DFA_DEFAULTS.reinsurer_expense_pct,
        capital_percentile: DFA_DEFAULTS.capital_percentile,
        cost_of_capital_pct: DFA_DEFAULTS.cost_of_capital_pct,
        available_capital: null,
        investment_yield_pct: DFA_DEFAULTS.investment_yield_pct,
        // The desk simulates the asset side too: a 4% swing on the yield a
        // year, the engine's own default being a fixed yield.
        asset_return_volatility_pct: 4,
        horizon_years: DFA_DEFAULTS.horizon_years,
        premium_growth_pct: DFA_DEFAULTS.premium_growth_pct,
        loss_trend_pct: DFA_DEFAULTS.loss_trend_pct,
        credit_pd_pct: panelPd,
        credit_pd_source: panelTotal > 0 ? 'signed panel ratings' : 'A-rated panel default',
        credit_lgd_pct: DFA_DEFAULTS.credit_lgd_pct,
        credit_stress_multiple: DFA_DEFAULTS.credit_stress_multiple,
        risk_load_sd_multiple: DFA_DEFAULTS.risk_load_sd_multiple,
        min_rate_on_line_pct: DFA_DEFAULTS.min_rate_on_line_pct,
        domicile,
        regulatory_required_capital: null,
        invested_assets: null,
        // The Handbook's scenarios, each with the one figure a broker moves.
        scenarios: STANDARD_SCENARIOS,
        // The structuring stage: the stated appetite it starts from, the
        // grid's defaults and the families it can test.
        appetite: DEFAULT_APPETITE,
        structuring: GRID_DEFAULTS,
        families: FAMILIES,
        // The seed for a standalone model typed from scratch: the same
        // fallbacks a placement without experience gets, so a blank model
        // and a thin one start from the same place. The premium is the
        // broker's to type.
        calibration: {
          expected_loss_ratio_pct: FALLBACK.loss_ratio_pct,
          large_loss_threshold: DEFAULT_LARGE_LOSS_THRESHOLD,
          large_frequency: FALLBACK.large_frequency,
          large_severity_mean: DEFAULT_LARGE_LOSS_THRESHOLD * FALLBACK.severity_multiple,
          cat_frequency: FALLBACK.cat_frequency,
          cat_severity_mean: DEFAULT_LARGE_LOSS_THRESHOLD * FALLBACK.cat_severity_multiple,
          attritional_cv_pct: DFA_DEFAULTS.attritional_cv_pct,
          parameter_uncertainty_pct: DFA_DEFAULTS.parameter_uncertainty_pct,
          cat_frequency_cv_pct: DFA_DEFAULTS.cat_frequency_cv_pct,
          opening_reserves: 0,
          reserve_development_pct: DFA_DEFAULTS.reserve_development_pct,
          reserve_cv_pct: DFA_DEFAULTS.reserve_cv_pct,
          risk_profile: null,
        },
      },
    });
  }),
);

const money = (max) => z.number().min(0).max(max);

const xolLayerSchema = z.object({
  name: z.string().max(80).optional(),
  attachment: money(1e12),
  limit: z.number().positive().max(1e12).nullish(),
  premium100: money(1e12).nullish(),
  rate_pct: z.number().min(0).max(100).nullish(),
  reinstatements: z.union([z.number().int().min(0).max(10), z.string().max(12)]).nullish(),
  reinstatement_pct: z.number().min(0).max(200).nullish(),
  placed_pct: z.number().min(0).max(100).nullish(),
  aggregate_deductible: money(1e12).nullish(),
});

const slidingScaleSchema = z.object({
  min_pct: z.number().min(0).max(50),
  max_pct: z.number().min(0).max(50),
  min_lr_pct: z.number().min(0).max(300),
  max_lr_pct: z.number().min(0).max(300),
});

const lossCorridorSchema = z.object({
  from_lr_pct: z.number().min(0).max(300),
  to_lr_pct: z.number().min(0).max(300),
  cedant_share_pct: z.number().min(0).max(100),
});

const aggregateCoverSchema = z.object({
  name: z.string().max(80).optional(),
  attachment: money(1e12).nullish(),
  limit: z.number().positive().max(1e12).nullish(),
  attachment_lr_pct: z.number().min(0).max(300).nullish(),
  exhaust_lr_pct: z.number().min(0).max(400).nullish(),
  premium100: money(1e12).nullish(),
  rate_pct: z.number().min(0).max(100).nullish(),
  placed_pct: z.number().min(0).max(100).nullish(),
});

const surplusSchema = z.object({
  retained_line: z.number().positive().max(1e12),
  lines: z.number().min(0.1).max(50),
  commission_pct: z.number().min(0).max(50).nullish(),
  event_limit: z.number().positive().max(1e12).nullish(),
});

const riskProfileSchema = z.array(z.object({
  sum_insured: z.number().positive().max(1e13),
  premium_pct: z.number().min(0).max(100),
})).max(12);

const structureSchema = z.object({
  quota_share: z.object({
    cession_pct: z.number().min(0).max(90),
    commission_pct: z.number().min(0).max(50).optional(),
    event_limit: z.number().positive().max(1e12).nullish(),
    sliding_scale: slidingScaleSchema.nullish(),
    loss_corridor: lossCorridorSchema.nullish(),
  }).nullish(),
  surplus: surplusSchema.nullish(),
  // A whole-book selection legitimately carries many layers at once.
  xol_layers: z.array(xolLayerSchema).max(40).optional(),
  aggregate_cover: aggregateCoverSchema.nullish(),
});

const SCENARIO_BOUNDS = {
  loss_ratio_delta_pts: z.number().min(-100).max(200),
  severity_multiple: z.number().min(0).max(10),
  large_frequency_multiple: z.number().min(0).max(20),
  cat_frequency_multiple: z.number().min(0).max(20),
  forced_cat_pml_multiple: z.number().min(0).max(5),
  reserve_development_pct: z.number().min(-50).max(200),
  reserve_shock_pct: z.number().min(0).max(200),
  latent_claims_pct_of_premium: z.number().min(0).max(300),
  uncollectible_pct: z.number().min(0).max(100),
  asset_shock_pct: z.number().min(0).max(100),
  premium_growth_pct: z.number().min(-30).max(50),
  loss_trend_pct: z.number().min(-20).max(50),
  investment_yield_pct: z.number().min(0).max(20),
  expense_ratio_pct: z.number().min(0).max(80),
};
const scenarioSchema = z.object(
  Object.fromEntries(SCENARIO_KEYS.map((k) => [k, SCENARIO_BOUNDS[k].nullish()])),
).strict();

const portfolioSchema = z.object({
    subject_premium: z.number().positive().max(1e13),
    expected_loss_ratio_pct: z.number().min(0).max(300),
    large_loss_threshold: z.number().positive().max(1e10).optional(),
    large_frequency: z.number().min(0).max(500).optional(),
    large_severity_mean: z.number().min(0).max(1e11).optional(),
    cat_frequency: z.number().min(0).max(50).optional(),
    cat_severity_mean: z.number().min(0).max(1e12).optional(),
    attritional_cv_pct: z.number().min(1).max(100).optional(),
    parameter_uncertainty_pct: z.number().min(0).max(100).nullish(),
    cat_frequency_cv_pct: z.number().min(0).max(200).nullish(),
    large_severity_cap: z.number().positive().max(1e12).nullish(),
    cat_pml: z.number().positive().max(1e13).nullish(),
    opening_reserves: money(1e14).nullish(),
    reserve_development_pct: z.number().min(-50).max(200).nullish(),
    reserve_cv_pct: z.number().min(0).max(100).nullish(),
    risk_profile: riskProfileSchema.nullish(),
  });

const assumptionsSchema = z.object({
    trials: z.number().int().min(500).max(20000).optional(),
    seed: z.number().int().optional(),
    expense_ratio_pct: z.number().min(0).max(80).optional(),
    reinsurer_expense_pct: z.number().min(0).max(50).optional(),
    capital_percentile: z.number().min(90).max(99.9).optional(),
    cost_of_capital_pct: z.number().min(0).max(30).optional(),
    available_capital: money(1e13).nullish(),
    investment_yield_pct: z.number().min(0).max(20).nullish(),
    asset_return_volatility_pct: z.number().min(0).max(100).nullish(),
    horizon_years: z.number().int().min(1).max(5).nullish(),
    premium_growth_pct: z.number().min(-30).max(50).nullish(),
    loss_trend_pct: z.number().min(-20).max(50).nullish(),
    credit_pd_pct: z.number().min(0).max(50).nullish(),
    credit_lgd_pct: z.number().min(0).max(100).nullish(),
    credit_stress_multiple: z.number().min(1).max(50).nullish(),
    risk_load_sd_multiple: z.number().min(0).max(5).nullish(),
    min_rate_on_line_pct: z.number().min(0).max(50).nullish(),
    // The country whose capital regime the capital is read against, and the
    // regulatory requirement itself when it is known from the last return.
    domicile: z.string().max(40).nullish(),
    regulatory_required_capital: money(1e14).nullish(),
    invested_assets: money(1e15).nullish(),
  });

const runSchema = z.object({
  portfolio: portfolioSchema,
  structures: z.record(z.string().max(40), structureSchema),
  variants: z.record(z.string().max(40), structureSchema).optional(),
  // The Handbook's scenarios: each a label and the inputs it moves.
  scenarios: z.record(z.string().max(60), scenarioSchema).optional(),
  assumptions: assumptionsSchema.optional(),
})
  .refine((b) => Object.keys(b.structures).length >= 1 && Object.keys(b.structures).length <= 4, {
    message: 'structures must name between 1 and 4 candidates',
  })
  .refine((b) => Object.keys(b.variants || {}).length <= 12, {
    message: 'variants must name at most 12 structures',
  })
  .refine((b) => Object.keys(b.scenarios || {}).length <= 12, {
    message: 'scenarios must name at most 12 cases',
  });

/** The capital regimes by country, for the domicile picker. */
router.get(
  '/dfa/regimes',
  asyncHandler(async (_req, res) => {
    res.json({ as_at: AS_AT, families: REGIME_FAMILIES, regimes: listRegimes() });
  }),
);

/** One country's regime in full: the requirement, the ratio, the ladder. */
router.get(
  '/dfa/regimes/:code',
  asyncHandler(async (req, res) => {
    const regime = regimeFor(req.params.code);
    if (!regime) throw new NotFoundError('Capital regime');
    res.json(regime);
  }),
);

router.post(
  '/dfa/run',
  asyncHandler(async (req, res) => {
    const body = validate(runSchema, req.body);
    res.json(runDfa(body));
  }),
);

// The grid the candidates are built from: which families, how many steps,
// the retention range (the attachment, and the surplus line), the top of
// the tower, and the fixed terms of the proportional covers.
const gridSchema = z.object({
  families: z.array(z.enum(FAMILY_KEYS)).min(1).max(FAMILY_KEYS.length),
  steps: z.number().int().min(2).max(8),
  retention_from: z.number().positive().max(1e12),
  retention_to: z.number().positive().max(1e12),
  tower_top: z.number().positive().max(1e13).nullish(),
  reinstatements: z.union([z.number().int().min(0).max(10), z.string().max(12)]).nullish(),
  cession_from: z.number().min(1).max(90).nullish(),
  cession_to: z.number().min(1).max(90).nullish(),
  commission_pct: z.number().min(0).max(50).nullish(),
  surplus_lines: z.number().min(1).max(20).nullish(),
  blend_cession_pct: z.number().min(1).max(90).nullish(),
})
  .refine((g) => g.retention_to >= g.retention_from, { message: 'retention_to must be at least retention_from' })
  .refine((g) => !(g.families.includes('xol') || g.families.includes('blend')) || Number(g.tower_top) > g.retention_to, {
    message: 'tower_top must sit above the highest retention for an excess-of-loss family',
  });

const appetiteSchema = z.object({
  max_ruin_pct: z.number().min(0).max(100).nullish(),
  max_loss_1in100_pct_of_capital: z.number().min(0).max(1000).nullish(),
  min_solvency_ratio_pct: z.number().min(0).max(10000).nullish(),
  max_combined_ratio_1in10_pct: z.number().min(0).max(1000).nullish(),
  require_standing_holds: z.boolean().nullish(),
  max_cost_pct_of_premium: z.number().min(0).max(100).nullish(),
}).strict();

const structuringSchema = z.object({
  portfolio: portfolioSchema,
  // The references every candidate is read beside: the current programme,
  // and the proposed one when it differs.
  structures: z.record(z.string().max(40), structureSchema),
  grid: gridSchema,
  appetite: appetiteSchema.optional(),
  stresses: z.record(z.string().max(60), scenarioSchema).optional(),
  assumptions: assumptionsSchema.optional(),
})
  .refine((b) => Object.keys(b.structures).length >= 1 && Object.keys(b.structures).length <= 2, {
    message: 'structures must name the current programme and, at most, the proposed one',
  })
  .refine((b) => Object.keys(b.stresses || {}).length <= 6, { message: 'stresses must name at most 6 cases' });

export const MAX_CANDIDATES = 40;

/**
 * The structuring sweep. Builds the candidates the grid names, runs every
 * one of them and the references on the same trials and under the same
 * stresses, and reads the lot against the appetite.
 */
router.post(
  '/dfa/structuring',
  asyncHandler(async (req, res) => {
    const body = validate(structuringSchema, req.body);
    const current = body.structures.current || Object.values(body.structures)[0] || {};
    const candidates = buildCandidates(body.grid, { current });
    if (!candidates.length) {
      throw new ValidationError('The grid names no candidate programme — check the retention range and the top of the tower');
    }
    if (candidates.length > MAX_CANDIDATES) {
      throw new ValidationError(`${candidates.length} candidates is more than the ${MAX_CANDIDATES} one run tests — fewer steps or families`);
    }
    const stresses = body.stresses && Object.keys(body.stresses).length ? body.stresses : DEFAULT_STRESSES;
    const appetite = { ...DEFAULT_APPETITE, ...(body.appetite || {}) };
    const result = runStructuring({
      portfolio: body.portfolio,
      structures: body.structures,
      candidates: Object.fromEntries(candidates.map((c) => [c.label, c.structure])),
      assumptions: body.assumptions,
      stresses,
    });
    const read = assessStructuring(result, { candidates, appetite });
    res.json({
      trials: result.trials,
      seed: result.seed,
      assumptions: result.assumptions,
      calibration: result.calibration,
      regime: result.regime,
      appetite,
      grid: { ...GRID_DEFAULTS, ...body.grid },
      families: FAMILIES,
      references: read.references,
      candidates: read.candidates,
      defensible: read.defensible,
      stresses: Object.fromEntries(Object.entries(result.stresses).map(([label, s]) => [label, {
        label,
        overrides: s.overrides,
        expected_loss_ratio_pct: s.expected_loss_ratio_pct,
        surplus_charge: s.surplus_charge,
        forced_event: s.forced_event,
      }])),
    });
  }),
);

export default router;
