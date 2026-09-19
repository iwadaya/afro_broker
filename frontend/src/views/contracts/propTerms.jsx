import React, { useState } from 'react';
import {
  toNumber, propMode, isQsMode, isSurplusMode, retentionAmt, cessionAmt, totalCapacity, surplusCapacity,
} from './calcs.js';

/* The proportional treaty's terms — the Universe treaty detail's LIMIT
   DETAILS, COMMISSIONS, LOSS PARTICIPATION, EPI and BROKERAGE & TAXES — as
   one object stored on the placement's proportional structure
   (`quote_structures[].prop`), in the shape the placement page always wrote,
   so a contract set up before the tool was stripped reads back unchanged;
   plus the numeric field, the toggle pills, and the three editing modals
   (the manual slide, the stepped loss participation, the EPI split). */

export const emptyPropTerms = () => ({
  // The treaty type, mirrored from the contract details so the stored
  // structure describes itself.
  treatyType: '',
  // Universe: whether triangulations are available for the treaty.
  triangulationsAvailable: true,
  // LIMIT DETAILS
  qsLimit: '', retentionPct: '', cessionPct: '', surplusMaxRetention: '', numLines: '',
  eventLimit: '', aal: '',
  // COMMISSIONS — fixed (QS and surplus) or a sliding scale with its bounds
  // and manual table; management expenses, profit commission, LCF.
  commissionMode: 'fixed', commissionPct: '', commissionSurplusPct: '',
  slidingMinLossRatio: '', slidingMaxLossRatio: '',
  slidingMinCommission: '', slidingMaxCommission: '',
  slidingTable: [], provisionalCommissionPct: '',
  mgmtExpensesPct: '', profitCommissionPct: '', lcfYears: '',
  // LOSS PARTICIPATION — off until switched on, as in Universe.
  lossPartEnabled: false, minLossRatioPct: '', maxLossRatioPct: '',
  reinsurerSharePct: '', lpvPct: '', lpSlides: [],
  // EPI — the quota share and surplus EPIs, their total, and the split by class.
  quotaShareEpi: '', surplusEpi: '', epi: '', epiSplit: [],
  // BROKERAGE & TAXES
  brokeragePct: '', taxesPct: '', lossCapPct: '', cashLossAdvice: '',
});

/** Stored terms from before the sectioned detail carried a single
    loss-participation % and a single EPI; and a record written before the
    cession % was stored derives it from the retention. */
export const upgradePropTerms = (t) => {
  const u = { ...emptyPropTerms(), ...(t || {}) };
  if (!u.reinsurerSharePct && u.lpvPct) u.reinsurerSharePct = u.lpvPct;
  if (!u.quotaShareEpi && !u.surplusEpi && u.epi) {
    if (propMode(u.treatyType) === 'surplus') u.surplusEpi = u.epi;
    else u.quotaShareEpi = u.epi;
  }
  if ((u.cessionPct === '' || u.cessionPct == null) && u.retentionPct !== '' && u.retentionPct != null) {
    const r = toNumber(u.retentionPct);
    if (r != null) u.cessionPct = String(+Math.max(0, Math.min(100, 100 - r)).toFixed(6));
  }
  return u;
};

/** The Universe auto-calcs for the terms: which halves the treaty type
    activates, the retention and cession amounts, the surplus capacity and
    the total treaty capacity. */
export function propCalcs(t, treatyTypeName = t?.treatyType) {
  const mode = propMode(treatyTypeName);
  const hasQS = isQsMode(mode);
  const hasSurplus = isSurplusMode(mode);
  return {
    mode,
    hasQS,
    hasSurplus,
    retAmt: hasQS ? retentionAmt(t.qsLimit, t.retentionPct) : null,
    cesAmt: hasQS ? cessionAmt(t.qsLimit, t.cessionPct) : null,
    surplusCapacity: hasSurplus ? surplusCapacity(t) : null,
    capacity: treatyTypeName ? totalCapacity({ mode, qsLimit: t.qsLimit, surplusMaxRetention: t.surplusMaxRetention, numLines: t.numLines }) : null,
  };
}

/** The QS + Surplus EPI total, mirrored into the legacy single `epi`. */
export const totalEpiOf = (t) => (toNumber(t.quotaShareEpi) || 0) + (toNumber(t.surplusEpi) || 0);

/** A derived amount for display: grouped digits, blank when unknown. */
export const fmtAmount = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));

/* ── inputs ── */

/** Strip grouping separators and any suffix, leaving a plain number string. */
const cleanNum = (v) => String(v).replace(/[^0-9.-]/g, '');
/** Group a number string for display, keeping the fraction typed so far. */
const displayNum = (v, suffix) => {
  if (v === '' || v == null) return '';
  const m = /^(-?)(\d*)(\.\d*)?$/.exec(String(v));
  if (!m) return String(v);
  const [, sign, int, frac = ''] = m;
  const grouped = int === '' ? '' : Number(int).toLocaleString('en-US');
  return `${sign}${grouped}${frac}${suffix || ''}`;
};

/**
 * A numeric treaty-detail field in the Universe style: shown with thousands
 * separators and a % where the field is a rate; the value handed back is an
 * unformatted number string.
 */
export function NumField({ value, onChange, readOnly, suffix, className = '', ...rest }) {
  const handle = (e) => {
    const el = e.target;
    // Formatting changes the string length, so hold the caret at a fixed
    // distance from the right — otherwise every inserted separator jumps it.
    const fromRight = el.value.length - (el.selectionStart ?? el.value.length);
    onChange(cleanNum(el.value));
    requestAnimationFrame(() => {
      if (document.activeElement !== el) return;
      const pos = Math.max(0, el.value.length - fromRight);
      el.setSelectionRange(pos, pos);
    });
  };
  return (
    <input
      {...rest}
      className={`fi${readOnly ? ' fi--readonly' : ''}${className ? ` ${className}` : ''}`}
      type="text"
      inputMode="decimal"
      value={displayNum(value, suffix)}
      readOnly={readOnly}
      onChange={readOnly ? undefined : handle}
    />
  );
}

/** A derived value: read-only, "auto" until it can be computed. */
export function Derived({ value, ...rest }) {
  return <input className="fi fi--readonly" readOnly placeholder="auto" value={value ?? ''} {...rest} />;
}

/** FIXED / SLIDING and YES / NO toggles, in the Universe pill style. */
export function MiniPills({ options, value, onChange, readOnly, ariaLabel }) {
  return (
    <div className="np-type-pills np-type-pills--mini" role="group" aria-label={ariaLabel}>
      {options.map(([v, label]) => (
        <button key={label} type="button" disabled={readOnly}
          className={`np-type-pill ${value === v ? 'is-on' : 'is-off'}`}
          aria-pressed={value === v}
          onClick={readOnly ? undefined : () => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** The editing modal shell the three terms modals share. */
export function ModModal({ title, sub, onClose, children, wide }) {
  return (
    <div className="mod-modal-backdrop" role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`mod-modal${wide ? ' mod-modal--wide' : ''}`} role="dialog" aria-modal="true">
        <div className="mod-modal-head">
          <div>
            <div className="mod-modal-title">{title}</div>
            {sub && <div className="mod-modal-sub">{sub}</div>}
          </div>
          <button type="button" className="mod-modal-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="mod-modal-body">{children}</div>
      </div>
    </div>
  );
}

function Term({ label, children }) {
  return (
    <div>
      <div className="np-term-label">{label}</div>
      {children}
    </div>
  );
}

/** Sliding-scale commission table — the provisional % plus the loss-ratio
    bands the commission slides between (the Universe manual slide). */
export function SlidingScaleModal({ terms, onSave, onClose, readOnly }) {
  const [rows, setRows] = useState(() => {
    const r = (terms.slidingTable || []).map((x) => ({ ...x }));
    while (r.length < 10) r.push({ lossRatioPct: '', commissionPct: '' });
    return r;
  });
  const [prov, setProv] = useState(terms.provisionalCommissionPct || '');
  const upd = (i, key, v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  return (
    <ModModal title="Sliding Scale Commission Table"
      sub="Loss ratio bands and the commission each pays — the scale slides between rows."
      onClose={onClose}>
      <div className="np-terms-grid" style={{ marginBottom: 4 }}>
        <Term label="Provisional Commission %">
          <NumField suffix="%" value={prov} readOnly={readOnly} placeholder="e.g. 30%" onChange={setProv} />
        </Term>
      </div>
      <div className="str-wrap">
        <table className="str-table" data-testid="sliding-table">
          <thead><tr><th>LOSS RATIO %</th><th>COMMISSION %</th><th className="str-x-cell" /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><NumField suffix="%" value={r.lossRatioPct} readOnly={readOnly}
                  placeholder="e.g. 65%" onChange={(v) => upd(i, 'lossRatioPct', v)} /></td>
                <td><NumField suffix="%" value={r.commissionPct} readOnly={readOnly}
                  placeholder="e.g. 30%" onChange={(v) => upd(i, 'commissionPct', v)} /></td>
                <td className="str-x-cell">
                  {!readOnly && (
                    <button type="button" className="np-row-x" aria-label={`Remove row ${i + 1}`}
                      onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>✕</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="np-modal-actions">
        {!readOnly && (
          <button type="button" className="np-struct-btn"
            onClick={() => setRows((rs) => [...rs, { lossRatioPct: '', commissionPct: '' }])}>
            ＋ Add row
          </button>
        )}
        <span className="np-modal-actions-gap" />
        <button type="button" className="np-struct-btn" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
        {!readOnly && (
          <button type="button" className="np-struct-btn np-struct-btn--primary" data-testid="save-sliding-table"
            onClick={() => onSave({
              slidingTable: rows.filter((r) =>
                String(r.lossRatioPct ?? '').trim() !== '' && String(r.commissionPct ?? '').trim() !== ''),
              provisionalCommissionPct: prov,
            })}>
            Save table
          </button>
        )}
      </div>
    </ModModal>
  );
}

/** Stepped loss participation — up to five corridors, each with its own
    reinsurer share. */
export function LpSlidesModal({ terms, onSave, onClose, readOnly }) {
  const pad = (list) => {
    const r = (list || []).slice(0, 5).map((x) => ({ ...x }));
    while (r.length < 5) r.push({ minLr: '', maxLr: '', share: '' });
    return r;
  };
  const [rows, setRows] = useState(() => pad(terms.lpSlides));
  const upd = (i, key, v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  return (
    <ModModal title="Stepped Loss Participation"
      sub="Up to 5 corridors with different reinsurer shares. Leave unused rows blank."
      onClose={onClose}>
      <div className="str-wrap">
        <table className="str-table" data-testid="lp-slides-table">
          <thead><tr><th className="np-slide-num" /><th>MIN LR %</th><th>MAX LR %</th><th>RE SHARE %</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="np-slide-num">{i + 1}</td>
                <td><NumField suffix="%" value={r.minLr} readOnly={readOnly}
                  placeholder="e.g. 70%" onChange={(v) => upd(i, 'minLr', v)} /></td>
                <td><NumField suffix="%" value={r.maxLr} readOnly={readOnly}
                  placeholder="e.g. 100%" onChange={(v) => upd(i, 'maxLr', v)} /></td>
                <td><NumField suffix="%" value={r.share} readOnly={readOnly}
                  placeholder="e.g. 50%" onChange={(v) => upd(i, 'share', v)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="np-modal-actions">
        {!readOnly && (
          <button type="button" className="np-struct-btn" onClick={() => setRows(pad([]))}>Clear all</button>
        )}
        <span className="np-modal-actions-gap" />
        <button type="button" className="np-struct-btn" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
        {!readOnly && (
          <button type="button" className="np-struct-btn np-struct-btn--primary" data-testid="save-lp-slides"
            onClick={() => onSave({ lpSlides: rows.filter((r) => r.minLr || r.maxLr || r.share) })}>
            Save corridors
          </button>
        )}
      </div>
    </ModModal>
  );
}

/** EPI split by line of business — an equal share of the QS + Surplus EPI
    total until entered, and a split that doesn't add back up is confirmed
    before it is kept. */
export function EpiSplitModal({ terms, cobNames, onSave, onClose, readOnly }) {
  const totalRef = totalEpiOf(terms);
  const [rows, setRows] = useState(() => (cobNames || []).map((cob) => {
    const existing = (terms.epiSplit || []).find((r) => r.cob === cob);
    const equal = totalRef && cobNames.length ? String(Math.round(totalRef / cobNames.length)) : '';
    return { cob, premium: existing?.premium ?? equal };
  }));
  const num = (v) => toNumber(v) || 0;
  const totalSplit = rows.reduce((s, r) => s + num(r.premium), 0);
  const pctOf = (p) => (totalRef > 0 && num(p) ? `${((num(p) / totalRef) * 100).toFixed(1)}%` : '—');
  const matched = totalRef > 0 && Math.abs(totalSplit - totalRef) < 1;
  const save = () => {
    if (totalRef > 0 && Math.abs(totalSplit - totalRef) > 1) {
      const msg = `Split total (${fmtAmount(Math.round(totalSplit))}) doesn't match the EPI total (${fmtAmount(Math.round(totalRef))}). Save anyway?`;
      if (!window.confirm(msg)) return;
    }
    onSave({ epiSplit: rows });
  };
  return (
    <ModModal title="EPI Split by Line of Business"
      sub="How the estimated premium income divides across the treaty's classes."
      onClose={onClose}>
      <div className="np-epi-ref">
        <span>QS: <b>{fmtAmount(toNumber(terms.quotaShareEpi)) || '—'}</b></span>
        <span>Surplus: <b>{fmtAmount(toNumber(terms.surplusEpi)) || '—'}</b></span>
        <span>Total: <b>{totalRef ? fmtAmount(Math.round(totalRef)) : '—'}</b></span>
      </div>
      <div className="str-wrap">
        <table className="str-table" data-testid="epi-split-table">
          <thead><tr><th>LINE OF BUSINESS</th><th>PREMIUM</th><th className="np-num-h">% OF TOTAL</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.cob}>
                <td className="np-epi-cob">{r.cob}</td>
                <td><NumField value={r.premium} readOnly={readOnly} placeholder="e.g. 1,000,000"
                  onChange={(v) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, premium: v } : x)))} /></td>
                <td className="np-num-h">{pctOf(r.premium)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="np-epi-total">
              <td>TOTAL</td>
              <td>{totalSplit ? fmtAmount(Math.round(totalSplit)) : '—'}</td>
              <td className="np-num-h" style={{ color: matched ? 'var(--accent2)' : 'var(--accent-amber)' }}>
                {totalRef > 0 && totalSplit > 0 ? `${((totalSplit / totalRef) * 100).toFixed(1)}%` : '—'}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="np-modal-actions">
        <span className="np-modal-actions-gap" />
        <button type="button" className="np-struct-btn" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
        {!readOnly && (
          <button type="button" className="np-struct-btn np-struct-btn--primary" onClick={save} data-testid="save-epi-split">
            Save split
          </button>
        )}
      </div>
    </ModModal>
  );
}
