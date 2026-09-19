import React, { useEffect, useMemo, useState } from 'react';
import { ModScreen, SaveBar, Notice, Kpi, KpiRow, NumCell, useSaveMsg, pasteGrid, ModModal, basisLabel } from './bits.jsx';
import { useModelling, useScreenSave, lossesOf, premiumByYearOf } from './store.jsx';
import { cn, fmtC, fmtOrEm, fPts, dateInputValue } from './engine.js';

/* Large / Cat loss capture and selection — ported from the modelling tool's
   LossListScreen and LossSelectionScreen, shared by the proportional and
   non-proportional flows. The list is the paste-aware grid (UW year derived
   from the date of loss, manual override sticky, class flagged when not on
   the treaty); the selection screen decides which of those losses feed the
   curve fit, applies per-loss inflation to the inception year, thresholds,
   additional loadings, and the losses ÷ premium loading analysis. */

/* The editable, pastable columns. INCURRED (paid + O/S) sits after O/S and
   NET RETENTION (gross less the cessions) at the end — both derived. The
   gross loss defaults to the incurred; the quota share, 1st and 2nd surplus
   and facultative are what each cession recovers from it. */
const LIST_COLS = [
  { key: 'uwYear', label: 'UW YEAR', type: 'year' },
  { key: 'insuredName', label: 'INSURED NAME', type: 'text' },
  { key: 'lossName', label: 'LOSS / EVENT', type: 'text' },
  { key: 'dateOfLoss', label: 'DATE OF LOSS', type: 'date' },
  { key: 'dateReported', label: 'DATE REPORTED', type: 'date' },
  { key: 'classOfBusiness', label: 'CLASS', type: 'cob' },
  { key: 'grossLoss', label: 'GROSS LOSS', type: 'num', hint: 'Defaults to the incurred (paid + O/S)' },
  { key: 'paid', label: 'PAID', type: 'num' },
  { key: 'os', label: 'O/S', type: 'num' },
  { key: 'quotaShare', label: 'QUOTA SHARE', type: 'num' },
  { key: 'firstSurplus', label: '1ST SURPLUS', type: 'num' },
  { key: 'secondSurplus', label: '2ND SURPLUS', type: 'num' },
  { key: 'facultative', label: 'FACULTATIVE', type: 'num' },
];
const CESSION_KEYS = ['quotaShare', 'firstSurplus', 'secondSurplus', 'facultative'];
const MIN_ROWS = 5;

const emptyRow = () => ({
  uwYear: '', uwYearManual: false, insuredName: '', lossName: '', dateOfLoss: '', dateReported: '',
  classOfBusiness: '', paid: '', os: '',
  grossLoss: '', quotaShare: '', firstSurplus: '', secondSurplus: '', facultative: '',
});
const yearOf = (dateStr) => (/^(\d{4})/.exec(String(dateStr || '').trim())?.[1] || '');
const isRowEmpty = (r) => !r.insuredName && !r.lossName && !r.dateOfLoss && !r.dateReported && !r.classOfBusiness
  && !r.paid && !r.os && !r.grossLoss && !CESSION_KEYS.some((k) => r[k]);
const incurredOf = (r) => cn(r.paid) + cn(r.os);
/** The gross (from-ground-up) loss: as entered, else the incurred. */
const grossOf = (r) => (r.grossLoss !== '' && r.grossLoss != null ? cn(r.grossLoss) : incurredOf(r));
/** What the cedant keeps: the gross loss less the quota share, surplus and facultative recoveries. */
const netRetentionOf = (r) => grossOf(r) - CESSION_KEYS.reduce((s, k) => s + cn(r[k]), 0);

function sectionOf(lossType) { return lossType === 'cat' ? 'cat_losses' : 'large_losses'; }
function selectionSectionOf(lossType) { return lossType === 'cat' ? 'loss_selection_cat' : 'loss_selection_large'; }

/* ── Loss list ───────────────────────────────────────────────────────────── */

export function LossListScreen({ lossType }) {
  const mod = useModelling();
  const { meta, get, save } = mod;
  const section = sectionOf(lossType);
  const label = lossType === 'cat' ? 'Cat' : 'Large';

  const [rows, setRows] = useState(Array.from({ length: MIN_ROWS }, emptyRow));
  const [reportDate, setReportDate] = useState('');
  const [dirty, setDirty] = useState(false);
  const [msg, flash] = useSaveMsg();

  useEffect(() => {
    const data = get(section);
    const losses = data?.losses || [];
    if (losses.length) {
      const loaded = losses.map((l) => {
        const dateOfLoss = dateInputValue(l.date_of_loss || '');
        const uwYear = l.uw_year != null ? String(l.uw_year) : '';
        return {
          uwYear,
          uwYearManual: !!uwYear && uwYear !== yearOf(dateOfLoss),
          insuredName: l.insured_name || '',
          lossName: l.loss_name || '',
          dateOfLoss,
          dateReported: dateInputValue(l.date_reported || ''),
          classOfBusiness: l.class_of_business || '',
          paid: l.paid ? String(l.paid) : '',
          os: l.os ? String(l.os) : '',
          grossLoss: l.gross_loss != null && l.gross_loss !== '' ? String(l.gross_loss) : '',
          quotaShare: l.quota_share ? String(l.quota_share) : '',
          firstSurplus: l.first_surplus ? String(l.first_surplus) : '',
          secondSurplus: l.second_surplus ? String(l.second_surplus) : '',
          facultative: l.facultative ? String(l.facultative) : '',
          is_selected: l.is_selected,
          inflation_factor: l.inflation_factor,
        };
      });
      while (loaded.length < MIN_ROWS) loaded.push(emptyRow());
      setRows(loaded);
    } else {
      setRows(Array.from({ length: MIN_ROWS }, emptyRow));
    }
    setReportDate(dateInputValue(data?.report_date || ''));
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.sections, lossType]);

  const filled = rows.filter((r) => !isRowEmpty(r));
  const cobOptions = meta.cobs || [];
  const unknownCob = filled.filter((r) => r.classOfBusiness && cobOptions.length > 0 && !cobOptions.includes(r.classOfBusiness)).length;
  const totalPaid = rows.reduce((a, r) => a + cn(r.paid), 0);
  const totalOS = rows.reduce((a, r) => a + cn(r.os), 0);

  const handleChange = (idx, field, val) => {
    const v = field === 'dateOfLoss' ? (dateInputValue(val) || val) : val;
    setRows((prev) => {
      const n = [...prev];
      const row = { ...n[idx], [field]: v };
      if (field === 'uwYear') {
        row.uwYearManual = String(v).trim() !== '';
        if (!row.uwYearManual) row.uwYear = yearOf(row.dateOfLoss);
      } else if (field === 'dateOfLoss' && !row.uwYearManual) {
        row.uwYear = yearOf(row.dateOfLoss) || row.uwYear;
      }
      n[idx] = row;
      if (idx >= n.length - 2 && v) while (n.length < idx + 3) n.push(emptyRow());
      return n;
    });
    setDirty(true);
  };

  const handlePaste = (e, ri, ci) => {
    const grid = pasteGrid(e);
    if (!grid) return;
    e.preventDefault();
    setRows((prev) => {
      const n = [...prev];
      grid.forEach((cells, pr) => {
        const rowIdx = ri + pr;
        while (n.length <= rowIdx) n.push(emptyRow());
        cells.forEach((val, pc) => {
          const colIdx = ci + pc;
          if (colIdx >= LIST_COLS.length) return;
          let v = val.trim();
          const key = LIST_COLS[colIdx].key;
          if (key === 'dateOfLoss' && v) v = dateInputValue(v);
          n[rowIdx] = { ...n[rowIdx], [key]: v };
          if (key === 'uwYear') n[rowIdx].uwYearManual = String(v).trim() !== '';
        });
        if (!n[rowIdx].uwYearManual) {
          const d = yearOf(n[rowIdx].dateOfLoss);
          if (d) n[rowIdx] = { ...n[rowIdx], uwYear: d };
        }
      });
      let lastFilled = n.length - 1;
      while (lastFilled >= 0 && isRowEmpty(n[lastFilled])) lastFilled--;
      const needed = Math.max(MIN_ROWS, lastFilled + 3);
      while (n.length < needed) n.push(emptyRow());
      return n;
    });
    setDirty(true);
  };

  const doSave = async () => {
    if (!dirty) return true;
    try {
      const losses = rows.filter((r) => !isRowEmpty(r)).map((r) => ({
        insured_name: r.insuredName,
        loss_name: r.lossName,
        uw_year: r.uwYear ? Number(String(r.uwYear).replace(/[^0-9]/g, '')) || null : null,
        date_of_loss: dateInputValue(r.dateOfLoss) || null,
        date_reported: dateInputValue(r.dateReported) || null,
        class_of_business: r.classOfBusiness,
        paid: cn(r.paid),
        os: cn(r.os),
        incurred: incurredOf(r),
        // The gross-to-net split: gross as entered (null = the incurred),
        // the cessions, and the net retention resolved from them.
        gross_loss: r.grossLoss !== '' && r.grossLoss != null ? cn(r.grossLoss) : null,
        quota_share: cn(r.quotaShare),
        first_surplus: cn(r.firstSurplus),
        second_surplus: cn(r.secondSurplus),
        facultative: cn(r.facultative),
        net_retention: netRetentionOf(r),
        // Selection state survives a list edit (selection defaults to true).
        is_selected: r.is_selected !== false,
        inflation_factor: r.inflation_factor ?? 1,
      }));
      await save(section, { report_date: reportDate || null, losses });
      setDirty(false);
      flash('ok', `Saved ${losses.length} record${losses.length === 1 ? '' : 's'}`);
      return true;
    } catch (e) {
      flash('err', `Save failed: ${e.message || 'server error'}`);
      return false;
    }
  };
  useScreenSave(mod, doSave);

  return (
    <ModScreen pill={`${basisLabel(meta)} TREATY: ${label.toUpperCase()} LOSSES`}
      title={`${label} Loss List`}
      sub="Individual loss records from the cedant. UW year auto-derives from the date of loss (a typed year sticks); paste whole blocks from Excel."
      actions={(
        <SaveBar dirty={dirty} msg={msg} onSave={doSave} canEdit={meta.canEdit}
          extra={meta.canEdit && (
            <button type="button" className="np-struct-btn"
              onClick={() => { setRows(Array.from({ length: MIN_ROWS }, emptyRow)); setDirty(true); }}>
              ✕ Clear
            </button>
          )} />
      )}>
      <div className="tri-info-bar">
        <div className="tri-info-item">Report Date{' '}
          <input type="date" className="np-mini-input" style={{ width: 150 }} value={reportDate} disabled={!meta.canEdit}
            onChange={(e) => { setReportDate(e.target.value); setDirty(true); }} />
        </div>
        <div className="tri-info-item">{filled.length} record{filled.length === 1 ? '' : 's'}</div>
        {unknownCob > 0 && (
          <div className="tri-info-item" style={{ color: 'var(--accent-amber)' }}>
            ⚠ {unknownCob} row{unknownCob === 1 ? '' : 's'} with a class not on the treaty
          </div>
        )}
      </div>

      <div className="np-table-wrap">
        <table className="mod-table ll-table">
          <thead>
            <tr>
              <th className="mod-num" style={{ width: 34 }}>#</th>
              {LIST_COLS.map((c) => (
                <React.Fragment key={c.key}>
                  <th title={c.hint || ''} className={c.type === 'num' ? 'mod-num' : c.type === 'year' ? 'mod-cell--center' : undefined}>{c.label}</th>
                  {c.key === 'os' && <th className="mod-num" title="Paid + O/S">INCURRED</th>}
                </React.Fragment>
              ))}
              <th className="mod-num" title="Gross loss less quota share, surplus and facultative">NET RETENTION</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={isRowEmpty(r) ? 'll-row--empty' : ''}>
                <td className="mod-num muted">{i + 1}</td>
                {LIST_COLS.map((c, ci) => (
                  <React.Fragment key={c.key}>
                  <td>
                    {c.type === 'num' ? (
                      <NumCell value={r[c.key]} readOnly={!meta.canEdit}
                        placeholder={c.key === 'grossLoss' && incurredOf(r) > 0 ? fmtC(incurredOf(r)) : undefined}
                        onChange={(v) => handleChange(i, c.key, v)}
                        onPaste={(e) => handlePaste(e, i, ci)} />
                    ) : c.type === 'cob' ? (
                      <select className="mod-cell mod-cell--left" value={r.classOfBusiness} disabled={!meta.canEdit}
                        style={r.classOfBusiness && cobOptions.length && !cobOptions.includes(r.classOfBusiness)
                          ? { borderColor: 'rgba(180,83,9,.5)', color: 'var(--accent-amber)' } : undefined}
                        onChange={(e) => handleChange(i, 'classOfBusiness', e.target.value)}
                        onPaste={(e) => handlePaste(e, i, ci)}>
                        <option value="">—</option>
                        {cobOptions.map((cob) => <option key={cob} value={cob}>{cob}</option>)}
                        {r.classOfBusiness && !cobOptions.includes(r.classOfBusiness) && (
                          <option value={r.classOfBusiness}>⚠ {r.classOfBusiness}</option>
                        )}
                      </select>
                    ) : (
                      <input className={`mod-cell mod-cell--${c.type === 'year' ? 'center' : 'left'}`}
                        type={c.type === 'date' ? 'date' : c.type === 'year' ? 'number' : 'text'}
                        value={r[c.key] || ''} readOnly={!meta.canEdit}
                        onChange={(e) => handleChange(i, c.key, e.target.value)}
                        onPaste={(e) => handlePaste(e, i, ci)} />
                    )}
                  </td>
                  {c.key === 'os' && (
                    <td className="mod-num" data-col="incurred">{incurredOf(r) > 0 ? fmtC(incurredOf(r)) : '–'}</td>
                  )}
                  </React.Fragment>
                ))}
                <td className="mod-num ll-net" data-col="netRetention"
                  style={netRetentionOf(r) < 0 ? { color: 'var(--accent-rose)' } : undefined}
                  title={netRetentionOf(r) < 0 ? 'The cessions exceed the gross loss' : ''}>
                  {isRowEmpty(r) ? '–' : fmtC(netRetentionOf(r))}
                </td>
              </tr>
            ))}
            <tr className="mod-total-row">
              <td />
              <td colSpan={6}><b>Total</b></td>
              <td className="mod-num"><b>{fmtC(filled.reduce((s, r) => s + grossOf(r), 0))}</b></td>
              <td className="mod-num"><b>{fmtC(totalPaid)}</b></td>
              <td className="mod-num"><b>{fmtC(totalOS)}</b></td>
              <td className="mod-num"><b>{fmtC(totalPaid + totalOS)}</b></td>
              {CESSION_KEYS.map((k) => (
                <td key={k} className="mod-num"><b>{fmtC(filled.reduce((s, r) => s + cn(r[k]), 0))}</b></td>
              ))}
              <td className="mod-num"><b>{fmtC(filled.reduce((s, r) => s + netRetentionOf(r), 0))}</b></td>
            </tr>
          </tbody>
        </table>
      </div>
    </ModScreen>
  );
}

/* ── Loss selection ──────────────────────────────────────────────────────── */

export function LossSelectionScreen({ lossType }) {
  const mod = useModelling();
  const { meta, get, save } = mod;
  const section = sectionOf(lossType);
  const snapSection = selectionSectionOf(lossType);
  const label = lossType === 'cat' ? 'Cat' : 'Large';

  const [losses, setLosses] = useState([]);
  const [threshold, setThreshold] = useState('');
  const [loadings, setLoadings] = useState([]);
  const [inflMode, setInflMode] = useState('manual');
  const [manualInflPct, setManualInflPct] = useState('3.0');
  const [showInfl, setShowInfl] = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [msg, flash] = useSaveMsg();

  useEffect(() => {
    setLosses(lossesOf(mod, lossType));
    const snap = get(snapSection);
    if (snap) {
      if (snap.threshold) setThreshold(String(snap.threshold));
      if (Array.isArray(snap.loadings)) setLoadings(snap.loadings.map((l) => ({ name: l.name || '', pct: l.pct != null ? String(l.pct) : '' })));
      if (snap.inflation_mode) setInflMode(snap.inflation_mode);
      if (snap.inflation_rate_pct != null) setManualInflPct(String(snap.inflation_rate_pct));
    }
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.sections, lossType]);

  const selected = losses.filter((l) => l.is_selected !== false);
  const totalIncurred = selected.reduce((s, l) => s + cn(l.incurred), 0);
  const totalInflated = selected.reduce((s, l) => s + cn(l.incurred) * cn(l.inflation_factor), 0);
  const totalLoadingPct = loadings.reduce((s, l) => s + cn(l.pct), 0);
  const avgFactor = selected.length ? selected.reduce((s, l) => s + cn(l.inflation_factor), 0) / selected.length : 1;

  const premiumByYear = useMemo(() => premiumByYearOf(mod, meta.basis),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mod.sections, meta.basis]);

  const lossLoading = useMemo(() => {
    if (!premiumByYear.length) return { rows: [], totalPremium: 0, totalInflated: 0, overallInflatedPct: null };
    const byYearLoss = new Map();
    for (const l of selected) {
      const y = Number(l.uw_year);
      if (!Number.isFinite(y)) continue;
      const cur = byYearLoss.get(y) || { count: 0, incurred: 0, inflated: 0 };
      cur.count += 1;
      cur.incurred += cn(l.incurred);
      cur.inflated += cn(l.incurred) * cn(l.inflation_factor);
      byYearLoss.set(y, cur);
    }
    const rows = premiumByYear.map(({ year, premium }) => {
      const l = byYearLoss.get(year) || { count: 0, incurred: 0, inflated: 0 };
      return {
        year, premium, ...l,
        pct: premium > 0 ? (l.incurred / premium) * 100 : null,
        inflatedPct: premium > 0 ? (l.inflated / premium) * 100 : null,
      };
    });
    const matched = rows.filter((r) => r.premium > 0);
    const totalPremium = matched.reduce((s, r) => s + r.premium, 0);
    const totInflated = matched.reduce((s, r) => s + r.inflated, 0);
    return {
      rows,
      totalPremium,
      totalLosses: matched.reduce((s, r) => s + r.incurred, 0),
      totalInflated: totInflated,
      overallPct: totalPremium > 0 ? (matched.reduce((s, r) => s + r.incurred, 0) / totalPremium) * 100 : null,
      overallInflatedPct: totalPremium > 0 ? (totInflated / totalPremium) * 100 : null,
    };
  }, [premiumByYear, selected]);

  const mutate = (fn) => { setLosses(fn); setDirty(true); };

  const applyInflation = () => {
    const targetYear = meta.inceptionYear;
    const pct = cn(manualInflPct);
    mutate((prev) => prev.map((l) => {
      const lossYear = Number(l.uw_year) || targetYear;
      const years = Math.max(0, targetYear - lossYear);
      const factor = Math.pow(1 + pct / 100, years);
      return { ...l, inflation_factor: Math.round(factor * 10000) / 10000 };
    }));
    setInflMode('manual');
    setShowInfl(false);
  };

  const doSave = async () => {
    if (!dirty) return true;
    try {
      // 1) selection + factors back onto the loss list section
      const listData = get(section) || { losses: [] };
      await save(section, {
        ...listData,
        losses: losses.map((l) => ({
          insured_name: l.insured_name, loss_name: l.loss_name, uw_year: l.uw_year,
          date_of_loss: l.date_of_loss, date_reported: l.date_reported ?? null,
          class_of_business: l.class_of_business,
          paid: cn(l.paid), os: cn(l.os), incurred: cn(l.incurred),
          gross_loss: l.gross_loss ?? null, quota_share: cn(l.quota_share), first_surplus: cn(l.first_surplus),
          second_surplus: cn(l.second_surplus), facultative: cn(l.facultative), net_retention: cn(l.net_retention),
          is_selected: l.is_selected !== false,
          inflation_factor: cn(l.inflation_factor) || 1,
        })),
      });
      // 2) the assumptions snapshot the downstream screens read
      const prevSnap = get(snapSection) || {};
      await save(snapSection, {
        ...prevSnap,
        inflation_mode: inflMode,
        inflation_rate_pct: cn(manualInflPct),
        inflation_to_year: meta.inceptionYear,
        threshold: cn(threshold) || null,
        loadings: loadings.filter((l) => l.name || l.pct),
        total_loading_pct: totalLoadingPct || null,
        selected_count: selected.length,
        selected_losses: selected.map((l) => ({
          uw_year: l.uw_year, insured_name: l.insured_name, loss_name: l.loss_name,
          date_of_loss: l.date_of_loss, date_reported: l.date_reported ?? null, class_of_business: l.class_of_business,
          paid: cn(l.paid), os: cn(l.os), incurred: cn(l.incurred),
          gross_loss: l.gross_loss ?? null, quota_share: cn(l.quota_share), first_surplus: cn(l.first_surplus),
          second_surplus: cn(l.second_surplus), facultative: cn(l.facultative), net_retention: cn(l.net_retention),
          inflation_factor: cn(l.inflation_factor),
          inflated_incurred: cn(l.incurred) * cn(l.inflation_factor),
        })),
      });
      setDirty(false);
      flash('ok', 'Selection saved');
      return true;
    } catch (e) {
      flash('err', `Save failed: ${e.message || 'server error'}`);
      return false;
    }
  };
  useScreenSave(mod, doSave);

  return (
    <ModScreen pill={`${basisLabel(meta)} TREATY: ${label.toUpperCase()} LOSS SELECTION`}
      title={`${label} Loss Selection`}
      sub="Choose which losses feed the curve fit, bring each to the inception year with an inflation factor, and add loadings."
      actions={<SaveBar dirty={dirty} msg={msg} onSave={doSave} canEdit={meta.canEdit} />}>

      <KpiRow>
        <Kpi label="Total" value={losses.length} />
        <Kpi label="Selected" value={selected.length} tone="green" />
        <Kpi label="Incurred" value={fmtOrEm(totalIncurred)} />
        <Kpi label="Inflation-Adj" value={fmtOrEm(totalInflated)} tone="blue" />
        <Kpi label="Avg Factor" value={avgFactor.toFixed(4)} />
        <Kpi label="Inception Yr" value={meta.inceptionYear || '—'} />
        {totalLoadingPct > 0 && <Kpi label="Loaded Total" value={fmtOrEm(totalInflated * (1 + totalLoadingPct / 100))} tone="amber" />}
        {lossLoading.overallInflatedPct != null && (
          <Kpi label="Loss Loading" value={fPts(lossLoading.overallInflatedPct)} tone="amber"
            title="Sum of selected (inflated) losses across matched years ÷ premium for those years" />
        )}
      </KpiRow>

      <div className="tri-info-bar">
        <div className="tri-info-item">
          Threshold{' '}
          <NumCell value={threshold} onChange={(v) => { setThreshold(v); setDirty(true); }} placeholder="e.g. 500,000"
            readOnly={!meta.canEdit} className="mod-cell--w120" />
          {meta.canEdit && (
            <button type="button" className="np-struct-btn" onClick={() => {
              const t = cn(threshold);
              if (!t) return;
              mutate((prev) => prev.map((r) => ({ ...r, is_selected: cn(r.incurred) * (cn(r.inflation_factor) || 1) >= t })));
            }}>Apply</button>
          )}
        </div>
        {meta.canEdit && (
          <div className="tri-info-item">
            <button type="button" className="np-struct-btn np-struct-btn--accent" onClick={() => setShowInfl(true)}>Inflation…</button>
            <button type="button" className="np-struct-btn" title="Increase every loss's inflation factor by 10%"
              onClick={() => mutate((prev) => prev.map((l) => ({ ...l, inflation_factor: Math.round(cn(l.inflation_factor) * 1.1 * 10000) / 10000 })))}>
              Factor +10%
            </button>
            <button type="button" className="np-struct-btn" onClick={() => setShowLoading(true)}>📈 Loss Loading</button>
            <button type="button" className="np-struct-btn" onClick={() => mutate((prev) => prev.map((r) => ({ ...r, is_selected: true })))}>All</button>
            <button type="button" className="np-struct-btn" onClick={() => mutate((prev) => prev.map((r) => ({ ...r, is_selected: false })))}>None</button>
          </div>
        )}
      </div>

      <div className="np-table-wrap">
        <table className="mod-table">
          <thead>
            <tr>
              <th style={{ width: 34 }}>✓</th><th className="mod-num">YEAR</th><th>INSURED / EVENT</th><th>LOSS NAME</th><th>DATE</th>
              <th className="mod-num">PAID</th><th className="mod-num">OS</th><th className="mod-num">INCURRED</th><th className="mod-cell--center" style={{ width: 96 }}>FACTOR</th><th className="mod-num">INFLATED</th>
            </tr>
          </thead>
          <tbody>
            {losses.length === 0 && (
              <tr><td colSpan={10} className="muted" style={{ padding: 12 }}>No losses found — enter them on the {label} Loss List screen.</td></tr>
            )}
            {losses.map((l, i) => (
              <tr key={i} className={l.is_selected === false ? 'll-row--off' : ''}>
                <td>
                  <input type="checkbox" className="np-check" checked={l.is_selected !== false} disabled={!meta.canEdit}
                    onChange={() => mutate((prev) => {
                      const n = [...prev];
                      n[i] = { ...n[i], is_selected: !(n[i].is_selected !== false) };
                      return n;
                    })} />
                </td>
                <td className="mod-num">{l.uw_year || '—'}</td>
                <td>{l.insured_name || '—'}</td>
                <td>{l.loss_name || '—'}</td>
                <td>{(l.date_of_loss || '').slice(0, 10) || '—'}</td>
                <td className="mod-num">{fmtOrEm(cn(l.paid))}</td>
                <td className="mod-num">{fmtOrEm(cn(l.os))}</td>
                <td className="mod-num"><b>{fmtOrEm(cn(l.incurred))}</b></td>
                <td>
                  <NumCell value={String(l.inflation_factor ?? 1)} readOnly={!meta.canEdit} align="center"
                    onChange={(v) => mutate((prev) => {
                      const n = [...prev];
                      n[i] = { ...n[i], inflation_factor: v };
                      return n;
                    })} />
                </td>
                <td className="mod-num" style={{ color: 'var(--accent-blue)' }}>{fmtOrEm(cn(l.incurred) * cn(l.inflation_factor))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="np-struct-card" style={{ marginTop: 12 }}>
        <div className="np-struct-card-header">
          <div>
            <div className="np-struct-card-h2">Additional Loadings</div>
            <div className="np-struct-card-hint">IBNR, trend or other adjustments applied on top of the inflated total.</div>
          </div>
          {meta.canEdit && (
            <button type="button" className="np-struct-btn np-struct-btn--accent"
              onClick={() => { setLoadings((prev) => [...prev, { name: '', pct: '' }]); setDirty(true); }}>
              ＋ Add loading
            </button>
          )}
        </div>
        {loadings.length === 0
          ? <div className="muted" style={{ fontSize: '.85rem' }}>No additional loadings.</div>
          : (
            <div className="ls-loadings-grid">
              {loadings.map((ld, i) => (
                <div key={i} className="ls-loading-row">
                  <input className="mod-cell mod-cell--left" style={{ flex: 1 }} placeholder="Loading name (e.g. IBNR)"
                    value={ld.name} readOnly={!meta.canEdit}
                    onChange={(e) => { setLoadings((prev) => prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x))); setDirty(true); }} />
                  <NumCell value={ld.pct} readOnly={!meta.canEdit} align="center" className="mod-cell--w90" placeholder="%"
                    onChange={(v) => { setLoadings((prev) => prev.map((x, j) => (j === i ? { ...x, pct: v } : x))); setDirty(true); }} />
                  {meta.canEdit && (
                    <button type="button" className="renew-x" aria-label="Remove loading"
                      onClick={() => { setLoadings((prev) => prev.filter((_, j) => j !== i)); setDirty(true); }}>✕</button>
                  )}
                </div>
              ))}
              <div className="muted" style={{ fontSize: '.85rem' }}>
                Total loading <b>{fPts(totalLoadingPct)}</b> → loaded total <b>{fmtOrEm(totalInflated * (1 + totalLoadingPct / 100))}</b>
              </div>
            </div>
          )}
      </section>

      {showInfl && (
        <ModModal title={`Inflation Adjustment — to ${meta.inceptionYear}`}
          sub="A flat annual rate compounded from each loss year to the inception year."
          onClose={() => setShowInfl(false)}>
          <div className="tri-info-bar" style={{ marginBottom: 10 }}>
            <div className="tri-info-item">Annual Rate{' '}
              <NumCell value={manualInflPct} onChange={setManualInflPct} align="center" className="mod-cell--w90" placeholder="%" />
              <span className="muted">% per year</span>
            </div>
          </div>
          <div className="toolbar">
            <button type="button" className="np-struct-btn" onClick={() => setShowInfl(false)}>Cancel</button>
            <button type="button" className="np-green-pill" onClick={applyInflation}>Apply Inflation</button>
          </div>
        </ModModal>
      )}

      {showLoading && (
        <ModModal wide title={`Loss Loading — ${label} Losses ÷ Premium`}
          sub="Per underwriting year: selected losses ÷ that year's premium. The All Years row is premium-weighted."
          onClose={() => setShowLoading(false)}>
          {premiumByYear.length === 0 ? (
            <Notice tone="info">No premium history found — enter the premium triangle, straight stats, or the NP premiums table first.</Notice>
          ) : (
            <div className="np-table-wrap">
              <table className="mod-table mod-table--compact">
                <thead><tr><th>YEAR</th><th className="mod-num">PREMIUM</th><th className="mod-num">LOSSES</th><th className="mod-num">LOADING</th><th className="mod-num">INFLATED LOSSES</th><th className="mod-num">INFLATED LOADING</th></tr></thead>
                <tbody>
                  {lossLoading.rows.map((r) => (
                    <tr key={r.year}>
                      <td>{r.year}</td>
                      <td className="mod-num">{fmtOrEm(r.premium)}</td>
                      <td className="mod-num">{r.count > 0 ? `${fmtOrEm(r.incurred)} (${r.count})` : '–'}</td>
                      <td className="mod-num">{r.pct == null ? '—' : fPts(r.pct)}</td>
                      <td className="mod-num">{r.count > 0 ? fmtOrEm(r.inflated) : '–'}</td>
                      <td className="mod-num" style={{ color: r.inflatedPct > 0 ? 'var(--accent-amber)' : undefined }}>
                        {r.inflatedPct == null ? '—' : fPts(r.inflatedPct)}
                      </td>
                    </tr>
                  ))}
                  <tr className="mod-total-row">
                    <td><b>All Years</b></td>
                    <td className="mod-num"><b>{fmtOrEm(lossLoading.totalPremium)}</b></td>
                    <td className="mod-num"><b>{fmtOrEm(lossLoading.totalLosses)}</b></td>
                    <td className="mod-num"><b>{lossLoading.overallPct == null ? '—' : fPts(lossLoading.overallPct)}</b></td>
                    <td className="mod-num"><b>{fmtOrEm(lossLoading.totalInflated)}</b></td>
                    <td className="mod-num" style={{ color: 'var(--accent-amber)' }}><b>{lossLoading.overallInflatedPct == null ? '—' : fPts(lossLoading.overallInflatedPct, 2)}</b></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </ModModal>
      )}
    </ModScreen>
  );
}
