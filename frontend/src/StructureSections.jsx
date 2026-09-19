import React, { useState } from 'react';
import { Fr } from './views/treatyDetail.jsx';
import { COUNTRIES } from './refData.js';
import { Link } from 'react-router-dom';
import { classByCode, detectOccupancyClass, autoFillClasses } from './occupancy.js';
import { OccupancyClassTable, useOccupancyClasses } from './OccupancyClasses.jsx';
import { useHasRole } from './auth.jsx';
import { ModModal } from './modelling/bits.jsx';

/* Structure sections ported from the modelling tool's NP structure screen:
   np-struct cards with a header (title + hint + actions), a layer table with
   sticky L-badges and an accent totals row, and a footnote. Sub-sections can
   be added inside each card as the workflow grows. */


/** Reinstatements are a count or unlimited — free reinstatements are 0%. */
export const REINSTATEMENT_OPTIONS = [
  ...Array.from({ length: 10 }, (_, i) => String(i + 1)), 'UNLIMITED',
];
const reinstatementLabel = (v) => (v === 'UNLIMITED' ? 'Unlimited' : v || '');

/** The regions a layer can be restricted to — the reference countries'
    regions (the page passes the live list); blank is worldwide. */
export const WORLDWIDE = '';
export const LAYER_REGIONS = [...new Set(COUNTRIES.map((c) => c.region).filter(Boolean))];

/** A layer's region select — worldwide, or one of the regions. */
function RegionSelect({ value, onChange, readOnly, regions = LAYER_REGIONS }) {
  if (readOnly) {
    return <input className="np-mini-input np-mini-input--readonly np-mini-input--left" data-col="region" readOnly value={value || 'Worldwide'} />;
  }
  return (
    <select className="np-mini-input np-mini-input--left" data-col="region" value={value || ''}
      onChange={(e) => onChange(e.target.value)}>
      <option value="">Worldwide</option>
      {value && !regions.includes(value) && <option value={value}>{value}</option>}
      {regions.map((r) => <option key={r} value={r}>{r}</option>)}
    </select>
  );
}

export const emptyLayerRow = () => ({
  id: null, name: '', type: 'XoL', region: '', attachment: '', limit: '', order: '100', premium: '',
  risk: true, cat: true,
  reinstatements: '', reinstatementPct: '', egnpi: '', rate: '', aad: '',
  // Stop Loss: the cover on a loss-ratio basis (the modelling tool's stop
  // loss structure) — attach and limit as % of the EPI (the EGNPI column),
  // and an ROL % override; limit, attachment and premium resolve from them.
  attachLrPct: '', limitLrPct: '', rolPct: '',
  // Aggregate XL: the cover in aggregate amounts (the modelling tool's
  // aggregate XL structure) — limit and deductible on the annual aggregate;
  // the per-loss deductible is the attachment, AAD as on any layer.
  aggLimit: '', aggDeductible: '',
});

/** True for the Treaty Detail's "Stop Loss" treaty type. */
export const isStopLossType = (name) => String(name || '').trim().toUpperCase() === 'STOP LOSS';
/** True for the Treaty Detail's "Aggregate XL" treaty type. */
export const isAggregateXlType = (name) => String(name || '').trim().toUpperCase() === 'AGGREGATE XL';

/** The modelling tool's peril mode for a non-proportional treaty type
    (npTreatyType.getNpTreatyTypeMode): Risk XL covers risk losses only, CAT
    XL cat losses only, anything else (Risk & CAT XL, Aggregate XL, Stop
    Loss…) both — with the covers free to deselect. */
export function npCoverMode(name) {
  const n = String(name || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (n === 'RISK XL') return 'RISK';
  if (n === 'CAT XL') return 'CAT';
  return 'BOTH';
}

/** Layer rows with the covers a peril mode locks: risk only, cat only, or as they are. */
export const applyCoverMode = (layers, mode) => (layers || []).map((r) => (
  mode === 'RISK' ? { ...r, risk: true, cat: false }
    : mode === 'CAT' ? { ...r, risk: false, cat: true }
      : r
));

/** True while a non-proportional type shows the per-class participation —
    a stop loss covers the whole account, an aggregate XL caps classes with
    inner limits instead. */
export const npShowsParticipation = (name) => !isStopLossType(name) && !isAggregateXlType(name);

/** A stop-loss row resolved to amounts, as the modelling tool resolves its
    stop loss structure: limit = EPI × limit LR %, attachment = EPI × attach
    LR %, premium = EPI × rate %, ROL % = rate / limit LR (unless overridden). */
export function stopLossResolved(r) {
  const epi = toNum(r.egnpi);
  const attachLr = toNum(r.attachLrPct);
  const limitLr = toNum(r.limitLrPct);
  const rate = toNum(r.rate);
  const limit = epi > 0 && r.limitLrPct !== '' ? (epi * limitLr) / 100 : 0;
  const attachment = epi > 0 && r.attachLrPct !== '' ? (epi * attachLr) / 100 : 0;
  const premium = epi > 0 && r.rate !== '' ? (epi * rate) / 100 : 0;
  const impliedRol = r.rate !== '' && limitLr > 0 ? (rate / limitLr) * 100 : null;
  const rolPct = r.rolPct !== '' && r.rolPct != null ? toNum(r.rolPct) : impliedRol;
  return { epi, limit, attachment, premium, impliedRol, rolPct };
}

/** A stop-loss or aggregate XL row with its resolved amounts in the standard
    fields, so the placement's layers, the payloads and the modelling read it
    as a layer: a stop loss resolves from the EPI, an aggregate XL carries
    its aggregate limit and deductible as the layer's limit and attachment. */
export const withStopLossAmounts = (r) => {
  if ((r.aggLimit ?? '') !== '' || (r.aggDeductible ?? '') !== '') {
    return {
      ...r,
      limit: r.aggLimit !== '' ? r.aggLimit : r.limit,
      attachment: r.aggDeductible !== '' ? r.aggDeductible : r.attachment,
    };
  }
  if ((r.attachLrPct ?? '') === '' && (r.limitLrPct ?? '') === '') return r;
  const { limit, attachment, premium } = stopLossResolved(r);
  return {
    ...r,
    limit: limit ? String(limit) : r.limit,
    attachment: attachment ? String(attachment) : r.attachment,
    premium: r.premium !== '' ? r.premium : (premium ? String(premium) : ''),
  };
};
export const withNpAmounts = withStopLossAmounts;

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const fmt = (n) => (n ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '');
/** Rate on line for a layer row: premium ÷ limit. */
const rolOf = (r) => {
  const lim = toNum(r.limit);
  const prem = toNum(r.premium);
  return lim > 0 && prem > 0 ? `${((prem / lim) * 100).toFixed(2)}%` : '';
};

/** Strip grouping separators and any suffix, leaving a plain number string. */
const cleanNum = (v) => String(v).replace(/[^0-9.-]/g, '');
/**
 * Group a stored number string for display, keeping whatever fraction has
 * been typed so far (so "3." and "3.70" survive mid-edit) and appending an
 * optional unit.
 */
const displayNum = (v, suffix) => {
  if (v === '' || v == null) return '';
  const m = /^(-?)(\d*)(\.\d*)?$/.exec(String(v));
  if (!m) return String(v);
  const [, sign, int, frac = ''] = m;
  const grouped = int === '' ? '' : Number(int).toLocaleString('en-US');
  return `${sign}${grouped}${frac}${suffix || ''}`;
};

/**
 * Numeric field for the structure tables and terms grids: always shown with
 * thousands separators, and a % where the column is a rate. The value handed
 * back is an unformatted number string, so every payload mapping is unchanged.
 */
export function NumInput({ value, onChange, readOnly, suffix, className, ...rest }) {
  // Formatting changes the string length, so hold the caret at a fixed
  // distance from the right — otherwise every inserted separator jumps it.
  const handle = (e) => {
    const el = e.target;
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
      className={`np-mini-input${readOnly ? ' np-mini-input--readonly' : ''}${className ? ` ${className}` : ''}`}
      type="text"
      inputMode="decimal"
      value={displayNum(value, suffix)}
      readOnly={readOnly}
      onChange={readOnly ? undefined : handle}
    />
  );
}

/** np-struct card shell: header (title, hint, actions), body, footnote. */
export function StructCard({ title, hint, actions, footnote, notice, children }) {
  return (
    <section className="np-struct-card">
      <div className="np-struct-card-header">
        <div>
          <div className="np-struct-card-h2">{title}</div>
          {hint && <div className="np-struct-card-hint">{hint}</div>}
        </div>
        {actions && <div className="np-struct-card-actions">{actions}</div>}
      </div>
      {notice && <div className="np-struct-notice">{notice}</div>}
      {children}
      {footnote && <div className="np-struct-footnote">{footnote}</div>}
    </section>
  );
}

/**
 * Layer table in the modelling tool's np-struct style.
 * Rows: { id?, name, type, attachment, limit, order, premium }.
 * Editable unless readOnly; rows with an id get their L-badge linked to the
 * layer page.
 */
export function StructLayerTable({ rows, onChange, readOnly, currency, coverMode = 'BOTH', regions = LAYER_REGIONS }) {
  // Risk XL locks the covers to risk, CAT XL to cat; both leaves them free.
  const locked = coverMode !== 'BOTH';
  const upd = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i) => onChange(rows.filter((_, j) => j !== i));

  const totLimit = rows.reduce((s, r) => s + toNum(r.limit), 0);
  const firstAttach = toNum(rows[0]?.attachment);
  const totPremium = rows.reduce((s, r) => s + toNum(r.premium), 0);
  const totRol = totLimit > 0 && totPremium > 0 ? `${((totPremium / totLimit) * 100).toFixed(2)}%` : '';

  return (
    <div className="np-table-wrap">
      <table className="np-struct-table">
        <thead>
          <tr>
            <th className="np-table-sticky">LAYER</th>
            <th className="np-th-left">NAME</th>
            <th className="np-th-left" title="The region the layer is restricted to — worldwide unless set">GEOGRAPHIC REGION</th>
            <th>LIMIT ({currency || 'CCY'})</th>
            <th>DEDUCTIBLE / ATTACHMENT</th>
            <th title="Number of reinstatements of the layer limit, or unlimited">REINSTATEMENTS</th>
            <th title="Reinstatement premium as a % of the layer premium">REINST. %</th>
            <th title="Estimated gross net premium income the rate applies to">EGNPI ({currency || 'CCY'})</th>
            <th title="Rate applied to EGNPI">RATE %</th>
            <th title="Annual aggregate deductible">AAD ({currency || 'CCY'})</th>
            <th>ORDER %</th>
            <th>PREMIUM 100%</th>
            <th title="Layer covers risk losses">RISK</th>
            <th title="Layer covers catastrophe losses">CAT</th>
            <th title="ROL = Premium 100% ÷ Limit (Rate-on-Line). Auto-computed.">ROL</th>
            {!readOnly && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={readOnly ? 15 : 16} className="muted" style={{ padding: 12 }}>
              No layers{readOnly ? '.' : ' — add one below.'}
            </td></tr>
          )}
          {rows.map((r, i) => (
            <tr key={r.id || `new-${i}`}>
              <th className="np-table-sticky">
                {r.id
                  ? <Link className="np-layer-badge" to={`/layers/${r.id}`} title="Open layer">L{i + 1}</Link>
                  : <span className="np-layer-badge">L{i + 1}</span>}
              </th>
              <td>
                <input className="np-mini-input np-mini-input--left" data-col="name" value={r.name} readOnly={readOnly}
                  placeholder={`Layer ${i + 1}`}
                  onChange={(e) => upd(i, { name: e.target.value })} />
              </td>
              <td><RegionSelect value={r.region} readOnly={readOnly} regions={regions}
                onChange={(region) => upd(i, { region })} /></td>
              <td><NumInput data-col="limit" value={r.limit} readOnly={readOnly} placeholder="—"
                onChange={(v) => upd(i, { limit: v })} /></td>
              <td><NumInput data-col="attachment" value={r.attachment} readOnly={readOnly} placeholder="—"
                onChange={(v) => upd(i, { attachment: v })} /></td>
              <td>
                {readOnly ? (
                  <input className="np-mini-input np-mini-input--readonly" data-col="reinstatements" readOnly
                    value={reinstatementLabel(r.reinstatements)} placeholder="—" />
                ) : (
                  <select className="np-mini-input" data-col="reinstatements" value={r.reinstatements || ''}
                    onChange={(e) => upd(i, { reinstatements: e.target.value })}>
                    <option value="">—</option>
                    {REINSTATEMENT_OPTIONS.map((n) => (
                      <option key={n} value={n}>{reinstatementLabel(n)}</option>
                    ))}
                  </select>
                )}
              </td>
              <td><NumInput data-col="reinstatementPct" suffix="%" value={r.reinstatementPct} readOnly={readOnly} placeholder="—"
                onChange={(v) => upd(i, { reinstatementPct: v })} /></td>
              <td><NumInput data-col="egnpi" value={r.egnpi} readOnly={readOnly} placeholder="—"
                onChange={(v) => upd(i, { egnpi: v })} /></td>
              <td><NumInput data-col="rate" suffix="%" value={r.rate} readOnly={readOnly} placeholder="—"
                onChange={(v) => upd(i, { rate: v })} /></td>
              <td><NumInput data-col="aad" value={r.aad} readOnly={readOnly} placeholder="—"
                onChange={(v) => upd(i, { aad: v })} /></td>
              <td><NumInput data-col="order" suffix="%" value={r.order} readOnly={readOnly} placeholder="—"
                onChange={(v) => upd(i, { order: v })} /></td>
              <td><NumInput data-col="premium" value={r.premium} readOnly={readOnly} placeholder="—"
                onChange={(v) => upd(i, { premium: v })} /></td>
              <td className={locked ? 'np-cover-locked' : ''} title={locked ? `${coverMode === 'RISK' ? 'Risk XL' : 'CAT XL'} — the covers follow the treaty type` : ''}>
                <input type="checkbox" className="np-check" data-col="risk"
                  checked={coverMode === 'RISK' ? true : coverMode === 'CAT' ? false : r.risk !== false}
                  disabled={readOnly || locked}
                  onChange={readOnly || locked ? undefined : (e) => upd(i, { risk: e.target.checked })} /></td>
              <td className={locked ? 'np-cover-locked' : ''}>
                <input type="checkbox" className="np-check" data-col="cat"
                  checked={coverMode === 'CAT' ? true : coverMode === 'RISK' ? false : r.cat !== false}
                  disabled={readOnly || locked}
                  onChange={readOnly || locked ? undefined : (e) => upd(i, { cat: e.target.checked })} /></td>
              <td><input className="np-mini-input np-mini-input--readonly" data-col="rol" readOnly value={rolOf(r)} placeholder="—" /></td>
              {!readOnly && (
                <td>
                  <button type="button" className="renew-x" onClick={() => remove(i)} aria-label="Remove layer">✕</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className="np-total-row">
              <th className="np-table-sticky np-total-label">TOTAL</th>
              <td />
              <td />
              <td><input className="np-mini-input np-mini-input--readonly" readOnly value={fmt(totLimit)} placeholder="—" /></td>
              <td><input className="np-mini-input np-mini-input--readonly" readOnly value={fmt(firstAttach)} placeholder="—" /></td>
              <td />
              <td />
              <td />
              <td />
              <td />
              <td />
              <td><input className="np-mini-input np-mini-input--readonly" readOnly value={fmt(totPremium)} placeholder="—" /></td>
              <td />
              <td />
              <td><input className="np-mini-input np-mini-input--readonly" readOnly value={totRol} placeholder="—"
                style={totRol ? { border: '2px solid rgba(37, 99, 235, .55)' } : undefined} /></td>
              {!readOnly && <td />}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Convert an API layer record into a table row. */
export const layerToRow = (l) => ({
  id: l.id || null,
  name: l.name || '',
  type: l.type || 'XoL',
  region: l.region || '',
  risk: l.risk_cover !== false,
  cat: l.cat_cover !== false,
  attachment: l.attachment != null ? String(Number(l.attachment)) : '',
  limit: l.limit_amt != null ? String(Number(l.limit_amt)) : '',
  order: l.order_pct != null ? String(Number(l.order_pct)) : '100',
  premium: l.premium100 != null ? String(Number(l.premium100)) : '',
  reinstatements: l.reinstatements || '',
  reinstatementPct: l.reinstatement_pct != null ? String(Number(l.reinstatement_pct)) : '',
  egnpi: l.egnpi != null ? String(Number(l.egnpi)) : '',
  rate: l.rate_pct != null ? String(Number(l.rate_pct)) : '',
  aad: l.aad != null ? String(Number(l.aad)) : '',
  attachLrPct: '', limitLrPct: '', rolPct: '', aggLimit: '', aggDeductible: '',
});

/** Convert a table row into an API layer payload. A stop-loss row sends its
    resolved amounts, so the placement's layer carries a limit and attachment. */
export const rowToPayload = (row, i, currency) => {
  const r = withStopLossAmounts(row);
  return {
    name: r.name.trim() || `Layer ${i + 1}`,
    type: r.type || 'XoL',
    region: r.region || null,
    attachment: r.attachment === '' ? undefined : Number(r.attachment),
    limit_amt: r.limit === '' ? undefined : Number(r.limit),
    order_pct: r.order === '' ? undefined : Number(r.order),
    premium100: r.premium === '' ? undefined : Number(r.premium),
    currency,
    risk_cover: r.risk !== false,
    cat_cover: r.cat !== false,
    // Cleared fields send null so a PATCH wipes the stored term.
    reinstatements: r.reinstatements || null,
    reinstatement_pct: r.reinstatementPct === '' ? null : Number(r.reinstatementPct),
    egnpi: r.egnpi === '' ? null : Number(r.egnpi),
    rate_pct: r.rate === '' ? null : Number(r.rate),
    aad: r.aad === '' ? null : Number(r.aad),
  };
};

/** The stop-loss fields of a stored structure row, to carry onto the real
    layer's row (the placement's layers do not hold loss-ratio terms). */
export const stopLossFieldsOf = (r) => ({
  attachLrPct: r?.attachLrPct ?? '', limitLrPct: r?.limitLrPct ?? '', rolPct: r?.rolPct ?? '',
  aggLimit: r?.aggLimit ?? '', aggDeductible: r?.aggDeductible ?? '',
});

/** Keep COB rows in sync with the placement's classes and layer count. */
export function seedCobRows(cobNames, existing, layerCount) {
  const byName = new Map((existing || []).map((r) => [r.cob, r]));
  return (cobNames || []).map((cob) => {
    const r = byName.get(cob) || { cob, limit: '', layers: [], manual: [] };
    const layers = Array.from({ length: layerCount }, (_, i) => r.layers?.[i] !== false);
    const manual = Array.from({ length: layerCount }, (_, i) => r.manual?.[i] === true);
    return { cob, limit: r.limit ?? '', layers, manual, innerLimit: r.innerLimit ?? '', innerDeductible: r.innerDeductible ?? '' };
  });
}

/**
 * The modelling tool's participation rule: a class participates in a layer
 * if and only if its underwriting limit exceeds that layer's attachment —
 * a loss from the class can then reach the layer. Cells ticked by hand
 * (manual) are left as they are. Applied when a limit or an attachment is
 * edited, never on load, so stored participation stands until touched.
 */
export function recomputeCobCoverage(rows, layers) {
  const n = (layers || []).length;
  return (rows || []).map((r) => {
    const ul = toNum(r.limit);
    const next = Array.from({ length: n }, (_, i) => r.layers?.[i] !== false);
    const manual = Array.from({ length: n }, (_, i) => r.manual?.[i] === true);
    for (let i = 0; i < n; i++) {
      if (manual[i]) continue;
      next[i] = ul > toNum(withStopLossAmounts(layers[i]).attachment);
    }
    return { ...r, layers: next, manual };
  });
}

/**
 * Classes of Business & Layer Participation — ported from the modelling
 * tool's CobParticipationCard: an underwriting limit per class, and a
 * participation checkbox per layer. Rendered as a sub-section below each
 * structure table.
 */
export function CobLimitsTable({ rows, layerCount, layers, onChange, readOnly, currency }) {
  const upd = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  // An edited underwriting limit re-derives the class's participation from
  // the layer attachments (the hand-ticked cells stay).
  const setLimit = (i, limit) => {
    const next = rows.map((r, j) => (j === i ? { ...r, limit } : r));
    onChange(layers ? recomputeCobCoverage(next, layers) : next);
  };
  const toggle = (i, li) => {
    const r = rows[i];
    const lyr = Array.from({ length: layerCount }, (_, k) => r.layers?.[k] !== false);
    const manual = Array.from({ length: layerCount }, (_, k) => r.manual?.[k] === true);
    lyr[li] = !lyr[li];
    manual[li] = true;
    upd(i, { layers: lyr, manual });
  };
  return (
    <div className="np-struct-sub">
      <div className="np-struct-sub-h">Classes of Business &amp; Layer Participation</div>
      <div className="np-struct-card-hint">
        Underwriting limits are entered per class. A class participates in a layer when its
        underwriting limit exceeds the layer’s attachment; tick or untick a layer to override.
      </div>
      <div className="np-table-wrap" style={{ marginTop: 8 }}>
        <table className="np-struct-table">
          <thead>
            <tr>
              <th>CLASS OF BUSINESS</th>
              <th>UNDERWRITING LIMIT ({currency || 'CCY'})</th>
              {Array.from({ length: layerCount }, (_, i) => <th key={i}>LAYER {i + 1}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={2 + layerCount} className="muted" style={{ padding: 14 }}>
                Select classes of business in Treaty Detail.
              </td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.cob}>
                <td style={{ fontWeight: 600 }}>{r.cob}</td>
                <td>
                  <NumInput value={r.limit} readOnly={readOnly} placeholder="—"
                    onChange={(v) => setLimit(i, v)} />
                </td>
                {Array.from({ length: layerCount }, (_, li) => (
                  <td key={li}>
                    <input type="checkbox" className="np-check" checked={r.layers?.[li] !== false}
                      disabled={readOnly}
                      title={r.manual?.[li] ? 'Set by hand' : 'From the underwriting limit and the layer attachment'}
                      onChange={readOnly ? undefined : () => toggle(i, li)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Serialise COB rows for the placement's structure_cobs column. */
export const cobRowsToPayload = (rows) => (rows || []).map((r) => ({
  cob: r.cob,
  limit: r.limit === '' || r.limit == null ? null : Number(r.limit),
  layers: (r.layers || []).map((b) => b !== false),
  manual: (r.manual || []).map((b) => b === true),
  inner_limit: r.innerLimit === '' || r.innerLimit == null ? null : Number(r.innerLimit),
  inner_deductible: r.innerDeductible === '' || r.innerDeductible == null ? null : Number(r.innerDeductible),
}));

/** Deserialise structure_cobs rows back into editable state. */
export const cobRowsFromPayload = (rows) => (rows || []).map((r) => ({
  cob: r.cob,
  limit: r.limit == null ? '' : String(r.limit),
  layers: (r.layers || []).map((b) => b !== false),
  manual: (r.manual || []).map((b) => b === true),
  innerLimit: r.inner_limit == null ? '' : String(r.inner_limit),
  innerDeductible: r.inner_deductible == null ? '' : String(r.inner_deductible),
}));

/**
 * Class of business · inner limits — the modelling tool's aggregate XL
 * classes table: an inner limit and inner deductible cap or floor a class
 * inside the aggregate cover; blank where a class has no sublimit.
 */
export function CobInnerLimitsTable({ rows, onChange, readOnly, currency }) {
  const upd = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="np-struct-sub">
      <div className="np-struct-sub-h">Class of Business &amp; Inner Limits</div>
      <div className="np-struct-card-hint">
        Inner limit and inner deductible cap or floor a class inside the aggregate cover — leave blank where a class has no sublimit.
      </div>
      <div className="np-table-wrap" style={{ marginTop: 8 }}>
        <table className="np-struct-table">
          <thead>
            <tr>
              <th>CLASS OF BUSINESS</th>
              <th>INNER LIMIT ({currency || 'CCY'})</th>
              <th>INNER DEDUCTIBLE ({currency || 'CCY'})</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={3} className="muted" style={{ padding: 14 }}>
                Select classes of business in Treaty Detail.
              </td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.cob}>
                <td style={{ fontWeight: 600 }}>{r.cob}</td>
                <td><NumInput data-col="innerLimit" value={r.innerLimit ?? ''} readOnly={readOnly} placeholder="—"
                  onChange={(v) => upd(i, { innerLimit: v })} /></td>
                <td><NumInput data-col="innerDeductible" value={r.innerDeductible ?? ''} readOnly={readOnly} placeholder="—"
                  onChange={(v) => upd(i, { innerDeductible: v })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Quote structures — count-driven sections, each proportional or
      non-proportional, modelled on the modelling tool's quote mode ── */

/* The Treaty Detail's proportional treaty types (the seeded lookup; the page
   passes the live list). Older structures store QS / Surplus / QS + Surplus,
   which read through propMode. */
export const PROP_TYPES = ['Quota Share', 'Quota Share & Surplus', 'First Surplus', 'Second Surplus', 'Third Surplus', 'Fac Oblig'];

/**
 * The modelling tool's treaty mode for a proportional treaty type name
 * (propTreatyHelpers.treatyModeFromType): 'quota', 'surplus' or 'both'.
 * Quota Share & Surplus is both; any surplus, and Fac Oblig, is surplus;
 * anything else reads as quota. The legacy Broker IQ names map the same way.
 */
export function propMode(name) {
  const n = String(name || '').trim().toLowerCase();
  if (n === 'qs + surplus') return 'both';
  if (n === 'qs') return 'quota';
  if (n === 'surplus') return 'surplus';
  if (n.includes('quota') && n.includes('surplus')) return 'both';
  if (n.includes('quota')) return 'quota';
  if (n.includes('surplus') || n.includes('fac oblig')) return 'surplus';
  return 'quota';
}

export const emptyPropTerms = () => ({
  // The treaty type defaults from the Treaty Detail's while it is proportional.
  treatyType: '', qsLimit: '', retentionPct: '', surplusMaxRetention: '',
  numLines: '', commissionPct: '', epi: '',
  eventLimit: '', aal: '', profitCommissionPct: '', mgmtExpensesPct: '',
  lpvPct: '', brokeragePct: '', cashLossAdvice: '',
  // The modelling tool's treaty-detail sections: commissions (fixed vs a
  // sliding scale with its manual table), loss participation corridors,
  // EPIs with the split by class, and brokerage & taxes.
  commissionMode: 'fixed', commissionSurplusPct: '',
  slidingMinLossRatio: '', slidingMaxLossRatio: '',
  slidingMinCommission: '', slidingMaxCommission: '',
  slidingTable: [], provisionalCommissionPct: '',
  lcfYears: '',
  lossPartEnabled: true, minLossRatioPct: '', maxLossRatioPct: '',
  reinsurerSharePct: '', lpSlides: [],
  quotaShareEpi: '', surplusEpi: '', epiSplit: [],
  taxesPct: '', lossCapPct: '',
});

/** Stored prop terms from before the sectioned detail existed carry a single
    loss-participation % and a single EPI — surface them in the fields that
    replaced them. */
export const upgradePropTerms = (t) => {
  const u = { ...emptyPropTerms(), ...(t || {}) };
  if (!u.reinsurerSharePct && u.lpvPct) u.reinsurerSharePct = u.lpvPct;
  if (!u.quotaShareEpi && !u.surplusEpi && u.epi) {
    if (propMode(u.treatyType) === 'surplus') u.surplusEpi = u.epi;
    else u.quotaShareEpi = u.epi;
  }
  return u;
};

export const emptyStructure = (cobNames = []) => ({
  basis: 'NP',
  // The non-proportional treaty type (one of the Treaty Detail's) and the
  // aggregate XL policy shape; defaulted from the Treaty Detail's type.
  npTreatyType: '',
  agg: { franchiseDeductible: false, structuredDeal: false },
  layers: [emptyLayerRow()],
  prop: emptyPropTerms(),
  cobs: seedCobRows(cobNames, [], 1),
});

/** Resize the structures array to n, preserving existing entries. */
export function resizeStructures(list, n, cobNames = []) {
  const next = [...(list || [])];
  while (next.length < n) next.push(emptyStructure(cobNames));
  return next.slice(0, n);
}

/**
 * Seed the structures to quote from the expiring structure. A structure is
 * one basis or the other, so a BOTH expiring fills two: its proportional
 * section into structure 1 and its layers into structure 2 (added if the
 * placement only had one).
 */
export function copyExpiringToStructures(expiring, structures, cobNames = []) {
  const list = structures?.length ? [...structures] : [emptyStructure(cobNames)];
  const asProp = (st) => ({ ...st, basis: 'PROP', prop: { ...expiring.prop } });
  // Premium is last year's, so it is dropped — the layer shape is what carries over.
  const asNP = (st) => ({
    ...st, basis: 'NP', layers: expiring.layers.map((r) => ({ ...r, id: null, premium: '' })),
  });

  if (normaliseBasis(expiring.basis) !== 'BOTH') {
    const seed = hasProp(expiring.basis) ? asProp : asNP;
    return [seed(list[0]), ...list.slice(1)];
  }
  const grown = resizeStructures(list, Math.max(list.length, 2), cobNames);
  return [asProp(grown[0]), asNP(grown[1]), ...grown.slice(2)];
}

/** Auto-calcs for proportional terms, as in Universe's prop treaty detail.
    A combined "QS + Surplus" treaty activates both halves; total capacity is
    the QS 100% limit plus the surplus capacity (max retention x lines). */
export function propCalcs(t) {
  const mode = propMode(t.treatyType);
  const hasQS = mode === 'quota' || mode === 'both';
  const hasSurplus = mode === 'surplus' || mode === 'both';
  const qsLimit = toNum(t.qsLimit);
  const retPct = toNum(t.retentionPct);
  const cesPct = hasQS && t.retentionPct !== '' ? Math.max(0, 100 - retPct) : '';
  const retAmt = hasQS && qsLimit > 0 && t.retentionPct !== '' ? (qsLimit * retPct) / 100 : 0;
  const cesAmt = hasQS && qsLimit > 0 && cesPct !== '' ? (qsLimit * cesPct) / 100 : 0;
  const maxRet = toNum(t.surplusMaxRetention);
  const surplusCapacity = hasSurplus ? maxRet * toNum(t.numLines) : 0;
  // Total treaty capacity as the modelling tool's treaty detail computes it:
  // quota → QS limit; both → QS limit + max retention × lines; surplus → the
  // max retention plus max retention × lines.
  const capacity = mode === 'quota' ? qsLimit : mode === 'both' ? qsLimit + surplusCapacity : maxRet + surplusCapacity;
  return { mode, isQS: hasQS, hasQS, hasSurplus, cesPct, retAmt, cesAmt, surplusCapacity, capacity };
}

/** Retention % from an entered cession %, each deriving the other as in the tool. */
export const retentionFromCession = (v) => (v === '' ? '' : String(+Math.max(0, Math.min(100, 100 - Number(v))).toFixed(6)));

function Term({ label, children }) {
  return (
    <div>
      <div className="np-term-label">{label}</div>
      {children}
    </div>
  );
}

/** FIXED / SLIDING and YES / NO mini toggles, styled like the basis pills. */
function MiniPills({ options, value, onChange, readOnly, ariaLabel }) {
  return (
    <div className="np-type-pills np-type-pills--mini" role="group" aria-label={ariaLabel}>
      {options.map(([v, label]) => (
        <button key={label} type="button" disabled={readOnly}
          className={`np-type-pill ${value === v ? 'is-on' : 'is-off'}`}
          onClick={readOnly ? undefined : () => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** A titled strip inside the proportional terms — the modelling tool's
    treaty-detail cards (COMMISSIONS, LOSS PARTICIPATION, EPI…) rendered as
    sub-sections of the structure card. */
function TermsSub({ title, controls, children }) {
  return (
    <div className="np-terms-sub">
      <div className="np-terms-sub-head">
        <span className="np-terms-sub-title">{title}</span>
        {controls}
      </div>
      {children}
    </div>
  );
}

/** Sliding-scale commission table — provisional % plus loss-ratio bands the
    engine interpolates between (the modelling tool's manual slide). */
function SlidingScaleModal({ terms, cobNames, onSave, onClose, readOnly }) {
  const [rows, setRows] = useState(() => {
    const r = (terms.slidingTable || []).map((x) => ({ ...x }));
    while (r.length < 10) r.push({ lossRatioPct: '', commissionPct: '' });
    return r;
  });
  const [prov, setProv] = useState(terms.provisionalCommissionPct || '');
  const upd = (i, key, v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  return (
    <ModModal title="Sliding Scale Commission Table"
      sub="Loss ratio bands and the commission each pays — the engine interpolates between rows."
      onClose={onClose}>
      <div className="np-terms-grid" style={{ marginBottom: 4 }}>
        <Term label="Provisional Commission %">
          <NumInput suffix="%" value={prov} readOnly={readOnly} placeholder="e.g. 30"
            onChange={setProv} />
        </Term>
      </div>
      <div className="str-wrap">
        <table className="str-table">
          <thead><tr><th>LOSS RATIO %</th><th>COMMISSION %</th><th className="str-x-cell" /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><NumInput suffix="%" value={r.lossRatioPct} readOnly={readOnly}
                  placeholder="e.g. 65" onChange={(v) => upd(i, 'lossRatioPct', v)} /></td>
                <td><NumInput suffix="%" value={r.commissionPct} readOnly={readOnly}
                  placeholder="e.g. 30" onChange={(v) => upd(i, 'commissionPct', v)} /></td>
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
        <button type="button" className="np-struct-btn" onClick={onClose}>
          {readOnly ? 'Close' : 'Cancel'}
        </button>
        {!readOnly && (
          <button type="button" className="np-struct-btn np-struct-btn--primary"
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

/** Stepped loss participation — up to five corridors with their own
    reinsurer shares. */
function LpSlidesModal({ terms, onSave, onClose, readOnly }) {
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
        <table className="str-table">
          <thead><tr><th className="np-slide-num" /><th>MIN LR %</th><th>MAX LR %</th><th>RE SHARE %</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="np-slide-num">{i + 1}</td>
                <td><NumInput suffix="%" value={r.minLr} readOnly={readOnly}
                  placeholder="e.g. 70" onChange={(v) => upd(i, 'minLr', v)} /></td>
                <td><NumInput suffix="%" value={r.maxLr} readOnly={readOnly}
                  placeholder="e.g. 100" onChange={(v) => upd(i, 'maxLr', v)} /></td>
                <td><NumInput suffix="%" value={r.share} readOnly={readOnly}
                  placeholder="e.g. 50" onChange={(v) => upd(i, 'share', v)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="np-modal-actions">
        {!readOnly && (
          <button type="button" className="np-struct-btn" onClick={() => setRows(pad([]))}>
            Clear all
          </button>
        )}
        <span className="np-modal-actions-gap" />
        <button type="button" className="np-struct-btn" onClick={onClose}>
          {readOnly ? 'Close' : 'Cancel'}
        </button>
        {!readOnly && (
          <button type="button" className="np-struct-btn np-struct-btn--primary"
            onClick={() => onSave({ lpSlides: rows.filter((r) => r.minLr || r.maxLr || r.share) })}>
            Save corridors
          </button>
        )}
      </div>
    </ModModal>
  );
}

/** EPI split by class of business — defaults to an equal share of the
    QS + Surplus EPI total, and flags a split that doesn't add back up. */
function EpiSplitModal({ terms, cobNames, onSave, onClose, readOnly }) {
  const totalRef = toNum(terms.quotaShareEpi) + toNum(terms.surplusEpi);
  const [rows, setRows] = useState(() => (cobNames || []).map((cob) => {
    const existing = (terms.epiSplit || []).find((r) => r.cob === cob);
    const equal = totalRef && cobNames.length ? String(Math.round(totalRef / cobNames.length)) : '';
    return { cob, premium: existing?.premium ?? equal };
  }));
  const totalSplit = rows.reduce((s, r) => s + toNum(r.premium), 0);
  const pctOf = (p) => (totalRef > 0 && toNum(p) ? `${((toNum(p) / totalRef) * 100).toFixed(1)}%` : '—');
  const matched = totalRef > 0 && Math.abs(totalSplit - totalRef) < 1;
  const save = () => {
    if (totalRef > 0 && Math.abs(totalSplit - totalRef) > 1) {
      const msg = `Split total (${fmt(Math.round(totalSplit))}) doesn't match the EPI total (${fmt(Math.round(totalRef))}). Save anyway?`;
      if (!window.confirm(msg)) return;
    }
    onSave({ epiSplit: rows });
  };
  return (
    <ModModal title="EPI Split by Line of Business"
      sub="How the estimated premium income divides across the treaty's classes."
      onClose={onClose}>
      <div className="np-epi-ref">
        <span>QS: <b>{fmt(toNum(terms.quotaShareEpi)) || '—'}</b></span>
        <span>Surplus: <b>{fmt(toNum(terms.surplusEpi)) || '—'}</b></span>
        <span>Total: <b>{totalRef ? fmt(Math.round(totalRef)) : '—'}</b></span>
      </div>
      <div className="str-wrap">
        <table className="str-table">
          <thead><tr><th>LINE OF BUSINESS</th><th>PREMIUM</th><th className="np-num-h">% OF TOTAL</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.cob}>
                <td className="np-epi-cob">{r.cob}</td>
                <td><NumInput value={r.premium} readOnly={readOnly} placeholder="e.g. 1,000,000"
                  onChange={(v) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, premium: v } : x)))} /></td>
                <td className="np-num-h">{pctOf(r.premium)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="np-epi-total">
              <td>TOTAL</td>
              <td>{totalSplit ? fmt(Math.round(totalSplit)) : '—'}</td>
              <td className="np-num-h" style={{ color: matched ? 'var(--accent2)' : 'var(--accent-amber)' }}>
                {totalRef > 0 && totalSplit > 0 ? `${((totalSplit / totalRef) * 100).toFixed(1)}%` : '—'}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="np-modal-actions">
        <span className="np-modal-actions-gap" />
        <button type="button" className="np-struct-btn" onClick={onClose}>
          {readOnly ? 'Close' : 'Cancel'}
        </button>
        {!readOnly && (
          <button type="button" className="np-struct-btn np-struct-btn--primary" onClick={save}>
            Save split
          </button>
        )}
      </div>
    </ModModal>
  );
}

/** Proportional structure terms — the modelling tool's treaty-detail
    sections: limits, commissions (fixed / sliding), loss participation,
    EPIs with their split, brokerage & taxes. Fields track the treaty type. */
export function PropTermsFields({ value, onChange, readOnly, currency, cobNames = [], propTreatyTypes = PROP_TYPES }) {
  const t = value;
  const set = (patch) => onChange({ ...t, ...patch });
  const [modal, setModal] = useState(null); // 'sliding' | 'lp' | 'epi'
  const { hasQS, hasSurplus, cesPct, retAmt, cesAmt, surplusCapacity, capacity } = propCalcs(t);
  const sliding = t.commissionMode === 'sliding';
  const lpOn = t.lossPartEnabled !== false;
  const slidingCount = (t.slidingTable || []).filter((r) => r.lossRatioPct || r.commissionPct).length;
  const lpCount = (t.lpSlides || []).filter((r) => r.minLr || r.maxLr || r.share).length;
  const epiCount = (t.epiSplit || []).filter((r) => String(r.premium ?? '').trim()).length;
  // Keep the legacy single-EPI field mirroring the QS + Surplus total so
  // older readers of the stored terms stay coherent.
  const setEpi = (patch) => {
    const next = { ...t, ...patch };
    const total = toNum(next.quotaShareEpi) + toNum(next.surplusEpi);
    set({ ...patch, epi: total ? String(total) : '' });
  };
  return (
    <div className="np-terms-wrap">
      <div className="np-terms-grid">
      <Term label="Treaty Type">
        {readOnly ? (
          <input className="np-mini-input np-mini-input--readonly" readOnly value={t.treatyType} />
        ) : (
          <select className="np-mini-input" value={t.treatyType}
            onChange={(e) => set({ treatyType: e.target.value })}>
            <option value="">Select treaty type…</option>
            {t.treatyType && !propTreatyTypes.includes(t.treatyType) && (
              <option value={t.treatyType}>{t.treatyType}</option>
            )}
            {propTreatyTypes.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        )}
      </Term>
      <Term label={`QS 100% Limit (${currency || 'CCY'})`}>
        <NumInput value={t.qsLimit} placeholder={hasQS ? 'e.g. 10,000,000' : 'N/A'}
          readOnly={readOnly || !hasQS} disabled={!readOnly && !hasQS}
          onChange={(v) => set({ qsLimit: v })} />
      </Term>
      <Term label="Retention %">
        <NumInput suffix="%" value={t.retentionPct} placeholder={hasQS ? 'e.g. 50' : 'N/A'}
          readOnly={readOnly || !hasQS} disabled={!readOnly && !hasQS}
          onChange={(v) => set({ retentionPct: v })} />
      </Term>
      <Term label="Retention Amount">
        <input className="np-mini-input np-mini-input--readonly" readOnly placeholder="auto"
          value={retAmt ? retAmt.toLocaleString() : ''} />
      </Term>
      <Term label="Cession %">
        <NumInput suffix="%" value={cesPct === '' ? '' : String(cesPct)} placeholder={hasQS ? 'e.g. 50' : 'N/A'}
          readOnly={readOnly || !hasQS} disabled={!readOnly && !hasQS}
          onChange={(v) => set({ retentionPct: retentionFromCession(v) })} />
      </Term>
      <Term label="Cession Amount">
        <input className="np-mini-input np-mini-input--readonly" readOnly placeholder="auto"
          value={cesAmt ? cesAmt.toLocaleString() : ''} />
      </Term>
      <Term label={`Surplus Max Retention (${currency || 'CCY'})`}>
        <NumInput value={t.surplusMaxRetention} placeholder={hasSurplus ? 'e.g. 1,000,000' : 'N/A'}
          readOnly={readOnly || !hasSurplus} disabled={!readOnly && !hasSurplus}
          onChange={(v) => set({ surplusMaxRetention: v })} />
      </Term>
      <Term label="Number of Lines">
        <NumInput value={t.numLines} placeholder={hasSurplus ? 'e.g. 5' : 'N/A'}
          readOnly={readOnly || !hasSurplus} disabled={!readOnly && !hasSurplus}
          onChange={(v) => set({ numLines: v })} />
      </Term>
      <Term label="Surplus Capacity">
        <input className="np-mini-input np-mini-input--readonly" readOnly placeholder="auto"
          value={surplusCapacity ? surplusCapacity.toLocaleString() : ''} />
      </Term>
      <Term label="Total Treaty Capacity">
        <input className="np-mini-input np-mini-input--readonly" readOnly placeholder="auto"
          value={capacity ? capacity.toLocaleString() : ''} />
      </Term>
      <Term label={`Event Limit (${currency || 'CCY'})`}>
        <NumInput value={t.eventLimit} placeholder="e.g. 3,000,000"
          readOnly={readOnly} onChange={(v) => set({ eventLimit: v })} />
      </Term>
      <Term label={`AAL (${currency || 'CCY'})`}>
        <NumInput value={t.aal} placeholder="e.g. 10,000,000"
          readOnly={readOnly} onChange={(v) => set({ aal: v })} />
      </Term>
      </div>

      <TermsSub title="COMMISSIONS"
        controls={
          <MiniPills readOnly={readOnly} ariaLabel="Commission mode"
            options={[['fixed', 'FIXED COMMISSION'], ['sliding', 'SLIDING SCALE']]}
            value={sliding ? 'sliding' : 'fixed'}
            onChange={(v) => set({ commissionMode: v })} />
        }>
        <div className={`np-terms-fade${sliding ? ' is-off' : ''}`}>
          <div className="np-terms-grid">
            <Term label="QS Commission %">
              <NumInput suffix="%" value={t.commissionPct} placeholder={hasQS ? 'e.g. 27.5' : 'N/A'}
                readOnly={readOnly || !hasQS} disabled={!readOnly && !hasQS}
                onChange={(v) => set({ commissionPct: v })} />
            </Term>
            <Term label="Surplus Commission %">
              <NumInput suffix="%" value={t.commissionSurplusPct} placeholder={hasSurplus ? 'e.g. 30' : 'N/A'}
                readOnly={readOnly || !hasSurplus} disabled={!readOnly && !hasSurplus}
                onChange={(v) => set({ commissionSurplusPct: v })} />
            </Term>
          </div>
        </div>
        <div className={`np-terms-fade${sliding ? '' : ' is-off'}`}>
          <div className="np-terms-grid">
            <Term label="Min Loss Ratio %">
              <NumInput suffix="%" value={t.slidingMinLossRatio} placeholder="e.g. 40"
                readOnly={readOnly} onChange={(v) => set({ slidingMinLossRatio: v })} />
            </Term>
            <Term label="Max Loss Ratio %">
              <NumInput suffix="%" value={t.slidingMaxLossRatio} placeholder="e.g. 80"
                readOnly={readOnly} onChange={(v) => set({ slidingMaxLossRatio: v })} />
            </Term>
            <Term label="Min Commission %">
              <NumInput suffix="%" value={t.slidingMinCommission} placeholder="e.g. 20"
                readOnly={readOnly} onChange={(v) => set({ slidingMinCommission: v })} />
            </Term>
            <Term label="Max Commission %">
              <NumInput suffix="%" value={t.slidingMaxCommission} placeholder="e.g. 35"
                readOnly={readOnly} onChange={(v) => set({ slidingMaxCommission: v })} />
            </Term>
          </div>
          <div className="np-sub-actions">
            <button type="button" className="np-struct-btn" onClick={() => setModal('sliding')}>
              Enter slide manually
            </button>
            <span className="np-badge-count">{slidingCount ? `${slidingCount} row(s)` : ''}</span>
          </div>
        </div>
        <div className="np-terms-grid">
          <Term label="Management Expenses %">
            <NumInput suffix="%" value={t.mgmtExpensesPct} placeholder="e.g. 5"
              readOnly={readOnly} onChange={(v) => set({ mgmtExpensesPct: v })} />
          </Term>
          <Term label="Profit Commission %">
            <NumInput suffix="%" value={t.profitCommissionPct} placeholder="e.g. 20"
              readOnly={readOnly} onChange={(v) => set({ profitCommissionPct: v })} />
          </Term>
          <Term label="Loss Carry Forward (LCF)">
            {readOnly ? (
              <input className="np-mini-input np-mini-input--readonly" readOnly
                value={t.lcfYears === 'extinction' ? 'Extinction' : t.lcfYears ? `${t.lcfYears} year(s)` : 'None'} />
            ) : (
              <select className="np-mini-input" value={t.lcfYears || ''}
                onChange={(e) => set({ lcfYears: e.target.value })}>
                <option value="">None</option>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                  <option key={n} value={n}>{n} year{n > 1 ? 's' : ''}</option>
                ))}
                <option value="extinction">Extinction</option>
              </select>
            )}
          </Term>
        </div>
      </TermsSub>

      <TermsSub title="LOSS PARTICIPATION"
        controls={
          <MiniPills readOnly={readOnly} ariaLabel="Loss participation enabled"
            options={[[true, 'YES'], [false, 'NO']]} value={lpOn}
            onChange={(v) => set({ lossPartEnabled: v })} />
        }>
        <div className={`np-terms-fade${lpOn ? '' : ' is-off'}`}>
          <div className="np-terms-grid">
            <Term label="Min Loss Ratio %">
              <NumInput suffix="%" value={t.minLossRatioPct} placeholder="e.g. 70"
                readOnly={readOnly} onChange={(v) => set({ minLossRatioPct: v })} />
            </Term>
            <Term label="Max Loss Ratio %">
              <NumInput suffix="%" value={t.maxLossRatioPct} placeholder="e.g. 100"
                readOnly={readOnly} onChange={(v) => set({ maxLossRatioPct: v })} />
            </Term>
            <Term label="Reinsurer Share %">
              <NumInput suffix="%" value={t.reinsurerSharePct} placeholder="e.g. 50"
                readOnly={readOnly} onChange={(v) => set({ reinsurerSharePct: v, lpvPct: v })} />
            </Term>
          </div>
          <div className="np-sub-actions">
            <button type="button" className="np-struct-btn" onClick={() => setModal('lp')}>
              Enter slides manually
            </button>
            <span className="np-badge-count">{lpCount ? `✓ ${lpCount} corridor(s)` : ''}</span>
          </div>
        </div>
      </TermsSub>

      <TermsSub title="EPI">
        <div className="np-terms-grid">
          <Term label={`Quota Share EPI (${currency || 'CCY'})`}>
            <NumInput value={t.quotaShareEpi} placeholder={hasQS ? 'e.g. 10,000,000' : 'N/A'}
              readOnly={readOnly || !hasQS} disabled={!readOnly && !hasQS}
              onChange={(v) => setEpi({ quotaShareEpi: v })} />
          </Term>
          <Term label={`Surplus EPI (${currency || 'CCY'})`}>
            <NumInput value={t.surplusEpi} placeholder={hasSurplus ? 'e.g. 5,000,000' : 'N/A'}
              readOnly={readOnly || !hasSurplus} disabled={!readOnly && !hasSurplus}
              onChange={(v) => setEpi({ surplusEpi: v })} />
          </Term>
        </div>
        <div className="np-sub-actions">
          <button type="button" className="np-struct-btn" disabled={!cobNames.length}
            title={cobNames.length ? '' : 'Select classes of business first'}
            onClick={() => cobNames.length && setModal('epi')}>
            EPI Split
          </button>
          <span className="np-badge-count">{epiCount ? `${epiCount} class(es)` : ''}</span>
        </div>
      </TermsSub>

      <TermsSub title="BROKERAGE &amp; TAXES">
        <div className="np-terms-grid">
          <Term label="Brokerage %">
            <NumInput suffix="%" value={t.brokeragePct} placeholder="e.g. 2.5"
              readOnly={readOnly} onChange={(v) => set({ brokeragePct: v })} />
          </Term>
          <Term label="Taxes %">
            <NumInput suffix="%" value={t.taxesPct} placeholder="e.g. 2"
              readOnly={readOnly} onChange={(v) => set({ taxesPct: v })} />
          </Term>
          <Term label="Loss Cap %">
            <NumInput suffix="%" value={t.lossCapPct} placeholder="e.g. 5"
              readOnly={readOnly} onChange={(v) => set({ lossCapPct: v })} />
          </Term>
          <Term label={`Cash Loss Advice (${currency || 'CCY'})`}>
            <NumInput value={t.cashLossAdvice} placeholder="e.g. 250,000"
              readOnly={readOnly} onChange={(v) => set({ cashLossAdvice: v })} />
          </Term>
        </div>
      </TermsSub>

      {modal === 'sliding' && (
        <SlidingScaleModal terms={t} readOnly={readOnly} onClose={() => setModal(null)}
          onSave={(patch) => { set(patch); setModal(null); }} />
      )}
      {modal === 'lp' && (
        <LpSlidesModal terms={t} readOnly={readOnly} onClose={() => setModal(null)}
          onSave={(patch) => { set(patch); setModal(null); }} />
      )}
      {modal === 'epi' && (
        <EpiSplitModal terms={t} cobNames={cobNames} readOnly={readOnly} onClose={() => setModal(null)}
          onSave={(patch) => { set(patch); setModal(null); }} />
      )}
    </div>
  );
}

/**
 * Proportional / non-proportional selector, shared by the expiring structure
 * and each structure to quote. `allowBoth` adds a third choice for a contract
 * written on both bases — only the expiring structure offers it, since a
 * structure to quote is one basis or the other.
 */
export function BasisPills({ basis, onChange, readOnly, allowBoth }) {
  const choices = [
    ['PROP', 'Proportional'],
    ['NP', 'Non-Proportional'],
    ...(allowBoth ? [['BOTH', 'Both']] : []),
  ];
  // Without the third pill, anything that is not PROP reads as NP.
  const current = allowBoth ? normaliseBasis(basis) : (basis === 'PROP' ? 'PROP' : 'NP');
  return (
    <div className="np-type-pills">
      {choices.map(([value, label]) => (
        <button key={value} type="button" disabled={readOnly}
          className={`np-type-pill ${current === value ? 'is-on' : 'is-off'}`}
          onClick={readOnly ? undefined : () => onChange(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export const layersToPayload = (layers) => (layers || []).map((r, i) => ({
  name: r.name.trim() || `Layer ${i + 1}`,
  type: r.type || 'XoL',
  region: r.region || null,
  attachment: r.attachment === '' ? null : Number(r.attachment),
  limit: r.limit === '' ? null : Number(r.limit),
  order: r.order === '' ? null : Number(r.order),
  premium: r.premium === '' ? null : Number(r.premium),
  risk: r.risk !== false,
  cat: r.cat !== false,
  reinstatements: r.reinstatements || null,
  reinstatement_pct: r.reinstatementPct === '' ? null : Number(r.reinstatementPct),
  egnpi: r.egnpi === '' ? null : Number(r.egnpi),
  rate_pct: r.rate === '' ? null : Number(r.rate),
  aad: r.aad === '' ? null : Number(r.aad),
  attach_lr_pct: r.attachLrPct === '' || r.attachLrPct == null ? null : Number(r.attachLrPct),
  limit_lr_pct: r.limitLrPct === '' || r.limitLrPct == null ? null : Number(r.limitLrPct),
  rol_pct: r.rolPct === '' || r.rolPct == null ? null : Number(r.rolPct),
  agg_limit: r.aggLimit === '' || r.aggLimit == null ? null : Number(r.aggLimit),
  agg_deductible: r.aggDeductible === '' || r.aggDeductible == null ? null : Number(r.aggDeductible),
}));

/** Stored layer → editable row. */
export const layerFromPayload = (l) => ({
  id: null,
  name: l.name || '',
  type: l.type || 'XoL',
  region: l.region || '',
  attachment: l.attachment == null ? '' : String(l.attachment),
  limit: l.limit == null ? '' : String(l.limit),
  order: l.order == null ? '100' : String(l.order),
  premium: l.premium == null ? '' : String(l.premium),
  risk: l.risk !== false,
  cat: l.cat !== false,
  reinstatements: l.reinstatements || '',
  reinstatementPct: l.reinstatement_pct == null ? '' : String(l.reinstatement_pct),
  egnpi: l.egnpi == null ? '' : String(l.egnpi),
  rate: l.rate_pct == null ? '' : String(l.rate_pct),
  aad: l.aad == null ? '' : String(l.aad),
  attachLrPct: l.attach_lr_pct == null ? '' : String(l.attach_lr_pct),
  limitLrPct: l.limit_lr_pct == null ? '' : String(l.limit_lr_pct),
  rolPct: l.rol_pct == null ? '' : String(l.rol_pct),
  aggLimit: l.agg_limit == null ? '' : String(l.agg_limit),
  aggDeductible: l.agg_deductible == null ? '' : String(l.agg_deductible),
});

/** The complementary cover sits on the opposite basis to the expiring
    treaty: a net (excess of loss) cover protecting the retention under a
    proportional treaty, or a proportional cover alongside a non-proportional
    one. It is optional, so `enabled` marks whether one was written. */
export const emptyComplementary = () => ({
  enabled: false, basis: null, layers: [emptyLayerRow()], prop: emptyPropTerms(),
});

/** The basis of the complementary cover for an expiring basis. */
export const complementaryBasis = (basis) => (basis === 'PROP' ? 'NP' : 'PROP');
export const complementaryLabel = (basis) => (complementaryBasis(basis) === 'NP' ? 'Net cover' : 'Proportional cover');

/** The expiring structure's complementary cover, tolerating older state
    stored before the cover existed. */
export const complementaryOf = (st) => ({ ...emptyComplementary(), ...(st?.complementary || {}) });

/** True once a complementary cover has been written on the expiring
    structure — on the basis the current expiring basis calls for, so a cover
    saved before the basis was switched does not read as set. */
export const hasComplementary = (st) => !!st?.complementary?.enabled
  && st.complementary.basis === complementaryBasis(st?.basis);


/**
 * Stop loss layer table — the modelling tool's stop loss structure: each
 * layer on a loss-ratio basis (attach and limit as % of the EPI), with the
 * limit, attachment and premium resolved from the EPI, and the ROL % implied
 * by rate ÷ limit LR unless overridden. The expiring table adds the rate and
 * ROL the tool's expiring stop loss carries.
 */
export function StopLossLayerTable({ rows, onChange, readOnly, currency, expiring = false, regions = LAYER_REGIONS }) {
  const upd = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i) => onChange(rows.filter((_, j) => j !== i));
  const ccy = currency || 'CCY';
  return (
    <div className="np-table-wrap">
      <table className="np-struct-table np-stoploss-table">
        <thead>
          <tr>
            <th className="np-table-sticky">LAYER</th>
            <th className="np-th-left">NAME</th>
            <th className="np-th-left" title="The region the layer is restricted to — worldwide unless set">GEOGRAPHIC REGION</th>
            <th title="Attachment as a % of the EPI (loss ratio)">ATTACH LR %</th>
            <th title="Limit as a % of the EPI (loss ratio)">LIMIT LR %</th>
            <th title="Estimated premium income the loss ratios apply to">EPI ({ccy})</th>
            <th title="Rate applied to the EPI">RATE %</th>
            <th title="ROL = Rate ÷ Limit LR; enter to override">ROL %</th>
            <th title="EPI × Limit LR">RESOLVED · LIMIT</th>
            <th title="EPI × Attach LR">RESOLVED · ATTACH</th>
            <th title="EPI × Rate, or as entered">PREMIUM 100%</th>
            <th>ORDER %</th>
            {!readOnly && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={readOnly ? 12 : 13} className="muted" style={{ padding: 12 }}>
              No layers{readOnly ? '.' : ' — add one below.'}
            </td></tr>
          )}
          {rows.map((r, i) => {
            const res = stopLossResolved(r);
            return (
              <tr key={r.id || `sl-${i}`}>
                <th className="np-table-sticky">
                  {r.id
                    ? <Link className="np-layer-badge" to={`/layers/${r.id}`} title="Open layer">L{i + 1}</Link>
                    : <span className="np-layer-badge">L{i + 1}</span>}
                </th>
                <td>
                  <input className="np-mini-input np-mini-input--left" data-col="name" value={r.name} readOnly={readOnly}
                    placeholder={`Layer ${i + 1}`} onChange={(e) => upd(i, { name: e.target.value })} />
                </td>
                <td><RegionSelect value={r.region} readOnly={readOnly} regions={regions}
                  onChange={(region) => upd(i, { region })} /></td>
                <td><NumInput data-col="attachLrPct" suffix="%" value={r.attachLrPct} readOnly={readOnly} placeholder="—%"
                  onChange={(v) => upd(i, { attachLrPct: v })} /></td>
                <td><NumInput data-col="limitLrPct" suffix="%" value={r.limitLrPct} readOnly={readOnly} placeholder="—%"
                  onChange={(v) => upd(i, { limitLrPct: v })} /></td>
                <td><NumInput data-col="egnpi" value={r.egnpi} readOnly={readOnly} placeholder="—"
                  onChange={(v) => upd(i, { egnpi: v })} /></td>
                <td><NumInput data-col="rate" suffix="%" value={r.rate} readOnly={readOnly} placeholder="—%"
                  onChange={(v) => upd(i, { rate: v })} /></td>
                <td><NumInput data-col="rolPct" suffix="%" value={r.rolPct} readOnly={readOnly}
                  placeholder={res.impliedRol != null ? `${res.impliedRol.toFixed(2)}%` : '—%'}
                  onChange={(v) => upd(i, { rolPct: v })} /></td>
                <td><input className="np-mini-input np-mini-input--readonly" data-col="resolvedLimit" readOnly
                  value={fmt(res.limit)} placeholder="—" /></td>
                <td><input className="np-mini-input np-mini-input--readonly" data-col="resolvedAttachment" readOnly
                  value={fmt(res.attachment)} placeholder="—" /></td>
                <td><NumInput data-col="premium" value={r.premium} readOnly={readOnly}
                  placeholder={res.premium ? fmt(res.premium) : '—'}
                  onChange={(v) => upd(i, { premium: v })} /></td>
                <td><NumInput data-col="order" suffix="%" value={r.order} readOnly={readOnly} placeholder="—"
                  onChange={(v) => upd(i, { order: v })} /></td>
                {!readOnly && (
                  <td>
                    <button type="button" className="renew-x" onClick={() => remove(i)} aria-label="Remove layer">✕</button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="np-struct-card-hint" style={{ marginTop: 6 }}>
        Loss-ratio basis: limit and attachment resolve as EPI × LR %; premium as EPI × rate unless entered.
        ROL = rate ÷ limit LR when both are entered{expiring ? ', overridable per layer' : ''}.
      </div>
    </div>
  );
}

/**
 * Aggregate XL layer table — the modelling tool's aggregate XL structure:
 * each layer in aggregate amounts (limit and deductible on the annual
 * aggregate), the per-loss deductible and AAD, and the risk / cat covers.
 * The aggregate limit and deductible are what the placement's layer carries.
 */
export function AggregateXlTable({ rows, onChange, readOnly, currency, regions = LAYER_REGIONS }) {
  const upd = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i) => onChange(rows.filter((_, j) => j !== i));
  const ccy = currency || 'CCY';
  return (
    <div className="np-table-wrap">
      <table className="np-struct-table np-agg-table">
        <thead>
          <tr>
            <th className="np-table-sticky">LAYER</th>
            <th className="np-th-left">NAME</th>
            <th className="np-th-left" title="The region the layer is restricted to — worldwide unless set">GEOGRAPHIC REGION</th>
            <th title="Limit on the annual aggregate">AGGREGATE LIMIT ({ccy})</th>
            <th title="Deductible on the annual aggregate">AGGREGATE DEDUCTIBLE ({ccy})</th>
            <th title="Per-loss deductible">DEDUCTIBLE ({ccy})</th>
            <th title="Annual aggregate deductible">AAD ({ccy})</th>
            <th>PREMIUM 100%</th>
            <th>ORDER %</th>
            <th title="Layer covers risk losses">RISK</th>
            <th title="Layer covers catastrophe losses">CAT</th>
            {!readOnly && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={readOnly ? 11 : 12} className="muted" style={{ padding: 12 }}>
              No layers{readOnly ? '.' : ' — add one below.'}
            </td></tr>
          )}
          {rows.map((r, i) => (
            <tr key={r.id || `agg-${i}`}>
              <th className="np-table-sticky">
                {r.id
                  ? <Link className="np-layer-badge" to={`/layers/${r.id}`} title="Open layer">L{i + 1}</Link>
                  : <span className="np-layer-badge">L{i + 1}</span>}
              </th>
              <td>
                <input className="np-mini-input np-mini-input--left" data-col="name" value={r.name} readOnly={readOnly}
                  placeholder={`Layer ${i + 1}`} onChange={(e) => upd(i, { name: e.target.value })} />
              </td>
              <td><RegionSelect value={r.region} readOnly={readOnly} regions={regions}
                onChange={(region) => upd(i, { region })} /></td>
              <td><NumInput data-col="aggLimit" value={r.aggLimit ?? ''} readOnly={readOnly} placeholder="—"
                onChange={(v) => upd(i, { aggLimit: v })} /></td>
              <td><NumInput data-col="aggDeductible" value={r.aggDeductible ?? ''} readOnly={readOnly} placeholder="—"
                onChange={(v) => upd(i, { aggDeductible: v })} /></td>
              <td><NumInput data-col="attachment" value={r.attachment} readOnly={readOnly} placeholder="—"
                onChange={(v) => upd(i, { attachment: v })} /></td>
              <td><NumInput data-col="aad" value={r.aad} readOnly={readOnly} placeholder="—"
                onChange={(v) => upd(i, { aad: v })} /></td>
              <td><NumInput data-col="premium" value={r.premium} readOnly={readOnly} placeholder="—"
                onChange={(v) => upd(i, { premium: v })} /></td>
              <td><NumInput data-col="order" suffix="%" value={r.order} readOnly={readOnly} placeholder="—"
                onChange={(v) => upd(i, { order: v })} /></td>
              <td><input type="checkbox" className="np-check" data-col="risk" checked={r.risk !== false} disabled={readOnly}
                onChange={readOnly ? undefined : (e) => upd(i, { risk: e.target.checked })} /></td>
              <td><input type="checkbox" className="np-check" data-col="cat" checked={r.cat !== false} disabled={readOnly}
                onChange={readOnly ? undefined : (e) => upd(i, { cat: e.target.checked })} /></td>
              {!readOnly && (
                <td>
                  <button type="button" className="renew-x" onClick={() => remove(i)} aria-label="Remove layer">✕</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="np-struct-card-hint" style={{ marginTop: 6 }}>
        Aggregate limit and deductible apply to the annual aggregate; the deductible and AAD apply per loss.
      </div>
    </div>
  );
}

/** The aggregate XL policy shape — the tool's two toggles. */
export function AggregateXlShape({ value, onChange, readOnly }) {
  const v = value || {};
  const items = [
    ['franchiseDeductible', 'Franchise Deductible', 'Deductible disappears once a loss breaches it (no offset)'],
    ['structuredDeal', 'Structured Deal', 'Multi-year or commutation-linked structure'],
  ];
  return (
    <div className="np-count-row np-agg-shape">
      <span className="np-count-hint" style={{ fontWeight: 700 }}>AGGREGATE XL · POLICY SHAPE</span>
      {items.map(([key, label, hint]) => (
        <label key={key} className="np-agg-toggle" title={hint}>
          <input type="checkbox" className="np-check" data-col={key} checked={!!v[key]} disabled={readOnly}
            onChange={readOnly ? undefined : (e) => onChange({ [key]: e.target.checked })} />
          {label}
        </label>
      ))}
    </div>
  );
}

/**
 * One quote structure section: S-badge header, proportional /
 * non-proportional basis pills, then either the prop terms grid or the NP
 * layer table — each with its Classes of Business sub-section.
 */
export function QuoteStructureSection({
  idx, value, onChange, readOnly, currency, cobNames, propTreatyTypes = PROP_TYPES, npTreatyTypes = [],
}) {
  const st = value;
  const set = (patch) => onChange({ ...st, ...patch });
  const isNP = st.basis !== 'PROP';
  const layerCount = isNP ? st.layers.length : 0;
  const cobs = seedCobRows(cobNames, st.cobs, layerCount);
  // The structure's non-proportional treaty type (one of the Treaty
  // Detail's) decides how it renders, as the modelling tool's structure
  // screen does: a stop loss on a loss-ratio basis, an aggregate XL in
  // aggregate amounts with inner limits, a Risk XL / CAT XL with its covers
  // locked, a Risk & CAT XL with them free.
  const npType = st.npTreatyType || '';
  const coverMode = npCoverMode(npType);
  // Edited layers re-derive the classes' participation from their attachments.
  const setLayers = (rows) => {
    const layers = applyCoverMode(rows, coverMode);
    set({ layers, cobs: recomputeCobCoverage(seedCobRows(cobNames, st.cobs, layers.length), layers) });
  };
  const setNpType = (npTreatyType) => set({ npTreatyType, layers: applyCoverMode(st.layers, npCoverMode(npTreatyType)) });
  const stopLossNP = isNP && isStopLossType(npType);
  const aggregateNP = isNP && isAggregateXlType(npType);

  return (
    <section className="np-struct-card">
      <div className="qss-header">
        <div className="qss-left">
          <div className="qss-struct-badge">S{idx + 1}</div>
          <div>
            <div className="qss-struct-title">Structure {idx + 1}</div>
            <div className="qss-struct-sub">
              {stopLossNP
                ? 'Non-proportional — stop loss on a loss-ratio basis; limit and attachment resolve from the EPI.'
                : aggregateNP
                  ? 'Non-proportional — aggregate XL in aggregate amounts, with inner limits per class.'
                  : isNP
                    ? `Non-proportional — layered excess of loss structure${coverMode === 'RISK' ? ', risk losses only' : coverMode === 'CAT' ? ', cat losses only' : ''}.`
                    : 'Proportional — terms track the chosen treaty type.'}
            </div>
          </div>
        </div>
        <BasisPills basis={st.basis} readOnly={readOnly} onChange={(basis) => set({ basis })} />
      </div>

      {isNP ? (
        <>
          <div className="np-count-row">
            <label htmlFor={`qss-np-type-${idx}`}>Treaty Type</label>
            {readOnly ? (
              <input className="fi qss-np-type" style={{ width: 260 }} readOnly value={npType} placeholder="—" />
            ) : (
              <select id={`qss-np-type-${idx}`} className="fi qss-np-type" style={{ width: 260 }} value={npType}
                onChange={(e) => setNpType(e.target.value)}>
                <option value="">Select treaty type…</option>
                {npType && !npTreatyTypes.includes(npType) && <option value={npType}>{npType}</option>}
                {npTreatyTypes.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            )}
            <span className="np-type-pills np-type-pills--mini" aria-label="Covers">
              <span className={`np-type-pill ${coverMode !== 'CAT' ? 'is-on' : 'is-off'}`}>RISK</span>
              <span className={`np-type-pill ${coverMode !== 'RISK' ? 'is-on' : 'is-off'}`}>CAT</span>
            </span>
            <span className="np-count-hint">The Treaty Detail’s non-proportional treaty types</span>
          </div>
          {aggregateNP && (
            <AggregateXlShape value={st.agg} readOnly={readOnly}
              onChange={(patch) => set({ agg: { ...(st.agg || {}), ...patch } })} />
          )}
          {stopLossNP ? (
            <StopLossLayerTable rows={st.layers} readOnly={readOnly} currency={currency}
              onChange={setLayers} />
          ) : aggregateNP ? (
            <AggregateXlTable rows={st.layers} readOnly={readOnly} currency={currency}
              onChange={setLayers} />
          ) : (
            <StructLayerTable rows={st.layers} readOnly={readOnly} currency={currency}
              coverMode={coverMode} onChange={setLayers} />
          )}
          {!readOnly && (
            <div className="toolbar" style={{ marginTop: 10 }}>
              <button type="button" className="np-struct-btn"
                onClick={() => setLayers([...st.layers, emptyLayerRow()])}>
                ＋ Add layer
              </button>
            </div>
          )}
        </>
      ) : (
        <PropTermsFields value={st.prop} readOnly={readOnly} currency={currency}
          cobNames={cobNames} propTreatyTypes={propTreatyTypes} onChange={(prop) => set({ prop })} />
      )}

      {/* A stop loss covers the whole account — the tool shows no per-class
          participation for it; an aggregate XL caps classes with inner limits. */}
      {aggregateNP ? (
        <CobInnerLimitsTable rows={cobs} readOnly={readOnly} currency={currency}
          onChange={(next) => set({ cobs: next })} />
      ) : (!isNP || npShowsParticipation(npType)) && (
        <CobLimitsTable rows={cobs} layerCount={layerCount} layers={isNP ? st.layers : []}
          readOnly={readOnly} currency={currency}
          onChange={(next) => set({ cobs: next })} />
      )}
    </section>
  );
}

/** Serialise structure layers (quote or expiring) for storage. */
/* ── Expiring structure & terms — Universe's treaty-detail cards in a 2 × 2
      grid: LIMIT DETAILS, COMMISSIONS and LOSS PARTICIPATION (with EPI and
      BROKERAGE & TAXES) for a proportional treaty, then STRUCTURE for a
      non-proportional one. The basis picks which cards are active; the
      others sit dimmed, and a click on one switches the basis. Stored on the
      placement's own expiring_structure column. ── */

export const NP_ACCOUNTING_METHODS = ['Losses Occurring During (LOD)', 'Risks Attaching During (RAD)', 'Claims Made'];
export const NP_ACCOUNTS = ['Quarterly', 'Half-yearly', 'Annual'];

/** The non-proportional treaty terms — the modelling tool's STRUCTURE card:
    the layer configuration and the premium & commissions. The treaty type is
    one of the Treaty Detail's non-proportional types (Risk XL, CAT XL…). */
export const emptyNpTerms = () => ({
  treatyType: '', deductible: '', maxRetention: '', accountingMethod: '', accounts: '',
  // Aggregate XL policy shape.
  franchiseDeductible: false, structuredDeal: false,
  egnpi: '', brokeragePct: '', taxesPct: '', ncbPct: '', profitCommissionPct: '',
});

export const emptyExpiring = () => ({
  basis: 'NP', layers: [emptyLayerRow()], prop: emptyPropTerms(), np: emptyNpTerms(),
  complementary: emptyComplementary(),
});

/** A stored basis, defaulting anything unrecognised to NP. */
export const normaliseBasis = (b) => (b === 'PROP' || b === 'BOTH' ? b : 'NP');
/** BOTH carries a proportional section and a non-proportional one. */
export const hasProp = (b) => b === 'PROP' || b === 'BOTH';
export const hasNP = (b) => b !== 'PROP';

/** Layer count that drives the COB limits table: none on a prop basis. */
export const basisLayerCount = (st) => (hasNP(st.basis) ? (st.layers || []).length : 0);

/** True once an expiring structure has been saved on the placement — the
    column defaults to {}, so a stored basis is the marker. A saved structure
    always wins over one derived from the prior year contract, empty or not. */
export const expiringIsStored = (raw) => !!raw && typeof raw === 'object' && !!raw.basis;

/** Serialise the expiring structure for the placement's expiring_structure column. */
export const expiringToPayload = (st) => {
  const comp = complementaryOf(st);
  const compBasis = complementaryBasis(st.basis);
  return {
    basis: normaliseBasis(st.basis),
    layers: hasNP(st.basis) ? layersToPayload(st.layers) : [],
    prop: { ...emptyPropTerms(), ...(st.prop || {}) },
    np: { ...emptyNpTerms(), ...(st.np || {}) },
    // The complementary cover is stored on the basis opposite the expiring
    // one; only the half that basis uses is written.
    complementary: {
      enabled: hasComplementary(st),
      basis: compBasis,
      layers: compBasis === 'NP' ? layersToPayload(comp.layers) : [],
      prop: compBasis === 'PROP' ? { ...emptyPropTerms(), ...(comp.prop || {}) } : {},
    },
  };
};

/** Deserialise the expiring structure back into editable state. */
export const expiringFromPayload = (stored) => ({
  basis: normaliseBasis(stored?.basis),
  layers: (stored?.layers || []).length ? stored.layers.map(layerFromPayload) : [emptyLayerRow()],
  prop: upgradePropTerms(stored?.prop),
  np: { ...emptyNpTerms(), ...(stored?.np || {}) },
  complementary: {
    enabled: !!stored?.complementary?.enabled,
    basis: stored?.complementary?.basis || null,
    layers: (stored?.complementary?.layers || []).length
      ? stored.complementary.layers.map(layerFromPayload) : [emptyLayerRow()],
    prop: upgradePropTerms(stored?.complementary?.prop),
  },
});

/** One card of the grid. Inactive cards (the other basis) are dimmed and
    switch the basis when clicked. */
function ExpCard({ label, tag, kind, on, onActivate, basisLabel, children }) {
  return (
    <section className={`td-card exp-card exp-card--${kind} ${on ? 'is-on' : 'is-off'}`}
      aria-disabled={!on}
      title={on || !onActivate ? '' : `Inactive — click to switch the expiring basis to ${basisLabel}`}
      onClick={on ? undefined : onActivate}>
      <div className="td-card-head">
        <span className="td-card-label">{label}</span>
        {tag}
      </div>
      <div className="td-card-body">{children}</div>
    </section>
  );
}

/** A numeric term row — N/A when its half of the treaty is off. */
function NumRow({ label, value, onChange, suffix, placeholder, off, readOnly }) {
  return (
    <Fr label={label}>
      <NumInput className="exp-num" suffix={suffix} value={value}
        placeholder={off ? 'N/A' : placeholder}
        readOnly={readOnly || off} disabled={!readOnly && off}
        onChange={onChange} />
    </Fr>
  );
}

/** An auto-calculated row. */
function AutoRow({ label, value }) {
  return (
    <Fr label={label}>
      <input className="np-mini-input np-mini-input--readonly exp-num" readOnly placeholder="auto" value={value} />
    </Fr>
  );
}

/**
 * The 2 × 2 grid of treaty-detail cards. `prop` says which basis is active;
 * `onActivate(basis)` is what a click on an inactive card does.
 */
function ExpiringTermsGrid({ st, set, readOnly, currency, cobNames, onActivate, npTreatyTypes = [], propTreatyTypes = PROP_TYPES }) {
  const prop = st.basis === 'PROP';
  const t = { ...emptyPropTerms(), ...(st.prop || {}) };
  const np = { ...emptyNpTerms(), ...(st.np || {}) };
  const setP = (patch) => set({ prop: { ...t, ...patch } });
  const setN = (patch) => set({ np: { ...np, ...patch } });
  const [modal, setModal] = useState(null); // 'sliding' | 'lp' | 'epi'
  const { hasQS, hasSurplus, cesPct, retAmt, cesAmt, surplusCapacity, capacity } = propCalcs(t);
  const sliding = t.commissionMode === 'sliding';
  const lpOn = t.lossPartEnabled !== false;
  const slidingCount = (t.slidingTable || []).filter((r) => r.lossRatioPct || r.commissionPct).length;
  const lpCount = (t.lpSlides || []).filter((r) => r.minLr || r.maxLr || r.share).length;
  const epiCount = (t.epiSplit || []).filter((r) => String(r.premium ?? '').trim()).length;
  // Keep the legacy single-EPI field mirroring the QS + Surplus total so
  // older readers of the stored terms stay coherent.
  const setEpi = (patch) => {
    const next = { ...t, ...patch };
    const total = toNum(next.quotaShareEpi) + toNum(next.surplusEpi);
    setP({ ...patch, epi: total ? String(total) : '' });
  };
  const ccy = currency || 'CCY';
  // A card of the inactive basis is read-only until it is switched to.
  const roP = readOnly || !prop;
  const roN = readOnly || prop;
  const toProp = onActivate ? () => onActivate('PROP') : undefined;
  const toNP = onActivate ? () => onActivate('NP') : undefined;

  const setLayerCount = (n) => {
    const k = Math.max(0, Math.min(20, Math.floor(Number(n) || 0)));
    const rows = [...(st.layers || [])];
    while (rows.length < k) rows.push(emptyLayerRow());
    set({ layers: rows.slice(0, k) });
  };

  return (
    <div className="exp-grid" data-basis={prop ? 'PROP' : 'NP'}>
      <ExpCard kind="limits" label="LIMIT DETAILS" on={prop} onActivate={toProp} basisLabel="Proportional"
        tag={<span className="td-card-tag">CAPACITY</span>}>
        <Fr label="Treaty Type" hint="The Treaty Detail's proportional treaty types">
          {roP ? (
            <input className="fi fi--readonly" readOnly value={t.treatyType} placeholder="—" />
          ) : (
            <select className="fi" value={t.treatyType} onChange={(e) => setP({ treatyType: e.target.value })}>
              <option value="">Select treaty type…</option>
              {t.treatyType && !propTreatyTypes.includes(t.treatyType) && (
                <option value={t.treatyType}>{t.treatyType}</option>
              )}
              {propTreatyTypes.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          )}
        </Fr>
        <NumRow label={`QS 100% Limit (${ccy})`} value={t.qsLimit} placeholder="e.g. 10,000,000"
          off={!hasQS} readOnly={roP} onChange={(v) => setP({ qsLimit: v })} />
        <NumRow label="Retention %" suffix="%" value={t.retentionPct} placeholder="e.g. 50"
          off={!hasQS} readOnly={roP} onChange={(v) => setP({ retentionPct: v })} />
        <AutoRow label="Retention Amount" value={retAmt ? retAmt.toLocaleString() : ''} />
        <NumRow label="Cession %" suffix="%" value={cesPct === '' ? '' : String(cesPct)} placeholder="e.g. 50"
          off={!hasQS} readOnly={roP} onChange={(v) => setP({ retentionPct: retentionFromCession(v) })} />
        <AutoRow label="Cession Amount" value={cesAmt ? cesAmt.toLocaleString() : ''} />
        <NumRow label={`Surplus Max Retention (${ccy})`} value={t.surplusMaxRetention} placeholder="e.g. 1,000,000"
          off={!hasSurplus} readOnly={roP} onChange={(v) => setP({ surplusMaxRetention: v })} />
        <NumRow label="Number of Lines" value={t.numLines} placeholder="e.g. 5"
          off={!hasSurplus} readOnly={roP} onChange={(v) => setP({ numLines: v })} />
        <AutoRow label="Surplus Capacity" value={surplusCapacity ? surplusCapacity.toLocaleString() : ''} />
        <AutoRow label="Total Treaty Capacity" value={capacity ? capacity.toLocaleString() : ''} />
        <NumRow label={`Event Limit (${ccy})`} value={t.eventLimit} placeholder="e.g. 3,000,000"
          readOnly={roP} onChange={(v) => setP({ eventLimit: v })} />
        <NumRow label={`AAL (${ccy})`} value={t.aal} placeholder="e.g. 10,000,000"
          readOnly={roP} onChange={(v) => setP({ aal: v })} />
      </ExpCard>

      <ExpCard kind="commissions" label="COMMISSIONS" on={prop} onActivate={toProp} basisLabel="Proportional"
        tag={
          <MiniPills readOnly={roP} ariaLabel="Commission mode"
            options={[['fixed', 'FIXED COMMISSION'], ['sliding', 'SLIDING SCALE']]}
            value={sliding ? 'sliding' : 'fixed'}
            onChange={(v) => setP({ commissionMode: v })} />
        }>
        <div className="td-hint">Choose between a single fixed commission or a sliding scale commission structure.</div>
        <div className={`np-terms-fade${sliding ? ' is-off' : ''}`}>
          <div className="exp-sub">FIXED COMMISSION</div>
          <NumRow label="QS Commission %" suffix="%" value={t.commissionPct} placeholder="e.g. 27.5"
            off={!hasQS} readOnly={roP} onChange={(v) => setP({ commissionPct: v })} />
          <NumRow label="Surplus Commission %" suffix="%" value={t.commissionSurplusPct} placeholder="e.g. 30"
            off={!hasSurplus} readOnly={roP} onChange={(v) => setP({ commissionSurplusPct: v })} />
        </div>
        <div className={`np-terms-fade${sliding ? '' : ' is-off'}`}>
          <div className="exp-sub">SLIDING SCALE</div>
          <NumRow label="Min Loss Ratio %" suffix="%" value={t.slidingMinLossRatio} placeholder="e.g. 40"
            readOnly={roP} onChange={(v) => setP({ slidingMinLossRatio: v })} />
          <NumRow label="Max Loss Ratio %" suffix="%" value={t.slidingMaxLossRatio} placeholder="e.g. 80"
            readOnly={roP} onChange={(v) => setP({ slidingMaxLossRatio: v })} />
          <NumRow label="Min Commission %" suffix="%" value={t.slidingMinCommission} placeholder="e.g. 20"
            readOnly={roP} onChange={(v) => setP({ slidingMinCommission: v })} />
          <NumRow label="Max Commission %" suffix="%" value={t.slidingMaxCommission} placeholder="e.g. 35"
            readOnly={roP} onChange={(v) => setP({ slidingMaxCommission: v })} />
          <div className="np-sub-actions">
            <button type="button" className="np-struct-btn" onClick={() => setModal('sliding')}>
              Enter slide manually
            </button>
            <span className="np-badge-count">{slidingCount ? `${slidingCount} row(s)` : '0 row(s)'}</span>
          </div>
        </div>
        <div className="exp-sub">ADDITIONAL</div>
        <NumRow label="Management Expenses %" suffix="%" value={t.mgmtExpensesPct} placeholder="e.g. 5"
          readOnly={roP} onChange={(v) => setP({ mgmtExpensesPct: v })} />
        <NumRow label="Profit Commission %" suffix="%" value={t.profitCommissionPct} placeholder="e.g. 20"
          readOnly={roP} onChange={(v) => setP({ profitCommissionPct: v })} />
        <Fr label="Loss Carry Forward (LCF)">
          {roP ? (
            <input className="fi fi--readonly" readOnly
              value={t.lcfYears === 'extinction' ? 'Extinction' : t.lcfYears ? `${t.lcfYears} year(s)` : 'None'} />
          ) : (
            <select className="fi" value={t.lcfYears || ''} onChange={(e) => setP({ lcfYears: e.target.value })}>
              <option value="">None</option>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <option key={n} value={n}>{n} year{n > 1 ? 's' : ''}</option>
              ))}
              <option value="extinction">Extinction</option>
            </select>
          )}
        </Fr>
      </ExpCard>

      <ExpCard kind="lp" label="LOSS PARTICIPATION" on={prop} onActivate={toProp} basisLabel="Proportional"
        tag={
          <MiniPills readOnly={roP} ariaLabel="Loss participation enabled"
            options={[[true, 'YES'], [false, 'NO']]} value={lpOn}
            onChange={(v) => setP({ lossPartEnabled: v })} />
        }>
        <div className="td-hint">Capture loss participation corridors where the reinsurer share changes above a given loss ratio.</div>
        <div className={`np-terms-fade${lpOn ? '' : ' is-off'}`}>
          <NumRow label="Min Loss Ratio %" suffix="%" value={t.minLossRatioPct} placeholder="e.g. 70"
            readOnly={roP} onChange={(v) => setP({ minLossRatioPct: v })} />
          <NumRow label="Max Loss Ratio %" suffix="%" value={t.maxLossRatioPct} placeholder="e.g. 100"
            readOnly={roP} onChange={(v) => setP({ maxLossRatioPct: v })} />
          <NumRow label="Reinsurer Share %" suffix="%" value={t.reinsurerSharePct} placeholder="e.g. 50"
            readOnly={roP} onChange={(v) => setP({ reinsurerSharePct: v, lpvPct: v })} />
          <div className="np-sub-actions">
            <button type="button" className="np-struct-btn" onClick={() => setModal('lp')}>
              Enter slides manually
            </button>
            <span className="np-badge-count">{lpCount ? `✓ ${lpCount} corridor(s)` : ''}</span>
          </div>
        </div>
        <div className="exp-sub">EPI</div>
        <NumRow label={`Quota Share EPI (${ccy})`} value={t.quotaShareEpi} placeholder="e.g. 10,000,000"
          off={!hasQS} readOnly={roP} onChange={(v) => setEpi({ quotaShareEpi: v })} />
        <NumRow label={`Surplus EPI (${ccy})`} value={t.surplusEpi} placeholder="e.g. 5,000,000"
          off={!hasSurplus} readOnly={roP} onChange={(v) => setEpi({ surplusEpi: v })} />
        <div className="np-sub-actions">
          <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={!cobNames.length}
            title={cobNames.length ? '' : 'Select classes of business first'}
            onClick={() => cobNames.length && setModal('epi')}>
            EPI Split
          </button>
          <span className="np-badge-count">{epiCount ? `${epiCount} class(es)` : ''}</span>
        </div>
        <div className="exp-sub">BROKERAGE &amp; TAXES</div>
        <NumRow label="Brokerage %" suffix="%" value={t.brokeragePct} placeholder="e.g. 2.5"
          readOnly={roP} onChange={(v) => setP({ brokeragePct: v })} />
        <NumRow label="Taxes %" suffix="%" value={t.taxesPct} placeholder="e.g. 2"
          readOnly={roP} onChange={(v) => setP({ taxesPct: v })} />
        <NumRow label="Loss Cap %" suffix="%" value={t.lossCapPct} placeholder="e.g. 5"
          readOnly={roP} onChange={(v) => setP({ lossCapPct: v })} />
        <NumRow label={`Cash Loss Advice (${ccy})`} value={t.cashLossAdvice} placeholder="e.g. 250,000"
          readOnly={roP} onChange={(v) => setP({ cashLossAdvice: v })} />
      </ExpCard>

      <ExpCard kind="np" label="STRUCTURE" on={!prop} onActivate={toNP} basisLabel="Non-Proportional"
        tag={<span className="td-card-tag">TERMS</span>}>
        <div className="exp-sub">LAYER CONFIGURATION</div>
        <Fr label="Treaty Type" hint="The Treaty Detail's non-proportional treaty types">
          {roN ? (
            <input className="fi fi--readonly" readOnly value={np.treatyType} placeholder="—" />
          ) : (
            <select className="fi" value={np.treatyType} onChange={(e) => setN({ treatyType: e.target.value })}>
              <option value="">Select treaty type…</option>
              {np.treatyType && !npTreatyTypes.includes(np.treatyType) && (
                <option value={np.treatyType}>{np.treatyType}</option>
              )}
              {npTreatyTypes.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
        </Fr>
        <Fr label="Number of Layers" hint="Sets the rows of the expiring layers table below">
          <input className="fi" type="number" min="0" max="20" step="1" placeholder="e.g. 4"
            value={(st.layers || []).length || ''} readOnly={roN} disabled={!readOnly && prop}
            onChange={(e) => setLayerCount(e.target.value)} />
        </Fr>
        <NumRow label={`Deductible (${ccy})`} value={np.deductible} placeholder="e.g. 1,000,000"
          readOnly={roN} onChange={(v) => setN({ deductible: v })} />
        <NumRow label={`Maximum Retention (${ccy})`} value={np.maxRetention} placeholder="e.g. 5,000,000"
          readOnly={roN} onChange={(v) => setN({ maxRetention: v })} />
        {[
          ['Accounting Method', 'accountingMethod', NP_ACCOUNTING_METHODS],
          ['Accounts', 'accounts', NP_ACCOUNTS],
        ].map(([label, key, options]) => (
          <Fr key={key} label={label}>
            {roN ? (
              <input className="fi fi--readonly" readOnly value={np[key]} placeholder="—" />
            ) : (
              <select className="fi" value={np[key]} onChange={(e) => setN({ [key]: e.target.value })}>
                <option value="">Select…</option>
                {np[key] && !options.includes(np[key]) && <option value={np[key]}>{np[key]}</option>}
                {options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            )}
          </Fr>
        ))}
        <div className="exp-sub">PREMIUM &amp; COMMISSIONS</div>
        <NumRow label={`Est. GNPI (${ccy})`} value={np.egnpi} placeholder="e.g. 50,000,000"
          readOnly={roN} onChange={(v) => setN({ egnpi: v })} />
        <NumRow label="Brokerage %" suffix="%" value={np.brokeragePct} placeholder="e.g. 10"
          readOnly={roN} onChange={(v) => setN({ brokeragePct: v })} />
        <NumRow label="Taxes %" suffix="%" value={np.taxesPct} placeholder="e.g. 2"
          readOnly={roN} onChange={(v) => setN({ taxesPct: v })} />
        <NumRow label="No Claims Bonus %" suffix="%" value={np.ncbPct} placeholder="e.g. 5"
          readOnly={roN} onChange={(v) => setN({ ncbPct: v })} />
        <NumRow label="Profit Commission %" suffix="%" value={np.profitCommissionPct} placeholder="e.g. 10"
          readOnly={roN} onChange={(v) => setN({ profitCommissionPct: v })} />
      </ExpCard>

      {modal === 'sliding' && (
        <SlidingScaleModal terms={t} readOnly={roP} onClose={() => setModal(null)}
          onSave={(patch) => { setP(patch); setModal(null); }} />
      )}
      {modal === 'lp' && (
        <LpSlidesModal terms={t} readOnly={roP} onClose={() => setModal(null)}
          onSave={(patch) => { setP(patch); setModal(null); }} />
      )}
      {modal === 'epi' && (
        <EpiSplitModal terms={t} cobNames={cobNames} readOnly={roP} onClose={() => setModal(null)}
          onSave={(patch) => { setP(patch); setModal(null); }} />
      )}
    </div>
  );
}

/**
 * The expiring structure & terms: the 2 × 2 grid of treaty-detail cards,
 * the expiring layers (non-proportional) and the classes of business. The
 * basis selector sits on the page above; `onBasisChange` is what a click on
 * an inactive card does (defaulting to setting the basis here).
 */
export function ExpiringStructureSection({
  value, onChange, readOnly, currency, cobRows, onCobsChange, cobsReadOnly, hint, notice, onBasisChange,
  npTreatyTypes, propTreatyTypes,
}) {
  const st = value;
  const prop = st.basis === 'PROP';
  const set = (patch) => onChange({ ...st, ...patch });
  const activate = readOnly ? undefined : (basis) => (onBasisChange ? onBasisChange(basis) : set({ basis }));
  const cobNames = (cobRows || []).map((r) => r.cob).filter(Boolean);
  // The expiring treaty type decides the layer table: a Stop Loss is on a
  // loss-ratio basis, as the modelling tool's expiring stop loss.
  const npType = st.np?.treatyType || '';
  const stopLoss = isStopLossType(npType);
  const aggregate = isAggregateXlType(npType);
  const coverMode = npCoverMode(npType);
  // Edited layers re-derive the classes' participation from their attachments.
  const setLayers = (rows) => {
    const layers = applyCoverMode(rows, coverMode);
    set({ layers });
    if (onCobsChange && cobRows) onCobsChange(recomputeCobCoverage(seedCobRows(cobNames, cobRows, layers.length), layers));
  };

  return (
    <StructCard
      title="Expiring Structure & Terms"
      hint={hint}
      notice={notice}
      actions={
        <span className="np-layer-count">
          {prop ? 'Basis' : 'Layers'}
          <b>{prop ? (st.prop?.treatyType || 'Proportional') : (st.layers.length || '—')}</b>
        </span>
      }
      footnote="Expiring structure is used for year-on-year comparison in the renewal pack.">
      <ExpiringTermsGrid st={st} set={set} readOnly={readOnly} currency={currency}
        cobNames={cobNames} onActivate={activate} npTreatyTypes={npTreatyTypes} propTreatyTypes={propTreatyTypes} />

      <ExpCard kind="layers"
        label={stopLoss ? 'EXPIRING STOP LOSS · BY LAYER' : aggregate ? 'EXPIRING AGGREGATE XL · BY LAYER' : 'EXPIRING LAYERS'}
        on={!prop}
        onActivate={activate ? () => activate('NP') : undefined}
        basisLabel="Non-Proportional"
        tag={<span className="td-card-tag">{stopLoss ? 'LOSS-RATIO BASIS' : aggregate ? 'AGGREGATE AMOUNTS' : st.layers.length ? `${st.layers.length} LAYER${st.layers.length > 1 ? 'S' : ''}` : 'LAYERS'}</span>}>
        {aggregate && (
          <AggregateXlShape value={st.np} readOnly={readOnly || prop}
            onChange={(patch) => set({ np: { ...emptyNpTerms(), ...(st.np || {}), ...patch } })} />
        )}
        {stopLoss ? (
          <StopLossLayerTable rows={st.layers} readOnly={readOnly || prop} currency={currency}
            onChange={setLayers} expiring />
        ) : aggregate ? (
          <AggregateXlTable rows={st.layers} readOnly={readOnly || prop} currency={currency}
            onChange={setLayers} />
        ) : (
          <StructLayerTable rows={st.layers} readOnly={readOnly || prop} currency={currency}
            coverMode={coverMode} onChange={setLayers} />
        )}
        {!readOnly && !prop && (
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button type="button" className="np-struct-btn"
              onClick={() => setLayers([...st.layers, emptyLayerRow()])}>
              ＋ Add layer
            </button>
          </div>
        )}
      </ExpCard>

      {/* A stop loss covers the whole account — no per-class participation;
          an aggregate XL caps classes with inner limits. */}
      {!prop && aggregate ? (
        <CobInnerLimitsTable rows={cobRows || []} currency={currency}
          readOnly={cobsReadOnly === undefined ? readOnly : cobsReadOnly}
          onChange={onCobsChange} />
      ) : (prop || npShowsParticipation(npType)) && (
        <CobLimitsTable rows={cobRows} layerCount={basisLayerCount(st)} layers={prop ? [] : st.layers}
          readOnly={cobsReadOnly === undefined ? readOnly : cobsReadOnly}
          currency={currency} onChange={onCobsChange} />
      )}
    </StructCard>
  );
}

/**
 * Complementary cover modal: the cover written alongside the expiring
 * treaty on the opposite basis. A proportional expiring treaty gets a net
 * (excess of loss) cover on the retention — a layer table; a non-proportional
 * one gets a proportional cover — the prop terms grid. Edits are local until
 * saved, and Remove clears the cover.
 */
export function ComplementaryCoverModal({ expiring, onSave, onClose, readOnly, currency, cobNames = [] }) {
  const compBasis = complementaryBasis(expiring.basis);
  const isNet = compBasis === 'NP';
  const [comp, setComp] = useState(() => complementaryOf(expiring));
  const set = (patch) => setComp((c) => ({ ...c, ...patch }));
  const title = isNet ? 'Net Cover' : 'Proportional Cover';
  const sub = isNet
    ? 'Complementary cover — the excess of loss layers protecting the net retention under the expiring proportional treaty.'
    : 'Complementary cover — the proportional treaty written alongside the expiring non-proportional programme.';
  return (
    <ModModal title={title} sub={sub} onClose={onClose} wide>
      {isNet ? (
        <>
          <StructLayerTable rows={comp.layers} readOnly={readOnly} currency={currency}
            onChange={(layers) => set({ layers })} />
          {!readOnly && (
            <div className="toolbar" style={{ marginTop: 10 }}>
              <button type="button" className="np-struct-btn"
                onClick={() => set({ layers: [...comp.layers, emptyLayerRow()] })}>
                ＋ Add layer
              </button>
            </div>
          )}
        </>
      ) : (
        <PropTermsFields value={comp.prop} readOnly={readOnly} currency={currency}
          cobNames={cobNames} onChange={(prop) => set({ prop })} />
      )}
      <div className="np-modal-actions">
        {!readOnly && hasComplementary(expiring) && (
          <button type="button" className="np-struct-btn"
            onClick={() => onSave(emptyComplementary())}>
            Remove cover
          </button>
        )}
        <span className="np-modal-actions-gap" />
        <button type="button" className="np-struct-btn" onClick={onClose}>
          {readOnly ? 'Close' : 'Cancel'}
        </button>
        {!readOnly && (
          <button type="button" className="np-struct-btn np-struct-btn--primary"
            onClick={() => onSave({ ...comp, enabled: true, basis: compBasis })}>
            Save {title.toLowerCase()}
          </button>
        )}
      </div>
    </ModModal>
  );
}

/** Serialise quote structures for the placement's quote_structures column. */
export const structuresToPayload = (list) => (list || []).map((st) => ({
  basis: st.basis === 'PROP' ? 'PROP' : 'NP',
  npTreatyType: st.npTreatyType || '',
  agg: { franchiseDeductible: !!st.agg?.franchiseDeductible, structuredDeal: !!st.agg?.structuredDeal },
  layers: st.basis === 'PROP' ? [] : layersToPayload(st.layers),
  prop: { ...st.prop },
  cobs: cobRowsToPayload(seedCobRows(
    (st.cobs || []).map((c) => c.cob),
    st.cobs,
    st.basis === 'PROP' ? 0 : st.layers.length,
  )),
}));

/** Deserialise quote structures back into editable state. */
export const structuresFromPayload = (list, cobNames = []) => (list || []).map((st) => ({
  basis: st.basis === 'PROP' ? 'PROP' : 'NP',
  npTreatyType: st.npTreatyType || '',
  agg: { franchiseDeductible: !!st.agg?.franchiseDeductible, structuredDeal: !!st.agg?.structuredDeal },
  layers: (st.layers || []).length ? st.layers.map(layerFromPayload) : [emptyLayerRow()],
  prop: upgradePropTerms(st.prop),
  cobs: seedCobRows(cobNames, cobRowsFromPayload(st.cobs), (st.layers || []).length || 1),
}));

/* ── Table of retentions — % of treaty limit usable per occupancy
      category, grouped by risk class, feeding the renewal pack ── */

export const DEFAULT_OCCUPANCY_CATEGORIES = [
  ['A', 'Dwellings'], ['A', 'Offices & Retail'], ['B', 'Warehousing'],
  ['B', 'Light Industry'], ['C', 'Heavy Industry'], ['C', 'Hazardous Risks'],
];

export const emptyRetentionRow = (category = '', klass = '') => ({ klass, category, pct: '' });

/** Seed the retentions state — treaty full limit plus one row per category. */
export const seedRetentions = (existing) => {
  const has = existing && existing.rows && existing.rows.length > 0;
  return {
    limit: has ? (existing.limit || '') : '',
    rows: has ? existing.rows : DEFAULT_OCCUPANCY_CATEGORIES.map(([k, c]) => emptyRetentionRow(c, k)),
  };
};

/**
 * Table of retentions in the np-struct style: each occupancy category gets a
 * risk class (A/B/C or 1/2/3) and a retention expressed as % of the treaty
 * full limit — the share of the limit the cedant may use for those risks.
 * Usable limit is auto-derived (treaty limit x %).
 */
export function RetentionsTable({ value, onChange, readOnly, currency, suggestedLimit }) {
  const { limit, rows } = value;
  const [showClasses, setShowClasses] = useState(false);
  const [note, setNote] = useState(null);
  // The grading is reference data an admin maintains, so it is read live.
  const { classes, live, reload: reloadClasses } = useOccupancyClasses();
  const isAdmin = useHasRole('admin');
  const upd = (i, patch) => onChange({ ...value, rows: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const remove = (i) => onChange({ ...value, rows: rows.filter((_, j) => j !== i) });
  const usable = (r) => (toNum(limit) * toNum(r.pct)) / 100;

  /**
   * What the row could take from the class table: the class its occupancy
   * reads as when that differs from the class typed in, otherwise the
   * standard share of capacity when the row has none. Null when the row is
   * settled or its occupancy means nothing to the table.
   */
  const suggestion = (r) => {
    const category = String(r.category || '').trim();
    if (!category) return null;
    const klass = String(r.klass || '').trim().toUpperCase();
    const hit = detectOccupancyClass(category, classes);
    if (!klass) return hit;
    if (hit && hit.klass !== klass) return hit;
    return String(r.pct ?? '').trim() ? null : classByCode(klass, classes);
  };
  const suggestions = rows.map(suggestion);
  // Every occupancy still missing a class or its share — including ones the
  // matcher will not recognise, so the button reports that rather than
  // sitting dead.
  const pending = rows.filter((r) => String(r.category || '').trim()
    && (!String(r.klass || '').trim() || !String(r.pct ?? '').trim())).length;

  const fill = (overwrite) => {
    const { rows: next, applied, considered } = autoFillClasses(rows, { overwrite, classes });
    onChange({ ...value, rows: next });
    const categories = (n) => `${n} occupanc${n === 1 ? 'y' : 'ies'}`;
    if (applied.length) {
      setNote(`Applied ${applied.length} of ${categories(considered)}: ${applied
        .map((a) => `${a.category} → ${a.klass} at ${a.pct}%`).join(', ')}.`);
    } else if (considered) {
      setNote(`No class could be detected from ${categories(considered)} — set the class by hand.`);
    } else {
      setNote('Nothing to detect — every occupancy already carries a class.');
    }
  };

  return (
    <div>
      <div className="ret-tools">
        <button type="button" className="np-struct-btn np-struct-btn--accent"
          aria-expanded={showClasses} onClick={() => setShowClasses((v) => !v)}>
          {showClasses ? 'Hide class table' : 'Class & % of capacity'}
        </button>
        {!readOnly && (
          <>
            <button type="button" className="np-struct-btn" disabled={!pending}
              title="Grade every occupancy that has no class yet, and give every row its class's % of capacity"
              onClick={() => fill(false)}>
              ⌕ Auto-detect classes{pending ? ` (${pending})` : ''}
            </button>
            <button type="button" className="np-struct-btn"
              title="Re-grade every occupancy from its description, replacing classes and shares already set"
              onClick={() => fill(true)}>Re-detect all</button>
          </>
        )}
      </div>

      {showClasses && (
        <OccupancyClassTable classes={classes} live={live} canEdit={isAdmin} onSaved={reloadClasses} />
      )}

      {note && <div className="np-struct-notice">{note}</div>}

      <div className="np-count-row" style={{ marginBottom: 10 }}>
        <label htmlFor="ret-limit">Treaty full limit (100%) {currency ? `— ${currency}` : ''}</label>
        <NumInput id="ret-limit" style={{ width: 160 }}
          value={limit} readOnly={readOnly}
          placeholder={suggestedLimit ? suggestedLimit.toLocaleString() : 'e.g. 100'}
          onChange={(v) => onChange({ ...value, limit: v })} />
        {!readOnly && suggestedLimit > 0 && toNum(limit) !== suggestedLimit && (
          <button type="button" className="btn ghost" style={{ padding: '4px 10px' }}
            onClick={() => onChange({ ...value, limit: String(suggestedLimit) })}>
            Use structure limit ({suggestedLimit.toLocaleString()})
          </button>
        )}
      </div>
      <div className="np-table-wrap">
        <table className="np-struct-table">
          <thead>
            <tr>
              <th className="np-table-sticky">#</th>
              <th title="Risk class grouping occupancies — A, B, C or 1, 2, 3. Auto-detected from the occupancy category.">CLASS</th>
              <th className="np-th-left">OCCUPANCY CATEGORY</th>
              <th title="Share of the treaty full limit the cedant may use for these risks">% OF TREATY LIMIT</th>
              <th title={`Usable limit = treaty full limit × %${currency ? ` (${currency})` : ''}`}>USABLE LIMIT</th>
              {!readOnly && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={readOnly ? 5 : 6} className="muted" style={{ padding: 12 }}>
                No categories{readOnly ? '.' : ' — add one below.'}
              </td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={i}>
                <th className="np-table-sticky"><span className="np-layer-badge">{i + 1}</span></th>
                <td>
                  <div className="ret-class-cell">
                    <input className={`np-mini-input${readOnly ? ' np-mini-input--readonly' : ''}`}
                      value={r.klass} readOnly={readOnly} placeholder="A / 1" style={{ width: 64 }}
                      onChange={(e) => upd(i, { klass: e.target.value })} />
                    {!readOnly && suggestions[i] && (
                      <button type="button" className="ret-suggest"
                        title={`"${r.category}" reads as class ${suggestions[i].klass} — ${suggestions[i].name}, ${suggestions[i].pct}% of capacity`}
                        onClick={() => upd(i, { klass: suggestions[i].klass, pct: String(suggestions[i].pct) })}>
                        → {suggestions[i].klass === String(r.klass || '').trim().toUpperCase()
                          ? `${suggestions[i].pct}%` : suggestions[i].klass}
                      </button>
                    )}
                  </div>
                </td>
                <td>
                  <input className="np-mini-input np-mini-input--left" value={r.category} readOnly={readOnly}
                    placeholder="e.g. Flour Milling"
                    onChange={(e) => upd(i, { category: e.target.value })} />
                </td>
                <td><NumInput suffix="%" value={r.pct} readOnly={readOnly} placeholder="—"
                  onChange={(v) => upd(i, { pct: v })} /></td>
                <td><input className="np-mini-input np-mini-input--readonly" readOnly placeholder="auto"
                  value={usable(r) ? usable(r).toLocaleString() : ''}
                  style={r.pct !== '' && toNum(r.pct) >= 100 ? { border: '2px solid rgba(37, 99, 235, .55)' } : undefined} /></td>
                {!readOnly && (
                  <td>
                    <button type="button" className="renew-x" onClick={() => remove(i)} aria-label="Remove category">✕</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Serialise the retentions state for the placement's retentions column. */
export const retentionsToPayload = (state) => ({
  limit: state.limit === '' ? null : Number(state.limit),
  rows: (state.rows || [])
    .filter((r) => r.category.trim() || r.klass.trim() || r.pct !== '')
    .map((r) => ({
      class: r.klass.trim(),
      category: r.category.trim(),
      pct: r.pct === '' ? null : Number(r.pct),
    })),
});

/** Deserialise stored retentions back into editable state. Legacy payloads
    were plain arrays of {category, retention, lines} — keep their categories
    but let class and % start blank. */
export const retentionsFromPayload = (stored) => {
  const rows = Array.isArray(stored) ? stored : (stored && stored.rows) || [];
  return {
    limit: (!Array.isArray(stored) && stored && stored.limit != null) ? String(stored.limit) : '',
    rows: rows.map((r) => ({
      klass: r.class || '',
      category: r.category || '',
      pct: r.pct == null ? '' : String(r.pct),
    })),
  };
};
