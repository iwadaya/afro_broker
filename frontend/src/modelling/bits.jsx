import React, { useState } from 'react';
import { cn, fmtC, parseFlexibleNumber } from './engine.js';
import { useModelling } from './store.jsx';

/* Shared atoms for the modelling screens — the Daylight rendering of the
   modelling tool's screen chrome: header pill + title, KPI tiles, toggle
   groups, comma-formatted numeric cells (raw while focused), and the
   tab-separated paste helper every grid uses. */

/** Screen shell: header pill, title, subtitle, actions (Save etc.), body. */
/** The treaty basis for a screen's header pill — both, when both wizards run. */
export function basisLabel(meta) {
  if (meta?.bases?.prop && meta?.bases?.np) return 'PROPORTIONAL & NON-PROPORTIONAL';
  return meta?.basis === 'PROP' ? 'PROPORTIONAL' : 'NON-PROPORTIONAL';
}

/** The classes of business a screen's data is split by — one pill per
    class, the active one lit; a click saves the current class and moves to
    the other. Nothing shows for a single-class treaty. */
export function CobPills() {
  const mod = useModelling();
  if (!mod.multiCob) return null;
  return (
    <div className="mod-cob-pills" role="tablist" aria-label="Class of business">
      <span className="mod-cob-label">CLASS OF BUSINESS</span>
      {mod.cobs.map((cob) => (
        <button key={cob} type="button" role="tab" aria-selected={cob === mod.activeCob}
          className={`np-type-pill mod-cob-pill ${cob === mod.activeCob ? 'is-on' : 'is-off'}`}
          onClick={() => mod.switchCob(cob)}>
          {cob}
        </button>
      ))}
      <span className="mod-cob-hint">Each class carries its own data on this screen.</span>
    </div>
  );
}

export function ModScreen({ pill, title, sub, actions, children }) {
  return (
    <section className="mod-screen">
      <CobPills />
      <div className="mod-head">
        <div>
          {pill && <div className="mod-pill">{pill}</div>}
          <h2 className="mod-title">{title}</h2>
          {sub && <div className="mod-sub">{sub}</div>}
        </div>
        {actions && <div className="mod-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Save button + dirty marker + transient message, one per screen. */
export function SaveBar({ dirty, msg, onSave, canEdit, extra }) {
  return (
    <div className="mod-savebar">
      {extra}
      {msg && <span className={`mod-msg mod-msg--${msg.type}`}>{msg.text}</span>}
      {dirty && <span className="mod-dirty">● Unsaved</span>}
      {canEdit && (
        <button type="button" className="np-green-pill" onClick={onSave}>Save</button>
      )}
    </div>
  );
}

/** Small helper managing the {type,text} save message with auto-clear. */
export function useSaveMsg() {
  const [msg, setMsg] = useState(null);
  const flash = (type, text, ms = 2500) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), ms);
  };
  return [msg, flash];
}

export function Kpi({ label, value, tone, title }) {
  return (
    <div className={`mod-kpi${tone ? ` mod-kpi--${tone}` : ''}`} title={title}>
      <div className="mod-kpi-label">{label}</div>
      <div className="mod-kpi-value">{value}</div>
    </div>
  );
}

export function KpiRow({ children }) {
  return <div className="mod-kpis">{children}</div>;
}

/** Pill toggle group: options = [[value, label]]. */
export function Toggle({ value, options, onChange, disabled }) {
  return (
    <div className="mod-toggle">
      {options.map(([v, label]) => (
        <button key={v} type="button" disabled={disabled}
          className={`mod-toggle-opt${value === v ? ' is-on' : ''}`}
          onClick={disabled ? undefined : () => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Notice({ tone = 'info', children }) {
  return <div className={`mod-notice mod-notice--${tone}`}>{children}</div>;
}

/**
 * Comma-formatted numeric cell: raw text while focused, grouped when idle.
 * Hands back the raw string. Paste bubbles to the caller for grid fills.
 */
export function NumCell({ value, onChange, onPaste, readOnly, placeholder = '0', className = '', align = 'right', ...rest }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');
  const display = editing ? raw : fmtC(value);
  return (
    <input
      {...rest}
      className={`mod-cell mod-cell--${align} ${className}`}
      type="text"
      inputMode="decimal"
      value={display}
      placeholder={placeholder}
      readOnly={readOnly}
      onFocus={() => { setEditing(true); setRaw(String(value ?? '').replace(/,/g, '')); }}
      onBlur={() => setEditing(false)}
      onChange={readOnly ? undefined : (e) => { setRaw(e.target.value); onChange(e.target.value.replace(/,/g, '')); }}
      onPaste={onPaste}
    />
  );
}

/** Read-only computed cell. */
export function CalcCell({ value, className = '', tone }) {
  return (
    <div className={`mod-cell mod-cell--right mod-cell--ro ${className}`}
      style={tone ? { color: tone } : undefined}>
      {value === '' || value == null ? '—' : value}
    </div>
  );
}

/** Split clipboard text into a trimmed 2-D grid (tab/newline separated). */
export function pasteGrid(e) {
  const text = e.clipboardData?.getData('text/plain');
  if (!text) return null;
  const rows = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split('\t'));
  if (!rows.length) return null;
  return rows;
}

/** Parse a pasted cell to a clean number string ('' if blank/non-numeric). */
export function pasteNum(v) {
  const n = parseFlexibleNumber(v);
  return n == null ? '' : String(n);
}

/**
 * Hand-rolled paired bar chart (projected vs actual), the modelling tool's
 * CSS-bar chart re-drawn as spans — no chart library.
 */
export function PairedBars({ data }) {
  // data: [{year, proj, act}] — heights normalised to the max.
  const max = Math.max(1, ...data.flatMap((d) => [d.proj, d.act]));
  const h = (v) => Math.max(2, Math.round((v / max) * 100));
  return (
    <div className="mod-chart">
      <div className="mod-bars">
        {data.map((d) => (
          <div key={d.year} className="mod-bars-col" title={`${d.year}: projected ${fmtC(Math.round(d.proj))}, actual ${fmtC(Math.round(d.act))}`}>
            <div className="mod-bars-pair">
              <div className="mod-bar mod-bar--proj" style={{ height: `${h(d.proj)}%` }} />
              <div className="mod-bar mod-bar--act" style={{ height: `${h(d.act)}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="mod-x-axis">
        {data.map((d) => <div key={d.year} className="mod-x-tick">{d.year}</div>)}
      </div>
    </div>
  );
}

export function ChartLegend({ items }) {
  return (
    <div className="mod-legend">
      {items.map(([klass, label]) => (
        <span key={label} className="mod-legend-item">
          <span className={`mod-legend-dot ${klass}`} />{label}
        </span>
      ))}
    </div>
  );
}

/** Modal shell (backdrop click closes). */
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

/** Loss-ratio traffic colours shared by the performance tables. */
export const lrColor = (v) => (v > 100 ? 'var(--accent-rose)' : v > 80 ? 'var(--accent-amber)' : 'var(--accent2)');
export const crColor = (v) => (v > 110 ? 'var(--accent-rose)' : v > 95 ? 'var(--accent-amber)' : 'var(--accent2)');

export { cn, fmtC };
