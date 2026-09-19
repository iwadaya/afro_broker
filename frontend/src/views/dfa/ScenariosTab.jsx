import React from 'react';
import { fmtPct } from '../../components.jsx';
import { stageOf } from './stages.js';
import { STANDINGS } from './model.js';
import { fmtKind, Term, Section, Note, StaleBar, EmptyResults, Toggle } from './bits.jsx';

/*
 * 07 Scenarios — the Handbook's process itself: the business plan as the
 * base case and a set of plausible adverse (and favourable) scenarios
 * beside it, each read for what it does to the result, the capital, the
 * surplus and the regulatory ratio. The chooser is the actuary's list —
 * every case on or off, its one figure editable — and the table reads the
 * last run: every scenario holds the same capital and re-runs the same seed
 * with one thing moved, so the movement is the scenario's, never sampling
 * noise.
 */

export function StandingPill({ standing }) {
  const s = STANDINGS[standing] || STANDINGS.holds;
  return <span className={`dfa-pill ${s.tone}`} title={s.text} data-standing={standing}>{s.label}</span>;
}

function Chooser({ scenarios, setScenarios }) {
  const sections = [...new Set(scenarios.map((s) => s.section))];
  const update = (key, patch) => setScenarios((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const allOn = scenarios.every((s) => s.on);
  const on = scenarios.filter((s) => s.on).length;
  return (
    <Section
      title="The scenarios to test"
      hint={`${on} of ${scenarios.length} on`}
      actions={(
        <button
          type="button" className="btn btn-secondary btn-sm" data-testid="dfa-scenarios-all"
          onClick={() => setScenarios((list) => list.map((s) => ({ ...s, on: !allOn })))}
        >
          {allOn ? 'Turn all off' : 'Turn all on'}
        </button>
      )}
      testid="dfa-scenario-chooser"
    >
      <div className="blueprint dfa-panel">
        <p className="dfa-lede">
          The business plan is the base case; each scenario moves one thing and runs the same
          simulated years again. Turn a case off if it is not plausible for this book, or change
          its figure. The set follows the CAS Handbook’s sections; the run tests every case that is on.
        </p>
        {sections.map((section) => (
          <div key={section} className="dfa-scenario-group">
            <div className="kicker">{section}</div>
            {scenarios.filter((s) => s.section === section).map((s) => (
              <div key={s.key} className={`dfa-scenario${s.on ? '' : ' is-off'}`} data-testid={`dfa-scenario-${s.key}`}>
                <div className="dfa-scenario-row">
                  <Toggle checked={s.on} onChange={(v) => update(s.key, { on: v })} testid={`dfa-scenario-on-${s.key}`}>
                    <span className="dfa-scenario-label">{s.label}</span>
                  </Toggle>
                  <div className="dfa-scenario-param">
                    <input
                      className="input" type="number" min={s.param.min} max={s.param.max} step={s.param.step || 1}
                      value={s.value ?? ''} disabled={!s.on}
                      aria-label={`${s.label}: ${s.param.label}`}
                      onChange={(e) => update(s.key, { value: e.target.value === '' ? '' : Number(e.target.value) })}
                      data-testid={`dfa-scenario-value-${s.key}`}
                    />
                    <span className="dfa-scenario-unit">{s.param.label}</span>
                  </div>
                </div>
                <p className="dfa-scenario-text">{s.text}</p>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Section>
  );
}

/** The base case in the scenario table's shape. */
function baseRow(results) {
  const pick = (b) => {
    const last = b.horizon ? b.horizon.by_year[b.horizon.by_year.length - 1] : null;
    return {
      result_mean: b.result.mean,
      capital_required: b.capital.required,
      solvency_ratio_pct: b.capital.solvency_ratio_pct,
      ruin_prob_pct: b.capital.ruin_prob_pct,
      regime: b.regime,
      horizon: last ? { years: b.horizon.years, surplus_end_mean: last.surplus_mean, surplus_end_p1: last.surplus_p1 } : null,
      standing: b.standing,
    };
  };
  return {
    label: 'Base case — the business plan',
    base: true,
    expected_loss_ratio_pct: results.calibration.expected.loss_ratio_pct,
    structures: { current: pick(results.structures.current), proposed: pick(results.structures.proposed) },
  };
}

const toneOf = (band) => (band.tone === 'good' ? 'ok' : band.tone === 'warn' ? 'warn' : 'fail');

function Results({ results, ccy }) {
  const rows = [baseRow(results), ...Object.values(results.scenarios || {})];
  const regime = results.regime;
  const readsRegime = Boolean(regime) && rows.every((r) => r.structures.proposed.regime && !r.structures.proposed.regime.needs_input);
  const money = (v) => fmtKind(v, 'money', ccy);
  const both = (p, c) => <>{p} <span className="muted small">/ {c}</span></>;
  const years = results.assumptions.horizon_years;
  const ratioCell = (b) => {
    if (readsRegime) {
      return <>{fmtPct(b.regime.ratio_pct, 0)} <span className={`dfa-pill ${toneOf(b.regime.band)}`}>{b.regime.band.level}</span></>;
    }
    return b.solvency_ratio_pct == null ? '—' : fmtPct(b.solvency_ratio_pct, 0);
  };
  const tested = rows.filter((r) => !r.base);
  const breaches = tested.filter((r) => r.structures.proposed.standing === 'breach');
  const strained = tested.filter((r) => r.structures.proposed.standing === 'strained');
  return (
    <Section
      title="What each scenario does — proposed, with current in grey"
      hint={readsRegime ? `${regime.ratio.label} under ${regime.regime}` : 'against the desk’s own capital standard'}
      testid="dfa-scenarios-table"
    >
      <div className="blueprint table-wrap">
        <table className="table dfa-compare dfa-scenarios-table">
          <thead>
            <tr>
              <th>Scenario</th>
              <th className="r">Loss ratio</th>
              <th className="r"><Term k="expected_result">Expected result</Term></th>
              <th className="r"><Term k="required_capital">Capital needed</Term></th>
              <th className="r"><Term k="ruin">Chance of ruin</Term></th>
              <th className="r"><Term k={readsRegime ? 'regime_ratio' : 'solvency'}>{readsRegime ? regime.ratio.label : 'Solvency ratio'}</Term></th>
              {readsRegime && <th className="r"><Term k="prob_breach">Chance of a breach</Term></th>}
              <th className="r"><Term k="scenario_surplus">Surplus at year {years}</Term></th>
              <th><Term k="standing">Standing</Term></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const p = r.structures.proposed;
              const c = r.structures.current;
              return (
                <tr key={r.label} className={r.base ? 'is-base' : ''} data-testid={r.base ? 'dfa-scenario-base' : undefined}>
                  <td>
                    <b>{r.label}</b>
                    {!r.base && r.surplus_charge > 0 && <div className="dfa-book-sub">one-off charge {money(r.surplus_charge)}</div>}
                    {!r.base && r.forced_event > 0 && <div className="dfa-book-sub">forced event {money(r.forced_event)}</div>}
                  </td>
                  <td className="r num">{fmtPct(r.expected_loss_ratio_pct, 0)}</td>
                  <td className="r num">{both(money(p.result_mean), money(c.result_mean))}</td>
                  <td className="r num">{both(money(p.capital_required), money(c.capital_required))}</td>
                  <td className="r num">{both(fmtPct(p.ruin_prob_pct, 2), fmtPct(c.ruin_prob_pct, 2))}</td>
                  <td className="r num">{ratioCell(p)}</td>
                  {readsRegime && <td className="r num">{both(fmtPct(p.regime.prob_breach_pct, 1), fmtPct(c.regime.prob_breach_pct, 1))}</td>}
                  <td className="r num">{p.horizon ? both(money(p.horizon.surplus_end_mean), money(p.horizon.surplus_end_p1)) : '—'}</td>
                  <td><StandingPill standing={p.standing} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Note>
        {tested.length === 0 && <>No scenario is on: turn some on and run again. </>}
        {breaches.length > 0 && <><b>{breaches.length} of {tested.length}</b> scenarios breach the capital under the proposed programme — {breaches.map((t) => t.label.toLowerCase()).join(', ')}. </>}
        {strained.length > 0 && <>{strained.length} {strained.length === 1 ? 'strains' : 'strain'} it — {strained.map((t) => t.label.toLowerCase()).join(', ')}. </>}
        {tested.length > 0 && !breaches.length && !strained.length && <>Every scenario holds under the proposed programme. </>}
        Surplus at year {years} is the expected figure and, after the slash, the 1-in-100 year. Every scenario
        holds the capital the base case holds and re-runs the same seed with one thing moved, so what moves
        is the scenario. {regime && !readsRegime && 'The regime needs its requirement typed on 03 Assumptions to read the ratio; the desk’s own solvency ratio stands in.'}
      </Note>
    </Section>
  );
}

export default function ScenariosTab({ shared }) {
  const { results, stale, ccy, scenarios, setScenarios } = shared;
  return (
    <>
      <StaleBar shared={shared} />
      <div className="dfa-grid dfa-grid-scenarios">
        {scenarios ? <Chooser scenarios={scenarios} setScenarios={setScenarios} /> : (
          <Section title="The scenarios to test">
            <div className="blueprint dfa-panel">
              <p className="dfa-lede">The scenarios follow the book — choose what to model on 01 Scope.</p>
            </div>
          </Section>
        )}
        {results ? (
          <div className={stale ? 'dfa-stale' : ''}><Results results={results} ccy={ccy} /></div>
        ) : (
          <EmptyResults shared={shared} stage={stageOf('scenarios')} what="the scenario table" />
        )}
      </div>
    </>
  );
}
