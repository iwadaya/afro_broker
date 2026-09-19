import React from 'react';
import { useFetch, ErrorBanner } from '../../components.jsx';
import { ASSUMPTION_GROUPS, CAPITAL_PERCENTILES, num } from './model.js';
import { Section, Note, NumberField } from './bits.jsx';
import RegimeCard from './RegimeCard.jsx';

/*
 * 03 Assumptions — who holds what and what it costs them, in four cards:
 * the insurer (its country of domicile among the fields, whose capital
 * regime — Solvency II, risk-based capital, a solvency margin, a minimum
 * capital — is read back as a card with its ladder), the reinsurers, the
 * projection and the simulation itself. Every field carries its meaning on
 * hover, the defaults are the book's, and one button puts them back.
 */

function Field({ f, value, onChange, ccy, note, regimes }) {
  if (f.kind === 'domicile') {
    const list = regimes?.regimes || [];
    return (
      <label className="field" title={f.title}>
        <span>{f.label}</span>
        <select
          className="input" value={value || ''} data-testid="dfa-domicile"
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">No regime — the desk’s own standard</option>
          {list.map((r) => <option key={r.code} value={r.code}>{r.country} · {r.family_label}</option>)}
        </select>
        {note && <small className="dfa-fieldnote">{note}</small>}
      </label>
    );
  }
  if (f.kind === 'percentile') {
    const v = num(value, 99.5);
    const listed = CAPITAL_PERCENTILES.some((o) => o.value === v);
    return (
      <label className="field" title={f.title}>
        <span>{f.label}</span>
        <select className="input" value={String(v)} onChange={(e) => onChange(Number(e.target.value))} data-testid="dfa-percentile">
          {CAPITAL_PERCENTILES.map((o) => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
          {!listed && <option value={String(v)}>{`${v}th percentile`}</option>}
        </select>
      </label>
    );
  }
  if (f.kind === 'horizon') {
    const v = Math.min(5, Math.max(1, Math.trunc(num(value, 1))));
    return (
      <label className="field" title="One treaty year, or up to five with the surplus rolled forward.">
        <span>{f.label}</span>
        <select className="input" value={String(v)} onChange={(e) => onChange(Number(e.target.value))} data-testid="dfa-horizon">
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={String(n)}>{n === 1 ? '1 year' : `${n} years`}</option>)}
        </select>
      </label>
    );
  }
  return (
    <NumberField
      label={`${f.label}${f.kind === 'money' && ccy ? ` (${ccy})` : ''}`}
      title={f.title}
      placeholder={f.placeholder}
      value={value ?? ''}
      onChange={onChange}
      note={note}
    />
  );
}

export default function AssumptionsTab({ shared }) {
  const { portfolio, assumptions, setAssumptions, ccy, regimes, results } = shared;
  // The chosen domicile's regime in full — its requirement and its ladder.
  const code = assumptions?.domicile || null;
  const regime = useFetch('GET', code ? `/dfa/regimes/${code}` : null, [code]);
  if (!portfolio) return <div className="muted small">Reading the book…</div>;
  if (!assumptions) {
    return (
      <div className="blueprint dfa-panel">
        <p className="dfa-lede">The assumptions follow the book — choose what to model on 01 Scope.</p>
      </div>
    );
  }
  const defaults = portfolio.defaults || {};
  const creditSource = defaults.credit_pd_source;
  const domicileNote = code && portfolio.domicile?.code === code ? `seeded from ${portfolio.domicile.source}` : undefined;
  // Once a run has read this regime, mark where each programme sits on the ladder.
  const marks = results?.regime?.code === code
    ? [['Gross', results.gross], ['Current', results.structures.current], ['Proposed', results.structures.proposed]]
      .filter(([, b]) => b.regime && !b.regime.needs_input)
      .map(([label, b]) => ({ label, ratio_pct: b.regime.ratio_pct }))
    : [];

  return (
    <>
      <div className="sechead">
        <p className="dfa-lede dfa-lede-wide">
          Sensible defaults, all of them editable: the capital standard and hurdle rate the
          buyer holds itself to, how a cover with no quote is priced, and whether to look one
          year out or five. Hover a label for what it means.
        </p>
        <span className="sechead-actions">
          <button
            type="button" className="btn btn-secondary btn-sm" data-testid="dfa-reset-assumptions"
            onClick={() => setAssumptions(() => ({ ...defaults }))}
          >
            Reset to the book’s defaults
          </button>
        </span>
      </div>
      <div className="dfa-grid dfa-grid-assume">
        {ASSUMPTION_GROUPS.map((g) => (
          <Section key={g.key} title={g.label} testid={`dfa-assume-${g.key}`}>
            <div className="blueprint dfa-panel">
              <p className="dfa-lede">{g.note}</p>
              <div className="dfa-fields">
                {g.fields.map((f) => (
                  <Field
                    key={f.key}
                    f={f}
                    ccy={ccy}
                    value={assumptions[f.key]}
                    onChange={(v) => setAssumptions((a) => ({ ...a, [f.key]: v }))}
                    note={f.key === 'credit_pd_pct' && creditSource ? `seeded from ${creditSource}` : (f.key === 'domicile' ? domicileNote : undefined)}
                    regimes={regimes}
                  />
                ))}
              </div>
              {g.key === 'insurer' && (
                <Note>
                  Leave the available capital blank and the insurer is assumed to hold exactly what
                  the gross book needs at the chosen percentile — the cleanest like-for-like read.
                </Note>
              )}
              {g.key === 'insurer' && code && (
                <>
                  <ErrorBanner error={regime.error} />
                  <RegimeCard regime={regime.data} marks={marks} />
                </>
              )}
              {g.key === 'insurer' && !code && (
                <Note>
                  No domicile chosen: 05 Capital and 07 Scenarios read the capital against the desk’s own
                  1-in-N standard. Pick the insurer’s country to read it against its regulator’s ladder —
                  Solvency II, risk-based capital, a solvency margin or a minimum capital.
                </Note>
              )}
              {g.key === 'projection' && (
                <Note>
                  Above one year, 05 Capital adds the surplus path and the chance of breaching the
                  capital standard in any year of the horizon.
                </Note>
              )}
            </div>
          </Section>
        ))}
      </div>
    </>
  );
}
