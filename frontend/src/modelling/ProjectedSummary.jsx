import React, { useMemo, useState } from 'react';
import { ModScreen, SaveBar, Notice, Toggle, PairedBars, ChartLegend, ModModal, useSaveMsg } from './bits.jsx';
import { useModelling, useScreenSave, lossCategoryByYear } from './store.jsx';
import { cn, fmtC, fPct, deriveLossComponents, runFinancialEngine, buildTreatyTerms } from './engine.js';
import { projectedRowsFromStore, sourceLabelOf } from './projections.js';

/* Projected Summary — ported from the modelling tool's PropProjectedSummary:
   UNCAPPED ultimates, projected vs actual premium and loss by UW year (with
   the attritional / large / CAT split from the saved loss grids), the
   reserving analysis (paid ultimate vs incurred ultimate), the loss-breakdown
   modal (amounts / percentages) and the paired-bar charts. Saving stores the
   yearly ACTUAL/PROJECTED records for the pricing screen. */

const fmt0 = (n) => (n == null ? '—' : fmtC(Math.round(n)));
const lrHot = (v) => Number.isFinite(v) && v > 1.0;

const TONES = {
  UNDER: { color: 'var(--accent-rose)', label: 'Under Reserving', detail: 'Paid ultimate exceeds incurred ultimate — case reserves may be too low.' },
  OVER: { color: 'var(--accent2)', label: 'Over Reserving', detail: 'Incurred ultimate exceeds paid ultimate — case reserves may be conservative.' },
  BALANCED: { color: 'var(--muted)', label: 'Balanced', detail: 'Paid and incurred ultimates align.' },
  NONE: { color: 'var(--muted)', label: 'No Data', detail: 'Paid and incurred projections are unavailable.' },
};
const classify = (paid, inc) => {
  if (!Number.isFinite(paid) || !Number.isFinite(inc) || (paid === 0 && inc === 0)) return 'NONE';
  const d = paid - inc;
  return d > 0 ? 'UNDER' : d < 0 ? 'OVER' : 'BALANCED';
};

export default function ProjectedSummary() {
  const mod = useModelling();
  const { meta, get, save } = mod;
  const [topMetric, setTopMetric] = useState('PREMIUM');
  const [showAnalyses, setShowAnalyses] = useState(false);
  const [showLossModal, setShowLossModal] = useState(false);
  const [modalTab, setModalTab] = useState('abs');
  const [msg, flash] = useSaveMsg();

  const projection = useMemo(() => projectedRowsFromStore(mod),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mod.sections]);
  const lossCat = useMemo(() => lossCategoryByYear(mod),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mod.sections]);
  const stripLC = get('straight_stats')?.strip_large_cat !== false;

  const terms = useMemo(() => buildTreatyTerms(meta.prop || {}, get('prop_terms') || {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mod.sections, meta.prop]);

  const rows = useMemo(() => projection.rows.map((r) => {
    const large = stripLC ? lossCat.large.get(Number(r.year)) || 0 : 0;
    const cat = stripLC ? lossCat.cat.get(Number(r.year)) || 0 : 0;
    return {
      year: r.year,
      ultPaid: r.ultPaid,
      proj: deriveLossComponents({ premium: r.ultPrem, incurredTotal: r.ultLoss, large, cat }),
      act: deriveLossComponents({ premium: r.actPrem, incurredTotal: r.actLoss, large, cat }),
    };
  }), [projection.rows, lossCat, stripLC]);

  const finByYear = useMemo(() => {
    const engineRows = projection.rows.map((r) => ({ year: r.year, ultPrem: r.ultPrem, ultLoss: r.ultLoss, actPrem: r.actPrem, actLoss: r.actLoss }));
    const finRows = runFinancialEngine(engineRows, terms).rows;
    return new Map(finRows.map((r) => [r.year, r]));
  }, [projection.rows, terms]);

  const tot = useMemo(() => {
    const tUPaid = rows.reduce((a, r) => a + (r.ultPaid || 0), 0);
    const tUL = rows.reduce((a, r) => a + r.proj.incurred, 0);
    return {
      tPrem: rows.reduce((a, r) => a + r.act.premium, 0),
      tUP: rows.reduce((a, r) => a + r.proj.premium, 0),
      tAL: rows.reduce((a, r) => a + r.act.incurred, 0),
      tUL, tUPaid, tUInc: tUL,
    };
  }, [rows]);
  const reservingDelta = tot.tUPaid - tot.tUInc;
  const combined = TONES[classify(tot.tUPaid, tot.tUInc)];

  const barData = rows.map((r) => (topMetric === 'LOSSES'
    ? { year: r.year, proj: r.proj.incurred, act: r.act.incurred }
    : { year: r.year, proj: r.proj.premium, act: r.act.premium }));
  const lrData = rows.map((r) => ({ year: r.year, proj: r.proj.incurredLR * 100, act: r.act.incurredLR * 100 }));

  const lossModalBases = useMemo(() => ([
    {
      key: 'ACTUAL',
      label: 'Actual (Incurred)',
      rows: rows.map((r) => {
        const fin = finByYear.get(r.year) || {};
        const prem = r.act.premium;
        const exp = prem > 0 ? (cn(fin.actComm) + cn(fin.actBrokerage) + cn(fin.actTaxes) + cn(fin.actPC)) / prem : 0;
        const cr = prem > 0 ? (r.act.incurred + cn(fin.actComm) + cn(fin.actBrokerage) + cn(fin.actTaxes) + cn(fin.actPC) - cn(fin.actLPC)) / prem : 0;
        return { year: r.year, ...r.act, expenseRatio: exp, combinedRatio: cr, resultPct: prem > 0 ? cn(fin.actResult) / prem : 0 };
      }),
    },
    {
      key: 'PROJECTED',
      label: 'Projected (Ultimate)',
      rows: rows.map((r) => {
        const fin = finByYear.get(r.year) || {};
        const prem = r.proj.premium;
        const exp = prem > 0 ? (cn(fin.comm) + cn(fin.brokerage) + cn(fin.taxes) + cn(fin.profitComm)) / prem : 0;
        const cr = prem > 0 ? (r.proj.incurred + cn(fin.comm) + cn(fin.brokerage) + cn(fin.taxes) + cn(fin.profitComm) - cn(fin.lpc)) / prem : 0;
        return { year: r.year, ...r.proj, expenseRatio: exp, combinedRatio: cr, resultPct: prem > 0 ? cn(fin.result) / prem : 0 };
      }),
    },
  ]), [rows, finByYear]);

  const sumYearRows = (rs) => {
    const premium = rs.reduce((a, r) => a + r.premium, 0);
    const attritional = rs.reduce((a, r) => a + r.attritional, 0);
    const large = rs.reduce((a, r) => a + r.large, 0);
    const cat = rs.reduce((a, r) => a + r.cat, 0);
    const expenseAmt = rs.reduce((a, r) => a + (r.expenseRatio || 0) * r.premium, 0);
    const combinedAmt = rs.reduce((a, r) => a + (r.combinedRatio || 0) * r.premium, 0);
    const resultAmt = rs.reduce((a, r) => a + (r.resultPct || 0) * r.premium, 0);
    const lr = (n) => (premium > 0 ? n / premium : 0);
    return {
      year: 'Total', premium, attritional, large, cat, incurred: attritional + large + cat,
      attrLR: lr(attritional), largeLR: lr(large), catLR: lr(cat), incurredLR: lr(attritional + large + cat),
      expenseRatio: lr(expenseAmt), combinedRatio: lr(combinedAmt), resultPct: lr(resultAmt),
    };
  };

  const doSave = async () => {
    if (!rows.length) return true;
    try {
      const payload = [];
      rows.forEach((r) => {
        payload.push({ uw_year: r.year, record_type: 'ACTUAL', ultimate_premium: r.act.premium, ultimate_loss: r.act.incurred, loss_ratio: r.act.incurredLR });
        payload.push({ uw_year: r.year, record_type: 'PROJECTED', ultimate_premium: r.proj.premium, ultimate_loss: r.proj.incurred, loss_ratio: r.proj.incurredLR });
      });
      await save('pricing_yearly', { rows: payload, source: projection.source, saved_at: new Date().toISOString() });
      flash('ok', 'Yearly records saved');
      return true;
    } catch (e) {
      flash('err', `Save failed: ${e.message || 'server error'}`);
      return false;
    }
  };
  useScreenSave(mod, doSave);

  const lossCells = (r, tab) => (tab === 'abs' ? (
    <>
      <td className="mod-num">{fmt0(r.premium)}</td>
      <td className="mod-num">{fmt0(r.attritional)}</td>
      <td className="mod-num">{fmt0(r.large)}</td>
      <td className="mod-num">{fmt0(r.cat)}</td>
      <td className="mod-num">{fPct(r.expenseRatio)}</td>
      <td className="mod-num" style={lrHot(r.combinedRatio) ? { color: 'var(--accent-rose)' } : undefined}>{fPct(r.combinedRatio)}</td>
      <td className="mod-num" style={r.resultPct < 0 ? { color: 'var(--accent-rose)' } : undefined}>{fPct(r.resultPct)}</td>
    </>
  ) : (
    <>
      <td className="mod-num">{r.premium > 0 ? '100.0%' : '—'}</td>
      <td className="mod-num" style={lrHot(r.attrLR) ? { color: 'var(--accent-rose)' } : undefined}>{fPct(r.attrLR)}</td>
      <td className="mod-num">{fPct(r.largeLR)}</td>
      <td className="mod-num">{fPct(r.catLR)}</td>
      <td className="mod-num">{fPct(r.expenseRatio)}</td>
      <td className="mod-num" style={lrHot(r.combinedRatio) ? { color: 'var(--accent-rose)' } : undefined}>{fPct(r.combinedRatio)}</td>
      <td className="mod-num" style={r.resultPct < 0 ? { color: 'var(--accent-rose)' } : undefined}>{fPct(r.resultPct)}</td>
    </>
  ));

  return (
    <ModScreen pill="PROPORTIONAL TREATY: PROJECTED SUMMARY" title="Projected Summary — Ultimate vs Actual"
      sub={sourceLabelOf(projection.source)}
      actions={<SaveBar dirty={false} msg={msg} onSave={doSave} canEdit={meta.canEdit} />}>

      {projection.rows.length === 0 && (
        <Notice tone="info">No data yet — enter the triangles or the Straight Stats screen first.</Notice>
      )}
      {projection.usedPlaceholderLdfs && (
        <Notice tone="warn">
          <b>No saved development factors found</b> — the projection is using placeholder benchmark curves. Select and
          save factors on the Development Factors screens before relying on these figures.
        </Notice>
      )}
      {projection.rows.length > 0 && (
        <>
          <Notice tone="info">
            <b>UNCAPPED ULTIMATES.</b> Premium and loss values here are the raw triangle / dev-factor projections. Treaty
            caps, sliding commission, profit commission (with LCF) and loss-participation credits are <b>not</b> applied
            — those live on the Quick Summary, which computes a different loss ratio because claims are capped first.
          </Notice>

          <div className="mod-two-col">
            <div className="mod-col-stack">
              <section className="np-struct-card">
                <div className="np-struct-card-header">
                  <div>
                    <div className="np-struct-card-h2">Projected vs Actual — {topMetric === 'LOSSES' ? 'Losses' : 'Premium'}</div>
                    <div className="np-struct-card-hint">Comparison per underwriting year.</div>
                  </div>
                  <Toggle value={topMetric} options={[['PREMIUM', 'Premium'], ['LOSSES', 'Losses']]} onChange={setTopMetric} />
                </div>
                <ChartLegend items={[['mod-bar--proj', 'Projected'], ['mod-bar--act', 'Actual']]} />
                <PairedBars data={barData} />
              </section>
              <section className="np-struct-card">
                <div className="np-struct-card-header">
                  <div>
                    <div className="np-struct-card-h2">Projected vs Actual Loss Ratio</div>
                    <div className="np-struct-card-hint">Ultimate vs incurred LR.</div>
                  </div>
                </div>
                <ChartLegend items={[['mod-bar--proj', 'Projected'], ['mod-bar--act', 'Actual']]} />
                <PairedBars data={lrData.map((d) => ({ year: d.year, proj: d.proj, act: d.act }))} />
              </section>
            </div>

            <section className="np-struct-card">
              <div className="np-struct-card-header">
                <div>
                  <div className="np-struct-card-h2">Summary Statistics</div>
                  <div className="np-struct-card-hint">Projected ultimate, actual incurred and the reserving check.</div>
                </div>
                <div className="mod-actions">
                  <button type="button" className="np-struct-btn np-struct-btn--accent" onClick={() => setShowLossModal(true)}>▦ Loss Breakdown</button>
                  <button type="button" className="np-struct-btn" onClick={() => setShowAnalyses((v) => !v)}>
                    {showAnalyses ? '▾ Analyses' : '▸ Analyses'}
                  </button>
                </div>
              </div>

              {showAnalyses && (
                <>
                  <div className="np-struct-sub-h">Reserving analysis — paid ultimate vs incurred ultimate</div>
                  <table className="mod-table mod-table--compact">
                    <thead><tr><th>UW YEAR</th><th className="mod-num">PAID ULT</th><th className="mod-num">INCURRED ULT</th><th className="mod-num">Δ</th><th>STATUS</th></tr></thead>
                    <tbody>
                      {rows.map((r) => {
                        const t = TONES[classify(r.ultPaid, r.proj.incurred)];
                        return (
                          <tr key={r.year}>
                            <td>{r.year}</td>
                            <td className="mod-num">{fmt0(r.ultPaid)}</td>
                            <td className="mod-num">{fmt0(r.proj.incurred)}</td>
                            <td className="mod-num" style={{ color: t.color }}>{fmt0((r.ultPaid || 0) - r.proj.incurred)}</td>
                            <td><span className="mod-tone-pill" style={{ color: t.color, borderColor: t.color }}>{t.label.toUpperCase()}</span></td>
                          </tr>
                        );
                      })}
                      <tr className="mod-total-row">
                        <td><b>Combined</b></td>
                        <td className="mod-num"><b>{fmt0(tot.tUPaid)}</b></td>
                        <td className="mod-num"><b>{fmt0(tot.tUInc)}</b></td>
                        <td className="mod-num" style={{ color: combined.color }}><b>{fmt0(reservingDelta)}</b></td>
                        <td><span className="mod-tone-pill" style={{ color: combined.color, borderColor: combined.color }}>{combined.label.toUpperCase()}</span></td>
                      </tr>
                    </tbody>
                  </table>
                  <Notice tone="info">{combined.detail}</Notice>
                </>
              )}

              <div className="np-struct-sub-h">Projected ultimate</div>
              <table className="mod-table mod-table--compact">
                <thead><tr><th>UW YEAR</th><th className="mod-num">PREMIUM</th><th className="mod-num">ULT. LOSSES</th><th className="mod-num">ULT. LR %</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.year}>
                      <td>{r.year}</td>
                      <td className="mod-num">{fmt0(r.proj.premium)}</td>
                      <td className="mod-num">{fmt0(r.proj.incurred)}</td>
                      <td className="mod-num" style={lrHot(r.proj.incurredLR) ? { color: 'var(--accent-rose)' } : undefined}>{fPct(r.proj.incurredLR)}</td>
                    </tr>
                  ))}
                  <tr className="mod-total-row" onClick={() => setShowLossModal(true)} style={{ cursor: 'pointer' }} title="View attritional / large / CAT breakdown">
                    <td><b>Total</b></td>
                    <td className="mod-num"><b>{fmt0(tot.tUP)}</b></td>
                    <td className="mod-num"><b>{fmt0(tot.tUL)}</b></td>
                    <td className="mod-num"><b>{fPct(tot.tUP > 0 ? tot.tUL / tot.tUP : 0)}</b></td>
                  </tr>
                </tbody>
              </table>

              <div className="np-struct-sub-h">Actual incurred</div>
              <table className="mod-table mod-table--compact">
                <thead><tr><th>UW YEAR</th><th className="mod-num">PREMIUM</th><th className="mod-num">INCURRED</th><th className="mod-num">INC. LR %</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.year}>
                      <td>{r.year}</td>
                      <td className="mod-num">{fmt0(r.act.premium)}</td>
                      <td className="mod-num">{fmt0(r.act.incurred)}</td>
                      <td className="mod-num" style={lrHot(r.act.incurredLR) ? { color: 'var(--accent-rose)' } : undefined}>{fPct(r.act.incurredLR)}</td>
                    </tr>
                  ))}
                  <tr className="mod-total-row">
                    <td><b>Total</b></td>
                    <td className="mod-num"><b>{fmt0(tot.tPrem)}</b></td>
                    <td className="mod-num"><b>{fmt0(tot.tAL)}</b></td>
                    <td className="mod-num"><b>{fPct(tot.tPrem > 0 ? tot.tAL / tot.tPrem : 0)}</b></td>
                  </tr>
                </tbody>
              </table>
            </section>
          </div>
        </>
      )}

      {showLossModal && (
        <ModModal wide title="Loss Breakdown — Actual vs Projected"
          sub="Attritional = ultimate / incurred loss − large − CAT (raw incurred from the saved loss grids)."
          onClose={() => setShowLossModal(false)}>
          <Toggle value={modalTab} options={[['abs', 'Amounts'], ['pct', 'Percentages']]} onChange={setModalTab} />
          {lossModalBases.map((base) => (
            <div key={base.key} style={{ marginTop: 12 }}>
              <div className="np-struct-sub-h">{base.label}</div>
              <div className="np-table-wrap">
                <table className="mod-table mod-table--compact">
                  <thead><tr><th>UW YEAR</th><th className="mod-num">PREMIUM</th><th className="mod-num">ATTRITIONAL</th><th className="mod-num">LARGE LOSS</th><th className="mod-num">CAT LOSS</th><th className="mod-num">EXPENSE RATIO</th><th className="mod-num">COMBINED RATIO</th><th className="mod-num">RESULT %</th></tr></thead>
                  <tbody>
                    {base.rows.map((r) => <tr key={r.year}><td>{r.year}</td>{lossCells(r, modalTab)}</tr>)}
                    <tr className="mod-total-row"><td><b>Total</b></td>{lossCells(sumYearRows(base.rows), modalTab)}</tr>
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </ModModal>
      )}
    </ModScreen>
  );
}
