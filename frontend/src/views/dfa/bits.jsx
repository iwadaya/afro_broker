import React from 'react';
import { fmtCompact, fmtMoney, fmtPct, StageEmpty } from '../../components.jsx';
import { GLOSSARY, runnable } from './model.js';

/*
 * The small pieces every stage of the desk shares: one way to write a
 * figure, one way to colour a change, a label that explains itself on
 * hover, a section head, the "these figures are old" bar, and the empty
 * state a result stage shows before there is a run.
 */

export function fmtKind(v, kind, ccy) {
  if (v == null) return '—';
  if (kind === 'pct') return fmtPct(v, 1);
  if (kind === 'pct2') return fmtPct(v, 2);
  if (kind === 'num') return fmtMoney(v, 1);
  return `${ccy ? `${ccy} ` : ''}${fmtCompact(v)}`;
}

/** A money formatter for one currency. */
export const moneyFmt = (ccy) => (v) => (v == null ? '—' : `${ccy ? `${ccy} ` : ''}${fmtCompact(v)}`);

/** good / bad / nothing, for a change in the direction the reader wants. */
export function deltaTone(delta, goodWhen) {
  if (delta == null || Math.abs(delta) < 0.005 || !goodWhen) return '';
  return (delta > 0) === (goodWhen === 'up') ? 'good' : 'bad';
}

/** Proposed less current, signed and coloured. */
export function Delta({ cur, prop, kind, ccy, goodWhen, arrows = false }) {
  const delta = cur != null && prop != null ? prop - cur : null;
  if (delta == null || Math.abs(delta) < 0.005) return <span className="dfa-delta muted">{arrows ? 'no change' : '—'}</span>;
  const tone = deltaTone(delta, goodWhen);
  const sign = arrows ? (delta > 0 ? '▲ ' : '▼ ') : (delta > 0 ? '+' : '−');
  return <span className={`dfa-delta ${tone}`}>{sign}{fmtKind(Math.abs(delta), kind, ccy)}</span>;
}

/** A figure's label, with what the figure means on hover. */
export function Term({ k, children }) {
  const text = GLOSSARY[k];
  if (!text) return <>{children}</>;
  return <span className="dfa-term" title={text} tabIndex={0}>{children}</span>;
}

export function Note({ children }) {
  return <div className="dfa-note">{children}</div>;
}

/** A section: its label, a hint after it, actions at the right, the body. */
export function Section({ title, hint, actions, children, className = '', testid }) {
  return (
    <section className={`dfa-section ${className}`} data-testid={testid}>
      <div className="sechead">
        <h3 className="seclabel">{title}</h3>
        {hint && <span className="hint">{hint}</span>}
        {actions && <span className="sechead-actions">{actions}</span>}
      </div>
      {children}
    </section>
  );
}

export function NumberField({ label, value, onChange, min, max, step, placeholder, title, className = '', ariaLabel, note, testid }) {
  return (
    <label className={`field ${className}`} title={title}>
      <span>{label}</span>
      <input
        className="input" type="number" min={min} max={max} step={step} placeholder={placeholder}
        aria-label={ariaLabel} data-testid={testid}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
      {note && <small className="dfa-fieldnote">{note}</small>}
    </label>
  );
}

export function Toggle({ checked, onChange, children, title, testid }) {
  return (
    <label className="dfa-toggle" title={title}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />
      {children}
    </label>
  );
}

/** Result stages: the figures are from an older run than the inputs. */
export function StaleBar({ shared }) {
  const { results, stale, running, run } = shared;
  if (!results || (!stale && !running)) return null;
  return (
    <div className="dfa-stalebar" role="status" data-testid="dfa-stalebar">
      <span>
        {running
          ? 'Simulating — the figures below are from the last run and will update when it lands.'
          : 'The inputs have changed since this run — the figures below are from the last run.'}
      </span>
      {!running && (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => run()}>Run analysis</button>
      )}
    </div>
  );
}

/** A result stage before there is a run to read: the reason, and the way there. */
export function EmptyResults({ shared, stage, what }) {
  const { portfolio, mode, cal, running, run, startedAt, now, setTab } = shared;
  const nothing = portfolio && (mode === 'contract' || mode === 'portfolio') && !portfolio.combined;
  const openScope = (text) => (
    <button type="button" className="btn btn-secondary" onClick={() => setTab('scope')}>{text}</button>
  );
  let title;
  let note;
  let action = null;
  if (running) {
    title = 'Simulating the book';
    note = `Every programme is being run through the same simulated treaty years${startedAt ? ` (${Math.round((now - startedAt) / 1000)}s so far)` : ''}. The stage fills in the moment the run lands.`;
  } else if (mode === 'unchosen') {
    title = 'Choose what to model first';
    note = 'A standalone book typed from scratch, one contract read from the placements, or the whole portfolio. A contract or the portfolio runs by itself; a standalone book runs once its premium is typed.';
    action = openScope('Open 01 Scope');
  } else if (mode === 'standalone' && !runnable(cal)) {
    title = 'Type the subject premium to run';
    note = 'The standalone loss model on 01 Scope starts from market defaults, and the engine needs the premium before it can simulate a year.';
    action = openScope('Open 01 Scope');
  } else if (nothing) {
    title = 'Nothing to analyse yet';
    note = 'None of the placements in the selection carries a subject premium. Choose another on 01 Scope, give the placement a premium, or model a standalone book.';
    action = openScope('Open 01 Scope');
  } else {
    title = `No run yet — ${what} appear here`;
    note = 'Set up the programme and the assumptions, then run the analysis. Every result stage reads the same run.';
    action = <button type="button" className="btn btn-primary" onClick={() => run()}>Run analysis</button>;
  }
  return (
    <StageEmpty stage={stage} title={title} note={note}>
      {action}
    </StageEmpty>
  );
}
