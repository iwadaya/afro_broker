import React, { useState } from 'react';
import { useRefData, entryOf } from '../RefData.jsx';
import { parseClass } from '../refData.js';

/* The Treaty Detail building blocks shared by the contract pages (the
   proportional treaty detail and the non-proportional contract details
   under Contracts) and the screens that read a placement's class: field
   rows, the date field, the class of business modal, and the class parser.

   The dropdowns themselves are the Universe modelling tool's reference
   lookups — brokers, treaty types, classes of business, the country and
   currency ref lists — held by RefDataProvider and bound by row id exactly
   as the tool's treaty detail binds them (the option helpers live beside the
   provider in RefData.jsx). */

export { parseClass };
export { OffListOption, RefOptions } from '../RefData.jsx';

/** Add 12 months to a yyyy-mm-dd date string (Universe: renewal = inception + 12mo). */
export function addMonths12(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCMonth(d.getUTCMonth() + 12);
  return d.toISOString().slice(0, 10);
}

/* Universe: expYears = the last 41 calendar years. */
export const EXP_YEARS = Array.from({ length: 41 }, (_, i) => new Date().getFullYear() - 40 + i).reverse();

/** Date input with an explicit calendar button — the native picker opens on
    demand (showPicker), so the calendar is a visible click away rather than a
    hidden affordance on the field's edge. */
export function DateField({ value, onChange, disabled, ...rest }) {
  const ref = React.useRef(null);
  const open = () => {
    const el = ref.current;
    if (!el || disabled) return;
    try { el.showPicker(); } catch { el.focus(); }
  };
  return (
    <div className="date-field">
      <input ref={ref} className="fi" type="date" value={value} disabled={disabled}
        onChange={onChange} {...rest} />
      <button type="button" className="date-field-btn" aria-label="Open calendar"
        title="Open calendar" disabled={disabled} onClick={open}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
          <path d="M3.5 9.5h17M8 2.8v4.4M16 2.8v4.4" />
        </svg>
      </button>
    </div>
  );
}

/** Field row in the Universe treaty-detail style: label left, control right. */
export function Fr({ label, missing, children, hint }) {
  return (
    <div className="fr">
      <div className={`fr-label${missing ? ' fr-label--missing' : ''}`} title={hint || ''}>
        {label}{missing && ' *'}
      </div>
      <div className="fr-control">{children}</div>
    </div>
  );
}

/** Line-of-business multi-select — Universe's CobSelectModal: the classes of
    business lookup, picked by id. A class the lookup no longer carries stays
    on offer (as its stored name) while it is selected. */
export function CobModal({ selected, onSave, onClose }) {
  const { classes: classList } = useRefData();
  const classes = [
    ...classList.map((c) => ({ id: c.id, name: c.name })),
    ...selected.filter((c) => !entryOf(classList, c)).map((c) => ({ id: c, name: c })),
  ];
  const [sel, setSel] = useState(() => new Set(selected.map((c) => entryOf(classList, c)?.id ?? c)));
  const toggle = (c) => setSel((s) => {
    const n = new Set(s);
    n.has(c) ? n.delete(c) : n.add(c);
    return n;
  });
  return (
    <div className="cob-modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cob-panel" role="dialog" aria-modal="true">
        <div className="renew-head">
          <div>
            <div className="renew-kicker">LINE OF BUSINESS</div>
            <div className="renew-title">Select classes</div>
          </div>
          <button type="button" className="renew-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="cob-list">
          {classes.map((c) => (
            <label key={c.id} className={`cob-item${sel.has(c.id) ? ' cob-item--on' : ''}`}>
              <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} />
              {c.name}
            </label>
          ))}
        </div>
        <div className="renew-actions" style={{ padding: '0 16px 16px' }}>
          <button type="button" className="renew-btn renew-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="renew-btn renew-btn--primary"
            onClick={() => { onSave([...sel]); onClose(); }}>
            Done{sel.size ? ` (${sel.size})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The expiring basis a treaty type implies — its reference category:
    PROPORTIONAL → proportional, NON_PROPORTIONAL → non-proportional. */
export function basisForTreatyType(treatyType) {
  if (treatyType?.category === 'PROPORTIONAL') return 'PROP';
  if (treatyType?.category === 'NON_PROPORTIONAL') return 'NP';
  return null;
}
