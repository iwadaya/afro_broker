/**
 * Dynamic financial analysis — the simulation engine behind the DFA module.
 * Pure functions, mirrored by unit tests; the routes layer only assembles
 * inputs from the book and hands the results to the UI.
 *
 * The model keeps the component structure of the DFA literature (the CAS DFA
 * Handbook; Kaufmann, Gadmer & Klett 2001; Diers 2008) cut down to what an
 * insurer buying reinsurance needs, and values the purchase the way that
 * literature does (capital relief × cost of capital against the ceded margin:
 * Mango, Major, Adler & Bunick 2013; Goldfarb's RAROC/EVA note; Ruhm & Brehm
 * on risk transfer).
 *
 * Conventions:
 *   - All monetary figures are at 100% of the subject portfolio, in the
 *     portfolio currency. Per-market shares are cut downstream.
 *   - One trial is one treaty year. Losses come in the three components the
 *     literature models separately: an attritional cost (lognormal), large
 *     non-cat events (Poisson frequency, Pareto severity above the large-loss
 *     threshold) and cat events (Poisson / Pareto with its own tail).
 *   - Parameter risk and common shock: a gamma-distributed year factor with
 *     mean 1 scales the attritional mean and the large-loss frequency
 *     together, so a bad year is bad across the book and Poisson counts
 *     become negative binomial. Cat frequency carries its own mixing factor.
 *   - Structures are applied to the SAME gross trials, so two structures
 *     differ only by the reinsurance arithmetic — never by sampling noise.
 *   - Order of response in a year: quota share (optional per-event limit,
 *     sliding-scale commission, loss corridor) → per-event excess of loss on
 *     the retained account (annual aggregate deductible, reinstatements,
 *     placed share; xol.js does the layer arithmetic) → aggregate excess of
 *     loss / stop loss on the net retained annual loss → reinsurer default.
 *     Attritional losses sit below the large-loss threshold by construction
 *     and never hit a per-event layer; they do count towards the aggregate.
 *   - A layer or aggregate cover without a premium is priced technically:
 *     expected recovery plus a standard-deviation risk load (Kreps 1998),
 *     floored at a minimum rate on line and grossed up for reinsurer expenses.
 *   - Required capital is the 1-in-N underwriting loss at the chosen
 *     percentile (VaR) with TVaR alongside. Against the insurer's available
 *     capital the engine also reads ruin probability, expected policyholder
 *     deficit, solvency ratio and earnings at risk.
 *   - Multi-year: later years are resampled with the book grown and losses
 *     trended while the programme stays fixed in nominal terms; the surplus
 *     rolls forward with investment income to give multi-year ruin and
 *     capital-breach probabilities (Diers 2010).
 *   - Prior-year reserves (the CAS Handbook's Section II): the opening loss
 *     reserve runs off with a lognormal one-year development factor — mean
 *     1 + the expected deviation, a coefficient of variation for how wide —
 *     drawn per trial and shared by every structure. The current programme
 *     does not respond to it; it is part of the year's result and so of the
 *     capital every structure needs.
 *   - Scenarios (Sections I–VI): named adverse and favourable cases re-run
 *     the same seed with the calibration or assumptions moved — the loss
 *     ratio, severities, frequencies, a forced event the size of the cat
 *     PML, reserve deterioration, latent claims, uncollectible recoveries, a
 *     fall in asset values, growth and trend — and report each against the
 *     base case: surplus at the horizon, ruin, and the regulatory ratio.
 *   - The capital regime (Section I's "RBC and the impact of business
 *     strategies on RBC results"): given a domicile, the capital held is read
 *     against that country's ladder — Solvency II, NAIC RBC, a solvency
 *     margin — with the strain the insurer can withstand before the first
 *     action level and the chance of reaching it in the year
 *     (capitalRegimes.js holds the regimes).
 *   - Surplus treaties cede per risk: the part of a risk's sum insured above
 *     the retained line, up to a number of lines. The engine has no risk
 *     list, so the book carries a risk profile (sum-insured bands with their
 *     premium shares — seeded from the modelling pack, else assumed from the
 *     large-loss calibration and said so). Every large event is read as a
 *     loss on a risk big enough to carry it (more likely a smaller one: a
 *     uniform damage ratio), drawn once from its own stream and shared by
 *     every structure; attritional and cat losses, spread across the book,
 *     cede at the profile's premium-weighted average cession — which is also
 *     the premium the treaty takes. Order of response: quota share, surplus,
 *     excess of loss on the retained account, stop loss.
 *   - Asset returns: the yield on the surplus and the float can carry a
 *     volatility (normal, its own stream, shared by every structure), so the
 *     year's net income — underwriting result plus investment income — and
 *     the solvency position at the year end are distributions too.
 *   - Structuring (runStructuring): many candidate programmes — the
 *     structure families across a range of retentions — applied to the same
 *     trials and re-run under named stresses, summarised compactly for the
 *     frontier and the appetite tests in domain/structuring.js.
 */

import { parseReinstatements } from './xol.js';
import { regimeFor, assessCapitalPosition } from './capitalRegimes.js';

const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Number with a fallback for blanks and non-numbers. */
const numOr = (v, fallback) => (v == null || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v));

// ---- Seeded sampling ----

/** Deterministic 32-bit PRNG (mulberry32); good enough for a planning tool. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller. Uniform draws are clamped off zero. */
function sampleNormal(rng) {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Lognormal with the given arithmetic mean and standard deviation. */
function sampleLognormal(rng, mean, sd) {
  if (!(mean > 0)) return 0;
  const cv = sd / mean;
  const sigma2 = Math.log(1 + cv * cv);
  const mu = Math.log(mean) - sigma2 / 2;
  return Math.exp(mu + Math.sqrt(sigma2) * sampleNormal(rng));
}

/** Poisson count: Knuth for the small rates a book carries, normal beyond. */
function samplePoisson(rng, lambda) {
  if (!(lambda > 0)) return 0;
  if (lambda > 60) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * sampleNormal(rng)));
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

/** Gamma(shape, scale) via Marsaglia–Tsang, boosted below shape 1. */
function sampleGamma(rng, shape, scale = 1) {
  if (!(shape > 0)) return 0;
  if (shape < 1) {
    const u = Math.max(rng(), 1e-12);
    return sampleGamma(rng, shape + 1, scale) * u ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      x = sampleNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.max(rng(), 1e-12);
    if (u < 1 - 0.0331 * x ** 4) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

/**
 * Mean-1 gamma factor with coefficient of variation `cv` — the mixing
 * variable that turns a Poisson count into a negative binomial and carries
 * parameter uncertainty into a year. Exactly 1 when cv is 0.
 */
function sampleFactor(rng, cv) {
  if (!(cv > 0)) return 1;
  const shape = 1 / (cv * cv);
  return sampleGamma(rng, shape, 1 / shape);
}

/**
 * The sum insured of the risk a large loss is read as sitting on: a band big
 * enough to carry the loss, weighted by its premium and — a uniform damage
 * ratio — inversely by its size, so a loss is more likely a partial loss on
 * a modest risk than a scratch on a huge one. A loss beyond every band is a
 * total loss on a risk of its own size.
 */
function sampleSumInsured(rng, bands, amount) {
  let total = 0;
  for (const b of bands) if (b.sum_insured >= amount) total += b.premium_pct / b.sum_insured;
  if (!(total > 0)) return amount;
  let u = rng() * total;
  for (const b of bands) {
    if (b.sum_insured < amount) continue;
    u -= b.premium_pct / b.sum_insured;
    if (u <= 0) return b.sum_insured;
  }
  return bands[bands.length - 1].sum_insured;
}

/** Pareto severity above `threshold` with tail index `alpha`, capped. */
function samplePareto(rng, threshold, alpha, cap) {
  const u = Math.max(rng(), 1e-12);
  const x = threshold * u ** (-1 / alpha);
  return cap != null ? Math.min(x, cap) : x;
}

/**
 * Pareto tail index from a mean severity above a threshold:
 * E[X] = α·t/(α−1) ⇒ α = m/(m−t). Clamped to [1.05, 8] so a mean at or
 * below the threshold still yields a usable (very heavy) tail.
 */
export function paretoAlphaFromMean(mean, threshold) {
  if (!(mean > threshold)) return 1.05;
  return Math.min(8, Math.max(1.05, mean / (mean - threshold)));
}

// ---- Risk profile ----

/**
 * The sums insured a book is written on, as bands: a typical sum insured and
 * the share of the subject premium on risks of that size. It is what a
 * surplus treaty responds to. `normaliseRiskProfile` keeps the valid bands,
 * sorted, with the shares summing to 100; with nothing usable it falls back
 * to `defaultRiskProfile` — five bands from the large-loss threshold up to
 * the largest single loss, the premium halving from one band to the next —
 * and says so in `source`.
 */
export function defaultRiskProfile(threshold, largestLoss) {
  const lo = Math.max(1, Number(threshold) || 250000);
  const hi = Math.max(lo * 2, Number(largestLoss) || lo * 40);
  const n = 5;
  const ratio = (hi / lo) ** (1 / (n - 1));
  const weights = [16, 8, 4, 2, 1];
  const total = weights.reduce((a, b) => a + b, 0);
  return {
    source: 'default',
    bands: weights.map((w, i) => ({
      sum_insured: round2(lo * ratio ** i),
      premium_pct: round2((w / total) * 100),
    })),
  };
}

export function normaliseRiskProfile(bands, threshold, largestLoss) {
  const valid = (Array.isArray(bands) ? bands : [])
    .map((b) => ({ sum_insured: Number(b?.sum_insured), premium_pct: Number(b?.premium_pct) }))
    .filter((b) => b.sum_insured > 0 && b.premium_pct > 0)
    .sort((a, b) => a.sum_insured - b.sum_insured);
  if (!valid.length) return defaultRiskProfile(threshold, largestLoss);
  const total = valid.reduce((a, b) => a + b.premium_pct, 0);
  return {
    source: 'given',
    bands: valid.map((b) => ({ sum_insured: b.sum_insured, premium_pct: round2((b.premium_pct / total) * 100) })),
  };
}

/**
 * The share of a risk of sum insured `si` a surplus cedes: nothing within
 * the retained line, then the part above it up to `lines` lines of the line.
 */
export function surplusShare(si, retainedLine, lines) {
  if (!(si > retainedLine) || !(retainedLine > 0) || !(lines > 0)) return 0;
  return Math.min(lines * retainedLine, si - retainedLine) / si;
}

/** The premium-weighted average cession of a surplus over a profile whose sums insured are scaled by `scale`. */
export function surplusAverageCession(profile, retainedLine, lines, scale = 1) {
  if (!profile?.bands?.length) return 0;
  return profile.bands.reduce((a, b) => a + (b.premium_pct / 100) * surplusShare(b.sum_insured * scale, retainedLine, lines), 0);
}

// ---- Calibration ----

export const DFA_DEFAULTS = {
  attritional_cv_pct: 12,        // year-to-year process volatility of the attritional cost
  parameter_uncertainty_pct: 10, // CV of the common year factor (attritional mean + large frequency)
  cat_frequency_cv_pct: 20,      // CV of the cat-rate mixing factor (0 = pure Poisson)
  severity_cap_multiple: 40,     // single-event cap, × mean severity, when no PML is given
  expense_ratio_pct: 30,         // insurer opex + acquisition on gross premium
  reinsurer_expense_pct: 10,     // reinsurer opex on premium assumed
  capital_percentile: 99.5,      // 1-in-200
  cost_of_capital_pct: 8,
  risk_load_sd_multiple: 0.35,   // technical price: E[L] + β·σ[L] (Kreps)
  min_rate_on_line_pct: 1,       // technical price floor for remote layers
  credit_pd_pct: 0.1,            // one-year reinsurer default probability (A-rated panel)
  credit_lgd_pct: 50,            // loss given default on recoveries
  credit_stress_multiple: 5,     // PD multiplier in the worst 1% of gross years
  investment_yield_pct: 3,       // on surplus and premium float in the roll-forward
  asset_return_volatility_pct: 0, // sd of the yield a year (0 holds the yield fixed)
  horizon_years: 1,
  premium_growth_pct: 0,         // volume growth a year (exposure and premium)
  loss_trend_pct: 0,             // severity inflation a year the premium does not keep up with
  reserve_development_pct: 0,    // expected one-year deviation of the opening reserve (+ is adverse)
  reserve_cv_pct: 8,             // coefficient of variation of the reserve development factor
  trials: 5000,
  seed: 42,
};

/**
 * Turn broker-legible portfolio figures into the sampling model.
 *
 * @param {object} p
 * @param {number} p.subject_premium         GNPI at 100%
 * @param {number} p.expected_loss_ratio_pct all-in expected loss ratio
 * @param {number} p.large_loss_threshold    attritional / large boundary
 * @param {number} p.large_frequency         expected large (non-cat) events a year
 * @param {number} p.large_severity_mean     mean large-event severity (ground up)
 * @param {number} p.cat_frequency           expected cat events a year
 * @param {number} p.cat_severity_mean       mean cat-event severity (ground up)
 * @param {number} [p.attritional_cv_pct]
 * @param {number} [p.parameter_uncertainty_pct]  common year factor CV
 * @param {number} [p.cat_frequency_cv_pct]       cat-rate mixing CV
 * @param {number} [p.large_severity_cap]         largest single non-cat loss
 * @param {number} [p.cat_pml]                    largest single cat loss
 * @param {number} [p.opening_reserves]           prior-year loss reserve carried into the year
 * @param {number} [p.reserve_development_pct]    expected one-year deviation of that reserve (+ adverse)
 * @param {number} [p.reserve_cv_pct]             CV of the reserve development factor
 * @param {number} [p.forced_event]               a scenario's forced cat event, added to every year
 * @param {object[]} [p.risk_profile]             sum-insured bands [{ sum_insured, premium_pct }] a surplus responds to
 */
export function calibratePortfolio(p) {
  const premium = Number(p.subject_premium);
  if (!(premium > 0)) throw new Error('subject_premium must be positive');
  const threshold = Number(p.large_loss_threshold) > 0 ? Number(p.large_loss_threshold) : 250000;

  const largeFrequency = Math.max(0, Number(p.large_frequency) || 0);
  const largeSeverityMean = Math.max(threshold * 1.2, Number(p.large_severity_mean) || 0);
  const catFrequency = Math.max(0, Number(p.cat_frequency) || 0);
  const catSeverityMean = Math.max(threshold * 2, Number(p.cat_severity_mean) || 0);
  const catThreshold = catSeverityMean / 2;

  const expectedTotal = premium * (Number(p.expected_loss_ratio_pct) || 0) / 100;
  const expectedLarge = largeFrequency * largeSeverityMean;
  const expectedCat = catFrequency * catSeverityMean;
  // The attritional cost is whatever the expected total leaves after the
  // event burdens; a floor keeps a mis-keyed calibration from going negative.
  const expectedAttritional = Math.max(0, expectedTotal - expectedLarge - expectedCat);

  const cvPct = Number(p.attritional_cv_pct) > 0
    ? Number(p.attritional_cv_pct) : DFA_DEFAULTS.attritional_cv_pct;
  const parameterCv = Math.max(0, numOr(p.parameter_uncertainty_pct, DFA_DEFAULTS.parameter_uncertainty_pct)) / 100;
  const catFrequencyCv = Math.max(0, numOr(p.cat_frequency_cv_pct, DFA_DEFAULTS.cat_frequency_cv_pct)) / 100;
  const largeCap = Number(p.large_severity_cap) > threshold
    ? Number(p.large_severity_cap) : largeSeverityMean * DFA_DEFAULTS.severity_cap_multiple;
  const catCap = Number(p.cat_pml) > catThreshold
    ? Number(p.cat_pml) : catSeverityMean * DFA_DEFAULTS.severity_cap_multiple;

  // Prior-year reserves: how much is carried, how it is expected to run off,
  // and how wide the one-year development is. Nothing when no reserve is given.
  const openingReserves = Math.max(0, Number(p.opening_reserves) || 0);
  const reserveDevelopment = clamp(numOr(p.reserve_development_pct, DFA_DEFAULTS.reserve_development_pct), -50, 200);
  const reserveCv = clamp(numOr(p.reserve_cv_pct, DFA_DEFAULTS.reserve_cv_pct), 0, 100);
  const forcedEvent = Number(p.forced_event) > 0 ? Number(p.forced_event) : null;
  const profile = normaliseRiskProfile(p.risk_profile, threshold, largeCap);

  return {
    subject_premium: premium,
    parameter_cv: parameterCv,
    reserves: { opening: openingReserves, development_pct: reserveDevelopment, cv_pct: reserveCv },
    forced_event: forcedEvent,
    profile,
    attritional: { mean: expectedAttritional, sd: expectedAttritional * (cvPct / 100) },
    large: {
      frequency: largeFrequency,
      threshold,
      alpha: paretoAlphaFromMean(largeSeverityMean, threshold),
      cap: largeCap,
    },
    cat: {
      frequency: catFrequency,
      threshold: catThreshold,
      alpha: paretoAlphaFromMean(catSeverityMean, catThreshold),
      cap: catCap,
      frequency_cv: catFrequencyCv,
    },
    expected: {
      attritional: round2(expectedAttritional),
      large: round2(expectedLarge),
      cat: round2(expectedCat),
      total: round2(expectedAttritional + expectedLarge + expectedCat),
      loss_ratio_pct: round2(((expectedAttritional + expectedLarge + expectedCat) / premium) * 100),
      reserve_development: round2(openingReserves * (reserveDevelopment / 100)),
    },
  };
}

/**
 * The calibration for a later year of a projection: volume growth scales
 * premium, the attritional cost, large-loss frequency and cat severity
 * (more risks, bigger events); severity trend inflates every loss. Cat
 * frequency is a property of the weather, not of the book, and stays.
 */
export function scaleCalibration(c, { exposure = 1, severity = 1 } = {}) {
  if (exposure === 1 && severity === 1) return c;
  const s = exposure * severity;
  const attritional = c.attritional.mean * s;
  const large = c.large.frequency * exposure * (c.expected.large / Math.max(c.large.frequency, 1e-12)) * severity;
  const cat = c.expected.cat * s;
  const premium = c.subject_premium * exposure;
  return {
    ...c,
    subject_premium: premium,
    attritional: { mean: attritional, sd: c.attritional.sd * s },
    large: { ...c.large, frequency: c.large.frequency * exposure, threshold: c.large.threshold * severity, cap: c.large.cap * severity },
    cat: { ...c.cat, threshold: c.cat.threshold * s, cap: c.cat.cap * s },
    // The reserve grows with the book; a forced event belongs to the first year only.
    reserves: c.reserves ? { ...c.reserves, opening: c.reserves.opening * s } : c.reserves,
    forced_event: null,
    // Sums insured inflate with the losses; the spread of the book stays.
    profile: c.profile
      ? { ...c.profile, bands: c.profile.bands.map((b) => ({ ...b, sum_insured: b.sum_insured * severity })) }
      : c.profile,
    expected: {
      attritional: round2(attritional),
      large: round2(c.large.frequency > 0 ? large : 0),
      cat: round2(cat),
      total: round2(attritional + (c.large.frequency > 0 ? large : 0) + cat),
      loss_ratio_pct: round2(((attritional + (c.large.frequency > 0 ? large : 0) + cat) / premium) * 100),
      reserve_development: round2((c.reserves?.opening || 0) * s * ((c.reserves?.development_pct || 0) / 100)),
    },
  };
}

/**
 * Simulate the gross treaty years once; every structure is applied to these.
 * @returns {{attritional: number, events: {amount: number, cat: boolean}[], factor: number}[]}
 */
export function simulateGrossTrials(calibration, { trials, seed }) {
  const rng = makeRng(seed);
  // The reserve run-off has its own stream, so giving a book a reserve
  // leaves the underwriting years it samples exactly as they were. So does
  // the risk each large event is read as sitting on (for a surplus).
  const reserveRng = makeRng((seed ^ 0x9e3779b9) >>> 0);
  const riskRng = makeRng((seed ^ 0x7f4a7c15) >>> 0);
  const out = new Array(trials);
  const paramCv = calibration.parameter_cv || 0;
  const catCv = calibration.cat.frequency_cv || 0;
  const bands = calibration.profile?.bands || null;
  for (let i = 0; i < trials; i += 1) {
    // One draw of the year factor moves the attritional mean and the large
    // frequency together: parameter risk plus common shock in one variable.
    const factor = sampleFactor(rng, paramCv);
    const attritional = sampleLognormal(rng, calibration.attritional.mean * factor, calibration.attritional.sd * factor);
    const events = [];
    const nLarge = samplePoisson(rng, calibration.large.frequency * factor);
    for (let k = 0; k < nLarge; k += 1) {
      const amount = samplePareto(rng, calibration.large.threshold, calibration.large.alpha, calibration.large.cap);
      events.push({ amount, cat: false, si: bands ? sampleSumInsured(riskRng, bands, amount) : amount });
    }
    const nCat = samplePoisson(rng, calibration.cat.frequency * sampleFactor(rng, catCv));
    for (let k = 0; k < nCat; k += 1) {
      events.push({
        amount: samplePareto(rng, calibration.cat.threshold, calibration.cat.alpha, calibration.cat.cap),
        cat: true,
      });
    }
    // A scenario's forced event (the cat PML happening) sits on top of the
    // sampled year, and is a cat event like any other to the programme.
    if (calibration.forced_event > 0) events.push({ amount: calibration.forced_event, cat: true, forced: true });
    // Larger events first: reinstatement capacity is consumed in loss order,
    // and a year's severity ordering is not something the sampler should decide.
    events.sort((a, b) => b.amount - a.amount);
    // Prior-year reserves run off with a lognormal development factor of
    // mean 1 + d and the given coefficient of variation: the change in the
    // ultimate, positive when adverse.
    let reserveDev = 0;
    const r = calibration.reserves;
    if (r && r.opening > 0) {
      const mean = 1 + r.development_pct / 100;
      reserveDev = r.cv_pct > 0
        ? r.opening * (sampleLognormal(reserveRng, mean, mean * (r.cv_pct / 100)) - 1)
        : r.opening * (mean - 1);
    }
    out[i] = { attritional, events, factor, reserve_dev: reserveDev };
  }
  return out;
}

// ---- Structure normalisation ----

function normaliseSliding(spec, provisional) {
  const minPct = clamp(numOr(spec?.min_pct, provisional), 0, 50);
  const maxPct = clamp(numOr(spec?.max_pct, provisional), 0, 50);
  const minLr = Math.max(0, numOr(spec?.min_lr_pct, 0));
  const maxLr = Math.max(0, numOr(spec?.max_lr_pct, 0));
  if (!(maxPct > minPct) || !(maxLr > minLr)) return null;
  return { min_pct: minPct, max_pct: maxPct, min_lr_pct: minLr, max_lr_pct: maxLr };
}

function normaliseCorridor(spec) {
  const from = Math.max(0, numOr(spec?.from_lr_pct, 0));
  const to = Math.max(0, numOr(spec?.to_lr_pct, 0));
  const share = clamp(numOr(spec?.cedant_share_pct, 0), 0, 100);
  if (!(to > from) || !(share > 0)) return null;
  return { from_lr_pct: from, to_lr_pct: to, cedant_share_pct: share };
}

/** Premium at 100% from a quoted amount or a rate on subject premium; null = price it. */
function premiumFromSpec(spec, subjectPremium) {
  if (Number(spec.premium100) > 0) return { premium100: Number(spec.premium100), priced: 'quoted' };
  if (Number(spec.rate_pct) > 0) return { premium100: subjectPremium * (Number(spec.rate_pct) / 100), priced: 'rate' };
  return { premium100: null, priced: 'technical' };
}

const placedPct = (v) => (v == null || v === '' ? 100 : clamp(Number(v) || 0, 0, 100));

/**
 * Normalise a structure spec: clamps, defaults, derived premiums.
 *
 * quota_share: { cession_pct, commission_pct, event_limit?, sliding_scale?,
 *                loss_corridor? }
 * surplus:     { retained_line, lines, commission_pct, event_limit? } — the
 *              cedant keeps one line of every risk and cedes up to `lines`
 *              lines above it; responds after the quota share
 * xol_layers:  [{ attachment, limit, premium100? | rate_pct?, reinstatements,
 *                 reinstatement_pct, placed_pct, aggregate_deductible? }]
 * aggregate_cover: { attachment | attachment_lr_pct, limit | exhaust_lr_pct,
 *                    premium100? | rate_pct?, placed_pct } — loss-ratio terms
 *                    are on the premium retained after the quota share.
 */
export function normaliseStructure(structure, subjectPremium) {
  const qsIn = structure?.quota_share;
  const cession = qsIn ? clamp(Number(qsIn.cession_pct) || 0, 0, 90) : 0;
  const commission = qsIn ? clamp(Number(qsIn.commission_pct) || 0, 0, 50) : 0;
  const qs = {
    event_limit: qsIn && Number(qsIn.event_limit) > 0 ? Number(qsIn.event_limit) : null,
    sliding_scale: qsIn?.sliding_scale ? normaliseSliding(qsIn.sliding_scale, commission) : null,
    loss_corridor: qsIn?.loss_corridor ? normaliseCorridor(qsIn.loss_corridor) : null,
  };

  const spIn = structure?.surplus;
  const surplus = spIn && Number(spIn.retained_line) > 0 && Number(spIn.lines) > 0
    ? {
      retained_line: Number(spIn.retained_line),
      lines: clamp(Number(spIn.lines), 0.1, 50),
      commission_pct: clamp(numOr(spIn.commission_pct, 0), 0, 50),
      event_limit: Number(spIn.event_limit) > 0 ? Number(spIn.event_limit) : null,
    }
    : null;

  const layers = (structure?.xol_layers || [])
    .map((l, i) => ({
      name: l.name || `Layer ${i + 1}`,
      attachment: Math.max(0, Number(l.attachment) || 0),
      limit: Number(l.limit) > 0 ? Number(l.limit) : null,
      ...premiumFromSpec(l, subjectPremium),
      reinstatements: typeof l.reinstatements === 'number'
        ? l.reinstatements : parseReinstatements(l.reinstatements),
      reinstatement_pct: Number(l.reinstatement_pct) >= 0 ? Number(l.reinstatement_pct) : 100,
      // Absent means fully placed; an explicit 0 means exactly that.
      placed_pct: placedPct(l.placed_pct),
      aggregate_deductible: Math.max(0, Number(l.aggregate_deductible) || 0),
    }))
    .filter((l) => l.limit != null && l.limit > 0)
    .sort((a, b) => a.attachment - b.attachment);

  const aggIn = structure?.aggregate_cover;
  let aggregate = null;
  if (aggIn) {
    const retainedPremium = subjectPremium * (1 - cession / 100);
    const attachLr = Math.max(0, Number(aggIn.attachment_lr_pct) || 0);
    const exhaustLr = Number(aggIn.exhaust_lr_pct);
    const attachment = Number(aggIn.attachment) > 0
      ? Number(aggIn.attachment) : retainedPremium * (attachLr / 100);
    const limit = Number(aggIn.limit) > 0
      ? Number(aggIn.limit)
      : (exhaustLr > attachLr ? retainedPremium * ((exhaustLr - attachLr) / 100) : null);
    if (limit != null && limit > 0) {
      aggregate = {
        name: aggIn.name || 'Aggregate XoL',
        attachment,
        limit,
        ...premiumFromSpec(aggIn, subjectPremium),
        placed_pct: placedPct(aggIn.placed_pct),
        attachment_lr_pct: retainedPremium > 0 ? round2((attachment / retainedPremium) * 100) : null,
        exhaust_lr_pct: retainedPremium > 0 ? round2(((attachment + limit) / retainedPremium) * 100) : null,
      };
    }
  }

  return { cession_pct: cession, commission_pct: commission, qs, surplus, xol_layers: layers, aggregate };
}

/** The engine-shaped spec of a normalised structure, optionally minus a cover. */
function specFrom(s, { dropLayer = -1, dropAggregate = false } = {}) {
  const premiumOf = (c) => (c.priced === 'technical' ? null : c.premium100);
  return {
    quota_share: s.cession_pct > 0 ? {
      cession_pct: s.cession_pct,
      commission_pct: s.commission_pct,
      event_limit: s.qs.event_limit,
      sliding_scale: s.qs.sliding_scale,
      loss_corridor: s.qs.loss_corridor,
    } : null,
    surplus: s.surplus ? { ...s.surplus } : null,
    xol_layers: s.xol_layers
      .filter((_, j) => j !== dropLayer)
      .map((l) => ({
        name: l.name,
        attachment: l.attachment,
        limit: l.limit,
        premium100: premiumOf(l),
        reinstatements: l.reinstatements,
        reinstatement_pct: l.reinstatement_pct,
        placed_pct: l.placed_pct,
        aggregate_deductible: l.aggregate_deductible,
      })),
    aggregate_cover: s.aggregate && !dropAggregate ? {
      name: s.aggregate.name,
      attachment: s.aggregate.attachment,
      limit: s.aggregate.limit,
      premium100: premiumOf(s.aggregate),
      placed_pct: s.aggregate.placed_pct,
    } : null,
  };
}

/** Commission earned at a treaty loss ratio: flat, or sliding 1:1 across the band. */
function commissionAt(lossRatioPct, s) {
  const sl = s.qs.sliding_scale;
  if (!sl) return s.commission_pct;
  if (lossRatioPct <= sl.min_lr_pct) return sl.max_pct;
  if (lossRatioPct >= sl.max_lr_pct) return sl.min_pct;
  const slope = (sl.max_pct - sl.min_pct) / (sl.max_lr_pct - sl.min_lr_pct);
  return sl.max_pct - (lossRatioPct - sl.min_lr_pct) * slope;
}

// ---- Technical pricing ----

/**
 * Technical premium at 100% for a cover with the given simulated recovery
 * distribution: expected loss plus β standard deviations (the
 * standard-deviation principle), floored at a minimum rate on line, then
 * grossed up for the reinsurer's expenses.
 */
export function technicalPremium({ mean, sd, limit }, pricing = {}) {
  const beta = Math.max(0, numOr(pricing.risk_load_sd_multiple, DFA_DEFAULTS.risk_load_sd_multiple));
  const minRol = Math.max(0, numOr(pricing.min_rate_on_line_pct, DFA_DEFAULTS.min_rate_on_line_pct)) / 100;
  const expense = clamp(numOr(pricing.reinsurer_expense_pct, DFA_DEFAULTS.reinsurer_expense_pct), 0, 90) / 100;
  const riskPremium = Math.max(mean + beta * sd, (limit || 0) * minRol);
  return riskPremium / (1 - expense);
}

function meanOf(values) {
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i];
  return values.length ? sum / values.length : 0;
}

function meanSd(values) {
  const mean = meanOf(values);
  let sq = 0;
  for (let i = 0; i < values.length; i += 1) sq += (values[i] - mean) ** 2;
  return { mean, sd: values.length ? Math.sqrt(sq / values.length) : 0 };
}

// ---- Structure application ----

/**
 * Run one structure over the gross trials and account both sides of the slip.
 *
 * @param {object} ctx
 * @param {number} ctx.subjectPremium
 * @param {number} [ctx.expenseRatioPct]
 * @param {number} [ctx.reinsurerExpensePct]
 * @param {object} [ctx.pricing]        technical-price assumptions
 * @param {object} [ctx.credit]         { pd, lgd, stress, threshold, u } — reinsurer
 *                                      default: probability pd (× stress when the
 *                                      gross year is beyond threshold), losing lgd
 *                                      of the year's recoveries; u are the per-trial
 *                                      uniforms shared by every structure
 * @param {number} [ctx.premiumScale]   scales quoted premiums in a grown year
 * @param {number} [ctx.surplusCharge]  a one-off charge to the year's result that no
 *                                      programme responds to (a scenario's reserve
 *                                      shock, latent claims or asset write-down)
 * @param {object} [ctx.profile]        the book's risk profile (sum-insured bands) a
 *                                      surplus treaty reads its average cession from;
 *                                      without one every loss is read as a total loss
 * @returns per-trial arrays plus the fixed premium flows and the priced structure
 */
export function applyStructure(trialsData, structure, ctx) {
  const { subjectPremium } = ctx;
  const expenseRatioPct = numOr(ctx.expenseRatioPct, DFA_DEFAULTS.expense_ratio_pct);
  const reinsurerExpensePct = numOr(ctx.reinsurerExpensePct, DFA_DEFAULTS.reinsurer_expense_pct);
  const pricing = { reinsurer_expense_pct: reinsurerExpensePct, ...(ctx.pricing || {}) };
  const credit = ctx.credit && ctx.credit.pd > 0 && ctx.credit.u ? ctx.credit : null;
  const premiumScale = numOr(ctx.premiumScale, 1);
  const surplusCharge = Math.max(0, numOr(ctx.surplusCharge, 0));

  const s = normaliseStructure(structure, subjectPremium);
  const cession = s.cession_pct / 100;
  const qsPremium = subjectPremium * cession;
  const insurerExpense = subjectPremium * (expenseRatioPct / 100);
  const n = trialsData.length;
  const L = s.xol_layers.length;
  const agg = s.aggregate;
  // The surplus sits on what the quota share leaves: its line and lines read
  // against each risk's sum insured net of the cession. Its average cession —
  // what attritional and cat losses cede, and the premium it takes — comes
  // from the profile; without one, nothing but the large events cede.
  const sp = s.surplus;
  const spAverage = sp ? surplusAverageCession(ctx.profile, sp.retained_line, sp.lines, 1 - cession) : 0;
  const spPremium = sp ? subjectPremium * (1 - cession) * spAverage : 0;
  const spCommission = sp ? spPremium * (sp.commission_pct / 100) : 0;

  const grossLoss = new Float64Array(n);
  const qsCeded = new Float64Array(n);
  const qsCommission = new Float64Array(n);
  const spCeded = new Float64Array(n);
  const xolPlaced = new Float64Array(n);
  const aggRecovery = new Float64Array(n);
  const aggPlaced = new Float64Array(n);
  const layerRecovery = s.xol_layers.map(() => new Float64Array(n));
  const layerReinstated = s.xol_layers.map(() => new Float64Array(n));
  const aad = new Float64Array(L);
  const consumed = new Float64Array(L);
  // Per-layer constants of the annual arithmetic (see computeXolLoss in
  // xol.js, whose cent-rounded semantics the loop below reproduces inline:
  // the hot path of the engine runs once per event per layer per trial).
  const attachment = Float64Array.from(s.xol_layers, (l) => l.attachment);
  const limit = Float64Array.from(s.xol_layers, (l) => l.limit);
  const placed = Float64Array.from(s.xol_layers, (l) => l.placed_pct / 100);
  const capacity = s.xol_layers.map((l) => (l.reinstatements === Infinity ? Infinity : l.limit * (1 + l.reinstatements)));
  const ripCapacity = s.xol_layers.map((l) => (l.reinstatements === Infinity ? Infinity : l.limit * l.reinstatements));
  const eventLimit = s.qs.event_limit;

  // Pass 1: losses and recoveries. Premiums come after, because a cover
  // without a quoted premium is priced off the recoveries it produces.
  for (let i = 0; i < n; i += 1) {
    const t = trialsData[i];
    let gross = t.attritional;
    let qsc = t.attritional * cession;
    let spc = sp ? t.attritional * (1 - cession) * spAverage : 0;
    let xolRec = 0;
    for (let j = 0; j < L; j += 1) {
      aad[j] = s.xol_layers[j].aggregate_deductible;
      consumed[j] = 0;
    }
    for (const e of t.events) {
      gross += e.amount;
      const qsEvent = eventLimit != null ? Math.min(e.amount * cession, eventLimit) : e.amount * cession;
      qsc += qsEvent;
      let retainedEvent = e.amount - qsEvent;
      if (sp) {
        // A large event is a loss on one risk: the surplus takes its share of
        // that risk. A cat event is spread across the book: the average share.
        let spEvent = e.cat
          ? retainedEvent * spAverage
          : retainedEvent * surplusShare((e.si > 0 ? e.si : e.amount) * (1 - cession), sp.retained_line, sp.lines);
        if (sp.event_limit != null) spEvent = Math.min(spEvent, sp.event_limit);
        spc += spEvent;
        retainedEvent -= spEvent;
      }
      for (let j = 0; j < L; j += 1) {
        // Layers are sorted by attachment: once an event falls short of one,
        // it falls short of every layer above it.
        if (retainedEvent <= attachment[j]) break;
        let toLayer = Math.min(retainedEvent - attachment[j], limit[j]);
        // The annual aggregate deductible absorbs otherwise-recoverable loss
        // before the reinsurer pays anything.
        if (aad[j] > 0) {
          const absorbed = Math.min(toLayer, aad[j]);
          aad[j] -= absorbed;
          toLayer -= absorbed;
          if (toLayer <= 0) continue;
        }
        const lossToLayer = round2(toLayer);
        const recovery = round2(Math.min(lossToLayer, Math.max(0, capacity[j] - consumed[j])));
        // Reinstatement capacity is consumed in loss order; the final limit
        // is not reinstated. Unlimited reinstatements always restore in full.
        const reinstatedBefore = Math.min(consumed[j], ripCapacity[j]);
        const reinstated = round2(Math.min(recovery, ripCapacity[j] - reinstatedBefore));
        consumed[j] += recovery;
        layerRecovery[j][i] += recovery;
        layerReinstated[j][i] += reinstated;
        xolRec += recovery * placed[j];
      }
    }

    // Loss-sensitive quota-share terms: the commission slides with the
    // treaty loss ratio; a corridor hands a share of the losses in a
    // loss-ratio band back to the cedant.
    let commissionAmt = qsPremium * (s.commission_pct / 100);
    if (qsPremium > 0) {
      const lr = (qsc / qsPremium) * 100;
      commissionAmt = qsPremium * (commissionAt(lr, s) / 100);
      const c = s.qs.loss_corridor;
      if (c) {
        qsc -= qsPremium * ((clamp(lr, c.from_lr_pct, c.to_lr_pct) - c.from_lr_pct) / 100) * (c.cedant_share_pct / 100);
      }
    }

    grossLoss[i] = gross;
    qsCeded[i] = qsc;
    qsCommission[i] = commissionAmt;
    spCeded[i] = spc;
    xolPlaced[i] = xolRec;
    if (agg) {
      const netBefore = gross - qsc - spc - xolRec;
      const rec = Math.min(Math.max(netBefore - agg.attachment, 0), agg.limit);
      aggRecovery[i] = rec;
      aggPlaced[i] = rec * (agg.placed_pct / 100);
    }
  }

  // Premiums: quoted (scaled for a grown year) or technical.
  const layerDetail = s.xol_layers.map((l, j) => {
    const { mean, sd } = meanSd(layerRecovery[j]);
    const technical = technicalPremium({ mean, sd, limit: l.limit }, pricing);
    return {
      ...l,
      premium100: l.premium100 != null ? l.premium100 * premiumScale : technical,
      technical_premium100: technical,
      expected_recovery100: mean,
      recovery_sd100: sd,
    };
  });
  const xolPremium = layerDetail.reduce((a, l) => a + l.premium100 * (l.placed_pct / 100), 0);
  let aggDetail = null;
  if (agg) {
    const { mean, sd } = meanSd(aggRecovery);
    const technical = technicalPremium({ mean, sd, limit: agg.limit }, pricing);
    aggDetail = {
      ...agg,
      premium100: agg.premium100 != null ? agg.premium100 * premiumScale : technical,
      technical_premium100: technical,
      expected_recovery100: mean,
      recovery_sd100: sd,
    };
  }
  const aggPremium = aggDetail ? aggDetail.premium100 * (aggDetail.placed_pct / 100) : 0;

  // Pass 2: reinstatement premium, reinsurer default, both sides' results.
  const cededLoss = new Float64Array(n);
  const netLoss = new Float64Array(n);
  const ripPaid = new Float64Array(n);
  const netPremium = new Float64Array(n);
  const insurerResult = new Float64Array(n);
  const reinsurerResult = new Float64Array(n);
  const reinsurerMargin = new Float64Array(n);
  const creditLoss = new Float64Array(n);
  const reserveDevelopment = new Float64Array(n);
  const layerRip = layerDetail.map(() => new Float64Array(n));

  for (let i = 0; i < n; i += 1) {
    let rip = 0;
    for (let j = 0; j < L; j += 1) {
      const l = layerDetail[j];
      const r = round2((layerReinstated[j][i] / l.limit) * l.premium100 * (l.reinstatement_pct / 100) * (l.placed_pct / 100));
      layerRip[j][i] = r;
      rip += r;
    }
    const ceded = qsCeded[i] + spCeded[i] + xolPlaced[i] + aggPlaced[i];
    let cl = 0;
    if (credit && ceded > 0) {
      const pd = credit.pd * (grossLoss[i] >= credit.threshold ? credit.stress : 1);
      if (credit.u[i] < pd) cl = ceded * credit.lgd;
    }
    const netPrem = subjectPremium - qsPremium + qsCommission[i] - spPremium + spCommission - xolPremium - aggPremium - rip;
    const riPremium = qsPremium + spPremium + xolPremium + aggPremium + rip;

    cededLoss[i] = ceded;
    creditLoss[i] = cl;
    netLoss[i] = grossLoss[i] - ceded + cl;
    ripPaid[i] = rip;
    netPremium[i] = netPrem;
    // The year's result also carries the prior-year reserve run-off and any
    // one-off charge a scenario puts on the surplus — neither responds to
    // the programme, so both are the same for every structure.
    const reserveDev = numOr(trialsData[i].reserve_dev, 0);
    reserveDevelopment[i] = reserveDev;
    insurerResult[i] = netPrem - netLoss[i] - insurerExpense - reserveDev - surplusCharge;
    reinsurerMargin[i] = riPremium - ceded - qsCommission[i] - spCommission;
    reinsurerResult[i] = reinsurerMargin[i] - riPremium * (reinsurerExpensePct / 100);
  }

  return {
    grossLoss,
    cededLoss,
    netLoss,
    ripPaid,
    netPremium,
    insurerResult,
    reinsurerResult,
    reinsurerMargin,
    creditLoss,
    reserveDevelopment,
    layerRecovery,
    layerRip,
    aggRecovery,
    aggPlaced,
    spCeded,
    flows: {
      subject_premium: round2(subjectPremium),
      qs_premium: round2(qsPremium),
      qs_commission: round2(meanOf(qsCommission)),
      surplus_premium: round2(spPremium),
      surplus_commission: round2(spCommission),
      surplus_average_cession_pct: round2(spAverage * 100),
      xol_premium: round2(xolPremium),
      aggregate_premium: round2(aggPremium),
      insurer_expense: round2(insurerExpense),
      reserve_development: round2(meanOf(reserveDevelopment)),
      surplus_charge: round2(surplusCharge),
    },
    structure: { ...s, xol_layers: layerDetail, aggregate: aggDetail },
  };
}

// ---- Summaries ----

// Both tails: the lower percentiles read a result or an income, the upper a loss.
const PCTS = [0.5, 1, 10, 25, 50, 75, 90, 95, 99, 99.5];

function sorted(values) {
  return Float64Array.from(values).sort();
}

/** Type-1 percentile off a pre-sorted ascending array. */
function pctOf(sortedArr, p) {
  const n = sortedArr.length;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return sortedArr[idx];
}

export function stats(values) {
  const n = values.length;
  const { mean, sd } = meanSd(values);
  const s = sorted(values);
  const out = {
    mean: round2(mean),
    sd: round2(sd),
    min: round2(s[0]),
    max: round2(s[n - 1]),
  };
  for (const p of PCTS) out[`p${String(p).replace('.', '_')}`] = round2(pctOf(s, p));
  return out;
}

/**
 * Risk capital off an underwriting-result distribution: the 1-in-N loss at
 * `percentile` (VaR) with the tail mean beyond it (TVaR). Positive numbers
 * are capital consumed; a book profitable even at the percentile needs none.
 */
export function capitalFromResults(results, percentile) {
  const losses = Float64Array.from(results, (v) => -v).sort();
  const varLoss = pctOf(losses, percentile);
  let tail = 0;
  let count = 0;
  for (let i = losses.length - 1; i >= 0 && losses[i] >= varLoss; i -= 1) {
    tail += losses[i];
    count += 1;
  }
  return {
    percentile,
    var: round2(Math.max(0, varLoss)),
    tvar: round2(Math.max(0, count ? tail / count : 0)),
  };
}

const perTrialRatio = (num, den) => Float64Array.from(num, (v, i) => (den[i] > 0 ? (v / den[i]) * 100 : 0));

/** Share of trials below zero, as a percentage. */
function probNegativePct(values) {
  let n = 0;
  for (let i = 0; i < values.length; i += 1) if (values[i] < 0) n += 1;
  return round2((n / values.length) * 100);
}

function countIf(values, pred) {
  let n = 0;
  for (let i = 0; i < values.length; i += 1) if (pred(values[i], i)) n += 1;
  return n;
}

/** Exceedance-curve points (return-period view) for the loss charts. */
function epCurve(grossLoss, cededLoss, netLoss) {
  const g = sorted(grossLoss);
  const c = sorted(cededLoss);
  const nn = sorted(netLoss);
  const grid = [];
  for (let p = 50; p < 99; p += 2) grid.push(p);
  grid.push(99, 99.5, 99.8);
  return grid.map((p) => ({
    p,
    return_period: round2(1 / (1 - p / 100)),
    gross: round2(pctOf(g, p)),
    ceded: round2(pctOf(c, p)),
    net: round2(pctOf(nn, p)),
  }));
}

/** ROE guarded against a near-zero capital base blowing the ratio up. */
function roePct(expectedResult, capital, premium) {
  if (!(capital > premium * 0.005)) return null;
  return round2((expectedResult / capital) * 100);
}

/** A ratio of cost to capital relief, null when the relief is immaterial. */
function impliedRatePct(cost, relief, premium) {
  if (!(relief > premium * 0.005)) return null;
  return round2((cost / relief) * 100);
}

/**
 * The year's investment return per trial: the yield, plus its volatility
 * times a standard normal drawn once per year and shared by every structure
 * (ctx.assetReturns.z[k]). Without a volatility the yield is fixed.
 */
function assetRateOf(ctx, k = 0) {
  const yieldR = numOr(ctx.investmentYieldPct, DFA_DEFAULTS.investment_yield_pct) / 100;
  const vol = ctx.assetReturns?.volatility || 0;
  const z = ctx.assetReturns?.z?.[k];
  if (!(vol > 0) || !z) return () => yieldR;
  return (i) => yieldR + vol * z[i];
}

/**
 * Multi-year surplus roll-forward: each year's underwriting result plus
 * investment income on the opening surplus and half the year's net premium
 * (the float) accrues to the surplus. Ruin is a negative surplus at any year
 * end; a breach is a surplus below the required capital of the first year.
 */
function horizonBlock(yearRuns, ctx, required) {
  const H = yearRuns.length;
  const n = yearRuns[0].insurerResult.length;
  const available = ctx.availableCapital;
  const surplus = new Float64Array(n).fill(available);
  const minSurplus = new Float64Array(n).fill(available);
  const cumulative = new Float64Array(n);
  const byYear = [];
  for (let k = 0; k < H; k += 1) {
    const r = yearRuns[k];
    const rate = assetRateOf(ctx, k);
    let investment = 0;
    for (let i = 0; i < n; i += 1) {
      const income = rate(i) * (Math.max(0, surplus[i]) + 0.5 * Math.max(0, r.netPremium[i]));
      investment += income;
      surplus[i] += r.insurerResult[i] + income;
      cumulative[i] += r.insurerResult[i];
      if (surplus[i] < minSurplus[i]) minSurplus[i] = surplus[i];
    }
    const s = sorted(surplus);
    byYear.push({
      year: k + 1,
      subject_premium: round2(r.flows.subject_premium),
      uw_result_mean: round2(meanOf(r.insurerResult)),
      investment_income_mean: round2(investment / n),
      surplus_mean: round2(meanOf(surplus)),
      surplus_p10: round2(pctOf(s, 10)),
      surplus_p1: round2(pctOf(s, 1)),
      surplus_p0_5: round2(pctOf(s, 0.5)),
      prob_negative_pct: round2((countIf(surplus, (v) => v < 0) / n) * 100),
      prob_below_required_pct: round2((countIf(surplus, (v) => v < required) / n) * 100),
    });
  }
  return {
    years: H,
    available_capital: round2(available),
    required_capital: required,
    by_year: byYear,
    prob_ruin_pct: round2((countIf(minSurplus, (v) => v < 0) / n) * 100),
    prob_capital_breach_pct: round2((countIf(minSurplus, (v) => v < required) / n) * 100),
    cumulative_result: stats(cumulative),
    surplus_end: stats(surplus),
    min_surplus: stats(minSurplus),
    // The lower tail of the worst year-end surplus over the horizon.
    min_surplus_p10: round2(pctOf(sorted(minSurplus), 10)),
    min_surplus_p1: round2(pctOf(sorted(minSurplus), 1)),
  };
}

/** Per-cover attribution: what each layer costs, recovers and buys. */
function layerAttribution(run, ctx, required, extras) {
  const premium = ctx.subjectPremium;
  const rows = run.structure.xol_layers.map((l, j) => {
    const placed = l.placed_pct / 100;
    const layerPremium = l.premium100 * placed;
    const recovery = l.expected_recovery100 * placed;
    const rip = meanOf(run.layerRip[j]);
    const cost = layerPremium + rip - recovery;
    const capacity = l.reinstatements === Infinity ? Infinity : l.limit * (1 + l.reinstatements);
    const n = run.layerRecovery[j].length;
    const without = extras.marginals?.[j];
    const marginal = without != null ? round2(without - required) : null;
    return {
      name: l.name,
      kind: 'xol',
      attachment: l.attachment,
      limit: l.limit,
      placed_pct: l.placed_pct,
      aggregate_deductible: l.aggregate_deductible,
      priced: l.priced,
      premium: round2(layerPremium),
      premium100: round2(l.premium100),
      technical_premium100: round2(l.technical_premium100),
      expected_recovery: round2(recovery),
      expected_rip: round2(rip),
      expected_cost: round2(cost),
      lol_pct: round2((l.expected_recovery100 / l.limit) * 100),
      rol_pct: round2((l.premium100 / l.limit) * 100),
      payback_years: l.premium100 > 0 ? round2(l.limit / l.premium100) : null,
      prob_attach_pct: round2((countIf(run.layerRecovery[j], (v) => v > 0) / n) * 100),
      prob_exhaust_pct: round2((countIf(run.layerRecovery[j], (v) => v >= capacity - 0.005) / n) * 100),
      marginal_capital_relief: marginal,
      implied_coc_pct: marginal != null ? impliedRatePct(cost, marginal, premium) : null,
    };
  });
  const a = run.structure.aggregate;
  if (a) {
    const placed = a.placed_pct / 100;
    const aggPremium = a.premium100 * placed;
    const recovery = a.expected_recovery100 * placed;
    const cost = aggPremium - recovery;
    const n = run.aggRecovery.length;
    const without = extras.aggregateMarginal;
    const marginal = without != null ? round2(without - required) : null;
    rows.push({
      name: a.name,
      kind: 'aggregate',
      attachment: round2(a.attachment),
      limit: round2(a.limit),
      attachment_lr_pct: a.attachment_lr_pct,
      exhaust_lr_pct: a.exhaust_lr_pct,
      placed_pct: a.placed_pct,
      priced: a.priced,
      premium: round2(aggPremium),
      premium100: round2(a.premium100),
      technical_premium100: round2(a.technical_premium100),
      expected_recovery: round2(recovery),
      expected_rip: 0,
      expected_cost: round2(cost),
      lol_pct: round2((a.expected_recovery100 / a.limit) * 100),
      rol_pct: round2((a.premium100 / a.limit) * 100),
      payback_years: a.premium100 > 0 ? round2(a.limit / a.premium100) : null,
      prob_attach_pct: round2((countIf(run.aggRecovery, (v) => v > 0) / n) * 100),
      prob_exhaust_pct: round2((countIf(run.aggRecovery, (v) => v >= a.limit - 0.005) / n) * 100),
      marginal_capital_relief: marginal,
      implied_coc_pct: marginal != null ? impliedRatePct(cost, marginal, premium) : null,
    });
  }
  return rows;
}

function summariseSide(run, ctx, grossBlock, extras = {}) {
  const premium = ctx.subjectPremium;
  const capital = capitalFromResults(run.insurerResult, ctx.capitalPercentile);
  const required = round2(Math.max(capital.var, 0));
  const resultStats = stats(run.insurerResult);
  const netLossStats = stats(run.netLoss);
  const netPremiumMean = meanOf(run.netPremium);
  const insurerRoe = roePct(resultStats.mean, required, premium);
  const available = ctx.availableCapital;
  const coc = ctx.costOfCapitalPct / 100;
  const relief = grossBlock ? round2(grossBlock.capital.required - required) : 0;

  // Downside of the underwriting result against the capital actually held.
  const losses = Float64Array.from(run.insurerResult, (v) => -v).sort();
  const n = losses.length;
  let consumption = 0;
  let deficit = 0;
  let ruin = 0;
  for (let i = 0; i < n; i += 1) {
    if (losses[i] > 0) consumption += losses[i];
    if (losses[i] > available) {
      ruin += 1;
      deficit += losses[i] - available;
    }
  }

  const riResultStats = stats(run.reinsurerResult);
  const cededStats = stats(run.cededLoss);
  const ripMean = meanOf(run.ripPaid);
  const surplusPremium = numOr(run.flows.surplus_premium, 0);
  const commission = run.flows.qs_commission + numOr(run.flows.surplus_commission, 0);
  const riPremium = round2(run.flows.qs_premium + surplusPremium + run.flows.xol_premium + run.flows.aggregate_premium + ripMean);
  const hasRi = riPremium > 0 || cededStats.mean > 0;
  const expectedCredit = meanOf(run.creditLoss);
  // The ceded margin is what the cover is expected to cost the buyer.
  const expectedCost = riPremium - cededStats.mean - commission;

  // The year on the balance sheet: the combined ratio year by year, the net
  // income once investment income (the yield, with its volatility) is
  // added, and where the capital held stands at the year end.
  const combinedRatio = stats(Float64Array.from(run.netLoss, (v, i) => (
    run.netPremium[i] > 0 ? ((v + run.flows.insurer_expense) / run.netPremium[i]) * 100 : 0
  )));
  const rate = assetRateOf(ctx, 0);
  const investment = Float64Array.from(run.netPremium, (v, i) => rate(i) * (Math.max(0, available) + 0.5 * Math.max(0, v)));
  const netIncome = Float64Array.from(run.insurerResult, (v, i) => v + investment[i]);
  const netIncomeStats = stats(netIncome);
  const solvencyEnd = required > 0
    ? (() => {
      const ratios = Float64Array.from(netIncome, (v) => ((available + v) / required) * 100);
      const st = stats(ratios);
      return {
        mean: st.mean,
        sd: st.sd,
        p0_5: st.p0_5,
        p1: st.p1,
        p10: st.p10,
        p50: st.p50,
        p90: st.p90,
        p99: st.p99,
        prob_below_100_pct: round2((countIf(ratios, (v) => v < 100) / n) * 100),
      };
    })()
    : null;
  const cocSaved = relief * coc;
  const valueAdded = cocSaved - expectedCost - expectedCredit;
  const riCapital = capitalFromResults(run.reinsurerResult, ctx.capitalPercentile);

  // Risk transfer as the reinsurer's regulator reads it (Ruhm & Brehm).
  let erdTail = 0;
  let tenTen = 0;
  for (let i = 0; i < n; i += 1) {
    const m = run.reinsurerMargin[i];
    if (m < 0) erdTail += -m;
    if (riPremium > 0 && m <= -0.1 * riPremium) tenTen += 1;
  }

  const block = {
    flows: run.flows,
    net_premium_mean: round2(netPremiumMean),
    loss: netLossStats,
    loss_ratio: stats(perTrialRatio(run.netLoss, run.netPremium)),
    combined_ratio_pct: netPremiumMean > 0
      ? round2(((netLossStats.mean + run.flows.insurer_expense) / netPremiumMean) * 100)
      : null,
    combined_ratio: combinedRatio,
    result: resultStats,
    prob_uw_loss_pct: probNegativePct(run.insurerResult),
    investment_income_mean: round2(meanOf(investment)),
    net_income: netIncomeStats,
    prob_net_loss_pct: probNegativePct(netIncome),
    solvency_end: solvencyEnd,
    capital: {
      ...capital,
      required,
      relief,
      roe_pct: insurerRoe,
      eva: round2(resultStats.mean - required * coc),
      available: round2(available),
      solvency_ratio_pct: required > 0 ? round2((available / required) * 100) : null,
      consumption_mean: round2(consumption / n),
      earnings_at_risk: round2(Math.max(0, pctOf(losses, 90))),
      loss_1in100: round2(Math.max(0, pctOf(losses, 99))),
      loss_1in100_pct_of_capital: available > 0 ? round2((Math.max(0, pctOf(losses, 99)) / available) * 100) : null,
      ruin_prob_pct: round2((ruin / n) * 100),
      epd_pct: round2((deficit / n / premium) * 100),
    },
    reinsurance: hasRi ? {
      ceded_premium: riPremium,
      expected_recoveries: cededStats.mean,
      expected_commission: round2(commission),
      expected_cost: round2(expectedCost),
      cost_pct_of_ceded_premium: riPremium > 0 ? round2((expectedCost / riPremium) * 100) : null,
      expected_credit_loss: round2(expectedCredit),
      capital_relief: relief,
      coc_saved: round2(cocSaved),
      value_added: round2(valueAdded),
      implied_coc_pct: impliedRatePct(expectedCost + expectedCredit, relief, premium),
      hurdle_coc_pct: ctx.costOfCapitalPct,
      efficient: (() => {
        const implied = impliedRatePct(expectedCost + expectedCredit, relief, premium);
        return implied == null ? null : implied <= ctx.costOfCapitalPct;
      })(),
      erd_pct: riPremium > 0 ? round2((erdTail / n / riPremium) * 100) : null,
      ten_ten_pct: round2((tenTen / n) * 100),
      risk_transfer_ok: riPremium > 0 ? erdTail / n / riPremium >= 0.01 : null,
    } : null,
    reinsurer: hasRi ? {
      premium: riPremium,
      expected_loss: cededStats.mean,
      expected_rip: round2(ripMean),
      commission_paid: round2(commission),
      loss_ratio_pct: riPremium > 0 ? round2((cededStats.mean / riPremium) * 100) : null,
      result: riResultStats,
      margin_pct: riPremium > 0 ? round2((riResultStats.mean / riPremium) * 100) : null,
      prob_loss_pct: probNegativePct(run.reinsurerResult),
      capital: {
        ...riCapital,
        required: round2(Math.max(riCapital.var, 0)),
        roe_pct: roePct(riResultStats.mean, Math.max(riCapital.var, 0), riPremium),
      },
      ceded: cededStats,
    } : null,
    layers: layerAttribution(run, ctx, required, extras),
    ep_curve: epCurve(run.grossLoss, run.cededLoss, run.netLoss),
    structure: {
      quota_share: run.structure.cession_pct > 0
        ? {
          cession_pct: run.structure.cession_pct,
          commission_pct: run.structure.commission_pct,
          event_limit: run.structure.qs.event_limit,
          sliding_scale: run.structure.qs.sliding_scale,
          loss_corridor: run.structure.qs.loss_corridor,
        }
        : null,
      surplus: run.structure.surplus
        ? {
          retained_line: run.structure.surplus.retained_line,
          lines: run.structure.surplus.lines,
          commission_pct: run.structure.surplus.commission_pct,
          event_limit: run.structure.surplus.event_limit,
          average_cession_pct: run.flows.surplus_average_cession_pct,
          premium100: run.flows.surplus_premium,
        }
        : null,
      xol_layers: run.structure.xol_layers.map((l) => ({
        name: l.name,
        attachment: l.attachment,
        limit: l.limit,
        premium100: round2(l.premium100),
        technical_premium100: round2(l.technical_premium100),
        priced: l.priced,
        reinstatements: l.reinstatements === Infinity ? 'UNLIMITED' : l.reinstatements,
        reinstatement_pct: l.reinstatement_pct,
        placed_pct: l.placed_pct,
        aggregate_deductible: l.aggregate_deductible,
      })),
      aggregate_cover: run.structure.aggregate ? {
        name: run.structure.aggregate.name,
        attachment: round2(run.structure.aggregate.attachment),
        limit: round2(run.structure.aggregate.limit),
        attachment_lr_pct: run.structure.aggregate.attachment_lr_pct,
        exhaust_lr_pct: run.structure.aggregate.exhaust_lr_pct,
        premium100: round2(run.structure.aggregate.premium100),
        technical_premium100: round2(run.structure.aggregate.technical_premium100),
        priced: run.structure.aggregate.priced,
        placed_pct: run.structure.aggregate.placed_pct,
      } : null,
    },
  };
  // Prior-year reserves: what the run-off did to the year, and how wide it is.
  block.reserves = ctx.reserves && ctx.reserves.opening > 0 ? (() => {
    const dev = stats(run.reserveDevelopment);
    return {
      opening: round2(ctx.reserves.opening),
      expected_development: dev.mean,
      development_sd: dev.sd,
      development_p90: dev.p90,
      development_p99_5: dev.p99_5,
      development_1in100_pct_of_capital: available > 0 ? round2((Math.max(0, dev.p99) / available) * 100) : null,
    };
  })() : null;
  // Leverage, the regulatory monitors the Handbook names (premium and
  // reserve leverage, the IRIS tests): premium and reserves over the capital held.
  const openingReserves = ctx.reserves?.opening || 0;
  block.leverage = available > 0 ? {
    gross_premium_to_capital_pct: round2((premium / available) * 100),
    net_premium_to_capital_pct: round2((netPremiumMean / available) * 100),
    reserves_to_capital_pct: round2((openingReserves / available) * 100),
    net_leverage_pct: round2(((netPremiumMean + openingReserves) / available) * 100),
  } : null;
  // The regulatory reading: the capital held against the domicile's ladder.
  block.regime = ctx.regime ? regimeBlock(run, ctx, available) : null;
  block.standing = standingOf(block);
  if (extras.yearRuns) block.horizon = horizonBlock(extras.yearRuns, ctx, required);
  return block;
}

/**
 * How a structure stands, in a word — 'holds', 'strained' or 'breach'.
 * Against the domicile's ladder when there is one: already below the first
 * action level, or expected to be there by the year end, is a breach; a
 * 1-in-4 chance of reaching it in the year, or the 1-in-10 year end below
 * it, is strained. Without a regime the desk's own capital standard stands
 * in: below 100% solvency is a breach; under 120%, or a 1% chance of ruin,
 * is strained.
 */
export function standingOf(b) {
  const r = b.regime;
  if (r && !r.needs_input) {
    if (r.band.tone !== 'good' || r.ratio_end_mean_pct < r.intervention_pct) return 'breach';
    if (r.prob_breach_pct >= 25 || r.ratio_end_p10_pct < r.intervention_pct) return 'strained';
    return 'holds';
  }
  const s = b.capital.solvency_ratio_pct;
  if (s != null && s < 100) return 'breach';
  if ((s != null && s < 120) || b.capital.ruin_prob_pct >= 1) return 'strained';
  return 'holds';
}

/**
 * Where the insurer stands on its domicile's capital ladder for this
 * structure: the requirement (typed, or the modelled capital at the regime's
 * own calibration standing in for it), the ratio and its band, the strain the
 * year can take before the first action level and the control level, the
 * chance of reaching each in the year, and the ratio at the year end.
 */
function regimeBlock(run, ctx, available) {
  const regime = ctx.regime;
  const proxy = regime.proxy;
  const modelled = proxy ? capitalFromResults(run.insurerResult, proxy.confidence)[proxy.measure] : null;
  const position = assessCapitalPosition(regime, { available, modelled, given: ctx.regulatoryRequired });
  const base = { ...position, modelled: modelled != null ? round2(modelled) : null };
  if (position.needs_input) {
    return { ...base, prob_breach_pct: null, prob_control_pct: null, ratio_end_mean_pct: null, ratio_end_p10_pct: null, ratio_end_p1_pct: null };
  }
  const n = run.insurerResult.length;
  let breach = 0;
  let control = 0;
  for (let i = 0; i < n; i += 1) {
    const loss = -run.insurerResult[i];
    if (loss > position.strain_before_action) breach += 1;
    if (position.strain_before_control != null && loss > position.strain_before_control) control += 1;
  }
  const endRatios = Float64Array.from(run.insurerResult, (v) => ((available + v) / position.required) * 100).sort();
  return {
    ...base,
    prob_breach_pct: round2((breach / n) * 100),
    prob_control_pct: position.strain_before_control != null ? round2((control / n) * 100) : null,
    ratio_end_mean_pct: round2(meanOf(endRatios)),
    ratio_end_p10_pct: round2(pctOf(endRatios, 10)),
    ratio_end_p1_pct: round2(pctOf(endRatios, 1)),
  };
}

/** The risk/return point a structure plots on the efficient-frontier chart. */
function frontierRow(label, kind, b) {
  return {
    label,
    kind,
    capital_required: b.capital.required,
    tvar: b.capital.tvar,
    result_mean: b.result.mean,
    result_sd: b.result.sd,
    roe_pct: b.capital.roe_pct,
    eva: b.capital.eva,
    ruin_prob_pct: b.capital.ruin_prob_pct,
    ceded_premium: b.reinsurance?.ceded_premium ?? 0,
    reinsurance_cost: b.reinsurance?.expected_cost ?? 0,
    value_added: b.reinsurance?.value_added ?? 0,
    combined_ratio_p90: b.combined_ratio?.p90 ?? null,
    net_income_mean: b.net_income?.mean ?? null,
  };
}

// ---- The full run ----

/** The gross annual loss beyond which reinsurer defaults cluster (worst 1%). */
function grossTailThreshold(trialsData) {
  const totals = Float64Array.from(trialsData, (t) => t.events.reduce((a, e) => a + e.amount, t.attritional)).sort();
  return pctOf(totals, 99);
}

/** Everything a scenario spec may move. */
export const SCENARIO_KEYS = [
  'loss_ratio_delta_pts', 'severity_multiple', 'large_frequency_multiple', 'cat_frequency_multiple',
  'forced_cat_pml_multiple', 'reserve_development_pct', 'reserve_shock_pct', 'latent_claims_pct_of_premium',
  'uncollectible_pct', 'asset_shock_pct', 'premium_growth_pct', 'loss_trend_pct', 'investment_yield_pct',
  'expense_ratio_pct',
];

/**
 * The scenarios the desk tests by default: the CAS Handbook's sections as
 * plausible adverse cases, and one favourable case beside them. Each carries
 * the one figure a broker would move (`param`) and what rides along with it
 * (`fixed`); scenarioOverrides() turns a definition into the spec runDfa takes.
 */
export const STANDARD_SCENARIOS = [
  {
    key: 'favourable',
    label: 'A good year',
    section: 'Pricing / business planning',
    text: 'Rates run better than the plan — the favourable case the Handbook asks for beside the adverse ones.',
    param: { key: 'loss_ratio_delta_pts', label: 'points off the loss ratio', value: -5, min: -50, max: 0, step: 1 },
    fixed: {},
  },
  {
    key: 'rates',
    label: 'Rates inadequate',
    section: 'Pricing / business planning',
    text: 'The book runs hotter than planned: inadequate rates, schedule credits, or a plan loss ratio that was optimistic.',
    param: { key: 'loss_ratio_delta_pts', label: 'points on the loss ratio', value: 10, min: 0, max: 100, step: 1 },
    fixed: {},
  },
  {
    key: 'growth',
    label: 'Excessive growth in under-priced business',
    section: 'Pricing / business planning',
    text: 'Volume grows fast in business priced below the book’s average. Over a horizon above one year the growth compounds; in a single year it is the loss-ratio drag that shows.',
    param: { key: 'premium_growth_pct', label: '% growth a year', value: 25, min: -30, max: 50, step: 1 },
    fixed: { loss_ratio_delta_pts: 5 },
  },
  {
    key: 'frequency',
    label: 'Large losses come more often',
    section: 'Reserve considerations',
    text: 'The large-loss frequency runs above the calibration — a shift in mix, the underwriting cycle, or a claims environment that has moved.',
    param: { key: 'large_frequency_multiple', label: '× the large-loss frequency', value: 1.5, min: 0, max: 10, step: 0.1 },
    fixed: {},
  },
  {
    key: 'inflation',
    label: 'Claims inflation',
    section: 'Reserve considerations',
    text: 'Every loss costs more than the calibration says, and keeps trending in later years while the programme stays fixed in nominal terms.',
    param: { key: 'severity_multiple', label: '× every severity', value: 1.1, min: 0.5, max: 3, step: 0.05 },
    fixed: { loss_trend_pct: 5 },
  },
  {
    key: 'reserves',
    label: 'Prior-year reserves deteriorate',
    section: 'Reserve considerations',
    text: 'The opening reserve develops adversely in the year — the largest liability on the balance sheet moving against the insurer. Needs an opening reserve on 01 Scope.',
    param: { key: 'reserve_shock_pct', label: '% of the opening reserve', value: 15, min: 0, max: 100, step: 1 },
    fixed: {},
  },
  {
    key: 'latent',
    label: 'Latent claims emerge',
    section: 'Mass tort exposure',
    text: 'A one-off charge for claims nobody reserved for — the Handbook’s mass-tort test — as a share of the year’s premium.',
    param: { key: 'latent_claims_pct_of_premium', label: '% of subject premium', value: 15, min: 0, max: 200, step: 1 },
    fixed: {},
  },
  {
    key: 'cat',
    label: 'The cat PML event happens',
    section: 'Reinsurance considerations',
    text: 'An event the size of the cat PML — the one typed on 01 Scope, else the modelled 1-in-200 cat event — lands on top of an ordinary year: does the tower hold, and what is left net?',
    param: { key: 'forced_cat_pml_multiple', label: '× the cat PML', value: 1, min: 0.1, max: 3, step: 0.1 },
    fixed: {},
  },
  {
    key: 'reinsurer',
    label: 'A reinsurer fails',
    section: 'Reinsurance considerations',
    text: 'Part of the year’s recoveries is never collected — a panel member impaired, a dispute, a commutation at a discount.',
    param: { key: 'uncollectible_pct', label: '% of recoveries uncollectible', value: 25, min: 0, max: 100, step: 1 },
    fixed: {},
  },
  {
    key: 'assets',
    label: 'Investment markets fall',
    section: 'Invested assets',
    text: 'Asset values fall and the loss goes straight to surplus — the Handbook’s reminder that the asset side can impair any insurer.',
    param: { key: 'asset_shock_pct', label: '% of invested assets', value: 10, min: 0, max: 100, step: 1 },
    fixed: {},
  },
];

/** The engine spec for a standard scenario at the given figure. */
export function scenarioOverrides(def, value = def.param.value) {
  return { ...def.fixed, [def.param.key]: Number(value) };
}

/**
 * A scenario's inputs: the base calibration and assumptions with the
 * overrides applied. Multiplicative moves scale the calibration; a forced
 * event is the cat PML (times a multiple) added to every first year; the
 * deterministic charges — a share of the opening reserve, of the premium, of
 * the invested assets — become one charge to the first year's surplus; an
 * uncollectible share becomes a certain default of that share of recoveries.
 *
 * @param {object} context  { catPml, investedAssets } from the base run
 */
export function applyScenario(portfolio, assumptions, overrides = {}, context = {}) {
  const o = overrides || {};
  const p = { ...portfolio };
  const a = { ...assumptions };
  const mult = (v) => Math.max(0, Number(v) || 0);
  if (o.loss_ratio_delta_pts != null) {
    p.expected_loss_ratio_pct = Math.max(0, numOr(p.expected_loss_ratio_pct, 0) + Number(o.loss_ratio_delta_pts));
  }
  if (o.severity_multiple != null) {
    const m = mult(o.severity_multiple);
    for (const k of ['large_severity_mean', 'cat_severity_mean', 'large_severity_cap', 'cat_pml']) {
      if (Number(p[k]) > 0) p[k] = Number(p[k]) * m;
    }
  }
  if (o.large_frequency_multiple != null) p.large_frequency = numOr(p.large_frequency, 0) * mult(o.large_frequency_multiple);
  if (o.cat_frequency_multiple != null) p.cat_frequency = numOr(p.cat_frequency, 0) * mult(o.cat_frequency_multiple);
  if (Number(o.forced_cat_pml_multiple) > 0) {
    const pml = Number(p.cat_pml) > 0 ? Number(p.cat_pml) : Number(context.catPml) || 0;
    if (pml > 0) p.forced_event = pml * Number(o.forced_cat_pml_multiple);
  }
  if (o.reserve_development_pct != null) p.reserve_development_pct = Number(o.reserve_development_pct);
  let charge = 0;
  if (o.reserve_shock_pct != null) charge += Math.max(0, Number(p.opening_reserves) || 0) * (Number(o.reserve_shock_pct) / 100);
  if (o.latent_claims_pct_of_premium != null) charge += (Number(p.subject_premium) || 0) * (Number(o.latent_claims_pct_of_premium) / 100);
  if (o.asset_shock_pct != null) charge += (Number(context.investedAssets) || 0) * (Number(o.asset_shock_pct) / 100);
  if (o.uncollectible_pct != null) {
    a.credit_pd_pct = 100;
    a.credit_lgd_pct = clamp(Number(o.uncollectible_pct) || 0, 0, 100);
    a.credit_stress_multiple = 1;
  }
  for (const k of ['premium_growth_pct', 'loss_trend_pct', 'investment_yield_pct', 'expense_ratio_pct']) {
    if (o[k] != null) a[k] = Number(o[k]);
  }
  return { portfolio: p, assumptions: { ...a, surplus_charge: round2(Math.max(0, charge)) } };
}

/**
 * One full run: calibrate, simulate the gross years once, apply each named
 * structure to the same trials, roll the surplus forward. `compact` skips
 * the per-cover marginals and the variants — the scenarios' runs need
 * neither.
 */
function runCore({ portfolio, structures, variants = {}, assumptions = {} }, { compact = false } = {}) {
  const a = { ...DFA_DEFAULTS, ...assumptions };
  const trials = Math.min(20000, Math.max(500, Math.trunc(a.trials) || DFA_DEFAULTS.trials));
  const seed = Number.isFinite(Number(a.seed)) ? Number(a.seed) : DFA_DEFAULTS.seed;
  const horizon = clamp(Math.trunc(numOr(a.horizon_years, 1)) || 1, 1, 5);
  const growth = numOr(a.premium_growth_pct, 0) / 100;
  const trend = numOr(a.loss_trend_pct, 0) / 100;

  const calibration = calibratePortfolio(portfolio);
  const yearCalibrations = [];
  const yearTrials = [];
  for (let k = 0; k < horizon; k += 1) {
    // A forced event belongs to the first year only; the later years are the
    // calibration grown and trended.
    const cal = k === 0
      ? calibration
      : { ...scaleCalibration(calibration, { exposure: (1 + growth) ** k, severity: (1 + trend) ** k }), forced_event: null };
    yearCalibrations.push(cal);
    yearTrials.push(simulateGrossTrials(cal, { trials, seed: seed + 1000003 * k }));
  }

  // Reinsurer default draws are shared by every structure, like the losses.
  const creditPd = clamp(numOr(a.credit_pd_pct, DFA_DEFAULTS.credit_pd_pct), 0, 100) / 100;
  const creditLgd = clamp(numOr(a.credit_lgd_pct, DFA_DEFAULTS.credit_lgd_pct), 0, 100) / 100;
  const creditStress = Math.max(1, numOr(a.credit_stress_multiple, DFA_DEFAULTS.credit_stress_multiple));
  const creditRng = makeRng((seed ^ 0x5bd1e995) >>> 0);
  const creditByYear = yearTrials.map((tr) => ({
    pd: creditPd,
    lgd: creditLgd,
    stress: creditStress,
    threshold: grossTailThreshold(tr),
    u: Float64Array.from({ length: trials }, () => creditRng()),
  }));

  // Asset returns: one standard normal a trial a year, shared by every
  // structure, so a bad investment year is the same bad year for each.
  const assetVolatility = clamp(numOr(a.asset_return_volatility_pct, DFA_DEFAULTS.asset_return_volatility_pct), 0, 100) / 100;
  const assetRng = makeRng((seed ^ 0x2545f491) >>> 0);
  const assetReturns = {
    volatility: assetVolatility,
    z: yearTrials.map(() => Float64Array.from({ length: trials }, () => sampleNormal(assetRng))),
  };

  const regime = regimeFor(a.domicile);
  const regulatoryRequired = Number(a.regulatory_required_capital) > 0 ? Number(a.regulatory_required_capital) : null;
  const surplusCharge = Math.max(0, numOr(a.surplus_charge, 0));

  const baseCtx = {
    expenseRatioPct: Number(a.expense_ratio_pct) >= 0 ? Number(a.expense_ratio_pct) : DFA_DEFAULTS.expense_ratio_pct,
    reinsurerExpensePct: Number(a.reinsurer_expense_pct) >= 0 ? Number(a.reinsurer_expense_pct) : DFA_DEFAULTS.reinsurer_expense_pct,
    capitalPercentile: Number(a.capital_percentile) || DFA_DEFAULTS.capital_percentile,
    costOfCapitalPct: Number(a.cost_of_capital_pct) >= 0 ? Number(a.cost_of_capital_pct) : DFA_DEFAULTS.cost_of_capital_pct,
    investmentYieldPct: Math.max(0, numOr(a.investment_yield_pct, DFA_DEFAULTS.investment_yield_pct)),
    pricing: {
      risk_load_sd_multiple: Math.max(0, numOr(a.risk_load_sd_multiple, DFA_DEFAULTS.risk_load_sd_multiple)),
      min_rate_on_line_pct: Math.max(0, numOr(a.min_rate_on_line_pct, DFA_DEFAULTS.min_rate_on_line_pct)),
    },
    reserves: calibration.reserves,
    regime,
    regulatoryRequired,
    assetReturns,
  };
  const ctxYear = (k) => ({
    ...baseCtx,
    subjectPremium: yearCalibrations[k].subject_premium,
    premiumScale: yearCalibrations[k].subject_premium / calibration.subject_premium,
    profile: yearCalibrations[k].profile,
    credit: creditByYear[k],
    surplusCharge: k === 0 ? surplusCharge : 0,
  });
  const ctx0 = ctxYear(0);

  // The gross book is "no reinsurance" run through the same machinery, so
  // every capital-relief figure is a like-for-like subtraction. Its 1-in-N
  // loss is also the default for the capital the insurer holds.
  const grossYearRuns = yearTrials.map((tr, k) => applyStructure(tr, {}, ctxYear(k)));
  const grossCapital = capitalFromResults(grossYearRuns[0].insurerResult, ctx0.capitalPercentile);
  const availableGiven = Number(a.available_capital) > 0;
  const availableCapital = availableGiven
    ? Number(a.available_capital)
    : (grossCapital.var > 0 ? round2(grossCapital.var) : round2(calibration.subject_premium * 0.2));
  // Invested assets, for the asset-side scenarios: the capital held plus the
  // reserves and half the year's premium (the float), unless given.
  const investedGiven = Number(a.invested_assets) > 0;
  const investedAssets = investedGiven
    ? Number(a.invested_assets)
    : round2(availableCapital + calibration.reserves.opening + 0.5 * calibration.subject_premium);
  const summaryCtx = { ...ctx0, availableCapital };
  const grossBlock = summariseSide(grossYearRuns[0], summaryCtx, null, { yearRuns: grossYearRuns });
  // The largest cat event of a year by return period: the PML the forced-event
  // scenario uses when none is typed (a sampled event, never a forced one).
  const largestCat = Float64Array.from(yearTrials[0], (t) => t.events.reduce(
    (m, e) => (e.cat && !e.forced && e.amount > m ? e.amount : m), 0,
  )).sort();

  const requiredOf = (run) => round2(Math.max(0, capitalFromResults(run.insurerResult, ctx0.capitalPercentile).var));

  const out = {};
  for (const [label, structure] of Object.entries(structures || {})) {
    const run = applyStructure(yearTrials[0], structure, ctx0);
    const s = run.structure;
    // Marginal capital of each cover: the programme without it, same trials.
    const marginals = compact
      ? null
      : s.xol_layers.map((_, j) => requiredOf(applyStructure(yearTrials[0], specFrom(s, { dropLayer: j }), ctx0)));
    const aggregateMarginal = !compact && s.aggregate
      ? requiredOf(applyStructure(yearTrials[0], specFrom(s, { dropAggregate: true }), ctx0)) : null;
    const yearRuns = [run];
    for (let k = 1; k < horizon; k += 1) yearRuns.push(applyStructure(yearTrials[k], structure, ctxYear(k)));
    out[label] = summariseSide(run, summaryCtx, grossBlock, { marginals, aggregateMarginal, yearRuns });
  }

  const variantRows = {};
  if (!compact) {
    for (const [label, structure] of Object.entries(variants || {})) {
      const run = applyStructure(yearTrials[0], structure, ctx0);
      variantRows[label] = frontierRow(label, 'variant', summariseSide(run, summaryCtx, grossBlock));
    }
  }

  const frontier = [
    frontierRow('gross', 'gross', grossBlock),
    ...Object.entries(out).map(([label, b]) => frontierRow(label, 'structure', b)),
    ...Object.values(variantRows),
  ];

  return {
    trials,
    seed,
    assumptions: {
      expense_ratio_pct: baseCtx.expenseRatioPct,
      reinsurer_expense_pct: baseCtx.reinsurerExpensePct,
      capital_percentile: baseCtx.capitalPercentile,
      cost_of_capital_pct: baseCtx.costOfCapitalPct,
      available_capital: round2(availableCapital),
      available_capital_source: availableGiven ? 'given' : 'gross 1-in-N underwriting loss',
      invested_assets: investedAssets,
      invested_assets_source: investedGiven ? 'given' : 'capital + reserves + half the premium',
      investment_yield_pct: baseCtx.investmentYieldPct,
      asset_return_volatility_pct: assetVolatility * 100,
      horizon_years: horizon,
      premium_growth_pct: growth * 100,
      loss_trend_pct: trend * 100,
      credit_pd_pct: creditPd * 100,
      credit_lgd_pct: creditLgd * 100,
      credit_stress_multiple: creditStress,
      risk_load_sd_multiple: baseCtx.pricing.risk_load_sd_multiple,
      min_rate_on_line_pct: baseCtx.pricing.min_rate_on_line_pct,
      domicile: regime ? regime.code : null,
      regulatory_required_capital: regulatoryRequired,
      surplus_charge: surplusCharge,
    },
    calibration: {
      subject_premium: round2(calibration.subject_premium),
      expected: calibration.expected,
      large_loss_threshold: calibration.large.threshold,
      parameter_uncertainty_pct: round2(calibration.parameter_cv * 100),
      cat_frequency_cv_pct: round2(calibration.cat.frequency_cv * 100),
      large_severity_cap: round2(calibration.large.cap),
      cat_pml: round2(calibration.cat.cap),
      opening_reserves: round2(calibration.reserves.opening),
      reserve_development_pct: calibration.reserves.development_pct,
      reserve_cv_pct: calibration.reserves.cv_pct,
      forced_event: calibration.forced_event,
      cat_pml_source: Number(portfolio.cat_pml) > 0 ? 'given' : 'sampling cap',
      cat_event_1in100: round2(pctOf(largestCat, 99)),
      cat_event_1in200: round2(pctOf(largestCat, 99.5)),
      risk_profile: calibration.profile,
    },
    regime,
    gross: grossBlock,
    structures: out,
    variants: variantRows,
    frontier,
  };
}

/** A structure's block cut down to what the scenario table reads. */
function compactBlock(b) {
  const last = b.horizon ? b.horizon.by_year[b.horizon.by_year.length - 1] : null;
  return {
    result_mean: b.result.mean,
    loss_mean: b.loss.mean,
    loss_ratio_mean: b.loss_ratio.mean,
    combined_ratio_pct: b.combined_ratio_pct,
    combined_ratio_p90: b.combined_ratio?.p90 ?? null,
    net_income_mean: b.net_income?.mean ?? null,
    net_income_p1: b.net_income?.p1 ?? null,
    capital_required: b.capital.required,
    solvency_ratio_pct: b.capital.solvency_ratio_pct,
    solvency_end_p1_pct: b.solvency_end?.p1 ?? null,
    ruin_prob_pct: b.capital.ruin_prob_pct,
    epd_pct: b.capital.epd_pct,
    loss_1in100: b.capital.loss_1in100,
    loss_1in100_pct_of_capital: b.capital.loss_1in100_pct_of_capital,
    reinsurance: b.reinsurance ? {
      ceded_premium: b.reinsurance.ceded_premium,
      expected_recoveries: b.reinsurance.expected_recoveries,
      expected_cost: b.reinsurance.expected_cost,
      expected_credit_loss: b.reinsurance.expected_credit_loss,
      capital_relief: b.reinsurance.capital_relief,
    } : null,
    regime: b.regime ? {
      required: b.regime.required,
      required_source: b.regime.required_source,
      needs_input: b.regime.needs_input,
      ratio_pct: b.regime.ratio_pct,
      band: b.regime.band,
      strain_before_action: b.regime.strain_before_action,
      prob_breach_pct: b.regime.prob_breach_pct,
      prob_control_pct: b.regime.prob_control_pct,
      ratio_end_mean_pct: b.regime.ratio_end_mean_pct,
      ratio_end_p1_pct: b.regime.ratio_end_p1_pct,
    } : null,
    horizon: b.horizon ? {
      years: b.horizon.years,
      surplus_end_mean: last.surplus_mean,
      surplus_end_p10: last.surplus_p10,
      surplus_end_p1: last.surplus_p1,
      prob_ruin_pct: b.horizon.prob_ruin_pct,
      prob_capital_breach_pct: b.horizon.prob_capital_breach_pct,
    } : null,
    standing: b.standing,
    threat: b.standing !== 'holds',
  };
}

/**
 * Run the DFA: calibrate, simulate the gross years once, then apply each
 * named structure to the same trials; then every scenario, re-simulated on
 * the same seed with its overrides, read against the same capital.
 *
 * @param {object} args
 * @param {object} args.portfolio    calibration inputs (see calibratePortfolio)
 * @param {Object<string, object>} args.structures  e.g. { current, proposed }
 * @param {Object<string, object>} [args.variants]  extra structures summarised
 *                                  compactly for the frontier chart
 * @param {Object<string, object>} [args.scenarios] { label: overrides } — see
 *                                  SCENARIO_KEYS and applyScenario
 * @param {object} [args.assumptions]
 */
export function runDfa({ portfolio, structures, variants = {}, assumptions = {}, scenarios = {} }) {
  const base = runCore({ portfolio, structures, variants, assumptions });
  const out = { ...base, scenarios: {} };
  // The PML a forced event is sized on: the one typed, else the modelled
  // 1-in-200 cat event (the sampling cap is a bound, not an estimate).
  const context = {
    catPml: Number(portfolio.cat_pml) > 0 ? Number(portfolio.cat_pml) : base.calibration.cat_event_1in200,
    investedAssets: base.assumptions.invested_assets,
  };
  // A scenario holds exactly the capital and assets the base case holds, so
  // the movement is the scenario's, never a re-derived starting point.
  const held = {
    ...assumptions,
    available_capital: base.assumptions.available_capital,
    invested_assets: base.assumptions.invested_assets,
  };
  for (const [label, overrides] of Object.entries(scenarios || {})) {
    const s = applyScenario(portfolio, held, overrides, context);
    const run = runCore({ portfolio: s.portfolio, structures, assumptions: s.assumptions }, { compact: true });
    const blocks = {};
    for (const [name, b] of Object.entries(run.structures)) blocks[name] = compactBlock(b);
    out.scenarios[label] = {
      label,
      overrides: { ...overrides },
      expected_loss_ratio_pct: run.calibration.expected.loss_ratio_pct,
      surplus_charge: run.assumptions.surplus_charge,
      forced_event: run.calibration.forced_event,
      gross: compactBlock(run.gross),
      structures: blocks,
    };
  }
  return out;
}

// ---- Structuring: many candidates on the same trials ----

/**
 * A structure's block cut to what the structuring stage reads for every
 * candidate: the economics of the cover, the year's result and net income
 * as distributions, the combined ratio year by year, the capital held
 * against the year, the solvency position at the year end, the regulatory
 * reading and the standing — without the per-cover attribution and the
 * exceedance curve the desk's own stages draw.
 */
function structuringBlock(b) {
  const r = b.reinsurance;
  return {
    flows: b.flows,
    net_premium_mean: b.net_premium_mean,
    loss: b.loss,
    loss_ratio: b.loss_ratio,
    combined_ratio_pct: b.combined_ratio_pct,
    combined_ratio: b.combined_ratio,
    result: b.result,
    prob_uw_loss_pct: b.prob_uw_loss_pct,
    investment_income_mean: b.investment_income_mean,
    net_income: b.net_income,
    prob_net_loss_pct: b.prob_net_loss_pct,
    solvency_end: b.solvency_end,
    capital: b.capital,
    reinsurance: r ? {
      ceded_premium: r.ceded_premium,
      expected_recoveries: r.expected_recoveries,
      expected_commission: r.expected_commission,
      expected_cost: r.expected_cost,
      cost_pct_of_ceded_premium: r.cost_pct_of_ceded_premium,
      expected_credit_loss: r.expected_credit_loss,
      capital_relief: r.capital_relief,
      coc_saved: r.coc_saved,
      value_added: r.value_added,
      implied_coc_pct: r.implied_coc_pct,
      hurdle_coc_pct: r.hurdle_coc_pct,
      efficient: r.efficient,
      erd_pct: r.erd_pct,
      risk_transfer_ok: r.risk_transfer_ok,
    } : null,
    reinsurer: b.reinsurer ? {
      premium: b.reinsurer.premium,
      expected_loss: b.reinsurer.expected_loss,
      loss_ratio_pct: b.reinsurer.loss_ratio_pct,
      result_mean: b.reinsurer.result.mean,
      margin_pct: b.reinsurer.margin_pct,
      prob_loss_pct: b.reinsurer.prob_loss_pct,
    } : null,
    regime: b.regime ? {
      required: b.regime.required,
      required_source: b.regime.required_source,
      needs_input: b.regime.needs_input,
      ratio_pct: b.regime.ratio_pct,
      band: b.regime.band,
      prob_breach_pct: b.regime.prob_breach_pct,
      ratio_end_mean_pct: b.regime.ratio_end_mean_pct,
      ratio_end_p10_pct: b.regime.ratio_end_p10_pct,
      ratio_end_p1_pct: b.regime.ratio_end_p1_pct,
    } : null,
    horizon: b.horizon ? {
      years: b.horizon.years,
      surplus_end_mean: b.horizon.surplus_end.mean,
      surplus_end_p1: b.horizon.surplus_end.p1,
      prob_ruin_pct: b.horizon.prob_ruin_pct,
      prob_capital_breach_pct: b.horizon.prob_capital_breach_pct,
    } : null,
    standing: b.standing,
    structure: b.structure,
  };
}

/**
 * The structuring run: the reference programmes (gross, the current one, the
 * proposed one) and every candidate — the families across a range of
 * retentions, built by domain/structuring.js — applied to the same simulated
 * years, then every one of them re-run under each named stress on the same
 * seed with one thing moved (the cat PML event, a reserve shock, rates
 * running hot) against the same capital. Compact throughout: no per-cover
 * marginals, no variants. What passes the appetite, and which candidate is
 * the pick, is structuring.js's reading of this result.
 *
 * @param {object} args
 * @param {object} args.portfolio      calibration inputs (see calibratePortfolio)
 * @param {Object<string, object>} [args.structures]  the references, e.g. { current, proposed }
 * @param {Object<string, object>} args.candidates    { label: structure }
 * @param {Object<string, object>} [args.stresses]    { label: overrides } — see SCENARIO_KEYS
 * @param {object} [args.assumptions]
 */
export function runStructuring({ portfolio, structures = {}, candidates = {}, assumptions = {}, stresses = {} }) {
  const all = { ...structures, ...candidates };
  const base = runCore({ portfolio, structures: all, assumptions }, { compact: true });
  const context = {
    catPml: Number(portfolio.cat_pml) > 0 ? Number(portfolio.cat_pml) : base.calibration.cat_event_1in200,
    investedAssets: base.assumptions.invested_assets,
  };
  const held = {
    ...assumptions,
    available_capital: base.assumptions.available_capital,
    invested_assets: base.assumptions.invested_assets,
  };
  const stressOut = {};
  for (const [label, overrides] of Object.entries(stresses || {})) {
    const sc = applyScenario(portfolio, held, overrides, context);
    const run = runCore({ portfolio: sc.portfolio, structures: all, assumptions: sc.assumptions }, { compact: true });
    const blocks = {};
    for (const [name, b] of Object.entries(run.structures)) blocks[name] = compactBlock(b);
    stressOut[label] = {
      label,
      overrides: { ...overrides },
      expected_loss_ratio_pct: run.calibration.expected.loss_ratio_pct,
      surplus_charge: run.assumptions.surplus_charge,
      forced_event: run.calibration.forced_event,
      gross: compactBlock(run.gross),
      structures: blocks,
    };
  }
  const references = {};
  for (const label of Object.keys(structures)) references[label] = structuringBlock(base.structures[label]);
  const out = {};
  for (const label of Object.keys(candidates)) out[label] = structuringBlock(base.structures[label]);
  return {
    trials: base.trials,
    seed: base.seed,
    assumptions: base.assumptions,
    calibration: base.calibration,
    regime: base.regime,
    gross: structuringBlock(base.gross),
    references,
    candidates: out,
    stresses: stressOut,
  };
}

// ---- Reinsurer credit ----

/**
 * One-year default probability (%) for a reinsurer from its financial-strength
 * rating, on either the agency letter scale (AAA…B) or the AM Best scale
 * (A++…C). Rounded from published impairment studies (Britt & Krvavych 2009;
 * S&P / Moody's one-year default tables); an unrated market gets 0.5%.
 */
export function reinsurerDefaultPdPct(rating) {
  if (rating == null || rating === '') return 0.5;
  const r = String(rating).toUpperCase().replace(/\s+/g, '');
  if (r === 'NR' || !/^[ABC]/.test(r)) return 0.5;
  if (/^(A\+\+|AAA)/.test(r)) return 0.03;
  if (/^(A\+|AA)/.test(r)) return 0.05;
  if (/^A/.test(r)) return 0.1;
  if (/^(B\+\+|B\+|BBB)/.test(r)) return 0.3;
  if (/^B/.test(r)) return 1.2;
  return 5;
}
