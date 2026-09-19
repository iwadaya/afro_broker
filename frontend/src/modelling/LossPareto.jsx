import React, { useEffect, useMemo, useState } from 'react';
import { ModScreen, SaveBar, Toggle, Notice, Kpi, KpiRow, NumCell, useSaveMsg, basisLabel } from './bits.jsx';
import { useModelling, useScreenSave, selectedLossesOf } from './store.jsx';
import { cn, fmtC, fmtOrEm, fPct } from './engine.js';
import {
  DISTS, fitAll, fitPareto, paretoQ, lognormalQ, lognormalCDF, expQ, weibullQ,
  calcLayerPrice, calcLayerPriceNumerical, rpAtAttachment,
} from './pricing.js';

/* Loss Pareto — ported from the modelling tool's LossParetoScreen: fit the
   heavy tail of the selected large/cat losses (Pareto, lognormal,
   exponential, Weibull with KS goodness-of-fit), read off the return-period
   curve, and price the treaty's layers against it — an empirical burning
   cost blended with the fitted model by weight. The fitted parameters and
   return-period key points are saved into the loss-selection snapshot, which
   is exactly where the pricing screens look for them. */

const RP_LIST = [500, 250, 200, 100, 50, 25, 20, 10, 5, 2];

export default function LossParetoScreen({ lossType }) {
  const mod = useModelling();
  const { meta, get, save } = mod;
  const snapSection = lossType === 'cat' ? 'loss_selection_cat' : 'loss_selection_large';
  const label = lossType === 'cat' ? 'Cat' : 'Large';

  const losses = useMemo(() => {
    return selectedLossesOf(mod, lossType)
      .map((l) => ({ ...l, inflated: cn(l.inflated_incurred) || cn(l.incurred) * cn(l.inflation_factor || 1) }))
      .filter((l) => l.inflated > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.sections, lossType]);

  const [xm, setXm] = useState(0);
  const [alpha, setAlpha] = useState(0);
  const [yearsOvr, setYearsOvr] = useState('');
  const [activeDist, setActiveDist] = useState('pareto');
  const [wEmp, setWEmp] = useState(50);
  const [wModel, setWModel] = useState(50);
  const [dirty, setDirty] = useState(false);
  const [msg, flash] = useSaveMsg();

  // Hydrate threshold/alpha/years from the snapshot (or seed from the data).
  useEffect(() => {
    const snap = get(snapSection);
    const vals = losses.map((l) => l.inflated).sort((a, b) => a - b);
    if (snap?.pareto_xm > 0) setXm(snap.pareto_xm);
    else if (vals.length) setXm(vals[0]);
    if (snap?.pareto_alpha > 0) setAlpha(snap.pareto_alpha);
    if (snap?.observation_years) setYearsOvr(String(snap.observation_years));
    if (snap?.active_distribution) setActiveDist(snap.active_distribution);
    const bc = snap?.return_period_curve?.layer_burning_cost;
    if (typeof bc?.wEmp === 'number') setWEmp(bc.wEmp);
    if (typeof bc?.wModel === 'number') setWModel(bc.wModel);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.sections, lossType]);

  // Refit α whenever the threshold or data moves.
  useEffect(() => {
    if (!losses.length || xm <= 0) return;
    const fit = fitPareto(losses.map((l) => l.inflated), xm);
    if (fit.alpha > 0) setAlpha(fit.alpha);
  }, [losses, xm]);

  const inflated = losses.map((l) => l.inflated);
  const fits = useMemo(() => fitAll(inflated, xm), [inflated, xm]);
  const bestFit = useMemo(() => [...fits].sort((a, b) => a.ks.ks - b.ks.ks)[0]?.key || 'pareto', [fits]);
  const sorted = useMemo(() => [...losses].sort((a, b) => b.inflated - a.inflated), [losses]);
  const total = sorted.reduce((s, l) => s + l.inflated, 0);
  const uwYrs = Number(yearsOvr) || Math.max(5, new Set(losses.map((l) => l.uw_year)).size) || 10;
  const freq = inflated.filter((l) => l >= xm).length / uwYrs;

  const activeFit = fits.find((f) => f.key === activeDist);
  const qFn = (p) => {
    if (activeDist === 'lognormal' && activeFit) return lognormalQ(p, activeFit.params.mu, activeFit.params.sigma);
    if (activeDist === 'exponential' && activeFit) return expQ(p, activeFit.params.lambda, xm);
    if (activeDist === 'weibull' && activeFit) return weibullQ(p, activeFit.params.k, activeFit.params.lam, xm);
    return alpha > 0 ? paretoQ(p, alpha, xm) : 0;
  };
  const returnPeriods = useMemo(
    () => RP_LIST.map((rp) => ({ rp, loss: (() => { const l = qFn(1 - 1 / rp); return Number.isFinite(l) && l > 0 ? l : 0; })() })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeDist, alpha, xm, fits],
  );

  const survivalFn = useMemo(() => {
    const f = activeFit;
    if (!f) return null;
    if (activeDist === 'pareto') return (v) => (v < xm ? 1 : Math.pow(xm / v, alpha));
    if (activeDist === 'lognormal') return (v) => (v <= 0 ? 1 : 1 - lognormalCDF(v, f.params.mu, f.params.sigma));
    if (activeDist === 'exponential') return (v) => (v < xm ? 1 : Math.exp(-f.params.lambda * (v - xm)));
    if (activeDist === 'weibull') return (v) => (v < xm ? 1 : Math.exp(-Math.pow((v - xm) / f.params.lam, f.params.k)));
    return null;
  }, [activeDist, activeFit, alpha, xm]);

  // The treaty layers this peril covers (NP structure rows).
  const structureLayers = useMemo(() => (meta.layers || []).filter((l) => (lossType === 'cat' ? l.cat !== false : l.risk !== false)), [meta.layers, lossType]);

  const layerRols = useMemo(() => {
    if (!structureLayers.length) return [];
    const byYear = new Map();
    for (const l of losses) {
      const yr = String(l.uw_year ?? '');
      if (!yr) continue;
      if (!byYear.has(yr)) byYear.set(yr, []);
      byYear.get(yr).push(l.inflated);
    }
    return structureLayers.map((sl, i) => {
      const D = cn(sl.attachment);
      const L = cn(sl.limit);
      const name = sl.name || `Layer ${i + 1}`;
      if (!(L > 0)) return { idx: i, layer: name, D, L, empiricalRol: 0, modelRol: 0, blendedRol: 0, blendedAnnual: 0, rp: null };
      let totalInLayer = 0;
      for (const yearLosses of byYear.values()) for (const inc of yearLosses) totalInLayer += Math.max(0, Math.min(inc - D, L));
      const empAnnual = uwYrs > 0 ? totalInLayer / uwYrs : 0;
      let modelAnnual = 0;
      let error = null;
      if (survivalFn) {
        if (activeDist === 'pareto') {
          const r = calcLayerPrice(alpha, xm, freq, D, L);
          modelAnnual = r.rpp;
          error = r.error || null;
        } else {
          modelAnnual = calcLayerPriceNumerical(freq, D, L, survivalFn).rpp;
        }
      }
      const wTot = Math.max(0, wEmp) + Math.max(0, wModel);
      const blendedAnnual = wTot <= 0 ? 0 : (Math.max(0, wEmp) * empAnnual + Math.max(0, wModel) * modelAnnual) / wTot;
      return {
        idx: i, layer: name, D, L,
        empiricalRol: L > 0 ? empAnnual / L : 0,
        modelRol: L > 0 ? modelAnnual / L : 0,
        blendedRol: L > 0 ? blendedAnnual / L : 0,
        blendedAnnual,
        rp: survivalFn ? rpAtAttachment(freq, D, survivalFn) : null,
        error,
      };
    });
  }, [structureLayers, losses, uwYrs, survivalFn, activeDist, alpha, xm, freq, wEmp, wModel]);

  const pareto = useMemo(() => {
    let c = 0;
    return sorted.map((l, i) => { c += l.inflated; return { ...l, rank: i + 1, cum: c, cumPct: total > 0 ? c / total : 0 }; });
  }, [sorted, total]);

  const doSave = async () => {
    if (!losses.length || xm <= 0) return true;
    try {
      const pts = returnPeriods.map((p) => ({ rp: p.rp, loss: p.loss }));
      const at = (rp) => pts.find((p) => p.rp === rp)?.loss ?? null;
      const prev = get(snapSection) || {};
      await save(snapSection, {
        ...prev,
        selected_count: losses.length,
        pareto_xm: xm,
        pareto_alpha: alpha,
        observation_years: uwYrs,
        active_distribution: activeDist,
        distribution_fits: fits.map((f) => ({ key: f.key, params: f.params, ks: f.ks, paramStr: f.paramStr, n: f.n })),
        return_period_curve: {
          activeDist, xm, yearsOvr: yearsOvr || null, points: pts,
          layer_burning_cost: {
            wEmp, wModel,
            rows: layerRols.map((r) => ({
              layer: r.layer, deductible: r.D, limit: r.L, return_period: r.rp,
              empirical_rol: r.empiricalRol, model_rol: r.modelRol,
              blended_rol: r.blendedRol, blended_annual_loss: r.blendedAnnual,
            })),
          },
        },
        return_period_key_points: { rp10: at(10), rp25: at(25), rp50: at(50), rp100: at(100), rp200: at(200), rp250: at(250) },
      });
      setDirty(false);
      flash('ok', 'Curve saved');
      return true;
    } catch (e) {
      flash('err', `Save failed: ${e.message || 'server error'}`);
      return false;
    }
  };
  useScreenSave(mod, doSave);

  const avg = losses.length ? total / losses.length : 0;
  const t5 = pareto.length >= 5 ? pareto[4].cumPct : pareto.length ? pareto[pareto.length - 1].cumPct : 0;

  // Exceedance curve as an inline SVG — loss (x, log-ish by rank) vs survival.
  const curvePts = useMemo(() => {
    if (!(alpha > 0) || !(xm > 0) || !survivalFn) return '';
    const maxLoss = Math.max(qFn(1 - 1 / 500) || 0, ...inflated, xm * 2);
    if (!(maxLoss > xm)) return '';
    const pts = [];
    for (let i = 0; i <= 100; i++) {
      const x = xm + ((maxLoss - xm) * i) / 100;
      const s = Math.max(0, Math.min(1, survivalFn(x)));
      pts.push(`${40 + (i / 100) * 270},${180 - s * 160}`);
    }
    return pts.join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [survivalFn, xm, alpha, inflated]);

  return (
    <ModScreen pill={`${basisLabel(meta)} TREATY: ${label.toUpperCase()} LOSS PARETO`}
      title={`${label} Loss Pareto`}
      sub="Fit the tail of the selected losses, read the return-period curve, and price the layers against it. Saving stores the fitted parameters where the pricing screens read them."
      actions={<SaveBar dirty={dirty} msg={msg} onSave={doSave} canEdit={meta.canEdit} />}>

      {losses.length === 0 && <Notice tone="info">No selected losses — complete the {label} Loss List and Selection screens first.</Notice>}

      <KpiRow>
        <Kpi label="Losses" value={losses.length} />
        <Kpi label="Total (Inflated)" value={fmtOrEm(total)} />
        <Kpi label="Average" value={fmtOrEm(avg)} />
        <Kpi label="Top 5 Share" value={fPct(t5)} title="Cumulative share of the five largest losses" />
        <Kpi label="α (Pareto)" value={alpha > 0 ? alpha.toFixed(3) : '—'} tone="green" />
        <Kpi label="Frequency ≥ threshold" value={freq > 0 ? `${freq.toFixed(2)}/yr` : '—'} tone="blue" />
      </KpiRow>

      <div className="tri-info-bar">
        <div className="tri-info-item">Threshold (xm){' '}
          <NumCell value={String(xm || '')} readOnly={!meta.canEdit} className="mod-cell--w120"
            onChange={(v) => { setXm(cn(v)); setDirty(true); }} />
        </div>
        <div className="tri-info-item">Observation Years{' '}
          <NumCell value={yearsOvr} readOnly={!meta.canEdit} align="center" className="mod-cell--w90" placeholder={String(uwYrs)}
            onChange={(v) => { setYearsOvr(v); setDirty(true); }} />
        </div>
        <div className="tri-info-item">Distribution
          <Toggle value={activeDist} disabled={!meta.canEdit}
            options={DISTS.map((d) => [d.key, d.key === bestFit ? `${d.label} ★` : d.label])}
            onChange={(v) => { setActiveDist(v); setDirty(true); }} />
        </div>
      </div>
      <Notice tone="info">★ marks the best Kolmogorov–Smirnov fit. The active distribution drives the return periods, the survival curve and the model leg of the layer pricing.</Notice>

      <div className="mod-two-col">
        <section className="np-struct-card">
          <div className="np-struct-card-header">
            <div><div className="np-struct-card-h2">Distribution Fits</div>
              <div className="np-struct-card-hint">Fitted above the threshold; smaller KS = closer fit.</div></div>
          </div>
          <table className="mod-table mod-table--compact">
            <thead><tr><th>DISTRIBUTION</th><th className="mod-num">PARAMETERS</th><th className="mod-num">N</th><th className="mod-num">KS</th><th className="mod-num">P-VALUE</th></tr></thead>
            <tbody>
              {fits.map((f) => (
                <tr key={f.key} className={f.key === activeDist ? 'is-active-row' : ''}>
                  <td>{DISTS.find((d) => d.key === f.key)?.label}{f.key === bestFit ? ' ★' : ''}</td>
                  <td className="mod-num">{f.paramStr}</td>
                  <td className="mod-num">{f.n}</td>
                  <td className="mod-num">{f.ks.ks.toFixed(4)}</td>
                  <td className="mod-num">{f.ks.pValue.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mod-svg-card">
            <div className="np-struct-card-hint" style={{ marginBottom: 4 }}>Survival curve P(X &gt; x) — {DISTS.find((d) => d.key === activeDist)?.label}</div>
            <svg width="100%" viewBox="0 0 320 200" preserveAspectRatio="xMidYMid meet">
              {[0.25, 0.5, 0.75].map((v) => (
                <line key={v} x1={40} y1={180 - v * 160} x2={310} y2={180 - v * 160} stroke="var(--hairline)" />
              ))}
              <line x1="40" y1="180" x2="310" y2="180" stroke="var(--hairline-strong)" />
              <line x1="40" y1="20" x2="40" y2="180" stroke="var(--hairline-strong)" />
              <text x="36" y="184" textAnchor="end" fill="var(--muted)" fontSize="9">0</text>
              <text x="36" y="24" textAnchor="end" fill="var(--muted)" fontSize="9">1</text>
              {curvePts && <polyline points={curvePts} fill="none" stroke="var(--accent)" strokeWidth="2" />}
            </svg>
          </div>
        </section>

        <section className="np-struct-card">
          <div className="np-struct-card-header">
            <div><div className="np-struct-card-h2">Return Periods</div>
              <div className="np-struct-card-hint">The 1-in-N-year loss implied by the active fit.</div></div>
          </div>
          <table className="mod-table mod-table--compact">
            <thead><tr><th>RETURN PERIOD</th><th className="mod-num">LOSS</th></tr></thead>
            <tbody>
              {returnPeriods.map((p) => (
                <tr key={p.rp}>
                  <td>1-in-{p.rp}</td>
                  <td className="mod-num">{p.loss > 0 ? fmtC(Math.round(p.loss)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="np-struct-card">
        <div className="np-struct-card-header">
          <div>
            <div className="np-struct-card-h2">Layer Pricing — Empirical × Model Blend</div>
            <div className="np-struct-card-hint">
              The treaty's {lossType === 'cat' ? 'cat' : 'risk'} layers priced two ways — the historical burning cost and the fitted severity model — blended by weight.
            </div>
          </div>
          <div className="tri-info-item">
            Weights: Empirical{' '}
            <NumCell value={String(wEmp)} readOnly={!meta.canEdit} align="center" className="mod-cell--w60"
              onChange={(v) => { setWEmp(cn(v)); setDirty(true); }} />
            Model{' '}
            <NumCell value={String(wModel)} readOnly={!meta.canEdit} align="center" className="mod-cell--w60"
              onChange={(v) => { setWModel(cn(v)); setDirty(true); }} />
          </div>
        </div>
        {structureLayers.length === 0 ? (
          <div className="muted" style={{ fontSize: '.85rem' }}>
            No {lossType === 'cat' ? 'cat' : 'risk'} layers on the structure — add layers on the Structure tab to price them here.
          </div>
        ) : (
          <div className="np-table-wrap">
            <table className="mod-table mod-table--compact">
              <thead><tr><th>LAYER</th><th className="mod-num">LIMIT</th><th className="mod-num">ATTACHMENT</th><th className="mod-num">RP AT ATTACH</th><th className="mod-num">EMPIRICAL ROL</th><th className="mod-num">MODEL ROL</th><th className="mod-num">BLENDED ROL</th><th className="mod-num">BLENDED ANNUAL LOSS</th></tr></thead>
              <tbody>
                {layerRols.map((r) => (
                  <tr key={r.idx}>
                    <td>{r.layer}</td>
                    <td className="mod-num">{fmtOrEm(r.L)}</td>
                    <td className="mod-num">{fmtOrEm(r.D)}</td>
                    <td className="mod-num">{r.rp ? `1-in-${r.rp.toFixed(1)}` : '—'}</td>
                    <td className="mod-num">{fPct(r.empiricalRol, 2)}</td>
                    <td className="mod-num">{r.error ? r.error : fPct(r.modelRol, 2)}</td>
                    <td className="mod-num"><b>{fPct(r.blendedRol, 2)}</b></td>
                    <td className="mod-num">{fmtOrEm(Math.round(r.blendedAnnual))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="np-struct-card">
        <div className="np-struct-card-header">
          <div><div className="np-struct-card-h2">Pareto Ranking</div>
            <div className="np-struct-card-hint">Selected losses largest-first with the cumulative share.</div></div>
        </div>
        <div className="np-table-wrap">
          <table className="mod-table mod-table--compact">
            <thead><tr><th className="mod-num">#</th><th className="mod-num">YEAR</th><th>INSURED / EVENT</th><th className="mod-num">INFLATED</th><th className="mod-num">CUMULATIVE</th><th className="mod-num">CUM %</th></tr></thead>
            <tbody>
              {pareto.map((l) => (
                <tr key={l.rank}>
                  <td className="mod-num">{l.rank}</td>
                  <td className="mod-num">{l.uw_year || '—'}</td>
                  <td>{l.insured_name || l.loss_name || '—'}</td>
                  <td className="mod-num">{fmtOrEm(l.inflated)}</td>
                  <td className="mod-num">{fmtOrEm(l.cum)}</td>
                  <td className="mod-num">{fPct(l.cumPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </ModScreen>
  );
}
