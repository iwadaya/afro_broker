import React, { useEffect, useMemo, useState } from 'react';
import { ModScreen, SaveBar, Notice, Kpi, KpiRow, ModModal, NumCell, useSaveMsg } from './bits.jsx';
import { useModelling, useScreenSave, lossCategoryByYear } from './store.jsx';
import { cn, fmtOrEm, deriveLossComponents, runFinancialEngine, calcStats, buildTreatyTerms } from './engine.js';
import { projectedRowsFromStore } from './projections.js';

/* Quick Summary — ported from the modelling tool's PropQuickSummary: the
   post-treaty-terms view. The same projected ultimates as the Projected
   Summary, transformed by the treaty's loss cap, commission (fixed or
   sliding), brokerage, taxes, profit commission (with loss carry-forward)
   and loss-participation credit — projected and actual side by side, with
   the LR distribution stats. The terms come from the Structure tab's
   proportional terms plus this screen's own terms card (sliding scale,
   taxes, loss cap and LCF live here, saved to the prop_terms section). */

const fmt = (v) => fmtOrEm(v);
const fp = (n) => (n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(1)}%`);

const TERM_FIELDS = [
  ['mode', 'Commission mode', 'select', ['FIXED', 'SLIDING']],
  ['fixed_commission_pct', 'Fixed commission %', 'num'],
  ['sliding_min_loss_ratio', 'Sliding: min LR %', 'num'],
  ['sliding_max_loss_ratio', 'Sliding: max LR %', 'num'],
  ['sliding_min_commission', 'Sliding: min comm %', 'num'],
  ['sliding_max_commission', 'Sliding: max comm %', 'num'],
  ['profit_commission_pct', 'Profit commission %', 'num'],
  ['mgmt_expenses_pct', 'Management expenses %', 'num'],
  ['lcf_years', 'Loss carry-forward years', 'num'],
  ['brokerage_pct', 'Brokerage %', 'num'],
  ['taxes_pct', 'Taxes %', 'num'],
  ['loss_cap_pct', 'Loss cap % of premium', 'num'],
  ['aal', 'AAL (cap fallback)', 'num'],
  ['lp_min_loss_ratio_pct', 'Loss part.: min LR %', 'num'],
  ['lp_max_loss_ratio_pct', 'Loss part.: max LR %', 'num'],
  ['lp_reinsurer_share_pct', 'Loss part.: reinsurer share %', 'num'],
];

export default function QuickSummary() {
  const mod = useModelling();
  const { meta, get, save } = mod;
  const [modal, setModal] = useState(null);
  const [termsDraft, setTermsDraft] = useState({});
  const [dirty, setDirty] = useState(false);
  const [msg, flash] = useSaveMsg();

  useEffect(() => {
    setTermsDraft(get('prop_terms') || {});
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.sections]);

  const terms = useMemo(() => {
    const t = buildTreatyTerms(meta.prop || {}, termsDraft);
    if (cn(t.lp_reinsurer_share_pct) > 0 && cn(t.lp_min_loss_ratio_pct) > 0) t.lp_enabled = true;
    return t;
  }, [meta.prop, termsDraft]);

  const projection = useMemo(() => projectedRowsFromStore(mod),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mod.sections]);
  const lossCat = useMemo(() => lossCategoryByYear(mod),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mod.sections]);
  const stripLC = get('straight_stats')?.strip_large_cat !== false;

  const { rows: calcRows, totals } = useMemo(
    () => runFinancialEngine(projection.rows, terms),
    [projection.rows, terms],
  );
  const stats = useMemo(() => calcStats(calcRows), [calcRows]);

  const largeAmt = (yr) => (stripLC ? lossCat.large.get(Number(yr)) || 0 : 0);
  const catAmt = (yr) => (stripLC ? lossCat.cat.get(Number(yr)) || 0 : 0);
  const projComp = (r) => deriveLossComponents({ premium: r.premium, incurredTotal: r.ultClaims, large: largeAmt(r.year), cat: catAmt(r.year) });
  const actComp = (r) => deriveLossComponents({ premium: r.actPremium, incurredTotal: r.actClaims, large: largeAmt(r.year), cat: catAmt(r.year) });
  const sumComp = (fn, key) => calcRows.reduce((a, r) => a + fn(r)[key], 0);

  const ultLR = totals.premium > 0 ? (totals.ultClaims / totals.premium) * 100 : 0;
  const ultCR = totals.premium > 0 ? ((totals.ultClaims + totals.comm + totals.brokerage + totals.taxes + totals.profitComm - totals.lpc) / totals.premium) * 100 : 0;
  const actLR = totals.actPremium > 0 ? (totals.actClaims / totals.actPremium) * 100 : 0;
  const actCR = totals.actPremium > 0 ? ((totals.actClaims + totals.actComm + totals.actBrokerage + totals.actTaxes + totals.actPC - totals.actLPC) / totals.actPremium) * 100 : 0;

  const doSave = async () => {
    if (!dirty) return true;
    try {
      await save('prop_terms', termsDraft);
      setDirty(false);
      flash('ok', 'Terms saved');
      return true;
    } catch (e) {
      flash('err', `Save failed: ${e.message || 'server error'}`);
      return false;
    }
  };
  useScreenSave(mod, doSave);

  const finTable = (kind) => (
    <div className="np-table-wrap">
      <table className="mod-table mod-table--compact">
        <thead>
          <tr>
            <th>UW YEAR</th><th className="mod-num">PREMIUM</th><th className="mod-num">ATTRITIONAL</th><th className="mod-num">LARGE</th><th className="mod-num">CAT</th><th className="mod-num">COMMISSION</th>
            <th className="mod-num">PROFIT COMM.</th><th className="mod-num">BROKERAGE</th><th className="mod-num">TAXES</th><th className="mod-num">LPC</th><th className="mod-num">RESULT</th><th className="mod-num">CUMULATIVE</th><th className="mod-num">CUM %</th>
          </tr>
        </thead>
        <tbody>
          {calcRows.map((r) => {
            const c = kind === 'proj' ? projComp(r) : actComp(r);
            const v = kind === 'proj'
              ? { prem: r.premium, comm: r.comm, pc: r.profitComm, brok: r.brokerage, taxes: r.taxes, lpc: r.lpc, result: r.result, cum: r.cumResult, cumPct: r.cumResultPct }
              : { prem: r.actPremium, comm: r.actComm, pc: r.actPC, brok: r.actBrokerage, taxes: r.actTaxes, lpc: r.actLPC, result: r.actResult, cum: r.actCumResult, cumPct: r.actCumResultPct };
            return (
              <tr key={r.year}>
                <td>{r.year}</td>
                <td className="mod-num">{fmt(v.prem)}</td>
                <td className="mod-num">{fmt(c.attritional)}</td>
                <td className="mod-num">{fmt(c.large)}</td>
                <td className="mod-num">{fmt(c.cat)}</td>
                <td className="mod-num">{fmt(v.comm)}</td>
                <td className="mod-num">{fmt(v.pc)}</td>
                <td className="mod-num">{fmt(v.brok)}</td>
                <td className="mod-num">{fmt(v.taxes)}</td>
                <td className="mod-num">{fmt(v.lpc)}</td>
                <td className="mod-num" style={{ color: v.result < 0 ? 'var(--accent-rose)' : 'var(--accent2)' }}>{fmt(v.result)}</td>
                <td className="mod-num" style={{ color: v.cum < 0 ? 'var(--accent-rose)' : 'var(--accent2)' }}>{fmt(v.cum)}</td>
                <td className="mod-num" style={{ color: v.cumPct < 0 ? 'var(--accent-rose)' : 'var(--accent2)' }}>{fp(v.cumPct)}</td>
              </tr>
            );
          })}
          <tr className="mod-total-row">
            <td><b>Total</b></td>
            <td className="mod-num"><b>{fmt(kind === 'proj' ? totals.premium : totals.actPremium)}</b></td>
            <td className="mod-num"><b>{fmt(sumComp(kind === 'proj' ? projComp : actComp, 'attritional'))}</b></td>
            <td className="mod-num"><b>{fmt(sumComp(kind === 'proj' ? projComp : actComp, 'large'))}</b></td>
            <td className="mod-num"><b>{fmt(sumComp(kind === 'proj' ? projComp : actComp, 'cat'))}</b></td>
            <td className="mod-num"><b>{fmt(kind === 'proj' ? totals.comm : totals.actComm)}</b></td>
            <td className="mod-num"><b>{fmt(kind === 'proj' ? totals.profitComm : totals.actPC)}</b></td>
            <td className="mod-num"><b>{fmt(kind === 'proj' ? totals.brokerage : totals.actBrokerage)}</b></td>
            <td className="mod-num"><b>{fmt(kind === 'proj' ? totals.taxes : totals.actTaxes)}</b></td>
            <td className="mod-num"><b>{fmt(kind === 'proj' ? totals.lpc : totals.actLPC)}</b></td>
            <td className="mod-num"><b>{fmt(kind === 'proj' ? totals.result : totals.actResult)}</b></td>
            <td className="mod-num"><b>{fmt(kind === 'proj' ? totals.cumResult : totals.actCumResult)}</b></td>
            <td className="mod-num"><b>{fp(kind === 'proj' ? totals.cumResultPct : totals.actCumResultPct)}</b></td>
          </tr>
        </tbody>
      </table>
    </div>
  );

  return (
    <ModScreen pill="PROPORTIONAL TREATY: QUICK SUMMARY" title="Quick Summary"
      sub="Underwriting year summary (projected vs actual) after treaty terms, and the portfolio stats."
      actions={(
        <SaveBar dirty={dirty} msg={msg} onSave={doSave} canEdit={meta.canEdit}
          extra={(
            <>
              <button type="button" className="np-struct-btn" onClick={() => setModal('terms')}>⚙ Treaty Terms</button>
              <button type="button" className="np-struct-btn" onClick={() => setModal('analysis')} disabled={!stats}>Portfolio Analysis</button>
            </>
          )} />
      )}>

      {calcRows.length === 0 ? (
        <Notice tone="info">No triangle or straight-stats data yet — complete the experience screens first.</Notice>
      ) : (
        <>
          <Notice tone="info">
            <b>POST-TREATY-TERMS.</b> The same projected ultimates as the Projected Summary, transformed by this treaty's
            loss cap, commission ({(terms.mode || 'FIXED').toUpperCase() === 'SLIDING' ? 'sliding scale' : `fixed ${cn(terms.fixed_commission_pct)}%`}),
            brokerage {cn(terms.brokerage_pct)}%, taxes {cn(terms.taxes_pct)}%, profit commission{cn(terms.lcf_years) > 0 ? ` (LCF ${cn(terms.lcf_years)} yrs)` : ''} and
            loss participation. Loss ratios here use <b>capped</b> claims.
          </Notice>

          <section className="np-struct-card">
            <div className="np-struct-card-header">
              <div>
                <div className="np-struct-card-h2">Projected by Underwriting Year (Ultimate)</div>
                <div className="np-struct-card-hint">
                  Ultimate loss projections + treaty terms
                  {projection.source === 'saved-factors' && <span style={{ color: 'var(--accent2)' }}> · using saved dev factors</span>}
                  {projection.source === 'triangle-recalc' && <span style={{ color: 'var(--accent-amber)' }}> · recalculated (no saved factors)</span>}
                </div>
              </div>
              <span className="qss-struct-badge">PROJECTED</span>
            </div>
            <KpiRow>
              <Kpi label="Total Ult. Premium" value={fmt(totals.premium)} tone="green" />
              <Kpi label="Total Ult. Claims" value={fmt(totals.ultClaims)} tone="blue" />
              <Kpi label="Ult. Loss Ratio" value={fp(ultLR)} />
              <Kpi label="Ult. Combined Ratio" value={fp(ultCR)} />
            </KpiRow>
            {finTable('proj')}
          </section>

          <section className="np-struct-card">
            <div className="np-struct-card-header">
              <div>
                <div className="np-struct-card-h2">Actual by Underwriting Year (Incurred)</div>
                <div className="np-struct-card-hint">Current incurred (paid + OS) positions.</div>
              </div>
              <span className="qss-struct-badge">ACTUAL</span>
            </div>
            <KpiRow>
              <Kpi label="Total Act. Premium" value={fmt(totals.actPremium)} tone="green" />
              <Kpi label="Total Inc. Claims" value={fmt(totals.actClaims)} tone="blue" />
              <Kpi label="Inc. Loss Ratio" value={fp(actLR)} />
              <Kpi label="Inc. Combined Ratio" value={fp(actCR)} />
            </KpiRow>
            {finTable('act')}
          </section>
        </>
      )}

      {modal === 'terms' && (
        <ModModal title="Treaty Terms" onClose={() => setModal(null)}
          sub="Seeded from the Structure tab's proportional terms; the sliding scale, taxes, loss cap and loss carry-forward live here.">
          <div className="mod-exp-params">
            {TERM_FIELDS.map(([key, label, kind, options]) => (
              <label key={key}>{label}
                {kind === 'select' ? (
                  <select className="mod-cell mod-cell--left" value={termsDraft[key] || options[0]} disabled={!meta.canEdit}
                    onChange={(e) => { setTermsDraft((s) => ({ ...s, [key]: e.target.value })); setDirty(true); }}>
                    {options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <NumCell align="center"
                    value={termsDraft[key] != null ? String(termsDraft[key]) : ''}
                    placeholder={(() => {
                      const seeded = buildTreatyTerms(meta.prop || {}, {})[key];
                      return seeded != null && seeded !== '' && cn(seeded) !== 0 ? String(seeded) : '—';
                    })()}
                    readOnly={!meta.canEdit}
                    onChange={(v) => { setTermsDraft((s) => ({ ...s, [key]: v === '' ? undefined : cn(v) })); setDirty(true); }} />
                )}
              </label>
            ))}
          </div>
          <div className="toolbar" style={{ marginTop: 12 }}>
            <button type="button" className="np-struct-btn" onClick={() => setModal(null)}>Close</button>
            {meta.canEdit && <button type="button" className="np-green-pill" onClick={async () => { const ok = await doSave(); if (ok) setModal(null); }}>Save terms</button>}
          </div>
        </ModModal>
      )}

      {modal === 'analysis' && stats && (
        <ModModal wide title="Portfolio Analysis" sub={`Loss ratio distribution over ${stats.n} underwriting years of incurred data.`} onClose={() => setModal(null)}>
          <KpiRow>
            <Kpi label="Mean LR" value={fp(stats.mean)} tone="blue" />
            <Kpi label="Median LR" value={fp(stats.median)} tone="green" />
            <Kpi label="Std. Deviation" value={stats.stdDev.toFixed(2)} tone="amber" />
            <Kpi label="Min LR" value={fp(stats.min)} />
            <Kpi label="Max LR" value={fp(stats.max)} />
            <Kpi label="Range" value={(stats.max - stats.min).toFixed(1)} />
          </KpiRow>
          <KpiRow>
            <Kpi label="Skewness" value={stats.skewness.toFixed(3)} title={stats.skewness > 0.5 ? 'Right-skewed' : stats.skewness < -0.5 ? 'Left-skewed' : 'Approx. symmetric'} />
            <Kpi label="Excess Kurtosis" value={stats.kurtosis.toFixed(3)} title={stats.kurtosis > 1 ? 'Heavy-tailed' : stats.kurtosis < -1 ? 'Light-tailed' : 'Near-normal'} />
            <Kpi label="Coeff. of Variation" value={fp(stats.cv)} />
            <Kpi label="VaR (95%)" value={fp(stats.var95)} title="1-in-20 year scenario" />
            <Kpi label="VaR (99%)" value={fp(stats.var99)} title="1-in-100 year scenario" />
            <Kpi label="IQR" value={stats.iqr.toFixed(1)} title="Interquartile range" />
          </KpiRow>
        </ModModal>
      )}
    </ModScreen>
  );
}
