import React, { useEffect, useMemo, useState } from 'react';
import { ModScreen, SaveBar, Kpi, KpiRow, NumCell, ModModal, useSaveMsg, pasteGrid, pasteNum, lrColor, crColor } from './bits.jsx';
import { useModelling, useScreenSave } from './store.jsx';
import { cn, fmtC } from './engine.js';

/* Historical Performance — ported from the modelling tool's
   NpHistoricalPerformance: the underwriting-year performance grid (premiums,
   claims, EGNPI, expense ratio → result, loss ratio, combined ratio) with
   the rolling moving-averages analysis. Paste from Excel supported. */

const EDIT_FIELDS = ['premiums', 'claims', 'egnpi', 'expense_ratio'];
const MA_WINDOWS = [2, 3, 4, 5, 6, 7, 8, 10];

export default function NpHistorical() {
  const mod = useModelling();
  const { meta, get, save } = mod;
  const section = 'np_historical';
  const years = meta.statYears || meta.years;

  const [rows, setRows] = useState([]);
  const [showMA, setShowMA] = useState(false);
  const [maWindow, setMaWindow] = useState(3);
  const [dirty, setDirty] = useState(false);
  const [msg, flash] = useSaveMsg();

  useEffect(() => {
    const data = get(section);
    const map = new Map((data?.rows || []).map((r) => [Number(r.uw_year), r]));
    setRows(years.map((y) => {
      const s = map.get(y) || {};
      const str = (v) => (v == null || v === '' || v === 0 ? '' : String(v));
      return { uw_year: y, premiums: str(s.premiums), claims: str(s.claims), egnpi: str(s.egnpi), expense_ratio: str(s.expense_ratio) || '10' };
    }));
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.sections, years.join(',')]);

  const computedRows = useMemo(() => rows.map((r) => {
    const prem = cn(r.premiums);
    const claims = cn(r.claims);
    const expR = cn(r.expense_ratio);
    const lossRatio = prem ? (claims / prem) * 100 : 0;
    return { ...r, result: prem ? prem - claims : 0, loss_ratio: lossRatio, combined_ratio: lossRatio + expR };
  }), [rows]);

  const totals = useMemo(() => {
    const n = computedRows.length;
    if (!n) return null;
    const sumPrem = computedRows.reduce((s, r) => s + cn(r.premiums), 0);
    const sumClaims = computedRows.reduce((s, r) => s + cn(r.claims), 0);
    const avgLR = sumPrem ? (sumClaims / sumPrem) * 100 : 0;
    const avgER = computedRows.reduce((s, r) => s + cn(r.expense_ratio), 0) / n;
    return {
      premiums: sumPrem, claims: sumClaims,
      egnpi: computedRows.reduce((s, r) => s + cn(r.egnpi), 0),
      result: sumPrem - sumClaims, loss_ratio: avgLR, expense_ratio: avgER, combined_ratio: avgLR + avgER,
    };
  }, [computedRows]);

  const maRows = useMemo(() => {
    const w = Math.max(2, Math.min(10, maWindow));
    return computedRows.map((r, i) => {
      if (i < w - 1) return { ...r, ma_lr: null, ma_er: null, ma_cr: null, ma_prem: null, ma_claims: null };
      const win = computedRows.slice(i - w + 1, i + 1);
      const wPrem = win.reduce((s, wr) => s + cn(wr.premiums), 0);
      const wClaims = win.reduce((s, wr) => s + cn(wr.claims), 0);
      const wER = win.reduce((s, wr) => s + cn(wr.expense_ratio), 0) / w;
      const wLR = wPrem ? (wClaims / wPrem) * 100 : 0;
      return { ...r, ma_lr: wLR, ma_er: wER, ma_cr: wLR + wER, ma_prem: wPrem / w, ma_claims: wClaims / w };
    });
  }, [computedRows, maWindow]);

  const maSummary = useMemo(() => {
    const filled = maRows.filter((r) => r.ma_lr != null);
    if (!filled.length) return null;
    const avgLR = filled.reduce((s, r) => s + r.ma_lr, 0) / filled.length;
    const avgCR = filled.reduce((s, r) => s + r.ma_cr, 0) / filled.length;
    const minLR = Math.min(...filled.map((r) => r.ma_lr));
    const maxLR = Math.max(...filled.map((r) => r.ma_lr));
    const trend = filled.length >= 2 ? filled[filled.length - 1].ma_cr - filled[filled.length - 2].ma_cr : null;
    return { avgLR, avgCR, minLR, maxLR, trend };
  }, [maRows]);

  const updateRow = (idx, field, val) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: val } : r)));
    setDirty(true);
  };

  const onPaste = (e, rowIdx, colIdx) => {
    const grid = pasteGrid(e);
    if (!grid) return;
    e.preventDefault();
    setRows((prev) => {
      const next = [...prev];
      grid.forEach((pr, ri) => {
        const targetRow = rowIdx + ri;
        if (targetRow >= next.length) return;
        pr.forEach((val, ci) => {
          const targetCol = colIdx + ci;
          if (targetCol >= EDIT_FIELDS.length) return;
          next[targetRow] = { ...next[targetRow], [EDIT_FIELDS[targetCol]]: pasteNum(val) };
        });
      });
      return next;
    });
    setDirty(true);
  };

  const doSave = async () => {
    if (!dirty) return true;
    try {
      await save(section, {
        rows: computedRows.map((r) => ({
          uw_year: r.uw_year,
          premiums: cn(r.premiums) || null, claims: cn(r.claims) || null, egnpi: cn(r.egnpi) || null,
          result: r.result || null, loss_ratio: r.loss_ratio || null,
          expense_ratio: cn(r.expense_ratio) || null, combined_ratio: r.combined_ratio || null,
        })),
      });
      setDirty(false);
      flash('ok', 'Performance saved');
      return true;
    } catch (e) {
      flash('err', `Save failed: ${e.message || 'server error'}`);
      return false;
    }
  };
  useScreenSave(mod, doSave);

  const fp1 = (v) => `${v.toFixed(1)}%`;

  return (
    <ModScreen pill="NON-PROPORTIONAL TREATY: HISTORICAL PERFORMANCE" title="Historical Performance"
      sub={`${meta.startYear} – ${meta.inceptionYear} · ${years.length} years · paste from Excel supported.`}
      actions={(
        <SaveBar dirty={dirty} msg={msg} onSave={doSave} canEdit={meta.canEdit}
          extra={<button type="button" className="np-struct-btn" onClick={() => setShowMA(true)}>📊 Moving Averages</button>} />
      )}>

      <div className="np-table-wrap">
        <table className="mod-table">
          <thead>
            <tr>
              <th>UW YEAR</th><th className="mod-num">PREMIUMS</th><th className="mod-num">CLAIMS</th><th className="mod-num">EGNPI</th>
              <th className="mod-num">RESULT</th><th className="mod-num">LOSS RATIO</th><th className="mod-cell--center">EXPENSE RATIO %</th><th className="mod-num">COMBINED RATIO</th>
            </tr>
          </thead>
          <tbody>
            {computedRows.map((r, i) => (
              <tr key={r.uw_year}>
                <td><span className="mod-year-chip">{r.uw_year}</span></td>
                <td><NumCell value={r.premiums} readOnly={!meta.canEdit} onChange={(v) => updateRow(i, 'premiums', v)} onPaste={(e) => onPaste(e, i, 0)} /></td>
                <td><NumCell value={r.claims} readOnly={!meta.canEdit} onChange={(v) => updateRow(i, 'claims', v)} onPaste={(e) => onPaste(e, i, 1)} /></td>
                <td><NumCell value={r.egnpi} readOnly={!meta.canEdit} onChange={(v) => updateRow(i, 'egnpi', v)} onPaste={(e) => onPaste(e, i, 2)} /></td>
                <td className="mod-num" style={{ color: r.result >= 0 ? 'var(--accent2)' : 'var(--accent-rose)' }}>{r.result ? fmtC(Math.round(r.result)) : '—'}</td>
                <td className="mod-num" style={{ color: r.loss_ratio ? lrColor(r.loss_ratio) : undefined }}>{r.loss_ratio ? fp1(r.loss_ratio) : '—'}</td>
                <td><NumCell value={r.expense_ratio} readOnly={!meta.canEdit} align="center" onChange={(v) => updateRow(i, 'expense_ratio', v)} onPaste={(e) => onPaste(e, i, 3)} /></td>
                <td className="mod-num" style={{ color: r.combined_ratio ? crColor(r.combined_ratio) : undefined, fontWeight: 700 }}>{r.combined_ratio ? fp1(r.combined_ratio) : '—'}</td>
              </tr>
            ))}
            {totals && (
              <tr className="mod-total-row">
                <td><b>TOTAL / AVG</b></td>
                <td className="mod-num"><b>{fmtC(Math.round(totals.premiums))}</b></td>
                <td className="mod-num"><b>{fmtC(Math.round(totals.claims))}</b></td>
                <td className="mod-num"><b>{fmtC(Math.round(totals.egnpi))}</b></td>
                <td className="mod-num" style={{ color: totals.result >= 0 ? 'var(--accent2)' : 'var(--accent-rose)' }}><b>{fmtC(Math.round(totals.result))}</b></td>
                <td className="mod-num" style={{ color: lrColor(totals.loss_ratio) }}><b>{fp1(totals.loss_ratio)}</b></td>
                <td className="mod-num"><b>{fp1(totals.expense_ratio)}</b></td>
                <td className="mod-num" style={{ color: crColor(totals.combined_ratio) }}><b>{fp1(totals.combined_ratio)}</b></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showMA && (
        <ModModal wide title="Moving Averages" sub="Rolling window analysis of underwriting performance."
          onClose={() => setShowMA(false)}>
          <div className="tri-info-bar" style={{ marginBottom: 8 }}>
            <div className="tri-info-item">Window{' '}
              <select className="np-mini-input" style={{ width: 100 }} value={maWindow} onChange={(e) => setMaWindow(Number(e.target.value))}>
                {MA_WINDOWS.map((w) => <option key={w} value={w}>{w}-Year</option>)}
              </select>
            </div>
          </div>
          <div className="np-table-wrap">
            <table className="mod-table mod-table--compact">
              <thead>
                <tr>
                  <th>UW YEAR</th><th className="mod-num">PREMIUMS</th><th className="mod-num">CLAIMS</th><th className="mod-num">LOSS RATIO</th>
                  <th className="mod-num">{maWindow}Y MA PREM</th><th className="mod-num">{maWindow}Y MA CLAIMS</th><th className="mod-num">{maWindow}Y MA LR</th><th className="mod-num">{maWindow}Y MA ER</th><th className="mod-num">{maWindow}Y MA CR</th>
                </tr>
              </thead>
              <tbody>
                {maRows.map((r) => (
                  <tr key={r.uw_year}>
                    <td>{r.uw_year}</td>
                    <td className="mod-num">{cn(r.premiums) ? fmtC(cn(r.premiums)) : '—'}</td>
                    <td className="mod-num">{cn(r.claims) ? fmtC(cn(r.claims)) : '—'}</td>
                    <td className="mod-num" style={{ color: r.loss_ratio ? lrColor(r.loss_ratio) : undefined }}>{r.loss_ratio ? fp1(r.loss_ratio) : '—'}</td>
                    <td className="mod-num" style={{ color: 'var(--accent-blue)' }}>{r.ma_prem != null ? fmtC(Math.round(r.ma_prem)) : '—'}</td>
                    <td className="mod-num" style={{ color: 'var(--accent-blue)' }}>{r.ma_claims != null ? fmtC(Math.round(r.ma_claims)) : '—'}</td>
                    <td className="mod-num" style={{ color: r.ma_lr != null ? lrColor(r.ma_lr) : undefined }}>{r.ma_lr != null ? fp1(r.ma_lr) : '—'}</td>
                    <td className="mod-num" style={{ color: 'var(--accent-amber)' }}>{r.ma_er != null ? fp1(r.ma_er) : '—'}</td>
                    <td className="mod-num" style={{ color: r.ma_cr != null ? crColor(r.ma_cr) : undefined, fontWeight: 700 }}>{r.ma_cr != null ? fp1(r.ma_cr) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {maSummary && (
            <KpiRow>
              <Kpi label={`Avg ${maWindow}Y MA Loss Ratio`} value={fp1(maSummary.avgLR)} />
              <Kpi label={`Avg ${maWindow}Y MA Combined`} value={fp1(maSummary.avgCR)} />
              <Kpi label="MA LR Range" value={`${fp1(maSummary.minLR)} – ${fp1(maSummary.maxLR)}`} />
              <Kpi label="Latest MA Trend" value={maSummary.trend != null ? `${maSummary.trend > 0 ? '▲' : '▼'} ${Math.abs(maSummary.trend).toFixed(1)}pp` : '—'}
                tone={maSummary.trend != null ? (maSummary.trend > 0 ? 'red' : 'green') : undefined} />
            </KpiRow>
          )}
        </ModModal>
      )}
    </ModScreen>
  );
}
