import { buildMatrixFromCells, calculateAgeToAgeFactors, calculatePattern, calculateCdfs, cn, projectStraightStats, DEFAULT_LDF_KEY } from './engine.js';
import { triangleCellsOf, savedCdfsOf, lossCategoryByYear } from './store.jsx';

/* The projection pipeline — ported from the modelling tool's
   projectWithSavedFactors, reading the placement's modelling sections
   instead of per-entity endpoints. Priority is preserved: the underwriter's
   SAVED dev factors project the triangles; with none saved the pattern is
   recalculated weighted from the raw triangle; with no triangles at all the
   straight stats (no-triangulation) screen projects on its benchmark curve.
   Large/CAT handling follows the tool: when stripping is on, straight-stats
   ultimates develop only the attritional part and add the large/CAT amounts
   back unprojected. */

function crd(cells) {
  return (cells || []).map((r) => ({
    origin_year: Number(r.origin_year),
    dev_months: Number(r.dev_months),
    cum_value: r.cum_value == null || r.cum_value === '' ? null : cn(r.cum_value),
  }));
}

function projectWithCdfs(matrix, years, cdfs) {
  return years.map((yr, r) => {
    let latestVal = 0;
    let latestCol = -1;
    for (let c = (matrix[r]?.length || 0) - 1; c >= 0; c--) {
      if (matrix[r][c] != null) { latestVal = matrix[r][c]; latestCol = c; break; }
    }
    if (latestCol === -1) return { year: yr, latest: 0, cdf: 1, ultimate: 0, ibnr: 0 };
    const cdf = (latestCol < cdfs.length ? cdfs[latestCol] : 1.0) || 1.0;
    const ultimate = latestVal * cdf;
    return { year: yr, latest: latestVal, cdf, ultimate, ibnr: ultimate - latestVal };
  });
}

function latestPerYear(matrix, years) {
  return years.map((yr, r) => {
    let latest = 0;
    for (let c = (matrix[r]?.length || 0) - 1; c >= 0; c--) {
      if (matrix[r][c] != null) { latest = matrix[r][c]; break; }
    }
    return { year: yr, latest };
  });
}

function recalcCdfs(matrix) {
  const factors = calculateAgeToAgeFactors(matrix);
  const { pattern } = calculatePattern(matrix, factors, 'weighted');
  return calculateCdfs(pattern, 1.0);
}

/**
 * Standard rows for the summaries and pricing:
 * [{year, ultPrem, ultLoss, ultPaid, actPrem, actLoss, actPaid}], plus which
 * source produced them and whether placeholder benchmark LDFs were used.
 */
export function projectedRowsFromStore(mod) {
  const premCells = crd(triangleCellsOf(mod, 'premium', 'MODIFIED'));
  const paidCells = crd(triangleCellsOf(mod, 'paid', 'MODIFIED'));
  const osCells = crd(triangleCellsOf(mod, 'os', 'MODIFIED'));

  const po = buildMatrixFromCells(premCells);
  const pdo = buildMatrixFromCells(paidCells);
  const oso = buildMatrixFromCells(osCells);

  if (po || pdo || oso) {
    const allYears = new Set([...(po?.years || []), ...(pdo?.years || []), ...(oso?.years || [])]);
    const yrs = Array.from(allYears).sort((a, b) => a - b);
    let mc = 0;
    [po, pdo, oso].filter(Boolean).forEach((o) => (o.matrix || []).forEach((r) => { mc = Math.max(mc, r.length); }));
    if (!mc) mc = 1;

    const gv = (o, y, c) => {
      if (!o) return null;
      const i = o.years.indexOf(y);
      return i === -1 ? null : o.matrix[i]?.[c] ?? null;
    };
    const im = yrs.map((y) => {
      const r = [];
      for (let c = 0; c < mc; c++) {
        const p = gv(pdo, y, c);
        const o = gv(oso, y, c);
        r.push(p === null && o === null ? null : (p || 0) + (o || 0));
      }
      return r;
    });
    const pm = yrs.map((y) => {
      const r = [];
      for (let c = 0; c < mc; c++) r.push(gv(po, y, c));
      return r;
    });
    const paidM = yrs.map((y) => {
      const r = [];
      for (let c = 0; c < mc; c++) r.push(gv(pdo, y, c));
      return r;
    });

    const savedIncCdfs = savedCdfsOf(mod, 'incurred') || savedCdfsOf(mod, 'paid');
    const savedPaidCdfs = savedCdfsOf(mod, 'paid');
    const savedPremCdfs = savedCdfsOf(mod, 'premium');

    let source = 'triangle-recalc';
    let attrProj = [];
    if (savedIncCdfs) {
      attrProj = projectWithCdfs(im, yrs, savedIncCdfs);
      source = 'saved-factors';
    } else {
      try { attrProj = projectWithCdfs(im, yrs, recalcCdfs(im)); } catch { attrProj = []; }
    }

    let paidProj = [];
    if (savedPaidCdfs) paidProj = projectWithCdfs(paidM, yrs, savedPaidCdfs);
    else { try { paidProj = projectWithCdfs(paidM, yrs, recalcCdfs(paidM)); } catch { paidProj = []; } }

    let premProj = [];
    if (savedPremCdfs) {
      premProj = projectWithCdfs(pm, yrs, savedPremCdfs);
      source = 'saved-factors';
    } else {
      try { premProj = projectWithCdfs(pm, yrs, recalcCdfs(pm)); } catch { premProj = []; }
    }

    const fullLatest = latestPerYear(im, yrs);
    const rows = yrs.map((y) => {
      const pP = premProj.find((p) => p.year === y);
      const aP = attrProj.find((p) => p.year === y);
      const dP = paidProj.find((p) => p.year === y);
      const fl = fullLatest.find((p) => p.year === y);
      return {
        year: y,
        ultPrem: pP?.ultimate || 0,
        ultLoss: aP?.ultimate || 0,
        ultPaid: dP?.ultimate || 0,
        actPrem: pP?.latest || 0,
        actLoss: fl?.latest || 0,
        actPaid: dP?.latest || 0,
      };
    });
    if (rows.length > 0) return { rows, source, usedPlaceholderLdfs: false };
  }

  // Fallback: straight stats on the benchmark curve.
  const ss = mod.get('straight_stats');
  const stats = ss?.stats || [];
  const parsed = stats
    .map((s) => ({ year: Number(s.year), premium: cn(s.premium), paid: cn(s.paid), os: cn(s.os) }))
    .filter((s) => s.premium || s.paid || s.os);
  if (!parsed.length) return { rows: [], source: null, usedPlaceholderLdfs: false };

  const stripLC = ss?.strip_large_cat !== false;
  const lossCat = stripLC ? lossCategoryByYear(mod) : null;
  let rows = projectStraightStats(parsed, ss?.class_key || DEFAULT_LDF_KEY);
  if (stripLC && lossCat) {
    rows = rows.map((r) => {
      const large = lossCat.large.get(Number(r.year)) || 0;
      const cat = lossCat.cat.get(Number(r.year)) || 0;
      if (large + cat <= 0) return r;
      const incurred = r.actLoss || 0;
      const cdf = Number.isFinite(r.devFactor) && r.devFactor > 0 ? r.devFactor : incurred > 0 ? (r.ultLoss || 0) / incurred : 1;
      const ultAttritional = Math.max(0, incurred - large - cat) * cdf;
      return { ...r, ultLoss: ultAttritional + large + cat };
    });
  }
  rows = rows.map((r) => ({ ...r, ultPaid: null, actPaid: null }));
  return { rows, source: 'straight-benchmark', usedPlaceholderLdfs: true };
}

export function sourceLabelOf(source) {
  return source === 'saved-factors' ? 'Using saved underwriter dev factors'
    : source === 'triangle-recalc' ? 'Recalculated from triangle (no saved factors)'
      : source === 'straight-benchmark' ? 'Straight stats on benchmark portfolio factors'
        : '';
}
