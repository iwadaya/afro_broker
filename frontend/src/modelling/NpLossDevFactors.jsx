import React, { useEffect, useMemo, useState } from 'react';
import { ModScreen, SaveBar, Toggle, Notice, Kpi, KpiRow, useSaveMsg } from './bits.jsx';
import { useModelling, useScreenSave, selectedLossesOf } from './store.jsx';
import { cn, fmtOrEm, fmt4 } from './engine.js';

/* NP Large / Cat loss development factors — ported from the modelling tool's
   NpLossDevFactors: the selected losses grouped by accident year, manual
   LDFs (benchmark or market factors) developing reported → ultimate, with
   the IBNR read off per year. */

function ldfsToCdfs(ldfs, tail) {
  const n = ldfs.length;
  const full = new Array(n + 1).fill(1.0);
  full[n] = tail;
  for (let i = n - 1; i >= 0; i--) full[i] = (Number(ldfs[i]) || 1.0) * full[i + 1];
  return full;
}

export default function NpLossDevFactors({ lossType }) {
  const mod = useModelling();
  const { meta, get, save } = mod;
  const section = lossType === 'cat' ? 'np_cat_ldf' : 'np_large_ldf';
  const label = lossType === 'cat' ? 'Cat' : 'Large';

  const [ldfCount, setLdfCount] = useState(5);
  const [ldfs, setLdfs] = useState(Array(15).fill(''));
  const [tailFactor, setTailFactor] = useState('1.0');
  const [view, setView] = useState('FACTORS');
  const [dirty, setDirty] = useState(false);
  const [msg, flash] = useSaveMsg();

  const selectedLosses = useMemo(() => selectedLossesOf(mod, lossType),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mod.sections, lossType]);

  useEffect(() => {
    const data = get(section);
    if (data) {
      if (Array.isArray(data.manualLdfs)) {
        const arr = Array(15).fill('');
        data.manualLdfs.forEach((v, i) => { if (i < 15) arr[i] = v ? String(v) : ''; });
        setLdfs(arr);
      }
      if (data.manualLdfCount) setLdfCount(Number(data.manualLdfCount) || 5);
      if (data.tailFactor != null) setTailFactor(String(data.tailFactor));
    } else {
      setLdfs(Array(15).fill(''));
      setLdfCount(5);
      setTailFactor('1.0');
    }
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.sections, lossType]);

  const ayRows = useMemo(() => {
    const map = {};
    selectedLosses.forEach((l) => {
      const year = l.uw_year || '?';
      const inflated = cn(l.inflated_incurred) || cn(l.incurred) * cn(l.inflation_factor || 1);
      if (!map[year]) map[year] = { year, reported: 0, count: 0 };
      map[year].reported += inflated || cn(l.incurred);
      map[year].count += 1;
    });
    return Object.values(map).sort((a, b) => a.year - b.year);
  }, [selectedLosses]);

  const activeLdfs = ldfs.slice(0, ldfCount).map((v) => Number(v) || 1.0);
  const cdfsFull = ldfsToCdfs(activeLdfs, Number(tailFactor) || 1.0);
  const hasLdfs = activeLdfs.some((v) => v !== 1.0);

  const ultimateRows = useMemo(() => {
    const n = ayRows.length;
    return ayRows.map((r, i) => {
      const ageIdx = Math.max(0, Math.min(cdfsFull.length - 1, n - 1 - i));
      const cdf = cdfsFull[ageIdx] ?? 1.0;
      const ultimate = r.reported * cdf;
      return { ...r, cdf, ultimate, ibnr: ultimate - r.reported };
    });
  }, [ayRows, cdfsFull]);

  const totReported = ayRows.reduce((s, r) => s + r.reported, 0);
  const totUltimate = ultimateRows.reduce((s, r) => s + r.ultimate, 0);
  const totIbnr = ultimateRows.reduce((s, r) => s + r.ibnr, 0);

  const doSave = async () => {
    if (!dirty) return true;
    try {
      const tail = Number(tailFactor) || 1.0;
      await save(section, {
        manualLdfs: ldfs.map((v) => Number(v) || 0),
        manualLdfCount: ldfCount,
        tailFactor: tail,
        factors: activeLdfs.map((ldf, i) => ({ dev_month: (i + 1) * 12, chosen_ldf: ldf, chosen_cdf: cdfsFull[i] ?? tail })),
        ultimates: ultimateRows.map((r) => ({ year: r.year, reported: r.reported, cdf: r.cdf, ultimate: r.ultimate, ibnr: r.ibnr, count: r.count })),
        totalUltimate: totUltimate,
        totalReported: totReported,
        updatedAt: new Date().toISOString(),
      });
      setDirty(false);
      flash('ok', 'Dev factors saved');
      return true;
    } catch (e) {
      flash('err', `Save failed: ${e.message || 'server error'}`);
      return false;
    }
  };
  useScreenSave(mod, doSave);

  return (
    <ModScreen pill={`NON-PROPORTIONAL TREATY: ${label.toUpperCase()} LOSS DEVELOPMENT FACTORS`}
      title={`${label} Loss Dev Factors`}
      sub={`Develop the selected ${label.toLowerCase()} losses from reported (inflated) to ultimate with manual LDFs.`}
      actions={<SaveBar dirty={dirty} msg={msg} onSave={doSave} canEdit={meta.canEdit} />}>

      <KpiRow>
        <Kpi label="Selected Losses" value={selectedLosses.length} />
        <Kpi label="Accident Years" value={ayRows.length} />
        <Kpi label="Total Reported" value={fmtOrEm(Math.round(totReported))} />
        <Kpi label="Total Ultimate" value={fmtOrEm(Math.round(totUltimate))} tone="green" />
        <Kpi label="IBNR" value={fmtOrEm(Math.round(totIbnr))} tone="red" />
      </KpiRow>

      <div className="tri-info-bar">
        <div className="tri-info-item">Dev periods{' '}
          <input type="number" min="1" max="15" className="np-mini-input" style={{ width: 64 }} value={ldfCount}
            disabled={!meta.canEdit}
            onChange={(e) => { setLdfCount(Math.max(1, Math.min(15, Number(e.target.value) || 1))); setDirty(true); }} />
        </div>
        <div className="tri-info-item">Tail factor{' '}
          <input type="number" step="0.01" min="1" className="np-mini-input" style={{ width: 80 }} value={tailFactor}
            disabled={!meta.canEdit}
            onChange={(e) => { setTailFactor(e.target.value); setDirty(true); }} />
        </div>
        <Toggle value={view} onChange={setView} options={[['FACTORS', '📊 Dev Factors'], ['DETAIL', '📋 Loss Detail']]} />
      </div>

      {view === 'FACTORS' ? (
        <>
          <section className="np-struct-card">
            <div className="np-struct-card-header">
              <div>
                <div className="np-struct-card-h2">Development Factors</div>
                <div className="np-struct-card-hint">Enter LDFs from benchmark or market data — 1.000 means fully developed.</div>
              </div>
            </div>
            <div className="np-table-wrap">
              <table className="mod-table mod-table--compact">
                <thead>
                  <tr>
                    <th>FACTOR</th>
                    {Array.from({ length: ldfCount }, (_, i) => <th className="mod-cell--center" key={i}>{i + 1}–{i + 2}</th>)}
                    <th className="mod-num">TAIL</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>LDF</td>
                    {Array.from({ length: ldfCount }, (_, i) => (
                      <td key={i}>
                        <input className="mod-cell mod-cell--center" placeholder="1.000" value={ldfs[i] ?? ''} readOnly={!meta.canEdit}
                          onChange={(e) => { setLdfs((prev) => { const a = [...prev]; a[i] = e.target.value; return a; }); setDirty(true); }} />
                      </td>
                    ))}
                    <td className="mod-num">{Number(tailFactor || 1).toFixed(3)}</td>
                  </tr>
                  <tr>
                    <td style={{ color: 'var(--accent-blue)' }}>CDF</td>
                    {Array.from({ length: ldfCount }, (_, i) => (
                      <td key={i} className="mod-num" style={{ color: 'var(--accent-blue)' }}>{fmt4(cdfsFull[i])}</td>
                    ))}
                    <td className="mod-num" style={{ color: 'var(--accent-blue)' }}>1.0000</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {ayRows.length > 0 && !hasLdfs && (
            <Notice tone="info">All LDFs are 1.0 — ultimates equal reported losses and IBNR is zero. Enter development factors above to project to ultimate.</Notice>
          )}

          {ayRows.length > 0 ? (
            <section className="np-struct-card">
              <div className="np-struct-card-header">
                <div>
                  <div className="np-struct-card-h2">Ultimate Loss Summary</div>
                  <div className="np-struct-card-hint">Selected losses aggregated by accident year, developed with the chosen LDFs.</div>
                </div>
              </div>
              <div className="np-table-wrap">
                <table className="mod-table mod-table--compact">
                  <thead><tr><th>ACC. YEAR</th><th className="mod-num">NO. LOSSES</th><th className="mod-num">REPORTED (INFLATED)</th><th className="mod-num">APPLIED CDF</th><th className="mod-num">IBNR</th><th className="mod-num">ULTIMATE</th></tr></thead>
                  <tbody>
                    {ultimateRows.map((r) => (
                      <tr key={r.year}>
                        <td>{r.year}</td>
                        <td className="mod-num">{r.count}</td>
                        <td className="mod-num">{fmtOrEm(Math.round(r.reported))}</td>
                        <td className="mod-num">{fmt4(r.cdf)}</td>
                        <td className="mod-num" style={{ color: r.ibnr > 0 ? 'var(--accent-rose)' : undefined }}>{fmtOrEm(Math.round(r.ibnr))}</td>
                        <td className="mod-num"><b>{fmtOrEm(Math.round(r.ultimate))}</b></td>
                      </tr>
                    ))}
                    <tr className="mod-total-row">
                      <td><b>Total</b></td>
                      <td className="mod-num">—</td>
                      <td className="mod-num"><b>{fmtOrEm(Math.round(totReported))}</b></td>
                      <td className="mod-num">—</td>
                      <td className="mod-num" style={{ color: 'var(--accent-rose)' }}><b>{fmtOrEm(Math.round(totIbnr))}</b></td>
                      <td className="mod-num" style={{ color: 'var(--accent2)' }}><b>{fmtOrEm(Math.round(totUltimate))}</b></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          ) : (
            <Notice tone="info">No selected losses — go back to the {label} Loss Selection screen and select the losses to include.</Notice>
          )}
        </>
      ) : (
        <section className="np-struct-card">
          <div className="np-struct-card-header">
            <div>
              <div className="np-struct-card-h2">Selected Losses</div>
              <div className="np-struct-card-hint">{selectedLosses.length} losses included in this analysis.</div>
            </div>
          </div>
          <div className="np-table-wrap">
            <table className="mod-table mod-table--compact">
              <thead><tr><th>ACC. YEAR</th><th>INSURED / EVENT</th><th>DATE OF LOSS</th><th className="mod-num">PAID</th><th className="mod-num">OS</th><th className="mod-num">INCURRED</th><th className="mod-num">INFL. FACTOR</th><th className="mod-num">INFLATED</th></tr></thead>
              <tbody>
                {[...selectedLosses].sort((a, b) => (a.uw_year || 0) - (b.uw_year || 0)).map((l, i) => (
                  <tr key={i}>
                    <td>{l.uw_year || '—'}</td>
                    <td>{l.insured_name || l.loss_name || '—'}</td>
                    <td>{(l.date_of_loss || '').slice(0, 10) || '—'}</td>
                    <td className="mod-num">{fmtOrEm(cn(l.paid))}</td>
                    <td className="mod-num">{fmtOrEm(cn(l.os))}</td>
                    <td className="mod-num">{fmtOrEm(cn(l.incurred))}</td>
                    <td className="mod-num">{fmt4(cn(l.inflation_factor || 1))}</td>
                    <td className="mod-num"><b>{fmtOrEm(Math.round(cn(l.incurred) * cn(l.inflation_factor || 1)))}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </ModScreen>
  );
}
