import React, { useEffect, useMemo, useState } from 'react';
import { ModScreen, SaveBar, Toggle, Notice, NumCell, CalcCell, useSaveMsg, pasteGrid, pasteNum } from './bits.jsx';
import { useModelling, useScreenSave } from './store.jsx';
import { cn, fmtC, fPct, projectStraightStats, LDF_CONFIG, DEFAULT_LDF_KEY, DEV_FACTOR_CURVES, IS_BENCHMARK_LDF } from './engine.js';

/* Straight Stats (No Triangulation) — ported from the modelling tool's
   PropNoTriangulation: the direct-entry premium / paid / OS grid by UW year
   for cedants that supply no triangulations, the per-treaty large/CAT strip
   toggle, and the projection preview off a benchmark LDF curve. On the
   placement page this screen sits ALONGSIDE the triangles rather than
   replacing them — both are completed; the summaries prefer the triangles
   and fall back to these stats. */

const COLS = ['premium', 'paid', 'os'];

export default function NoTriangulation() {
  const mod = useModelling();
  const { meta, get, save } = mod;
  const section = 'straight_stats';

  // Straight stats run through the renewal year, one row beyond the triangle window.
  const years = meta.statYears || meta.years;
  const [rows, setRows] = useState({});
  const [strip, setStrip] = useState(true);
  const [classKey, setClassKey] = useState(DEFAULT_LDF_KEY);
  const [dirty, setDirty] = useState(false);
  const [msg, flash] = useSaveMsg();

  useEffect(() => {
    const data = get(section);
    const next = {};
    for (const r of data?.stats || []) {
      next[String(r.year)] = {
        premium: r.premium ? String(r.premium) : '',
        paid: r.paid ? String(r.paid) : '',
        os: r.os ? String(r.os) : '',
      };
    }
    setRows(next);
    setStrip(data?.strip_large_cat !== false);
    setClassKey(data?.class_key || DEFAULT_LDF_KEY);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.sections]);

  const getRow = (year) => rows[String(year)] || { premium: '', paid: '', os: '' };
  const incurred = (r) => cn(r.paid) + cn(r.os);

  const updateCell = (year, col, value) => {
    setRows((prev) => ({ ...prev, [String(year)]: { ...getRow(year), ...{ [col]: value } } }));
    setDirty(true);
  };

  const handlePaste = (e, yearIdx, colIdx) => {
    const grid = pasteGrid(e);
    if (!grid) return;
    e.preventDefault();
    setRows((prev) => {
      const next = { ...prev };
      grid.forEach((pastedRow, rOff) => {
        const target = yearIdx + rOff;
        if (target >= years.length) return;
        const y = String(years[target]);
        pastedRow.forEach((val, cOff) => {
          const ci = colIdx + cOff;
          if (ci >= COLS.length) return;
          if (!next[y]) next[y] = { premium: '', paid: '', os: '' };
          next[y] = { ...next[y], [COLS[ci]]: pasteNum(val) };
        });
      });
      return next;
    });
    setDirty(true);
  };

  const totals = useMemo(() => years.reduce((acc, y) => {
    const r = getRow(y);
    acc.premium += cn(r.premium);
    acc.paid += cn(r.paid);
    acc.os += cn(r.os);
    acc.incurred += incurred(r);
    return acc;
  }, { premium: 0, paid: 0, os: 0, incurred: 0 }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [rows, years]);

  const statsPayload = () => years.map((year) => {
    const r = getRow(year);
    return { year: Number(year), premium: cn(r.premium), paid: cn(r.paid), os: cn(r.os) };
  });

  const projection = useMemo(
    () => projectStraightStats(statsPayload().filter((s) => s.premium || s.paid || s.os), classKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, classKey, years],
  );

  const doSave = async () => {
    if (!dirty) return true;
    try {
      await save(section, { strip_large_cat: strip, class_key: classKey, stats: statsPayload() });
      setDirty(false);
      flash('ok', 'Straight stats saved');
      return true;
    } catch (e) {
      flash('err', `Save failed: ${e.message || 'server error'}`);
      return false;
    }
  };
  useScreenSave(mod, doSave);

  const curve = DEV_FACTOR_CURVES[classKey];

  return (
    <ModScreen pill="PROPORTIONAL TREATY: STRAIGHT STATS" title="Straight Stats (No Triangulation)"
      sub="Per-year premium, paid and outstanding when the cedant supplies no triangulations. Completed alongside the triangles; the projected summary uses the triangles first and falls back to these stats."
      actions={<SaveBar dirty={dirty} msg={msg} onSave={doSave} canEdit={meta.canEdit} />}>

      <div className="tri-info-bar">
        <div className="tri-info-item">Start Year <b>{meta.startYear}</b> <span className="mod-derived-tag">↗ Treaty Detail</span></div>
        <div className="tri-info-item">Renewal Year <b>{meta.inceptionYear}</b> <span className="mod-derived-tag">↗ Treaty Detail</span></div>
        <div className="tri-info-item">
          Large / CAT losses
          <Toggle value={strip ? 'strip' : 'keep'} disabled={!meta.canEdit}
            onChange={(v) => { setStrip(v === 'strip'); setDirty(true); }}
            options={[['strip', 'Strip from incurred'], ['keep', 'Keep in incurred']]} />
        </div>
      </div>
      <Notice tone="info">
        Saved per treaty. <b>Strip</b> removes the saved large/CAT losses from incurred before projecting and adds
        them back unprojected; <b>Keep</b> projects the full incurred and folds everything into attritional.
      </Notice>

      <div className="np-table-wrap">
        <table className="nt-table">
          <thead>
            <tr>
              <th>UW YEAR</th>
              <th className="mod-num">GROSS PREMIUM ({meta.currency})</th>
              <th className="mod-num">PAID CLAIMS</th>
              <th className="mod-num">OS CLAIMS</th>
              <th className="mod-num">INCURRED (CALC)</th>
            </tr>
          </thead>
          <tbody>
            {years.map((year, yi) => {
              const r = getRow(year);
              return (
                <tr key={year}>
                  <td><span className="mod-year-chip">{year}</span></td>
                  {COLS.map((col, ci) => (
                    <td key={col}>
                      <NumCell value={r[col]} readOnly={!meta.canEdit}
                        onChange={(v) => updateCell(year, col, v)}
                        onPaste={(e) => handlePaste(e, yi, ci)} />
                    </td>
                  ))}
                  <td><CalcCell value={incurred(r) ? fmtC(incurred(r)) : ''} /></td>
                </tr>
              );
            })}
            <tr className="mod-total-row">
              <td><span className="mod-year-chip mod-year-chip--total">Total</span></td>
              <td><CalcCell value={fmtC(totals.premium)} /></td>
              <td><CalcCell value={fmtC(totals.paid)} /></td>
              <td><CalcCell value={fmtC(totals.os)} /></td>
              <td><CalcCell value={fmtC(totals.incurred)} /></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mod-two-col">
        <section className="np-struct-card">
          <div className="np-struct-card-header">
            <div>
              <div className="np-struct-card-h2">Benchmark LDF Curve</div>
              <div className="np-struct-card-hint">Per-class development curve used to project these stats to ultimate.</div>
            </div>
            <select className="np-mini-input" style={{ width: 200 }} value={classKey} disabled={!meta.canEdit}
              onChange={(e) => { setClassKey(e.target.value); setDirty(true); }}>
              {Object.entries(LDF_CONFIG).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
            </select>
          </div>
          {IS_BENCHMARK_LDF && (
            <Notice tone="warn">
              Uncalibrated benchmark factors in use ({curve?.source}) — replace with assumptions calibrated to this
              cedant before relying on the projection for binding pricing.
            </Notice>
          )}
          <table className="mod-table mod-table--compact">
            <thead><tr><th>DEV PERIOD</th><th className="mod-num">LDF</th><th className="mod-num">CDF</th></tr></thead>
            <tbody>
              {curve?.ldfs.map((l, i) => (
                <tr key={l.devYear}>
                  <td>{l.devYear}</td>
                  <td className="mod-num">{l.ldf.toFixed(3)}</td>
                  <td className="mod-num">{curve.cdfs[i].toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="np-struct-card">
          <div className="np-struct-card-header">
            <div>
              <div className="np-struct-card-h2">Projection Preview</div>
              <div className="np-struct-card-hint">Ultimate premium and loss per year off the chosen curve (newest year develops most).</div>
            </div>
          </div>
          <table className="mod-table mod-table--compact">
            <thead><tr><th>YEAR</th><th className="mod-num">ULT PREMIUM</th><th className="mod-num">ULT LOSS</th><th className="mod-num">ULT LR</th><th className="mod-num">CDF</th></tr></thead>
            <tbody>
              {projection.length === 0 && (
                <tr><td colSpan={5} className="muted" style={{ padding: 10 }}>Enter stats above to see the projection.</td></tr>
              )}
              {projection.map((p) => (
                <tr key={p.year}>
                  <td>{p.year}</td>
                  <td className="mod-num">{fmtC(Math.round(p.ultPrem))}</td>
                  <td className="mod-num">{fmtC(Math.round(p.ultLoss))}</td>
                  <td className="mod-num">{p.ultPrem > 0 ? fPct(p.ultLoss / p.ultPrem) : '—'}</td>
                  <td className="mod-num">{p.devFactor.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </ModScreen>
  );
}
