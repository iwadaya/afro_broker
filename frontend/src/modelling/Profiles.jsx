import React, { useEffect, useMemo, useState } from 'react';
import { ModScreen, SaveBar, Notice, Kpi, KpiRow, NumCell, useSaveMsg, pasteGrid, pasteNum, basisLabel } from './bits.jsx';
import { useModelling, useScreenSave } from './store.jsx';
import { cn, fmtOrEm, fPts, sanitizeNumber } from './engine.js';
import { SWISS_RE_CURVES, SWISS_RE_C, mbbefdG } from './pricing.js';

/* Risk / Claims profile — ported from the modelling tool's ProfileScreen: the
   per-class sum-insured band grid (paste-aware) shared by PROP and NP, plus
   the risk-only Swiss Re MBBEFD exposure-rating panel: severity C, PML,
   curve concentration, gross loss ratio, the curve-implied reconciliation
   and the hand-rolled G(d) chart. Bands and parameters are stored per class
   of business under one section. */

const emptyBand = () => ({ min: '', max: '', policies: '', sumInsured: '', premiums: '', claimsPaid: '' });
const bandHasData = (b) => cn(b.min) !== 0 || cn(b.max) !== 0 || cn(b.policies) !== 0 || cn(b.sumInsured) !== 0 || cn(b.premiums) !== 0 || cn(b.claimsPaid) !== 0;
const autoCurveForBandUI = (avgSI) => (avgSI <= 400_000 ? 'Y1' : avgSI <= 1_000_000 ? 'Y2' : avgSI <= 2_000_000 ? 'Y3' : 'Y4');

export default function ProfileScreen({ profileType }) {
  const mod = useModelling();
  const { meta, get, save } = mod;
  const isClaims = profileType === 'claims';
  const section = isClaims ? 'claims_profile' : 'risk_profile';
  const cobs = meta.cobs.length ? meta.cobs : ['All classes'];

  const cols = isClaims
    ? ['min', 'max', 'policies', 'sumInsured', 'premiums', 'claimsPaid']
    : ['min', 'max', 'policies', 'sumInsured', 'premiums'];
  const labels = isClaims
    ? ['MIN SUM INSURED', 'MAX SUM INSURED', 'COUNT', 'TOTAL SUM INSURED', 'PREMIUM', 'INCURRED CLAIMS']
    : ['MIN SUM INSURED', 'MAX SUM INSURED', 'POLICIES', 'SUM INSURED', 'PREMIUMS'];

  // The class shown: the screen's shared class pills pick it on a
  // multi-class treaty; a single class (or none) keys the data as before.
  const activeCob = mod.multiCob && cobs.includes(mod.activeCob) ? mod.activeCob : cobs[0];
  const [bands, setBands] = useState(Array.from({ length: 7 }, emptyBand));
  const [exp, setExp] = useState({ cValue: '', pmlPct: '100', selectedCurve: 'Y3', customB: '', grossLossRatio: '100' });
  const [showExposure, setShowExposure] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [msg, flash] = useSaveMsg();

  // Hydrate the active class's bands + exposure parameters.
  useEffect(() => {
    const data = get(section)?.[activeCob];
    if (data?.bands?.length) {
      setBands(data.bands.map((x) => ({
        min: x.from_amt != null ? String(x.from_amt) : '',
        max: x.to_amt != null ? String(x.to_amt) : '',
        policies: x.no_of_risks != null ? String(x.no_of_risks) : (x.no_of_claims != null ? String(x.no_of_claims) : ''),
        sumInsured: x.total_sum_insured != null ? String(x.total_sum_insured) : '',
        premiums: x.gross_premium != null ? String(x.gross_premium) : '',
        claimsPaid: x.aggregate_incurred != null ? String(x.aggregate_incurred) : '',
      })));
    } else {
      setBands(Array.from({ length: 7 }, emptyBand));
    }
    setExp({
      cValue: data?.c_value != null && data.c_value !== 0 ? String(data.c_value) : '',
      pmlPct: data?.pml_percentage != null && data.pml_percentage !== 0 ? String(data.pml_percentage) : '100',
      selectedCurve: data?.selected_curve || 'Y3',
      customB: data?.custom_b != null ? String(data.custom_b) : '',
      grossLossRatio: data?.gross_loss_ratio != null && data.gross_loss_ratio !== 0 ? String(data.gross_loss_ratio) : '100',
    });
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.sections, activeCob, profileType]);

  const totals = useMemo(() => ({
    policies: bands.reduce((s, b) => s + cn(b.policies), 0),
    sumInsured: bands.reduce((s, b) => s + cn(b.sumInsured), 0),
    premiums: bands.reduce((s, b) => s + cn(b.premiums), 0),
    claimsPaid: bands.reduce((s, b) => s + cn(b.claimsPaid), 0),
  }), [bands]);
  const totalRate = totals.sumInsured > 0 ? (totals.premiums / totals.sumInsured) * 100 : 0;
  const totalLR = totals.premiums > 0 ? (totals.claimsPaid / totals.premiums) * 100 : 0;

  const curveC = exp.selectedCurve === 'Custom' ? cn(exp.customB) : (SWISS_RE_C[exp.selectedCurve] ?? 3.0);
  const bandExposure = useMemo(() => {
    const pml = cn(exp.pmlPct);
    return bands.filter(bandHasData).map((band) => {
      const si = cn(band.sumInsured);
      const maxBand = cn(band.max);
      const bandPML = si * (pml / 100);
      if (bandPML <= 0) return { expLoss: 0 };
      const d = Math.min(maxBand / bandPML, 1);
      return { expLoss: bandPML * mbbefdG(d, curveC) };
    });
  }, [bands, exp.pmlPct, curveC]);
  const totalExpLoss = bandExposure.reduce((s, b) => s + (b.expLoss || 0), 0);
  const overallExpRate = totals.sumInsured > 0 ? (totalExpLoss / totals.sumInsured) * 100 : 0;
  const curveImpliedC = totals.sumInsured > 0 ? totalExpLoss / totals.sumInsured : 0;
  const cVal = cn(exp.cValue);
  const alignment = cVal > 0 && curveImpliedC > 0
    ? (() => {
      const diff = Math.abs(cVal - curveImpliedC) / curveImpliedC;
      return { level: diff < 0.1 ? 'ok' : diff < 0.25 ? 'warn' : 'err', diffPct: diff * 100 };
    })()
    : null;

  const curvePolyline = useMemo(() => {
    const pts = [];
    for (let i = 0; i <= 100; i++) {
      const d = i / 100;
      pts.push(`${40 + d * 270},${180 - mbbefdG(d, curveC) * 160}`);
    }
    return pts.join(' ');
  }, [curveC]);

  const updateBand = (idx, field, val) => {
    setBands((prev) => prev.map((b, i) => (i === idx ? { ...b, [field]: val } : b)));
    setDirty(true);
  };

  const handleCellPaste = (e, startRow, startColKey) => {
    const rows = pasteGrid(e);
    if (!rows || (rows.length <= 1 && rows[0]?.length <= 1)) return;
    e.preventDefault();
    const colStart = cols.indexOf(startColKey);
    if (colStart < 0) return;
    setBands((prev) => {
      const next = [...prev.map((r) => ({ ...r }))];
      while (next.length < startRow + rows.length) next.push(emptyBand());
      rows.forEach((pr, rOff) => {
        pr.forEach((val, cOff) => {
          const ci = colStart + cOff;
          if (ci < cols.length) next[startRow + rOff][cols[ci]] = pasteNum(val);
        });
      });
      return next;
    });
    setDirty(true);
  };

  const persist = async (cobName, bandsState, expState) => {
    const nonEmpty = bandsState.filter(bandHasData);
    const bandPayload = nonEmpty.map((b) => (isClaims
      ? { from_amt: cn(b.min), to_amt: cn(b.max), no_of_claims: cn(b.policies), total_sum_insured: cn(b.sumInsured), aggregate_incurred: cn(b.claimsPaid), gross_premium: cn(b.premiums) }
      : { from_amt: cn(b.min), to_amt: cn(b.max), no_of_risks: cn(b.policies), total_sum_insured: cn(b.sumInsured), gross_premium: cn(b.premiums) }));
    const prev = get(section) || {};
    await save(section, {
      ...prev,
      [cobName]: {
        bands: bandPayload,
        ...(isClaims ? {} : {
          c_value: cn(expState.cValue) || null,
          pml_percentage: cn(expState.pmlPct) || 100,
          selected_curve: expState.selectedCurve || null,
          custom_b: cn(expState.customB) || null,
          gross_loss_ratio: cn(expState.grossLossRatio) || 100,
        }),
      },
    });
  };

  const doSave = async () => {
    if (!dirty) return true;
    try {
      await persist(activeCob, bands, exp);
      setDirty(false);
      flash('ok', 'Profile saved');
      return true;
    } catch (e) {
      flash('err', `Save failed: ${e.message || 'server error'}`);
      return false;
    }
  };
  useScreenSave(mod, doSave);

  return (
    <ModScreen pill={`${basisLabel(meta)} TREATY: ${isClaims ? 'CLAIMS' : 'RISK'} PROFILE`}
      title={isClaims ? 'Claims Profile' : 'Risk Profile'}
      sub={isClaims
        ? 'Incurred claims by sum-insured band, per class of business.'
        : 'The cedant’s risk profile by sum-insured band, per class of business — feeds the MBBEFD exposure rating.'}
      actions={<SaveBar dirty={dirty} msg={msg} onSave={doSave} canEdit={meta.canEdit} />}>

      <KpiRow>
        <Kpi label={isClaims ? 'Total Claims' : 'Total Policies'} value={fmtOrEm(totals.policies)} />
        <Kpi label="Total Sum Insured" value={fmtOrEm(totals.sumInsured)} />
        <Kpi label="Total Premium" value={fmtOrEm(totals.premiums)} />
        {isClaims && <Kpi label="Total Incurred" value={fmtOrEm(totals.claimsPaid)} />}
        {isClaims
          ? <Kpi label="Loss Ratio" value={totalLR > 0 ? fPts(totalLR) : '—'} tone={totalLR > 100 ? 'red' : totalLR > 70 ? 'amber' : 'green'} />
          : <Kpi label="Avg SI / Policy" value={totals.policies > 0 ? fmtOrEm(Math.round(totals.sumInsured / totals.policies)) : '—'} />}
        <Kpi label="Rate ‰" value={totals.sumInsured > 0 ? `${((totals.premiums / totals.sumInsured) * 1000).toFixed(3)}‰` : '—'} />
      </KpiRow>

      <div className="np-table-wrap">
        <table className="mod-table">
          <thead>
            <tr>
              {labels.map((l) => <th key={l} className="mod-num">{l}</th>)}
              <th className="mod-num">{isClaims ? 'LOSS RATIO' : 'RATE %'}</th>
              {isClaims && <th className="mod-num">RATE %</th>}
              {meta.canEdit && <th style={{ width: 34 }} />}
            </tr>
          </thead>
          <tbody>
            {bands.map((b, i) => {
              const si = cn(b.sumInsured);
              const pr = cn(b.premiums);
              const cp = cn(b.claimsPaid);
              const rate = si > 0 ? (pr / si) * 100 : 0;
              const lr = pr > 0 ? (cp / pr) * 100 : 0;
              return (
                <tr key={i}>
                  {cols.map((f) => (
                    <td key={f}>
                      <NumCell value={b[f]} readOnly={!meta.canEdit}
                        onChange={(v) => updateBand(i, f, v)}
                        onPaste={(e) => handleCellPaste(e, i, f)} />
                    </td>
                  ))}
                  {isClaims && (
                    <td className="mod-num" style={{ color: lr > 100 ? 'var(--accent-rose)' : lr > 70 ? 'var(--accent-amber)' : 'var(--accent2)' }}>
                      {lr > 0 ? fPts(lr) : '—'}
                    </td>
                  )}
                  <td className="mod-num">{rate > 0 ? `${rate.toFixed(3)}%` : '—'}</td>
                  {meta.canEdit && (
                    <td>
                      <button type="button" className="renew-x" aria-label="Remove band"
                        onClick={() => { setBands((prev) => prev.filter((_, j) => j !== i)); setDirty(true); }}>✕</button>
                    </td>
                  )}
                </tr>
              );
            })}
            <tr className="mod-total-row">
              <td colSpan={2}><b>Total</b></td>
              <td className="mod-num"><b>{fmtOrEm(totals.policies)}</b></td>
              <td className="mod-num"><b>{fmtOrEm(totals.sumInsured)}</b></td>
              <td className="mod-num"><b>{fmtOrEm(totals.premiums)}</b></td>
              {isClaims && <td className="mod-num"><b>{fmtOrEm(totals.claimsPaid)}</b></td>}
              <td className="mod-num"><b>{isClaims ? (totalLR > 0 ? fPts(totalLR) : '—') : (totalRate > 0 ? `${totalRate.toFixed(3)}%` : '—')}</b></td>
              {isClaims && <td className="mod-num"><b>{totalRate > 0 ? `${totalRate.toFixed(3)}%` : '—'}</b></td>}
              {meta.canEdit && <td />}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ fontSize: '.8rem', marginTop: 4 }}>
        Paste from Excel to fill bands ({isClaims ? '6 columns: min, max, count, total sum insured, premium, incurred claims' : '5 columns: min, max, policies, sum insured, premiums'}).
        {meta.canEdit && (
          <>
            {' '}
            <button type="button" className="np-struct-btn" onClick={() => { setBands((p) => [...p, emptyBand()]); }}>＋ Add band</button>
            {' '}
            <button type="button" className="np-struct-btn" onClick={() => { setBands((p) => [...p].sort((a, b) => cn(a.min) - cn(b.min))); setDirty(true); }}>Sort ↑</button>
          </>
        )}
      </div>

      {!isClaims && (
        <section className="np-struct-card" style={{ marginTop: 14 }}>
          <div className="np-struct-card-header">
            <div>
              <div className="np-struct-card-h2">Exposure Rating — Swiss Re MBBEFD</div>
              <div className="np-struct-card-hint">
                Severity rate (C) = expected loss ÷ SI (audit benchmark); curve concentration (c) shapes the
                destruction-ratio curve (Y1=0, Y2=1.5, Y3=3, Y4=5); gross loss ratio converts gross XL loss to risk premium.
              </div>
            </div>
            <button type="button" className="np-struct-btn" onClick={() => setShowExposure((v) => !v)}>
              {showExposure ? '▼ Hide' : '▶ Show'} exposure rating
            </button>
          </div>
          {showExposure && (
            <>
              <div className="mod-exp-params">
                <label>Severity Rate (C)
                  <input className="mod-cell mod-cell--center" placeholder="e.g. 0.035" value={exp.cValue} readOnly={!meta.canEdit}
                    onChange={(e) => { setExp((s) => ({ ...s, cValue: sanitizeNumber(e.target.value) || e.target.value })); setDirty(true); }} />
                </label>
                <label>PML Factor %
                  <input className="mod-cell mod-cell--center" placeholder="100" value={exp.pmlPct} readOnly={!meta.canEdit}
                    onChange={(e) => { setExp((s) => ({ ...s, pmlPct: e.target.value })); setDirty(true); }} />
                </label>
                <label>Curve
                  <select className="mod-cell mod-cell--left" value={exp.selectedCurve} disabled={!meta.canEdit}
                    onChange={(e) => { setExp((s) => ({ ...s, selectedCurve: e.target.value })); setDirty(true); }}>
                    {SWISS_RE_CURVES.map((c) => <option key={c.name} value={c.name.split(' ')[0]}>{c.name} — {c.desc}</option>)}
                    <option value="Custom">Custom (c)</option>
                  </select>
                </label>
                {exp.selectedCurve === 'Custom' && (
                  <label>c (concentration)
                    <input className="mod-cell mod-cell--center" placeholder="e.g. 3.0" value={exp.customB} readOnly={!meta.canEdit}
                      onChange={(e) => { setExp((s) => ({ ...s, customB: e.target.value })); setDirty(true); }} />
                  </label>
                )}
                <label>Gross Loss Ratio %
                  <input className="mod-cell mod-cell--center" placeholder="100" value={exp.grossLossRatio} readOnly={!meta.canEdit}
                    onChange={(e) => { setExp((s) => ({ ...s, grossLossRatio: e.target.value })); setDirty(true); }} />
                </label>
              </div>

              {(alignment || curveImpliedC > 0) && (
                <Notice tone={alignment?.level === 'err' ? 'warn' : 'info'}>
                  <b>Reconciliation.</b> Entered C <b>{cVal > 0 ? cVal.toFixed(4) : '—'}</b> vs curve-implied severity{' '}
                  <b>{curveImpliedC > 0 ? curveImpliedC.toFixed(4) : '—'}</b>
                  {alignment && <> — Δ {alignment.diffPct.toFixed(1)}% {alignment.level === 'ok' ? '(aligned)' : alignment.level === 'warn' ? '(review)' : '(misaligned — change the curve, revise C, or document why)'}</>}
                  {curveImpliedC > 0 && meta.canEdit && (
                    <>
                      {' '}
                      <button type="button" className="np-struct-btn"
                        onClick={() => { setExp((s) => ({ ...s, cValue: curveImpliedC.toFixed(6) })); setDirty(true); }}>
                        Apply curve-implied
                      </button>
                    </>
                  )}
                </Notice>
              )}
              {exp.selectedCurve === 'Auto' && (
                <div className="muted" style={{ fontSize: '.8rem', marginBottom: 8 }}>
                  Auto-curve per band:{' '}
                  {bands.filter(bandHasData).map((b, idx) => {
                    const si = cn(b.sumInsured);
                    const n = cn(b.policies);
                    const avgSI = n > 0 ? si / n : 0;
                    return <span key={idx} style={{ marginRight: 10 }}>Band {idx + 1} → <b>{avgSI > 0 ? autoCurveForBandUI(avgSI) : '—'}</b></span>;
                  })}
                </div>
              )}

              <KpiRow>
                <Kpi label="Total SI" value={fmtOrEm(totals.sumInsured)} />
                <Kpi label="PML" value={fmtOrEm(Math.round(totals.sumInsured * cn(exp.pmlPct) / 100))} />
                {cVal > 0 && <Kpi label="C × SI (Expected)" value={fmtOrEm(Math.round(totals.sumInsured * cVal))} tone="green" />}
                <Kpi label={`Exp. Rate (${exp.selectedCurve})`} value={overallExpRate > 0 ? `${overallExpRate.toFixed(3)}%` : '—'} tone="blue" />
                <Kpi label="Gross XL Loss" value={fmtOrEm(Math.round(totalExpLoss))} />
                {cn(exp.grossLossRatio) > 0 && cn(exp.grossLossRatio) !== 100 && (
                  <Kpi label={`Risk Premium (${cn(exp.grossLossRatio)}%)`} value={fmtOrEm(Math.round(totalExpLoss * cn(exp.grossLossRatio) / 100))} tone="green" />
                )}
              </KpiRow>

              <div className="mod-two-col">
                <div className="mod-svg-card">
                  <div className="np-struct-card-hint" style={{ marginBottom: 4 }}>
                    G(d) — destruction-ratio curve ({exp.selectedCurve === 'Custom' ? `c=${cn(exp.customB)}` : exp.selectedCurve})
                  </div>
                  <svg width="100%" viewBox="0 0 320 200" preserveAspectRatio="xMidYMid meet">
                    {[0.2, 0.4, 0.6, 0.8].map((v) => (
                      <g key={v}>
                        <line x1={40} y1={180 - v * 160} x2={310} y2={180 - v * 160} stroke="var(--hairline)" />
                        <text x={36} y={184 - v * 160} textAnchor="end" fill="var(--muted)" fontSize="9">{v.toFixed(1)}</text>
                        <line x1={40 + v * 270} y1={20} x2={40 + v * 270} y2={180} stroke="var(--hairline)" />
                        <text x={40 + v * 270} y={194} textAnchor="middle" fill="var(--muted)" fontSize="9">{v.toFixed(1)}</text>
                      </g>
                    ))}
                    <line x1="40" y1="180" x2="310" y2="180" stroke="var(--hairline-strong)" />
                    <line x1="40" y1="20" x2="40" y2="180" stroke="var(--hairline-strong)" />
                    <line x1="40" y1="180" x2="310" y2="20" stroke="var(--hairline)" strokeDasharray="4,3" />
                    <polyline points={curvePolyline} fill="none" stroke="var(--accent)" strokeWidth="2" />
                  </svg>
                </div>
                <div>
                  <div className="np-struct-card-hint" style={{ marginBottom: 4 }}>Curve comparison at key points</div>
                  <table className="mod-table mod-table--compact">
                    <thead>
                      <tr><th>d</th>{SWISS_RE_CURVES.map((c) => <th key={c.name} className="mod-num">{c.name.split(' ')[0]}</th>)}{exp.selectedCurve === 'Custom' && <th className="mod-num">CUSTOM</th>}</tr>
                    </thead>
                    <tbody>
                      {[0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0].map((d) => (
                        <tr key={d}>
                          <td>{(d * 100).toFixed(0)}%</td>
                          {SWISS_RE_CURVES.map((cv) => <td key={cv.name} className="mod-num">{(mbbefdG(d, cv.c ?? 0) * 100).toFixed(2)}%</td>)}
                          {exp.selectedCurve === 'Custom' && <td className="mod-num" style={{ color: 'var(--accent2)' }}>{(mbbefdG(d, cn(exp.customB)) * 100).toFixed(2)}%</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="muted" style={{ fontSize: '.78rem', marginTop: 8 }}>
                Audit: C={exp.cValue || '—'}, PML={exp.pmlPct || '100'}%, curve={exp.selectedCurve},
                c={exp.selectedCurve === 'Custom' ? cn(exp.customB) || '—' : (SWISS_RE_C[exp.selectedCurve] ?? 'per band')},
                loss ratio={exp.grossLossRatio || '100'}%{curveImpliedC > 0 ? `, curve-implied C=${curveImpliedC.toFixed(4)}` : ''}
              </div>
            </>
          )}
        </section>
      )}
    </ModScreen>
  );
}
