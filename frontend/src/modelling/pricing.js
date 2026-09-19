/* Pricing maths — ported from the Universe modelling tool's npPricingEngine
   and loss-pareto-math: Pareto fitting/LEV, the MBBEFD (Swiss Re) exposure
   curves, severity distribution fits with KS goodness-of-fit, and the three
   per-layer NP pricing methods (pure burning cost, Pareto, exposure rating).
   Pure functions over plain data; formulas kept verbatim. */

import { cn } from './engine.js';

/* ── MBBEFD (Swiss Re exposure curve) ────────────────────────────────────── */

/** G(d,c) = log(1 + (e^c − 1)·d) / c, the destruction-ratio curve. */
export function mbbefdG(d, c) {
  if (d <= 0) return 0;
  if (d >= 1) return 1;
  if (Math.abs(c) < 1e-10) return d;
  return Math.log(1 + (Math.exp(c) - 1) * d) / c;
}
export const SWISS_RE_C = { Y1: 0, Y2: 1.5, Y3: 3.0, Y4: 5.0 };
export const SWISS_RE_CURVES = [
  { name: 'Auto', c: null, desc: 'Per-band: Y1–Y4 by mean SI (Swiss Re brochure Step 4)' },
  { name: 'Y1 (Uniform)', c: 0, desc: 'Personal lines — SI ≤ 400k' },
  { name: 'Y2', c: 1.5, desc: 'Commercial small — SI ≤ 1M' },
  { name: 'Y3', c: 3.0, desc: 'Commercial medium — SI ≤ 2M' },
  { name: 'Y4', c: 5.0, desc: 'Industrial / large commercial — SI > 2M' },
];

/** Swiss Re brochure Step 4: pick the Y-curve per band by mean SI. */
export function autoCurveForBand(avgSI) {
  if (avgSI <= 400_000) return 'Y1';
  if (avgSI <= 1_000_000) return 'Y2';
  if (avgSI <= 2_000_000) return 'Y3';
  return 'Y4';
}

/** MBBEFD limited expected value for layer [D, D+L] on one risk of SI. */
export function mbbefdLayerLEV(si, pmlPct, cValue, deductible, limit) {
  if (si <= 0 || limit <= 0) return 0;
  const pml = si * (pmlPct / 100);
  if (pml <= 0) return 0;
  const dRatio = Math.min(deductible / pml, 1);
  const dlRatio = Math.min((deductible + limit) / pml, 1);
  return pml * (mbbefdG(dlRatio, cValue) - mbbefdG(dRatio, cValue));
}

/* ── Pareto ──────────────────────────────────────────────────────────────── */

/** MLE Pareto(α) fit above threshold xm. */
export function fitPareto(losses, xm) {
  const v = (losses || []).filter((l) => l >= xm);
  const n = v.length;
  if (n === 0) return { alpha: 0, n: 0 };
  let s = 0;
  for (const x of v) s += Math.log(x / xm);
  return { alpha: s > 0 ? n / s : 0, n };
}

/** Loss at exceedance probability p. */
export function paretoQ(p, alpha, xm) {
  if (!(p > 0 && p < 1) || !(alpha > 0) || !(xm > 0)) return 0;
  return xm * Math.pow(1 - p, -1 / alpha);
}

export function paretoCDF(x, a, xm) { return x < xm ? 0 : 1 - Math.pow(xm / x, a); }

/** E[min(X, cap)] for Pareto(α, xm). */
export function paretoLEV(alpha, xm, cap) {
  if (cap <= 0 || alpha <= 0 || xm <= 0) return 0;
  if (cap <= xm) return cap;
  if (Math.abs(alpha - 1) < 1e-9) return xm * (1 + Math.log(cap / xm));
  return ((xm * alpha) / (alpha - 1)) * (1 - Math.pow(xm / cap, alpha - 1)) + cap * Math.pow(xm / cap, alpha);
}

/** Expected annual loss to layer [D, D+L]: (n/years) × (LEV(D+L) − LEV(D)). */
export function paretoLayerExpectedLoss(alpha, xm, deductible, limit, n, years) {
  if (alpha <= 0 || years <= 0 || n <= 0) return 0;
  const D = Math.max(deductible, xm);
  return (n / years) * (paretoLEV(alpha, xm, D + limit) - paretoLEV(alpha, xm, D));
}

export function paretoAttachment(alpha, xm, deductible) {
  if (alpha <= 0 || xm <= 0 || deductible <= xm) return 1;
  return Math.pow(xm / deductible, alpha);
}
export function paretoExhaustion(alpha, xm, deductible, limit) {
  return paretoAttachment(alpha, xm, deductible + limit);
}

/* ── Severity distribution fits + KS (loss-pareto-math) ──────────────────── */

function erf(x) {
  const a1 = 0.254829592; const a2 = -0.284496736; const a3 = 1.421413741;
  const a4 = -1.453152027; const a5 = 1.061405429; const p = 0.3275911;
  const sg = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  return sg * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
}
function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pL = 0.02425; const pH = 1 - pL;
  let q; let r;
  if (p < pL) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= pH) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

export function fitLognormal(losses, xm) {
  const v = losses.filter((l) => l >= xm);
  const n = v.length;
  if (n === 0) return { mu: 0, sigma: 1, n: 0 };
  const lg = v.map((l) => Math.log(l));
  const mu = lg.reduce((a, b) => a + b, 0) / n;
  const sigma = Math.sqrt(lg.reduce((a, b) => a + Math.pow(b - mu, 2), 0) / n) || 0.01;
  return { mu, sigma, n };
}
export function lognormalCDF(x, mu, sigma) { return x <= 0 ? 0 : 0.5 * (1 + erf((Math.log(x) - mu) / (sigma * Math.SQRT2))); }
export function lognormalQ(p, mu, sigma) { return Math.exp(mu + sigma * normInv(p)); }

export function fitExponential(losses, xm) {
  const v = losses.filter((l) => l >= xm);
  const n = v.length;
  if (n === 0) return { lambda: 1, n: 0 };
  const mean = v.reduce((a, b) => a + (b - xm), 0) / n;
  return { lambda: mean > 0 ? 1 / mean : 1, n };
}
export function expCDF(x, lam, xm) { return x < xm ? 0 : 1 - Math.exp(-lam * (x - xm)); }
export function expQ(p, lam, xm) { return xm - Math.log(1 - p) / lam; }

export function fitWeibull(losses, xm) {
  const v = losses.filter((l) => l >= xm).map((l) => l - xm).filter((l) => l > 0);
  const n = v.length;
  if (n < 3) return { k: 1, lam: 1, n: 0 };
  let k = 1;
  for (let it = 0; it < 50; it++) {
    const lg = v.map((x) => Math.log(x));
    const vk = v.map((x) => Math.pow(x, k));
    const vkL = v.map((x, i) => Math.pow(x, k) * lg[i]);
    const sVk = vk.reduce((a, b) => a + b, 0);
    const sVkL = vkL.reduce((a, b) => a + b, 0);
    const sLog = lg.reduce((a, b) => a + b, 0);
    const f = n / k + sLog - (n * sVkL) / sVk;
    const fp = -n / (k * k) - (n * (vkL.map((x, i) => x * lg[i]).reduce((a, b) => a + b, 0) * sVk - sVkL * sVkL)) / (sVk * sVk);
    if (Math.abs(fp) < 1e-15) break;
    k -= f / fp;
    if (k <= 0.01) k = 0.01;
    if (Math.abs(f / fp) < 1e-8) break;
  }
  const lam = Math.pow(v.map((x) => Math.pow(x, k)).reduce((a, b) => a + b, 0) / n, 1 / k);
  return { k, lam, n };
}
export function weibullCDF(x, k, lam, xm) { const z = x - xm; return z <= 0 ? 0 : 1 - Math.exp(-Math.pow(z / lam, k)); }
export function weibullQ(p, k, lam, xm) { return xm + lam * Math.pow(-Math.log(1 - p), 1 / k); }

/** Kolmogorov–Smirnov distance + approximate p-value. */
export function calcKS(losses, cdfFn, xm) {
  const v = losses.filter((x) => x >= xm).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return { ks: 1, pValue: 0 };
  let mx = 0;
  for (let i = 0; i < n; i++) {
    const c = cdfFn(v[i]);
    mx = Math.max(mx, Math.abs((i + 1) / n - c), Math.abs(i / n - c));
  }
  const sq = Math.sqrt(n);
  const z = (sq + 0.12 + 0.11 / sq) * mx;
  return { ks: mx, pValue: Math.max(0, Math.min(1, 2 * Math.exp(-2 * z * z))) };
}

const fDec = (n, d = 4) => (n == null || !Number.isFinite(n) ? '—' : Number(n).toFixed(d));

export const DISTS = [
  { key: 'pareto', label: 'Pareto' },
  { key: 'lognormal', label: 'Lognormal' },
  { key: 'exponential', label: 'Exponential' },
  { key: 'weibull', label: 'Weibull' },
];

/** Fit all four severity distributions above xm, with KS per fit. */
export function fitAll(losses, xm) {
  const p = fitPareto(losses, xm);
  const ln = fitLognormal(losses, xm);
  const ex = fitExponential(losses, xm);
  const wb = fitWeibull(losses, xm);
  return [
    { key: 'pareto', params: p, ks: calcKS(losses, (x) => paretoCDF(x, p.alpha, xm), xm), paramStr: `α=${fDec(p.alpha, 3)}`, n: p.n },
    { key: 'lognormal', params: ln, ks: calcKS(losses, (x) => lognormalCDF(x, ln.mu, ln.sigma), xm), paramStr: `μ=${fDec(ln.mu, 2)} σ=${fDec(ln.sigma, 2)}`, n: ln.n },
    { key: 'exponential', params: ex, ks: calcKS(losses, (x) => expCDF(x, ex.lambda, xm), xm), paramStr: `λ=${fDec(ex.lambda, 6)}`, n: ex.n },
    { key: 'weibull', params: wb, ks: calcKS(losses, (x) => weibullCDF(x, wb.k, wb.lam, xm), xm), paramStr: `k=${fDec(wb.k, 3)} λ=${fDec(wb.lam, 0)}`, n: wb.n },
  ];
}

/** Closed-form Pareto layer price: severity in [max(xm,ret), +lim], × freq. */
export function calcLayerPrice(alpha, xm, freq, ret, lim) {
  if (alpha <= 1) return { severity: 0, rpp: 0, error: 'α ≤ 1' };
  const LEV = (L) => {
    if (L <= xm) return L;
    const m = (alpha * xm) / (alpha - 1);
    return m * (1 - Math.pow(xm / L, alpha - 1)) + L * Math.pow(xm / L, alpha);
  };
  const att = Math.max(xm, ret);
  const sev = LEV(att + lim) - LEV(att);
  return { severity: sev, rpp: freq * sev };
}

/** Numerical (trapezoid over the survival fn) layer price for non-Pareto fits. */
export function calcLayerPriceNumerical(freq, D, L, survivalFn, steps = 400) {
  if (!(L > 0) || !survivalFn) return { severity: 0, rpp: 0 };
  const h = L / steps;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const x = D + i * h;
    const w = i === 0 || i === steps ? 0.5 : 1;
    sum += w * Math.max(0, survivalFn(x));
  }
  const severity = sum * h;
  return { severity, rpp: freq * severity };
}

export function lossReturnPeriod(x, freq, survivalFn) {
  if (!(freq > 0) || !survivalFn) return null;
  const s = survivalFn(x);
  if (!(s > 0)) return null;
  return 1 / (freq * s);
}
export function rpAtAttachment(freq, D, survivalFn) {
  return lossReturnPeriod(D, freq, survivalFn);
}

/* ── NP layer pricing methods (npPricingEngine) ──────────────────────────── */

export function fmtRol(v) {
  if (!v || !Number.isFinite(v) || v <= 0) return '';
  return `${(v * 100).toFixed(2)}%`;
}

/**
 * Pure burning cost for layer [D, D+L] (Clark 2014 steps 2–6): layer-cut each
 * selected inflated loss, sum by year, divide by year-matched EGNPI, average
 * over observation years, apply to prospective EGNPI, ÷ limit → true ROL.
 */
export function calcPureBurningCost(losses, deductible, limit, egnpi, obsYears, egnpiByYear) {
  if (!losses?.length || limit <= 0) return { rol: 0, avgAnnualLayerLoss: 0 };
  const selected = losses.filter((l) => l.is_selected !== false);
  const withValues = selected
    .map((l) => ({ year: l.uw_year, loss: cn(l.inflated_incurred) || (cn(l.incurred) + cn(l.os)) }))
    .filter((l) => l.loss > 0);
  if (!withValues.length) return { rol: 0, avgAnnualLayerLoss: 0 };

  const byYear = {};
  for (const { year, loss } of withValues) {
    const hit = Math.max(0, Math.min(loss - deductible, limit));
    byYear[String(year)] = (byYear[String(year)] || 0) + hit;
  }
  const totalLayerLoss = Object.values(byYear).reduce((s, v) => s + v, 0);
  const hasPerYearEgnpi = egnpiByYear && Object.keys(egnpiByYear).length > 0;

  let avgLossCost;
  let avgEgnpi;
  let years;
  if (hasPerYearEgnpi) {
    const allYears = new Set([...Object.keys(byYear).map(Number), ...Object.keys(egnpiByYear).map(Number)]);
    years = obsYears || allYears.size || 1;
    let totalLossCost = 0;
    let egnpiSum = 0;
    let egnpiCount = 0;
    for (const y of allYears) {
      const yEgnpi = cn(egnpiByYear[y]);
      if (yEgnpi > 0) {
        totalLossCost += (byYear[y] || 0) / yEgnpi;
        egnpiSum += yEgnpi;
        egnpiCount++;
      }
    }
    avgLossCost = years > 0 ? totalLossCost / years : 0;
    avgEgnpi = egnpiCount > 0 ? egnpiSum / egnpiCount : cn(egnpi);
  } else {
    years = obsYears || Object.keys(byYear).length || 1;
    avgEgnpi = cn(egnpi);
    avgLossCost = avgEgnpi > 0 ? totalLayerLoss / years / avgEgnpi : 0;
  }
  const prospectiveEgnpi = cn(egnpi);
  const avgAnnualLayerLoss = avgLossCost * prospectiveEgnpi;
  const rol = limit > 0 ? avgAnnualLayerLoss / limit : 0;
  return { rol, avgLossCost, avgAnnualLayerLoss, avgEgnpi, totalLayerLoss, years };
}

/** Pareto pricing for a layer, preferring saved fitted params from the loss
    selection / Pareto screen. rol = expected layer loss ÷ limit. */
export function calcParetoROL(losses, deductible, limit, egnpi, savedParams) {
  if (limit <= 0 || egnpi <= 0) return { rol: 0, alpha: 0, xm: 0, prAttach: 0, prExhaust: 0 };
  let alpha; let xm; let n; let years;
  if (savedParams && cn(savedParams.pareto_alpha) > 0 && cn(savedParams.pareto_xm) > 0) {
    alpha = cn(savedParams.pareto_alpha);
    xm = cn(savedParams.pareto_xm);
    n = cn(savedParams.selected_count) || 10;
    years = cn(savedParams.observation_years) || 10;
  } else {
    const selected = (losses || []).filter((l) => l.is_selected !== false);
    const vals = selected.map((l) => cn(l.inflated_incurred) || cn(l.incurred) + cn(l.os)).filter((v) => v > 0);
    if (vals.length < 3) return { rol: 0, alpha: 0, xm: 0, prAttach: 0, prExhaust: 0 };
    const sorted = [...vals].sort((a, b) => a - b);
    xm = sorted[Math.floor(sorted.length * 0.25)] || sorted[0];
    const fit = fitPareto(vals, xm);
    alpha = fit.alpha;
    n = fit.n;
    years = cn(savedParams?.observation_years) || Math.max(5, new Set(selected.map((l) => l.uw_year)).size);
  }
  if (alpha <= 0) return { rol: 0, alpha: 0, xm: 0, prAttach: 0, prExhaust: 0 };
  const expLayerLoss = paretoLayerExpectedLoss(alpha, xm, deductible, limit, n, years);
  return {
    rol: limit > 0 ? expLayerLoss / limit : 0,
    alpha, xm, expLayerLoss,
    prAttach: Math.min(1, paretoAttachment(alpha, xm, deductible)),
    prExhaust: Math.min(1, paretoExhaustion(alpha, xm, deductible, limit)),
  };
}

/** Risk XL exposure rating over MBBEFD curves per risk-profile band
    (Swiss Re 9-step; auto per-band curve + gross-loss-ratio step 8). */
export function calcRiskExposureRating(profiles, deductible, limit, egnpi) {
  if (!profiles?.length || limit <= 0 || egnpi <= 0) return { rol: 0, totalExpLoss: 0 };
  let totalExpLoss = 0;
  let totalSI = 0;
  for (const { profile, bands } of profiles) {
    if (!bands?.length) continue;
    const pmlPct = cn(profile.pml_percentage) || 100;
    const curveKey = profile.selected_curve || 'Y3';
    const useAuto = curveKey === 'Auto';
    const grossLossRatio = cn(profile.gross_loss_ratio) > 0 ? cn(profile.gross_loss_ratio) / 100 : 1.0;
    let profileExpLoss = 0;
    for (const band of bands) {
      const nRisks = cn(band.no_of_risks);
      const si = cn(band.total_sum_insured);
      if (nRisks <= 0 || si <= 0) continue;
      const avgSI = si / nRisks;
      if (!Number.isFinite(avgSI) || avgSI <= 0) continue;
      const bandCurveKey = useAuto ? autoCurveForBand(avgSI) : curveKey;
      const c = bandCurveKey === 'Custom' ? cn(profile.custom_b) : (SWISS_RE_C[bandCurveKey] ?? 3.0);
      totalSI += si;
      profileExpLoss += nRisks * mbbefdLayerLEV(avgSI, pmlPct, c, deductible, limit);
    }
    totalExpLoss += profileExpLoss * grossLossRatio;
  }
  const rol = totalSI > 0 && limit > 0 ? totalExpLoss / limit : 0;
  return { rol, totalExpLoss, totalSI };
}

function interpOEP(points, loss) {
  if (!points?.length || loss <= 0) return 0;
  if (loss <= points[0].loss) return 1 / points[0].rp;
  if (loss >= points[points.length - 1].loss) return 0;
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    if (loss >= p1.loss && loss <= p2.loss) {
      const t = (loss - p1.loss) / (p2.loss - p1.loss);
      return 1 / (p1.rp + t * (p2.rp - p1.rp));
    }
  }
  return 0;
}

/** Cat XL exposure rating: saved return-period curve first (trapezoidal OEP
    integration), then Pareto on cat losses, then a flagged flat fallback
    gated on CRESTA exposure being present. */
export function calcCatExposureRating(crestaRows, deductible, limit, egnpi, catSnap, catLosses, obsYears) {
  if (limit <= 0 || egnpi <= 0) return { rol: 0, totalExposure: 0 };

  if (catSnap?.return_period_key_points) {
    const kp = catSnap.return_period_key_points;
    const rp10 = cn(kp.rp10);
    const rp25 = cn(kp.rp25);
    const rp50 = cn(kp.rp50);
    const rp100 = cn(kp.rp100);
    const rp200 = cn(kp.rp200);
    if (rp10 > 0 || rp50 > 0) {
      const points = [
        { rp: 1, loss: 0 },
        { rp: 5, loss: rp10 > 0 ? rp10 * 0.4 : 0 },
        { rp: 10, loss: rp10 || 0 },
        { rp: 25, loss: rp25 || (rp10 && rp50 ? (rp10 + rp50) / 2 : 0) },
        { rp: 50, loss: rp50 || 0 },
        { rp: 100, loss: rp100 || (rp50 ? rp50 * 1.5 : 0) },
        { rp: 200, loss: rp200 || (rp100 ? rp100 * 1.4 : 0) },
        { rp: 500, loss: rp200 ? rp200 * 1.5 : 0 },
      ].filter((p) => p.loss > 0);
      let aep = 0;
      for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        const f1 = 1 / p1.rp;
        const f2 = 1 / p2.rp;
        const h1 = Math.max(0, Math.min(p1.loss - deductible, limit));
        const h2 = Math.max(0, Math.min(p2.loss - deductible, limit));
        aep += ((f1 - f2) * (h1 + h2)) / 2;
      }
      return {
        rol: limit > 0 ? aep / limit : 0,
        aep,
        prAttach: interpOEP(points, deductible),
        prExhaust: interpOEP(points, deductible + limit),
        method: 'rp_curve',
      };
    }
  }

  if ((catLosses?.length || 0) >= 3) {
    const selected = catLosses.filter((l) => l.is_selected !== false);
    const vals = selected.map((l) => cn(l.inflated_incurred) || cn(l.incurred) + cn(l.os)).filter((v) => v > 0);
    if (vals.length >= 3) {
      const sorted = [...vals].sort((a, b) => a - b);
      const xm = sorted[Math.floor(sorted.length * 0.25)] || sorted[0];
      const { alpha, n } = fitPareto(vals, xm);
      const years = obsYears || Math.max(5, new Set(selected.map((l) => l.uw_year)).size);
      if (alpha > 0) {
        const expLayerLoss = paretoLayerExpectedLoss(alpha, xm, deductible, limit, n, years);
        return {
          rol: limit > 0 ? expLayerLoss / limit : 0,
          alpha, xm, expLayerLoss,
          prAttach: Math.min(1, paretoAttachment(alpha, xm, deductible)),
          prExhaust: Math.min(1, paretoExhaustion(alpha, xm, deductible, limit)),
          method: 'pareto',
        };
      }
    }
  }

  if (crestaRows?.length) {
    const totalExposure = crestaRows.reduce(
      (s, r) => s + cn(r.eq_agg) + cn(r.ws_agg) + cn(r.flood_agg) + cn(r.srcc_agg) + cn(r.others_agg), 0,
    );
    if (totalExposure > 0 && egnpi > 0) {
      const impliedLoss = egnpi * 0.15;
      const rol = limit > 0 ? Math.max(0, Math.min(impliedLoss - deductible, limit)) / (limit * (obsYears || 10)) : 0;
      return { rol, totalExposure, method: 'flat_loss_ratio_fallback' };
    }
  }
  return { rol: 0, method: 'none' };
}

/** Price one peril component of one layer with all three methods. */
export function priceComponent({ deductible, limit, egnpi, losses, savedParams, exposureFn, obsYears, egnpiByYear }) {
  if (limit <= 0 || egnpi <= 0) return null;
  const burnResult = calcPureBurningCost(losses, deductible, limit, egnpi, obsYears, egnpiByYear);
  const paretoResult = calcParetoROL(losses, deductible, limit, egnpi, savedParams);
  const expResult = exposureFn(deductible, limit, egnpi);
  const prAttach = paretoResult.prAttach || expResult.prAttach || 0;
  const prExhaust = paretoResult.prExhaust || expResult.prExhaust || 0;
  return {
    pureBurnRol: burnResult.rol,
    paretoRol: paretoResult.rol,
    exposureRol: expResult.rol,
    prAttach,
    prExhaust,
    coveredLossCount: Array.isArray(losses) ? losses.filter((x) => x && x.is_selected !== false).length : 0,
  };
}
