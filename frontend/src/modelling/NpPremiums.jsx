import React, { useEffect, useMemo, useState } from 'react';
import { ModScreen, SaveBar, Toggle, Notice, NumCell, CalcCell, ModModal, useSaveMsg, pasteGrid, pasteNum } from './bits.jsx';
import { useModelling, useScreenSave } from './store.jsx';
import { cn, fmtC } from './engine.js';

/* Premiums & Inflation Cockpit — ported from the modelling tool's
   NpPremiumsTable: EGNPI by underwriting year (the burning-cost denominator
   for every NP pricing method), year-by-year inflation assumptions with the
   cumulative factor, and the rate-changes capture with on-level premium. */

function computeCumulative(rows) {
  let factor = 1.0;
  return rows.map((r) => {
    const pct = cn(r.inflationPct);
    factor *= 1 + pct / 100;
    return { ...r, cumulativeFactor: factor };
  });
}

export default function NpPremiums() {
  const mod = useModelling();
  const { meta, get, save } = mod;
  const section = 'np_premiums';
  // EGNPI runs through the renewal year — the prospective year is the base
  // the burning cost applies its loss-cost rate to.
  const years = meta.statYears || meta.years;

  const [uwRows, setUwRows] = useState([]);
  const [inflationRows, setInflationRows] = useState([]);
  const [rateRows, setRateRows] = useState([]);
  const [inflationMode, setInflationMode] = useState('perYear');
  const [averagePct, setAveragePct] = useState('');
  const [showRates, setShowRates] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [msg, flash] = useSaveMsg();

  useEffect(() => {
    const data = get(section);
    const uwMap = new Map((data?.uwRows || []).map((r) => [String(r.uwYear ?? r.uw_year), r]));
    const infMap = new Map((data?.inflationRows || []).map((r) => [String(r.uwYear ?? r.uw_year), r]));
    const rateMap = new Map((data?.rateRows || []).map((r) => [String(r.uwYear ?? r.uw_year), r]));
    setUwRows(years.map((y) => {
      const cur = uwMap.get(String(y));
      return { uwYear: y, egnpi: cur?.egnpi != null && cur.egnpi !== '' ? String(cur.egnpi) : '' };
    }));
    setInflationRows(computeCumulative(years.map((y) => {
      const cur = infMap.get(String(y));
      return { uwYear: y, inflationPct: cur?.inflationPct != null && cur.inflationPct !== '' ? String(cur.inflationPct) : '' };
    })));
    setRateRows(years.map((y) => {
      const cur = rateMap.get(String(y));
      return { uwYear: y, rateChangePct: cur?.rateChangePct != null && cur.rateChangePct !== '' ? String(cur.rateChangePct) : '' };
    }));
    setInflationMode(data?.inflationMode === 'average' ? 'average' : 'perYear');
    setAveragePct(data?.averageInflationPct != null ? String(data.averageInflationPct) : '');
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.sections, years.join(',')]);

  const deltaPct = (i) => {
    const cur = cn(uwRows[i]?.egnpi);
    const prev = i > 0 ? cn(uwRows[i - 1]?.egnpi) : 0;
    return prev !== 0 && cur !== 0 ? ((cur - prev) / prev) * 100 : null;
  };

  const applyAverage = (pct) => {
    setInflationRows((prev) => computeCumulative(prev.map((r) => ({ ...r, inflationPct: pct }))));
    setDirty(true);
  };

  // On-level premium: each year's EGNPI brought to current rate level by the
  // product of subsequent rate changes (the modelling tool's rate modal).
  const onLevel = useMemo(() => {
    const factors = years.map((_, i) => {
      let f = 1;
      for (let j = i + 1; j < years.length; j++) f *= 1 + cn(rateRows[j]?.rateChangePct) / 100;
      return f;
    });
    return years.map((y, i) => ({ year: y, factor: factors[i], onLevel: cn(uwRows[i]?.egnpi) * factors[i] }));
  }, [years, uwRows, rateRows]);

  const doSave = async () => {
    if (!dirty) return true;
    try {
      await save(section, {
        inflationMode,
        averageInflationPct: averagePct === '' ? null : cn(averagePct),
        uwRows: uwRows.map((r) => ({ uwYear: r.uwYear, egnpi: r.egnpi === '' ? null : cn(r.egnpi) })),
        inflationRows: inflationRows.map((r) => ({ uwYear: r.uwYear, inflationPct: r.inflationPct === '' ? null : cn(r.inflationPct), cumulativeFactor: r.cumulativeFactor || 1 })),
        rateRows: rateRows.map((r) => ({ uwYear: r.uwYear, rateChangePct: r.rateChangePct === '' ? null : cn(r.rateChangePct) })),
      });
      setDirty(false);
      flash('ok', 'Premiums saved');
      return true;
    } catch (e) {
      flash('err', `Save failed: ${e.message || 'server error'}`);
      return false;
    }
  };
  useScreenSave(mod, doSave);

  return (
    <ModScreen pill="NON-PROPORTIONAL TREATY: PREMIUMS & INFLATION" title="Premiums & Inflation Cockpit"
      sub={`Underwriting years ${meta.startYear} to ${meta.inceptionYear} — the EGNPI base every burning-cost calculation divides by.`}
      actions={(
        <SaveBar dirty={dirty} msg={msg} onSave={doSave} canEdit={meta.canEdit}
          extra={<button type="button" className="np-struct-btn" onClick={() => setShowRates(true)}>⚙ Rate Changes</button>} />
      )}>

      <div className="mod-two-col">
        <section className="np-struct-card">
          <div className="np-struct-card-header">
            <div>
              <div className="np-struct-card-h2">Underwriting Years · Premium</div>
              <div className="np-struct-card-hint">EGNPI per UW year — paste directly from Excel; Δ vs prior year is derived.</div>
            </div>
          </div>
          <div className="np-table-wrap">
            <table className="mod-table mod-table--compact">
              <thead><tr><th>UW</th><th className="mod-num">EGNPI ({meta.currency})</th><th className="mod-num">Δ VS PREV</th></tr></thead>
              <tbody>
                {uwRows.map((r, i) => {
                  const chg = deltaPct(i);
                  return (
                    <tr key={r.uwYear}>
                      <td><span className="mod-year-chip">{r.uwYear}</span></td>
                      <td>
                        <NumCell value={r.egnpi} readOnly={!meta.canEdit}
                          onChange={(v) => { setUwRows((prev) => prev.map((x, j) => (j === i ? { ...x, egnpi: v } : x))); setDirty(true); }}
                          onPaste={(e) => {
                            const grid = pasteGrid(e);
                            if (!grid) return;
                            e.preventDefault();
                            setUwRows((prev) => {
                              const next = [...prev];
                              grid.forEach((line, rOff) => {
                                const target = i + rOff;
                                if (!next[target]) return;
                                next[target] = { ...next[target], egnpi: pasteNum(line[0]) };
                              });
                              return next;
                            });
                            setDirty(true);
                          }} />
                      </td>
                      <td className="mod-num" style={{ color: chg == null ? 'var(--muted)' : chg >= 0 ? 'var(--accent2)' : 'var(--accent-rose)' }}>
                        {chg == null ? '—' : `${chg.toFixed(2)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="np-struct-card">
          <div className="np-struct-card-header">
            <div>
              <div className="np-struct-card-h2">Inflation Assumptions</div>
              <div className="np-struct-card-hint">Cumulative factor applies sequentially year-on-year (base = 1.00).</div>
            </div>
            <Toggle value={inflationMode} disabled={!meta.canEdit}
              options={[['perYear', 'Per year'], ['average', 'Average']]}
              onChange={(m) => {
                setInflationMode(m);
                setDirty(true);
                if (m === 'average') {
                  let avg = averagePct;
                  if (avg === '') {
                    const vals = inflationRows.map((r) => cn(r.inflationPct)).filter((n) => n !== 0);
                    avg = vals.length ? (vals.reduce((s, n) => s + n, 0) / vals.length).toFixed(2) : '0';
                    setAveragePct(avg);
                  }
                  applyAverage(avg);
                }
              }} />
          </div>
          {inflationMode === 'average' && (
            <div className="tri-info-bar">
              <div className="tri-info-item">Average inflation %{' '}
                <NumCell value={averagePct} readOnly={!meta.canEdit} align="center" className="mod-cell--w90"
                  onChange={(v) => { setAveragePct(v); setDirty(true); }} />
                {meta.canEdit && <button type="button" className="np-struct-btn" onClick={() => applyAverage(averagePct)}>Apply</button>}
              </div>
            </div>
          )}
          <div className="np-table-wrap">
            <table className="mod-table mod-table--compact">
              <thead><tr><th>UW</th><th className="mod-cell--center">INFLATION %</th><th className="mod-num">CUMULATIVE</th></tr></thead>
              <tbody>
                {inflationRows.map((r, i) => (
                  <tr key={r.uwYear}>
                    <td><span className="mod-year-chip">{r.uwYear}</span></td>
                    <td>
                      <NumCell value={r.inflationPct} align="center" readOnly={!meta.canEdit || inflationMode === 'average'}
                        onChange={(v) => {
                          setInflationRows((prev) => computeCumulative(prev.map((x, j) => (j === i ? { ...x, inflationPct: v } : x))));
                          setDirty(true);
                        }} />
                    </td>
                    <td><CalcCell value={(r.cumulativeFactor || 1).toFixed(4)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {showRates && (
        <ModModal wide title="Rate Changes & On-Level Premium"
          sub="Capture year-over-year rate movement; each year's EGNPI is brought to current rate level by the product of the subsequent changes."
          onClose={() => setShowRates(false)}>
          <div className="np-table-wrap">
            <table className="mod-table mod-table--compact">
              <thead><tr><th>UW YEAR</th><th className="mod-num">EGNPI</th><th className="mod-cell--center">RATE CHANGE %</th><th className="mod-num">ON-LEVEL FACTOR</th><th className="mod-num">ON-LEVEL PREMIUM</th></tr></thead>
              <tbody>
                {years.map((y, i) => (
                  <tr key={y}>
                    <td>{y}</td>
                    <td className="mod-num">{cn(uwRows[i]?.egnpi) ? fmtC(cn(uwRows[i].egnpi)) : '—'}</td>
                    <td>
                      <NumCell value={rateRows[i]?.rateChangePct ?? ''} align="center" readOnly={!meta.canEdit}
                        onChange={(v) => { setRateRows((prev) => prev.map((x, j) => (j === i ? { ...x, rateChangePct: v } : x))); setDirty(true); }} />
                    </td>
                    <td className="mod-num">{onLevel[i].factor.toFixed(4)}</td>
                    <td className="mod-num">{onLevel[i].onLevel ? fmtC(Math.round(onLevel[i].onLevel)) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Notice tone="info">A +10% change in a later year lifts every earlier year's on-level premium by 10% — the burning cost then reads history at today's rates.</Notice>
          <div className="toolbar" style={{ marginTop: 8 }}>
            <button type="button" className="np-green-pill" onClick={() => setShowRates(false)}>Done</button>
          </div>
        </ModModal>
      )}
    </ModScreen>
  );
}
