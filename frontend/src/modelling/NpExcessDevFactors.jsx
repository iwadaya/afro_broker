import React, { useEffect, useMemo, useState } from 'react';
import { ModScreen, SaveBar, Toggle, Notice, useSaveMsg } from './bits.jsx';
import { useModelling, useScreenSave, egnpiByYearOf } from './store.jsx';
import {
  buildMatrixFromCells, calculateAgeToAgeFactors, calculatePattern, calculateCdfs,
  fitExponentialCdfs, deriveLdfsFromCdfs, calculateBF, cn, fmtOrEm, fmt4, fPct,
} from './engine.js';
import { FactorTable } from './DevFactors.jsx';

/* NP Excess Development Factors — ported from the modelling tool's
   NpExcessDevFactors: excess-of-loss losses developed to ultimate either in
   DIRECT mode (reported XS losses per year + manual LDFs) or TRIANGLE mode
   (a cumulative excess triangle run through the chain ladder, with link
   ratio exclusions and a BF overlay on the EGNPI from the premiums table).
   The underwriter's chosen factors are what the ultimate summary uses. */

const AVG_METHODS = [['weighted', 'Weighted'], ['simple', 'Simple'], ['last3', 'Last 3'], ['last5', 'Last 5']];

export default function NpExcessDevFactors() {
  const mod = useModelling();
  const { meta, get, save } = mod;
  const section = 'np_excess_dev';
  const { startYear, numDevYears, years } = meta;
  const devPeriods = useMemo(() => Array.from({ length: numDevYears }, (_, i) => (i + 1) * 12), [numDevYears]);

  const [dataMode, setDataMode] = useState('DIRECT');
  const [view, setView] = useState('FACTORS');
  const [avgMethod, setAvgMethod] = useState('weighted');
  const [projMethod, setProjMethod] = useState('CHAIN');
  const [chosenBase, setChosenBase] = useState('ACTUAL');
  const [tailFactor, setTailFactor] = useState('1.0');
  const [ielr, setIelr] = useState('0.65');
  const [chosenLdfs, setChosenLdfs] = useState([]);
  const [chosenCdfs, setChosenCdfs] = useState([]);
  const [excluded, setExcluded] = useState(new Set());
  const [manualLosses, setManualLosses] = useState([]);
  const [ldfCount, setLdfCount] = useState(5);
  const [manualLdfs, setManualLdfs] = useState(Array(10).fill(''));
  const [triCells, setTriCells] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [msg, flash] = useSaveMsg();

  useEffect(() => {
    const data = get(section);
    if (data) {
      if (Array.isArray(data.manualLosses)) setManualLosses(data.manualLosses.map((v) => (v ? String(v) : '')));
      if (Array.isArray(data.manualLdfs)) {
        const arr = Array(10).fill('');
        data.manualLdfs.forEach((v, i) => { if (i < 10) arr[i] = v ? String(v) : ''; });
        setManualLdfs(arr);
      }
      if (data.manualLdfCount) setLdfCount(Number(data.manualLdfCount) || 5);
      if (data.dataMode) setDataMode(data.dataMode);
      if (data.projMethod) setProjMethod(data.projMethod);
      if (data.avgMethod) setAvgMethod(data.avgMethod);
      if (data.tailFactor != null) setTailFactor(String(data.tailFactor));
      if (data.ielr != null) setIelr(String(data.ielr));
      if (data.chosenBase) setChosenBase(data.chosenBase);
      if (Array.isArray(data.triCells)) setTriCells(data.triCells);
      if (Array.isArray(data.factors) && data.factors.length) {
        setChosenLdfs(data.factors.map((f) => f.chosen_ldf ?? null));
        setChosenCdfs(data.factors.map((f) => f.chosen_cdf ?? null));
      }
      if (Array.isArray(data.excluded) && (!data.excludedForYearWindow || data.excludedForYearWindow === `${startYear}:${numDevYears}`)) {
        setExcluded(new Set(data.excluded));
      }
    } else {
      setManualLosses([]);
      setManualLdfs(Array(10).fill(''));
      setTriCells([]);
      setChosenLdfs([]);
      setChosenCdfs([]);
      setExcluded(new Set());
    }
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.sections]);

  const triCalcs = useMemo(() => {
    if (dataMode !== 'TRIANGLE' || !triCells.length) return null;
    const d = buildMatrixFromCells(triCells, startYear, numDevYears);
    if (!d) return null;
    const { matrix } = d;
    const factors = calculateAgeToAgeFactors(matrix);
    const { pattern, warnings } = calculatePattern(matrix, factors, avgMethod, { excluded });
    const tail = Number(tailFactor) || 1.0;
    const cdfs = calculateCdfs(pattern, tail);
    const paramCdfs = fitExponentialCdfs(cdfs);
    return { matrix, factors, pattern, patternWarnings: warnings, cdfs, paramLdfs: deriveLdfsFromCdfs(paramCdfs), paramCdfs };
  }, [dataMode, triCells, startYear, numDevYears, avgMethod, excluded, tailFactor]);

  const directCalcs = useMemo(() => {
    if (dataMode !== 'DIRECT') return null;
    const ldfs = manualLdfs.slice(0, ldfCount).map((v) => Number(v) || 1.0);
    const tail = Number(tailFactor) || 1.0;
    const cdfs = calculateCdfs(ldfs, tail);
    const paramCdfs = fitExponentialCdfs(cdfs);
    return { pattern: ldfs, cdfs, paramLdfs: deriveLdfsFromCdfs(paramCdfs), paramCdfs, patternWarnings: [] };
  }, [dataMode, manualLdfs, ldfCount, tailFactor]);

  const activeCalcs = dataMode === 'TRIANGLE' ? triCalcs : directCalcs;
  const hasCalcs = !!activeCalcs?.pattern?.length;

  const egnpiByYear = useMemo(() => egnpiByYearOf(mod),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mod.sections]);

  const bfResults = useMemo(() => {
    if (projMethod !== 'BF' || !triCalcs?.matrix) return null;
    const egnpiRows = years.map((yr) => egnpiByYear[yr] || 0);
    const clProjs = years.map((yr, r) => {
      let latestVal = 0; let latestCol = -1;
      const row = triCalcs.matrix[r] || [];
      for (let c = row.length - 1; c >= 0; c--) if (row[c] != null) { latestVal = row[c]; latestCol = c; break; }
      const cdf = latestCol >= 0 ? triCalcs.cdfs[latestCol] || 1 : 1;
      return { year: yr, latest: latestVal, cdf, ultimate: latestVal * cdf, ibnr: latestVal * cdf - latestVal };
    });
    return calculateBF(clProjs, egnpiRows, Number(ielr) || 0);
  }, [projMethod, triCalcs, years, egnpiByYear, ielr]);

  const switchBase = (base) => {
    if (!activeCalcs) return;
    setChosenBase(base);
    const src = base === 'PARAM' ? { ldfs: activeCalcs.paramLdfs, cdfs: activeCalcs.paramCdfs } : { ldfs: activeCalcs.pattern, cdfs: activeCalcs.cdfs };
    setChosenLdfs((src.ldfs || []).map((v) => v));
    setChosenCdfs((src.cdfs || []).slice(0, src.ldfs?.length || 0).map((v) => v));
    setDirty(true);
  };

  const triCellValue = (yr, dm) => {
    const c = triCells.find((tc) => tc.origin_year === yr && tc.dev_months === dm);
    return c?.cum_value != null ? String(c.cum_value) : '';
  };
  const setTriCell = (yr, dm, raw) => {
    const value = raw === '' ? null : Number(raw) || 0;
    setTriCells((prev) => {
      const idx = prev.findIndex((c) => c.origin_year === yr && c.dev_months === dm);
      const updated = [...prev];
      if (idx >= 0) updated[idx] = { ...updated[idx], cum_value: value };
      else updated.push({ origin_year: yr, dev_months: dm, cum_value: value });
      return updated;
    });
    setDirty(true);
  };

  // Ultimate summary: reported XS losses (direct entry) developed by the
  // chosen CDFs, newest year picking the least-developed factor.
  const summaryRows = useMemo(() => {
    if (!chosenLdfs.length) return [];
    const n = years.length;
    return years.map((yr, i) => {
      const reported = cn(manualLosses[i]);
      const ageIdx = Math.max(0, Math.min(chosenCdfs.length - 1, n - 1 - i));
      const cdf = Number(chosenCdfs[ageIdx]) || 1.0;
      return { year: yr, reported, cdf, ultimate: reported * cdf, ibnr: reported * cdf - reported };
    });
  }, [years, manualLosses, chosenLdfs, chosenCdfs]);

  const doSave = async () => {
    if (!dirty) return true;
    try {
      const sy = startYear;
      const triangleCells = triCells.filter((c) => {
        const r = Number(c.origin_year) - sy;
        const col = Math.round(Number(c.dev_months) / 12) - 1;
        if (!Number.isFinite(r) || !Number.isFinite(col) || r < 0 || col < 0) return false;
        return col <= numDevYears - r - 1;
      });
      await save(section, {
        dataMode, projMethod, avgMethod, chosenBase,
        tailFactor: Number(tailFactor) || 1.0,
        ielr: Number(ielr) || 0,
        manualLosses: manualLosses.map((v) => Number(v) || 0),
        manualLdfs: manualLdfs.map((v) => Number(v) || 0),
        manualLdfCount: ldfCount,
        triCells: triangleCells,
        factors: chosenLdfs.map((ldf, i) => ({
          dev_month: (i + 1) * 12,
          chosen_source: chosenBase === 'LINK_RATIO' ? 'SELECTED' : chosenBase,
          chosen_ldf: ldf == null ? null : Number(ldf) || null,
          chosen_cdf: chosenCdfs[i] == null ? null : Number(chosenCdfs[i]) || null,
          actual_ldf: activeCalcs?.pattern?.[i] ?? null,
          actual_cdf: activeCalcs?.cdfs?.[i] ?? null,
          parametrized_ldf: activeCalcs?.paramLdfs?.[i] ?? null,
          parametrized_cdf: activeCalcs?.paramCdfs?.[i] ?? null,
        })),
        excluded: [...excluded],
        excludedForYearWindow: `${startYear}:${numDevYears}`,
        updatedAt: new Date().toISOString(),
      });
      setDirty(false);
      flash('ok', 'Excess LDFs saved');
      return true;
    } catch (e) {
      flash('err', `Save failed: ${e.message || 'server error'}`);
      return false;
    }
  };
  useScreenSave(mod, doSave);

  return (
    <ModScreen pill="NON-PROPORTIONAL TREATY: EXCESS DEVELOPMENT FACTORS" title="Excess LDFs"
      sub="Develop reported excess losses to ultimate — direct manual LDFs, or a chain ladder over the excess triangle with link-ratio exclusions and a BF overlay."
      actions={<SaveBar dirty={dirty} msg={msg} onSave={doSave} canEdit={meta.canEdit} />}>

      <div className="tri-info-bar">
        <div className="tri-info-item">Start Year <b>{startYear}</b></div>
        <div className="tri-info-item">Dev Years <b>{numDevYears}</b></div>
        <div className="tri-info-item">Tail{' '}
          <input type="number" step="0.01" min="1" className="np-mini-input" style={{ width: 76 }} value={tailFactor}
            disabled={!meta.canEdit} onChange={(e) => { setTailFactor(e.target.value); setDirty(true); }} />
        </div>
        <div className="tri-info-item">Data Mode
          <Toggle value={dataMode} disabled={!meta.canEdit}
            options={[['DIRECT', 'Direct Entry'], ['TRIANGLE', 'Triangle']]}
            onChange={(m) => { setDataMode(m); setDirty(true); }} />
        </div>
        {dataMode === 'TRIANGLE' && (
          <div className="tri-info-item">Projection
            <Toggle value={projMethod} disabled={!meta.canEdit}
              options={[['CHAIN', 'Chain Ladder'], ['BF', 'BF']]}
              onChange={(m) => { setProjMethod(m); setDirty(true); }} />
          </div>
        )}
        <Toggle value={view} onChange={setView}
          options={[['FACTORS', '📊 Factors'], ['SUMMARY', '📋 Ultimate Summary']]} />
      </div>

      {dataMode === 'TRIANGLE' && projMethod === 'BF' && (
        <div className="mod-bf-bar">
          <label>Initial Expected XS Loss Ratio (IELR)</label>
          <input className="mod-cell mod-cell--center" style={{ width: 90 }} value={ielr} disabled={!meta.canEdit}
            onChange={(e) => { setIelr(e.target.value); setDirty(true); }} />
          <span className="muted">{((Number(ielr) || 0) * 100).toFixed(0)}% of EGNPI (from the Premiums Table)</span>
        </div>
      )}

      {activeCalcs?.patternWarnings?.length > 0 && (
        <Notice tone="warn">
          <b>⚠ Thin LDF columns ({activeCalcs.patternWarnings.length}).</b>{' '}
          {activeCalcs.patternWarnings.map((w) => `${w.devPeriod}m: ${w.contributingRows} origin year${w.contributingRows === 1 ? '' : 's'}`).join('; ')} — recommended ≥ 3.
        </Notice>
      )}

      {view === 'FACTORS' && (
        <>
          {dataMode === 'DIRECT' ? (
            <div className="mod-two-col">
              <section className="np-struct-card">
                <div className="np-struct-card-header">
                  <div>
                    <div className="np-struct-card-h2">Reported Excess Losses</div>
                    <div className="np-struct-card-hint">Cumulative reported losses above the retention, per accident year.</div>
                  </div>
                </div>
                <table className="mod-table mod-table--compact">
                  <thead><tr><th>YEAR</th><th className="mod-num">REPORTED XS LOSS</th></tr></thead>
                  <tbody>
                    {years.map((yr, i) => (
                      <tr key={yr}>
                        <td>{yr}</td>
                        <td>
                          <input className="mod-cell mod-cell--right" value={manualLosses[i] ?? ''} readOnly={!meta.canEdit} placeholder="0"
                            onChange={(e) => { setManualLosses((prev) => { const a = [...prev]; a[i] = e.target.value.replace(/,/g, ''); return a; }); setDirty(true); }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section className="np-struct-card">
                <div className="np-struct-card-header">
                  <div>
                    <div className="np-struct-card-h2">Input Development Factors</div>
                    <div className="np-struct-card-hint">
                      LDFs from benchmark or market data.
                      {' '}Dev periods{' '}
                      <input type="number" min="1" max="10" className="np-mini-input" style={{ width: 58 }} value={ldfCount}
                        disabled={!meta.canEdit}
                        onChange={(e) => { setLdfCount(Math.max(1, Math.min(10, Number(e.target.value) || 1))); setDirty(true); }} />
                    </div>
                  </div>
                </div>
                <table className="mod-table mod-table--compact">
                  <thead><tr><th>PERIOD</th><th className="mod-cell--center">LDF</th></tr></thead>
                  <tbody>
                    {Array.from({ length: ldfCount }, (_, i) => (
                      <tr key={i}>
                        <td>{i + 1}–{i + 2}</td>
                        <td>
                          <input className="mod-cell mod-cell--center" value={manualLdfs[i] ?? ''} readOnly={!meta.canEdit} placeholder="1.000"
                            onChange={(e) => { setManualLdfs((prev) => { const a = [...prev]; a[i] = e.target.value; return a; }); setDirty(true); }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </div>
          ) : (
            <section className="np-struct-card">
              <div className="np-struct-card-header">
                <div>
                  <div className="np-struct-card-h2">Excess Loss Triangle</div>
                  <div className="np-struct-card-hint">Cumulative excess losses (XS retention) per accident year × development period. Click a link ratio below to exclude it.</div>
                </div>
                <Toggle value={avgMethod} disabled={!meta.canEdit} options={AVG_METHODS}
                  onChange={(m) => { setAvgMethod(m); setDirty(true); }} />
              </div>
              <div className="np-table-wrap">
                <table className="tri-table">
                  <thead>
                    <tr>
                      <th className="tri-hdr tri-yr-hdr">YEAR</th>
                      {devPeriods.map((d) => <th key={d} className="tri-hdr">{d}m</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {years.map((yr, r) => (
                      <tr key={yr}>
                        <td className="tri-yr">{yr}</td>
                        {devPeriods.map((dm, c) => {
                          const active = c < devPeriods.length - r;
                          if (!active) return <td key={dm} className="tri-off" />;
                          return (
                            <td key={dm} className="tri-cell">
                              <input className="tri-inp" value={triCellValue(yr, dm)} readOnly={!meta.canEdit}
                                onChange={(e) => setTriCell(yr, dm, e.target.value.replace(/,/g, ''))} />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {triCalcs && (
                <div className="np-table-wrap" style={{ marginTop: 8 }}>
                  <table className="mod-table mod-table--compact">
                    <thead>
                      <tr><th>LINK RATIOS</th>{triCalcs.pattern.map((_, i) => <th key={i} className="mod-num">{i + 1}–{i + 2}</th>)}</tr>
                    </thead>
                    <tbody>
                      {years.map((yr, r) => (
                        <tr key={yr}>
                          <td>{yr}</td>
                          {triCalcs.pattern.map((_, c) => {
                            const f = triCalcs.factors[r]?.[c];
                            if (f == null) return <td key={c} className="mod-num muted">—</td>;
                            const off = excluded.has(`${r}:${c}`);
                            return (
                              <td key={c} className="mod-num">
                                <button type="button" disabled={!meta.canEdit} className={`df-ratio${off ? ' df-ratio--off' : ''}`}
                                  onClick={() => {
                                    setExcluded((prev) => {
                                      const next = new Set(prev);
                                      const key = `${r}:${c}`;
                                      if (next.has(key)) next.delete(key);
                                      else next.add(key);
                                      return next;
                                    });
                                    setDirty(true);
                                  }}>
                                  {f.toFixed(4)}
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {hasCalcs ? (
            <>
              <section className="np-struct-card">
                <div className="np-struct-card-header">
                  <div>
                    <div className="np-struct-card-h2">{dataMode === 'DIRECT' ? 'Input' : 'Actual'} Development Factors</div>
                    <div className="np-struct-card-hint">{dataMode === 'DIRECT' ? 'From the manual LDF inputs.' : `Derived from the excess triangle (${avgMethod}).`}</div>
                  </div>
                </div>
                <FactorTable pattern={activeCalcs.pattern} cdfs={activeCalcs.cdfs} />
              </section>
              <section className="np-struct-card">
                <div className="np-struct-card-header">
                  <div>
                    <div className="np-struct-card-h2">Parametrized Development Factors</div>
                    <div className="np-struct-card-hint">Exponential fit to the cumulative development.</div>
                  </div>
                </div>
                <FactorTable pattern={activeCalcs.paramLdfs} cdfs={activeCalcs.paramCdfs} accent="param" />
              </section>
              {projMethod === 'BF' && bfResults && (
                <section className="np-struct-card">
                  <div className="np-struct-card-header">
                    <div>
                      <div className="np-struct-card-h2">BF Projections</div>
                      <div className="np-struct-card-hint">Latest + (EGNPI × IELR × % unreported), EGNPI from the Premiums Table.</div>
                    </div>
                  </div>
                  <div className="np-table-wrap">
                    <table className="mod-table mod-table--compact">
                      <thead><tr><th>YEAR</th><th className="mod-num">LATEST</th><th className="mod-num">CDF</th><th className="mod-num">EGNPI</th><th className="mod-num">EXPECTED IBNR</th><th className="mod-num">BF ULTIMATE</th><th className="mod-num">BF XS LR</th></tr></thead>
                      <tbody>
                        {bfResults.map((r) => (
                          <tr key={r.year}>
                            <td>{r.year}</td>
                            <td className="mod-num">{fmtOrEm(Math.round(r.latest))}</td>
                            <td className="mod-num">{fmt4(r.cdf)}</td>
                            <td className="mod-num">{fmtOrEm(Math.round(r.premium))}</td>
                            <td className="mod-num">{fmtOrEm(Math.round(r.expectedIbnr))}</td>
                            <td className="mod-num"><b>{fmtOrEm(Math.round(r.ultimate))}</b></td>
                            <td className="mod-num">{fPct(r.lossRatio)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              <section className="np-struct-card df-chosen">
                <div className="np-struct-card-header">
                  <div>
                    <div className="np-struct-card-h2">Underwriter Chosen Factors</div>
                    <div className="np-struct-card-hint">The set the ultimate summary develops with.</div>
                  </div>
                  <Toggle value={chosenBase} disabled={!meta.canEdit}
                    options={[['ACTUAL', dataMode === 'DIRECT' ? 'INPUT' : 'ACTUAL'], ['PARAM', 'PARAM']]}
                    onChange={switchBase} />
                </div>
                {chosenLdfs.length > 0 ? (
                  <FactorTable pattern={chosenLdfs} cdfs={chosenCdfs} editable={meta.canEdit} accent="chosen"
                    onChange={(kind, idx, val) => {
                      const n = val === '' ? null : Number(val);
                      const set = kind === 'ldf' ? setChosenLdfs : setChosenCdfs;
                      set((prev) => { const a = [...prev]; a[idx] = Number.isFinite(n) ? n : val; return a; });
                      setDirty(true);
                    }} />
                ) : (
                  <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={!meta.canEdit}
                    onClick={() => switchBase(chosenBase)}>
                    ↳ Load factors from the {chosenBase === 'PARAM' ? 'parametrized' : dataMode === 'DIRECT' ? 'input' : 'actual'} set
                  </button>
                )}
              </section>
            </>
          ) : (
            <Notice tone="info">{dataMode === 'DIRECT' ? 'Enter LDFs above to compute development factors.' : 'Enter excess triangle data above to compute development factors.'}</Notice>
          )}
        </>
      )}

      {view === 'SUMMARY' && (
        chosenLdfs.length === 0 ? (
          <Notice tone="info">Load development factors first (Factors tab).</Notice>
        ) : (
          <section className="np-struct-card">
            <div className="np-struct-card-header">
              <div>
                <div className="np-struct-card-h2">Ultimate Summary</div>
                <div className="np-struct-card-hint">Reported excess losses developed with the chosen CDFs (newest year takes the least-developed factor).</div>
              </div>
            </div>
            <div className="np-table-wrap">
              <table className="mod-table mod-table--compact">
                <thead><tr><th>YEAR</th><th className="mod-num">REPORTED XS</th><th className="mod-num">APPLIED CDF</th><th className="mod-num">IBNR</th><th className="mod-num">ULTIMATE XS</th></tr></thead>
                <tbody>
                  {summaryRows.map((r) => (
                    <tr key={r.year}>
                      <td>{r.year}</td>
                      <td className="mod-num">{fmtOrEm(Math.round(r.reported))}</td>
                      <td className="mod-num">{fmt4(r.cdf)}</td>
                      <td className="mod-num" style={{ color: r.ibnr > 0 ? 'var(--accent-rose)' : undefined }}>{fmtOrEm(Math.round(r.ibnr))}</td>
                      <td className="mod-num"><b>{fmtOrEm(Math.round(r.ultimate))}</b></td>
                    </tr>
                  ))}
                  <tr className="mod-total-row">
                    <td><b>Total</b></td>
                    <td className="mod-num"><b>{fmtOrEm(Math.round(summaryRows.reduce((s, r) => s + r.reported, 0)))}</b></td>
                    <td className="mod-num">—</td>
                    <td className="mod-num" style={{ color: 'var(--accent-rose)' }}><b>{fmtOrEm(Math.round(summaryRows.reduce((s, r) => s + r.ibnr, 0)))}</b></td>
                    <td className="mod-num" style={{ color: 'var(--accent2)' }}><b>{fmtOrEm(Math.round(summaryRows.reduce((s, r) => s + r.ultimate, 0)))}</b></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        )
      )}
    </ModScreen>
  );
}
