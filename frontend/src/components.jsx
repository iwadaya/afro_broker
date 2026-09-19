import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

/** Fetch on mount (and when `deps` change). Returns { data, error, loading, reload }. */
export function useFetch(method, path, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: !!path });
  const reload = useCallback(() => {
    // No path — nothing to load (a placement that is not created yet).
    if (!path) {
      setState({ data: null, error: null, loading: false });
      return undefined;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    api(method, path)
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((error) => alive && setState({ data: null, error, loading: false }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => reload(), [reload]);
  return { ...state, reload };
}

/** A panel: Daylight's glass card. Every panel on the designed screens uses this. */
export function Blueprint({ as: Tag = 'div', className = '', children, ...rest }) {
  return <Tag className={`blueprint ${className}`} {...rest}>{children}</Tag>;
}

export function SectionLabel({ children }) {
  return <div className="seclabel">{children}</div>;
}

/** One status pill helper; four tones only (solid / accent / neutral / outline). */
export function Pill({ tone = 'neutral', children, className = '' }) {
  return <span className={`pill pill-${tone} ${className}`}>{children}</span>;
}

/**
 * Backend status → semantic tone + display label.
 *
 * Colour carries meaning here rather than being one accent ramp: neutral until
 * something is in play, blue while out to market, gold when a decision or an
 * authorisation is owed, green for confirmed progress, and red reserved for
 * exceptions. Every pill also carries its label, so the tone supplements the
 * reading rather than being the only signal.
 *
 * This is the one mapping for the whole product — no view defines its own.
 */
const STATUS = {
  DRAFT: ['grey', 'Draft'], DATA: ['grey', 'Data'], PACK: ['grey', 'Pack'],
  LEAD_MARKETING: ['blue', 'Lead marketing'], FOLLOW_MARKETING: ['blue', 'Follow marketing'],
  QUOTED: ['green', 'Quoted'],
  FOT_AGREED: ['gold', 'FOT agreed'], LINES_WRITTEN: ['gold', 'Lines written'],
  SIGNED: ['gold', 'Signed'], WRITTEN: ['gold', 'Written'],
  BOUND: ['green', 'Bound'],
  INCOMPLETE: ['red', 'Incomplete'],
  DECLINED: ['red', 'Declined'], NTU: ['red', 'NTU'], LAPSED: ['red', 'Lapsed'],
  OPEN: ['grey', 'Open'], CLOSED: ['grey', 'Closed'],
  APPROACHED: ['blue', 'Approached'], AGREED: ['blue', 'Agreed'],
  proposed: ['gold', 'Proposed'], authorised: ['green', 'Authorised'], superseded: ['grey', 'Superseded'],
  draft: ['grey', 'Draft'], approved: ['green', 'Approved'], in_review: ['blue', 'In review'],
  agreed: ['blue', 'Agreed'], pending: ['grey', 'Pending'], rejected: ['red', 'Rejected'],
  active: ['green', 'Active'], accepted: ['blue', 'Agreed'], withdrawn: ['red', 'Withdrawn'],
  watch: ['gold', 'Watch'], reconciled: ['green', 'Reconciled'], warnings: ['gold', 'Warnings'],
  Scheduled: ['grey', 'Scheduled'], Estimated: ['blue', 'Estimated'],
  // Market register: counterparty type, security list and KYC file.
  reinsurer: ['blue', 'Reinsurer'], insurer: ['blue', 'Insurer'], broker: ['blue', 'Broker'],
  declined: ['red', 'Declined'],
  not_started: ['grey', 'Not started'], in_progress: ['gold', 'In progress'],
  expired: ['red', 'Expired'],
  Open: ['blue', 'Open'], Closed: ['grey', 'Closed'], Advised: ['gold', 'Advised'],
  // The spine (§1.2): version states, distribution stages, response outcomes,
  // recipient tracking and the cedant cycle.
  EXPIRING: ['grey', 'Expiring'], SUBMITTED: ['blue', 'Submitted'],
  ALTERNATIVE: ['gold', 'Alternative'], NEGOTIATED: ['blue', 'Negotiated'],
  FOT: ['gold', 'FOT'],
  QUOTING: ['blue', 'Quoting'], FOLLOW: ['gold', 'Follow'],
  SENT: ['blue', 'Sent'], PENDING: ['grey', 'Pending'],
  DELIVERED: ['blue', 'Delivered'], OPENED: ['blue', 'Opened'],
  RESPONDED: ['green', 'Responded'], BOUNCED: ['red', 'Bounced'], FAILED: ['red', 'Failed'],
  NO_RESPONSE: ['grey', 'No response'], ALTERNATIVE_QUOTED: ['gold', 'Alternative quoted'],
  ABSTAINED: ['grey', 'Abstained'],
  TAKEN_UP: ['green', 'Taken up'], NOT_TAKEN_UP: ['red', 'Not taken up'],
  overridden: ['red', 'Break-glass'],
  // MDP debit notes and treaty losses.
  issued: ['green', 'Issued'], sent: ['blue', 'Sent'], paid: ['green', 'Paid'],
  open: ['gold', 'Open'], advised: ['blue', 'Advised'], settled: ['green', 'Settled'],
  // Renewal pack analysis: run states, change direction and significance.
  analysing: ['blue', 'Analysing'], complete: ['green', 'Complete'], failed: ['red', 'Failed'],
  // How far an uploaded pack covers each section of the house skeleton. A
  // section the cedant never sends is grey rather than red — it is not in
  // play yet; the gap note beside it carries what has to be chased.
  supplied: ['green', 'Supplied'], partial: ['gold', 'Partial'], missing: ['grey', 'Not supplied'],
  improved: ['green', 'Improved'], deteriorated: ['red', 'Deteriorated'],
  unchanged: ['grey', 'Unchanged'], unclear: ['gold', 'Unclear'],
  high: ['red', 'High'], medium: ['gold', 'Medium'], low: ['grey', 'Low'],
};

export function StatusPill({ value, tone, label }) {
  const [t, l] = STATUS[value] || ['neutral', String(value ?? '—')];
  return <Pill tone={tone || t} className="status">{label ?? l}</Pill>;
}

/** `Southern Alliance` → `SA`. */
export function initials(name, max = 2) {
  if (!name) return '—';
  return String(name).split(/\s+/).filter(Boolean).slice(0, max)
    .map((w) => w[0].toUpperCase())
    .join('');
}

/** Initials avatar. The tone cycles deterministically from the name. */
export function Avatar({ name, tone, size }) {
  const tones = ['mint', 'gold', 'blue', 'red'];
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const picked = tone || tones[h % tones.length];
  return (
    <span className={`avatar avatar-${picked}${size === 'sm' ? ' avatar-sm' : ''}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** Avatar plus name — the standard way to show a counterparty or a person. */
export function Person({ name, meta, tone, size }) {
  return (
    <span className="person">
      <Avatar name={name} tone={tone} size={size} />
      <span className="person-text">
        <span className="person-name" title={name}>{name}</span>
        {meta && <span className="person-meta">{meta}</span>}
      </span>
    </span>
  );
}

/**
 * A progress bar always ships with its text percentage — the bar alone is
 * never the only signal, and the tone only supplements the number.
 */
export function ProgressBar({ value, tone = 'emerald', label, showValue = true }) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
  return (
    <span
      className="pbar"
      role="progressbar"
      aria-valuenow={Math.round(safe)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span className="pbar-track">
        <span className={`pbar-fill pbar-${tone}`} style={{ width: `${safe}%` }} />
      </span>
      {showValue && <span className="pbar-value">{Math.round(safe)}%</span>}
    </span>
  );
}

/** Search box with a visible clear affordance. */
export function SearchInput({ value, onChange, placeholder = 'Search…', label }) {
  return (
    <span className="searchbox">
      <span className="searchbox-icon" aria-hidden="true">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="11" cy="11" r="6.2" /><path d="m16 16 3.6 3.6" strokeLinecap="round" />
        </svg>
      </span>
      <input
        type="search"
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label || placeholder}
      />
      {value && (
        <button type="button" className="searchbox-clear" onClick={() => onChange('')} aria-label="Clear search">×</button>
      )}
    </span>
  );
}

/**
 * The tracker's stages: the backend status machine's happy path, in full.
 *
 * All ten are shown rather than an abridged set — a placement sitting at
 * LINES_WRITTEN or SIGNED must land on a stage of its own, or the tracker
 * would report it as not started.
 */
export const TRACKER_STAGES = [
  'DRAFT', 'DATA', 'PACK', 'LEAD_MARKETING', 'QUOTED',
  'FOT_AGREED', 'FOLLOW_MARKETING', 'LINES_WRITTEN', 'SIGNED', 'BOUND',
];

/** Branch statuses, and the forward stage each one branched from. */
const OFF_PATH_ANCHOR = { INCOMPLETE: 'LINES_WRITTEN' };

/**
 * Lifecycle tracker.
 *
 * Stages come from the backend's own state machine — the UI never invents a
 * transition. A terminal status (DECLINED, NTU, LAPSED) has no node of its
 * own, so nothing is marked current rather than guessing a position.
 */
export function WorkflowTracker({ stages = TRACKER_STAGES, current, label = 'Placement progress' }) {
  const anchor = OFF_PATH_ANCHOR[current] || current;
  const activeIndex = stages.indexOf(anchor);
  return (
    <ol className="tracker" aria-label={label}>
      {stages.map((stage, i) => {
        const done = activeIndex >= 0 && i < activeIndex;
        const isCurrent = i === activeIndex;
        const state = done ? 'done' : isCurrent ? 'current' : 'todo';
        return (
          <li key={stage} className={`tracker-step ${state}`} aria-current={isCurrent ? 'step' : undefined}>
            <span className="tracker-node">{done ? '✓' : ''}</span>
            <span className="tracker-label">
              {STATUS[stage]?.[1] || stage}
              <span className="sr-only">
                {done ? ' — completed' : isCurrent ? ' — current stage' : ' — not started'}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A stage before the record supports it: the reason, not a blank panel or a
 * greyed tab. `stage` is { ordinal, label }; the title says what is
 * missing, the note what fills it, and the children are the way there.
 */
export function StageEmpty({ stage, title, note, children }) {
  return (
    <section className="blueprint rpa-stage-empty">
      <span className="kicker accent">Step {stage.ordinal} · {stage.label}</span>
      <h3 className="rpa-stage-empty-title">{title}</h3>
      <p className="rpa-stage-empty-note">{note}</p>
      {children && <div className="rpa-stage-empty-actions">{children}</div>}
    </section>
  );
}

/** ✓ / ! glyph rows for validation and readiness panels. */
export function GlyphRow({ warn, children }) {
  return (
    <div className="valrow">
      <span className={`valglyph${warn ? ' warn' : ''}`}>{warn ? '!' : '✓'}</span>
      <span className="valtext">{children}</span>
    </div>
  );
}

/* Tone helper for the views that build `tone-*` class names by hand. It reads
   from the one STATUS map above so a status can never render two ways. */
export function statusTone(value) {
  return STATUS[value]?.[0] || 'grey';
}

/** The three compliance tones, drawn on the same accent ramp as the statuses. */
const COMPLIANCE_TONE = { ok: 'green', attention: 'amber', blocked: 'red' };

export function TonePill({ tone, children }) {
  return <span className={`status tone-${COMPLIANCE_TONE[tone] || 'grey'}`}>{children}</span>;
}

/**
 * Tab strip. `tabs` = [{ value, label, hint, ordinal, sub }]; `value`/`onChange`
 * control it. `hint` is a count after the label. `ordinal` and `sub` make a
 * tab a stage — a small monospaced step number beside the label and the
 * stage's state underneath — for a spine that walks one record through a
 * flow; the register tabs pass neither and render as they always have.
 */
export function Tabs({ tabs, value, onChange, className, label }) {
  // The roving-tab pattern: the strip is one Tab stop (the selected tab), and
  // the arrow keys move along it, selecting as they go.
  const onKeyDown = (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: 0, End: 0 }[e.key];
    if (step === undefined) return;
    const i = Math.max(0, tabs.findIndex((t) => t.value === value));
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + step + tabs.length) % tabs.length;
    e.preventDefault();
    onChange(tabs[next].value);
    e.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
  };
  return (
    <div className={className ? `tabs ${className}` : 'tabs'} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          tabIndex={t.value === value ? 0 : -1}
          className={`tab${t.value === value ? ' active' : ''}`}
          onClick={() => onChange(t.value)}
        >
          {t.ordinal != null && <span className="tab-ordinal num">{t.ordinal}</span>}
          {t.sub != null ? (
            <span className="tab-text">
              <span className="tab-label">{t.label}</span>
              <span className="tab-sub">{t.sub}</span>
            </span>
          ) : t.label}
          {t.hint != null && <span className="tab-count">{t.hint}</span>}
        </button>
      ))}
    </div>
  );
}

/** A labelled filter control. Options are strings or { value, label }. */
export function Filter({ label, value, onChange, options, placeholder = 'Any', type = 'select' }) {
  return (
    <label className="field">
      <span>{label}</span>
      {type === 'select' ? (
        <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">{placeholder}</option>
          {options.map((o) => (
            <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>
          ))}
        </select>
      ) : (
        <input
          className="input"
          type={type}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      )}
    </label>
  );
}

export function ErrorBanner({ error }) {
  if (!error) return null;
  const detail = error.data?.details
    ? ` (${JSON.stringify(error.data.details.fieldErrors || error.data.details)})`
    : '';
  return <div className="err banner">{error.message}{detail}</div>;
}

// ---- Formatting ----

export function fmtMoney(n, dp = 0) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtPct(n, dp = 2) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Number(n).toFixed(dp)}%`;
}

/** Display name for an AI provider id. ChatGPT is the only live provider;
    the other labels keep analyses stored before the switch rendering. */
export function providerLabel(p) {
  return { anthropic: 'Claude', openai: 'ChatGPT', gemini: 'Gemini' }[p] || p;
}

/** Compact money for KPIs: 412m, 68.4m, 1.98bn. */
export function fmtCompact(n) {
  const v = Number(n);
  if (!v) return '0';
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(v % 1e9 === 0 ? 0 : 2)}bn`;
  if (Math.abs(v) >= 1e6) {
    const m = v / 1e6;
    return `${m.toLocaleString('en-US', { maximumFractionDigits: m >= 100 ? 0 : 1 })}m`;
  }
  return fmtMoney(v);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '01 Jan 27' (shortYear) or '01 Jan 2027'. */
export function fmtDate(value, { shortYear = false } = {}) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const y = d.getUTCFullYear();
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${shortYear ? String(y).slice(2) : y}`;
}

/** '14 Aug 09:12' for audit timestamps. */
export function fmtStamp(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function Money({ amount, currency }) {
  if (amount == null) return <span>—</span>;
  return <span className="num">{currency ? `${currency} ` : ''}{fmtMoney(amount, Number(amount) % 1 ? 2 : 0)}</span>;
}

export function Pct({ value, dp = 2 }) {
  if (value == null) return <span>—</span>;
  return <span className="num">{fmtPct(value, dp)}</span>;
}

// ---- Legacy building blocks (operational views) ----

export function Card({ title, actions, children }) {
  return (
    <section className="card blueprint">
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A UUID shown in full, with a click-to-copy affordance. */
export function Uuid({ value }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span>—</span>;
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard is unavailable outside a secure context; the id is still
      // selectable on the page.
    }
  }
  return (
    <span className="uuid">
      <code>{value}</code>
      <button type="button" className="small ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </span>
  );
}

/** Minimal controlled form: fields = [{name,label,type,options,required,...}]. */
export function Form({ fields, submitLabel = 'Save', onSubmit, initial = {} }) {
  const [values, setValues] = useState(() => ({ ...initial }));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  function set(name, v) { setValues((s) => ({ ...s, [name]: v })); }

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onSubmit(values);
      setValues({ ...initial });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="inline-form">
      {fields.map((f) => (
        <label key={f.name} className="field">
          <span>{f.label}{f.required && ' *'}</span>
          {f.type === 'select' ? (
            <select className="input" value={values[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)} required={f.required}>
              <option value="" disabled>—</option>
              {f.options.map((o) => (
                <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>
              ))}
            </select>
          ) : f.type === 'checkbox' ? (
            <input type="checkbox" checked={!!values[f.name]} onChange={(e) => set(f.name, e.target.checked)} />
          ) : f.type === 'textarea' ? (
            <textarea
              className="input"
              value={values[f.name] ?? ''}
              onChange={(e) => set(f.name, e.target.value)}
              required={f.required}
              rows={f.rows || 3}
              placeholder={f.placeholder}
            />
          ) : (
            <input
              className="input"
              type={f.type || 'text'}
              value={values[f.name] ?? ''}
              onChange={(e) => set(f.name, f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
              required={f.required}
              step={f.step}
              placeholder={f.placeholder}
            />
          )}
        </label>
      ))}
      <button type="submit" disabled={busy}>{busy ? '…' : submitLabel}</button>
      <ErrorBanner error={error} />
    </form>
  );
}
