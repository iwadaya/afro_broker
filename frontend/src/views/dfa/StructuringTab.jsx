import React, { useEffect, useMemo, useState } from 'react';
import { fmtCompact, fmtPct, fmtStamp, StageEmpty } from '../../components.jsx';
import { stageOf } from './stages.js';
import { APPETITE_FIELDS, FAMILY_TONES, gridCount, gridProblem, num, runnable } from './model.js';
import { fmtKind, Term, Section, Note, NumberField, Toggle, moneyFmt } from './bits.jsx';
import { StandingPill } from './ScenariosTab.jsx';
import { FrontierCostChart, FamilyRanges, RangeStrip } from './structuringCharts.jsx';
import OnePager from './OnePager.jsx';

/*
 * 08 Structuring — from the simulation to a renewal decision. The stated
 * risk appetite on the left, what to test on the right (the four structure
 * families across a range of retentions); one button tests every candidate
 * on the same simulated years as the current programme and re-runs each
 * under the stresses. Then the reading: the frontier of cost against
 * volatility with every programme on it, the defensible range each family
 * fits at with the pick — the cheapest programme inside the appetite — the
 * stress table, every programme tested in one table, the full outcome
 * range of the one selected, and the renewal one-pager to print.
 */

const familyLabel = (families, key) => families?.find((f) => f.key === key)?.short || key;
const costOf = (b) => b?.reinsurance?.expected_cost ?? 0;

/** What a candidate is, under its label: the tower, the commission, the surplus's average cession. */
function candidateTerms(c) {
  const st = c.structure || {};
  const parts = [];
  if (st.quota_share) parts.push(`commission ${fmtPct(st.quota_share.commission_pct, 0)}`);
  if (st.surplus) parts.push(`${num(st.surplus.lines)} lines · commission ${fmtPct(st.surplus.commission_pct, 0)} · average cession ${fmtPct(st.surplus.average_cession_pct, 1)}`);
  const layers = st.xol_layers || [];
  if (layers.length) {
    const top = Math.max(...layers.map((l) => num(l.attachment) + num(l.limit)));
    parts.push(`${layers.length} ${layers.length === 1 ? 'layer' : 'layers'} to ${fmtCompact(top)}`);
  }
  return parts.join(' · ');
}
/** "Solvency ratio" → "solvency ratio", leaving a proper name inside the label alone. */
const lc = (t) => (t ? t.charAt(0).toLowerCase() + t.slice(1) : t);
/** "a, b and c" */
const listOf = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** The button that runs the sweep, with the wait shown on it. */
function TestButton({ shared, size = '' }) {
  const { cal, grid, sweeping, sweep, sweepStale, runSweep, sweepStartedAt, now } = shared;
  const problem = gridProblem(grid);
  const can = runnable(cal) && !problem && !sweeping;
  return (
    <button
      type="button" className={`btn btn-primary ${size}`} disabled={!can} onClick={() => runSweep()}
      title={problem || undefined} data-testid="dfa-sweep"
    >
      {sweeping ? `Testing…${sweepStartedAt ? ` ${fmtElapsed(now - sweepStartedAt)}` : ''}` : sweep ? (sweepStale ? 'Test the structures again' : 'Test again') : 'Test the structures'}
    </button>
  );
}

/** The figures below are from an older test than the inputs. */
function SweepBar({ shared }) {
  const { sweep, sweeping, sweepStale } = shared;
  if (!sweep || (!sweepStale && !sweeping)) return null;
  return (
    <div className="dfa-stalebar" role="status" data-testid="dfa-sweepbar">
      <span>
        {sweeping
          ? 'Testing — the figures below are from the last test and will update when it lands.'
          : 'The inputs have changed since these programmes were tested — the figures below are from the last test.'}
      </span>
      {!sweeping && <TestButton shared={shared} size="btn-sm" />}
    </div>
  );
}

// ---- The inputs: the appetite, and what to test ----

function AppetiteCard({ shared }) {
  const { appetite, setAppetite, portfolio, ccy, assumptions, results, sweep } = shared;
  const defaults = portfolio?.defaults?.appetite || {};
  const capital = sweep?.assumptions?.available_capital ?? results?.assumptions?.available_capital ?? null;
  const given = num(assumptions?.available_capital) > 0;
  const m = moneyFmt(ccy);
  return (
    <Section
      title="The risk appetite"
      hint="what the board will accept — every programme is read against each line"
      actions={(
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAppetite(() => ({ ...defaults }))} data-testid="dfa-appetite-reset">
          Reset
        </button>
      )}
      testid="dfa-appetite"
    >
      <div className="blueprint dfa-panel">
        <p className="dfa-lede">
          The tolerance stated in the insurer’s own terms. A programme <b>fits</b> only when it passes
          every line; a blank limit switches that line off. The capital these read against is{' '}
          {capital != null ? <b>{m(capital)}</b> : 'the capital held'}
          {given ? ' (typed on 03 Assumptions)' : ' (assumed: what the gross book needs at the chosen percentile — type the real figure on 03 Assumptions)'}.
        </p>
        <div className="dfa-fields dfa-fields-appetite">
          {APPETITE_FIELDS.map((f) => (
            <NumberField
              key={f.key}
              label={`${f.label}${f.unit ? ` (${f.unit})` : ''}`}
              title={f.title}
              step={f.step}
              min="0"
              placeholder={f.key === 'max_cost_pct_of_premium' ? 'no budget' : undefined}
              value={appetite?.[f.key] ?? ''}
              onChange={(v) => setAppetite((a) => ({ ...a, [f.key]: v }))}
              testid={`dfa-appetite-${f.key}`}
            />
          ))}
        </div>
        <Toggle
          checked={appetite?.require_standing_holds !== false}
          onChange={(on) => setAppetite((a) => ({ ...a, require_standing_holds: on }))}
          title="The programme must stand as “holds” on the domicile’s capital ladder (03 Assumptions) — or against the desk’s own standard when no domicile is chosen."
          testid="dfa-appetite-standing"
        >
          Must <b>hold</b> on the capital ladder{results?.regime ? ` — ${results.regime.regime}` : ''}
        </Toggle>
      </div>
    </Section>
  );
}

function GridCard({ shared }) {
  const { grid, setGrid, portfolio, ccy, current } = shared;
  const families = portfolio?.defaults?.families || [];
  if (!grid) return null;
  const on = (key) => grid.families.includes(key);
  const toggle = (key, v) => setGrid((g) => ({ ...g, families: v ? [...new Set([...g.families, key])] : g.families.filter((k) => k !== key) }));
  const set = (key) => (v) => setGrid((g) => ({ ...g, [key]: v }));
  const count = gridCount(grid);
  const problem = gridProblem(grid);
  const needsTower = on('xol') || on('blend');
  const needsLine = needsTower || on('surplus');
  const hasTower = (current?.xol_layers || []).some((l) => num(l.limit) > 0);
  return (
    <Section title="What to test" hint={`${count} programme${count === 1 ? '' : 's'} on the same simulated years`} testid="dfa-grid">
      <div className="blueprint dfa-panel">
        <p className="dfa-lede">
          Each family across the range, in equal steps. The excess-of-loss tower keeps the shape of the
          current programme above the retention{hasTower ? ' (its upper layers and their quotes stand)' : ' — with no tower on the book, one layer from the retention to the top'};
          a moved layer is priced by the model.
        </p>
        <div className="dfa-families">
          {families.map((f) => (
            <label key={f.key} className={`dfa-family fam-${FAMILY_TONES[f.key]}${on(f.key) ? ' is-on' : ''}`} title={f.text}>
              <input type="checkbox" checked={on(f.key)} onChange={(e) => toggle(f.key, e.target.checked)} data-testid={`dfa-family-${f.key}`} />
              <span className="dfa-family-text">
                <b><i className="dfa-famkey" aria-hidden="true" /> {f.label}</b>
                <span>{f.text}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="dfa-fields dfa-fields-row">
          <NumberField label="Steps a family" min="2" max="8" step="1" value={grid.steps} onChange={set('steps')} title="How many points each family is tested at, from the bottom of its range to the top." testid="dfa-grid-steps" />
          {needsLine && (
            <>
              <NumberField label={`Retention from${ccy ? ` (${ccy})` : ''}`} min="0" value={grid.retention_from} onChange={set('retention_from')} title="The lowest retention tested — the excess-of-loss attachment, and the surplus’s retained line." testid="dfa-grid-from" />
              <NumberField label={`Retention to${ccy ? ` (${ccy})` : ''}`} min="0" value={grid.retention_to} onChange={set('retention_to')} title="The highest retention tested." testid="dfa-grid-to" />
            </>
          )}
          {needsTower && (
            <>
              <NumberField label={`Top of the tower${ccy ? ` (${ccy})` : ''}`} min="0" value={grid.tower_top} onChange={set('tower_top')} title="Where the excess-of-loss tower exhausts. Seeded from the current tower, else the cat PML." testid="dfa-grid-top" />
              <label className="field" title="Reinstatements on a layer the model prices; a layer kept from the current tower keeps its own.">
                <span>Reinstatements</span>
                <select className="input" value={String(grid.reinstatements)} onChange={(e) => set('reinstatements')(e.target.value)}>
                  {['0', '1', '2', '3', 'UNLIMITED'].map((o) => <option key={o} value={o}>{o === 'UNLIMITED' ? '∞ unlimited' : o}</option>)}
                </select>
              </label>
            </>
          )}
          {on('quota_share') && (
            <>
              <NumberField label="Cession from %" min="1" max="90" value={grid.cession_from} onChange={set('cession_from')} title="The lowest quota-share cession tested." />
              <NumberField label="Cession to %" min="1" max="90" value={grid.cession_to} onChange={set('cession_to')} title="The highest quota-share cession tested." />
            </>
          )}
          {(on('quota_share') || on('surplus') || on('blend')) && (
            <NumberField label="Ceding commission %" min="0" max="50" value={grid.commission_pct} onChange={set('commission_pct')} title="The commission on the proportional covers — quota share and surplus." />
          )}
          {on('surplus') && (
            <NumberField label="Surplus lines" min="1" max="20" step="1" value={grid.surplus_lines} onChange={set('surplus_lines')} title="How many lines of the retained line the surplus cedes: the biggest risk fully covered is (lines + 1) × the line." testid="dfa-grid-lines" />
          )}
          {on('blend') && (
            <NumberField label="Blend’s quota share %" min="1" max="90" value={grid.blend_cession_pct} onChange={set('blend_cession_pct')} title="The fixed quota share under the excess-of-loss tower in the blended programmes." />
          )}
        </div>
        {problem ? <div className="dfa-warn" data-testid="dfa-grid-problem">{problem}</div> : (
          <Note>
            Every candidate, the current programme and the gross book run on the same simulated years, then again
            under each stress — the cat PML event, a reserve shock and rates running hot, at the figures on 07 Scenarios.
          </Note>
        )}
      </div>
    </Section>
  );
}

// ---- The reading ----

/** The decision in a sentence, the range each family fits at, and the pick's figures. */
function Decision({ shared, selected, onSelect, onOnePager }) {
  const { sweep, ccy, adopt } = shared;
  const m = moneyFmt(ccy);
  const d = sweep.defensible;
  const pick = sweep.candidates.find((c) => c.label === d.recommended) || null;
  const current = sweep.references.current;
  const sentence = (() => {
    if (!pick) return 'Nothing was tested — turn a family on and test again.';
    const r = pick.reinsurance;
    const cheaper = current?.reinsurance ? costOf(pick) <= costOf(current) : null;
    if (d.recommended_fits) {
      return (
        <>
          <b>{d.fits} of {d.tested}</b> programmes tested fit the appetite. The pick is <b>{pick.label}</b>:{' '}
          {m(r?.ceded_premium ?? 0)} a year to reinsurers for an expected cost of {m(costOf(pick))}, the 1-in-100 net loss
          at {fmtPct(pick.capital.loss_1in100_pct_of_capital, 0)} of capital, a {fmtPct(pick.capital.ruin_prob_pct, 2)} chance of ruin
          and a {fmtPct(pick.combined_ratio.p90, 0)} combined ratio in a 1-in-10 year
          {cheaper == null ? '.' : cheaper ? ' — cheaper than the current programme.' : ' — dearer than the current programme, which does not fit.'}
        </>
      );
    }
    return (
      <>
        <b>Nothing tested fits the appetite.</b> The closest is <b>{pick.label}</b>, which fails{' '}
        {listOf(pick.appetite.tests.filter((t) => !t.ok).map((t) => lc(t.label)))}.
        Loosen a line of the appetite, widen the range, raise the top of the tower — or type the real capital held on 03 Assumptions.
      </>
    );
  })();
  const facts = pick ? [
    { k: 'Premium paid', term: 'ceded_premium', v: pick.reinsurance?.ceded_premium ?? 0, c: current?.reinsurance?.ceded_premium ?? 0, kind: 'money' },
    { k: 'Expected cost', term: 'ceded_cost', v: costOf(pick), c: costOf(current), kind: 'money' },
    { k: 'Capital needed', term: 'required_capital', v: pick.capital.required, c: current?.capital.required, kind: 'money' },
    { k: 'Chance of ruin', term: 'ruin', v: pick.capital.ruin_prob_pct, c: current?.capital.ruin_prob_pct, kind: 'pct2' },
    { k: '1-in-100 loss, % of capital', term: 'appetite', v: pick.capital.loss_1in100_pct_of_capital, c: current?.capital.loss_1in100_pct_of_capital, kind: 'pct' },
  ] : [];
  const currentFits = current?.appetite?.pass;
  return (
    <Section title="A defensible range" hint={d.recommended_fits ? 'the cheapest programme inside the appetite' : 'nothing fits yet'} testid="dfa-decision">
      <div className="blueprint dfa-panel">
        <p className={`dfa-verdict ${d.recommended_fits ? 'good' : 'bad'}`} data-testid="dfa-decision-sentence">{sentence}</p>
        {pick && (
          <div className="dfa-facts dfa-facts-pick" data-testid="dfa-pick-facts">
            {facts.map((f) => (
              <div key={f.k} className="dfa-fact">
                <div className="dfa-fact-k"><Term k={f.term}>{f.k}</Term></div>
                <div className="dfa-fact-v">{fmtKind(f.v, f.kind, ccy)}</div>
                <div className="dfa-fact-s">current {fmtKind(f.c, f.kind, ccy)}</div>
              </div>
            ))}
          </div>
        )}
        <div className="dfa-block">
          <div className="dfa-block-head">
            <span className="dfa-block-title"><b><Term k="defensible">Where each family fits</Term></b> — the room to negotiate in</span>
            <span className="muted small">
              {current ? (currentFits ? 'The current programme fits the appetite.' : `The current programme does not fit: it fails ${current.appetite.failed.join(', ')}.`) : ''}
            </span>
          </div>
          <FamilyRanges families={d.families} candidates={sweep.candidates} ccy={ccy} />
        </div>
        <div className="dfa-actions">
          {pick && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => adopt(pick)} data-testid="dfa-adopt">
              Use {pick.label} as the proposed programme
            </button>
          )}
          {pick && pick.label !== selected && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onSelect(pick.label)}>Show the pick below</button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onOnePager} data-testid="dfa-onepager-open">Renewal one-pager</button>
        </div>
        <Note>
          The pick is the cheapest programme that passes every line of the appetite — safe, without paying for more
          protection than the appetite needs. Adopting it puts it on 02 Programme as the proposed programme and runs
          the desk on it, so every stage reads it; the one-pager is the page to take into the renewal.
        </Note>
      </div>
    </Section>
  );
}

/** How the selected programme and the current one stand after one thing goes wrong. */
function StressTable({ shared, candidate }) {
  const { sweep, ccy } = shared;
  const m = moneyFmt(ccy);
  const current = sweep.references.current;
  const labels = sweep.defensible.stresses;
  const regime = sweep.regime;
  const rows = [['Selected', candidate], ['Current', current]].filter(([, b]) => b);
  const ratio = (s) => (regime && s.ratio_pct != null ? fmtPct(s.ratio_pct, 0) : (s.solvency_ratio_pct == null ? '—' : fmtPct(s.solvency_ratio_pct, 0)));
  return (
    <Section title="Stress-tested" hint="the same years and the same capital, one thing moved" testid="dfa-stress">
      <div className="blueprint table-wrap">
        <table className="table dfa-compare dfa-stress-table">
          <thead>
            <tr>
              <th>Stress</th>
              <th>Programme</th>
              <th className="r"><Term k="expected_result">Result</Term></th>
              <th className="r"><Term k="ruin">Ruin</Term></th>
              <th className="r"><Term k={regime ? 'regime_ratio' : 'solvency'}>{regime ? regime.ratio.label : 'Solvency'}</Term></th>
              <th><Term k="stress_standing">Standing</Term></th>
            </tr>
          </thead>
          <tbody>
            <tr className="is-base">
              <td><b>Base case</b></td>
              <td />
              <td className="r num">{rows.map(([l, b]) => <div key={l}>{m(b.result.mean)}</div>)}</td>
              <td className="r num">{rows.map(([l, b]) => <div key={l}>{fmtPct(b.capital.ruin_prob_pct, 2)}</div>)}</td>
              <td className="r num">{rows.map(([l, b]) => <div key={l}>{regime && b.regime?.ratio_pct != null ? fmtPct(b.regime.ratio_pct, 0) : (b.capital.solvency_ratio_pct == null ? '—' : fmtPct(b.capital.solvency_ratio_pct, 0))}</div>)}</td>
              <td>{rows.map(([l, b]) => <div key={l}><StandingPill standing={b.standing} /></div>)}</td>
            </tr>
            {labels.map((label) => (
              <tr key={label} data-testid="dfa-stress-row">
                <td>
                  <b>{label}</b>
                  {sweep.stresses[label]?.forced_event > 0 && <div className="dfa-book-sub">event {m(sweep.stresses[label].forced_event)}</div>}
                  {sweep.stresses[label]?.surplus_charge > 0 && <div className="dfa-book-sub">one-off charge {m(sweep.stresses[label].surplus_charge)}</div>}
                </td>
                <td>{rows.map(([l]) => <div key={l} className={l === 'Current' ? 'muted' : ''}>{l}</div>)}</td>
                <td className="r num">{rows.map(([l, b]) => <div key={l} className={l === 'Current' ? 'muted' : ''}>{b.stress[label] ? m(b.stress[label].result_mean) : '—'}</div>)}</td>
                <td className="r num">{rows.map(([l, b]) => <div key={l} className={l === 'Current' ? 'muted' : ''}>{b.stress[label] ? fmtPct(b.stress[label].ruin_prob_pct, 2) : '—'}</div>)}</td>
                <td className="r num">{rows.map(([l, b]) => <div key={l} className={l === 'Current' ? 'muted' : ''}>{b.stress[label] ? ratio(b.stress[label]) : '—'}</div>)}</td>
                <td>{rows.map(([l, b]) => <div key={l}>{b.stress[label] ? <StandingPill standing={b.stress[label].standing} /> : '—'}</div>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note>
        Each stress holds the capital the base case holds and re-runs the same seed with one thing moved, so what moves
        is the stress. The first line of each cell is the selected programme, the second the current one.
      </Note>
    </Section>
  );
}

const stressTone = (standing) => (standing === 'holds' ? 'ok' : standing === 'strained' ? 'warn' : 'fail');

/** Every programme tested, one row each, the references on top. */
function CandidatesTable({ shared, selected, onSelect }) {
  const { sweep, ccy } = shared;
  const [onlyFits, setOnlyFits] = useState(false);
  const m = moneyFmt(ccy);
  const families = sweep.families;
  const refs = Object.entries(sweep.references).filter(([k]) => k !== 'gross').map(([k, b]) => ({ ...b, label: k === 'current' ? 'Current programme' : 'Proposed programme', ref: true }));
  const rows = [...refs, ...sweep.candidates.filter((c) => !onlyFits || c.appetite.pass)];
  const regime = sweep.regime;
  const stresses = sweep.defensible.stresses;
  return (
    <Section
      title="Every programme tested"
      hint={`${sweep.candidates.length} candidates · ${fmtCompact(sweep.trials)} simulated years · seed ${sweep.seed}`}
      actions={(
        <Toggle checked={onlyFits} onChange={setOnlyFits} testid="dfa-only-fits"><span className="small">Only those that fit</span></Toggle>
      )}
      testid="dfa-candidates"
    >
      <div className="blueprint table-wrap dfa-candidates-wrap">
        <table className="table dfa-compare dfa-candidates">
          <thead>
            <tr>
              <th>Programme</th>
              <th className="r"><Term k="ceded_premium">Premium paid</Term></th>
              <th className="r"><Term k="ceded_cost">Expected cost</Term></th>
              <th className="r"><Term k="net_volatility">Result swings</Term></th>
              <th className="r"><Term k="combined_ratio">Combined ratio · median / 1-in-10</Term></th>
              <th className="r"><Term k="net_income">Net income · expected / 1-in-100</Term></th>
              <th className="r"><Term k="required_capital">Capital needed</Term></th>
              <th className="r"><Term k="ruin">Ruin</Term></th>
              <th className="r">1-in-100 loss, % capital</th>
              <th className="r"><Term k={regime ? 'regime_ratio' : 'solvency'}>{regime ? regime.ratio.label : 'Solvency'}</Term></th>
              <th><Term k="appetite">Fits?</Term></th>
              <th><Term k="stress_standing">Under stress</Term></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const isSel = !c.ref && c.label === selected;
              const failed = c.appetite.tests.filter((t) => !t.ok);
              return (
                <tr
                  key={c.label}
                  className={`${c.ref ? 'is-ref' : 'is-candidate'}${isSel ? ' is-selected' : ''}${c.recommended ? ' is-pick' : ''}`}
                  onClick={() => { if (!c.ref) onSelect(c.label); }}
                  data-testid={c.ref ? 'dfa-candidate-ref' : 'dfa-candidate'}
                  data-family={c.family || 'ref'}
                >
                  <td>
                    <div className="dfa-cover-name">
                      {!c.ref && <i className={`dfa-famkey fam-${FAMILY_TONES[c.family]}`} aria-hidden="true" />} {c.label}
                      {c.recommended && <span className="dfa-tag dfa-tag-pick"> the pick</span>}
                      {c.efficient && !c.ref && <span className="dfa-tag" title="No other programme tested is both cheaper and steadier."> efficient</span>}
                    </div>
                    {!c.ref && <div className="muted small">{familyLabel(families, c.family)} · {candidateTerms(c)}</div>}
                  </td>
                  <td className="r num">{m(c.reinsurance?.ceded_premium ?? 0)}</td>
                  <td className="r num">{m(costOf(c))}</td>
                  <td className="r num">{m(c.result.sd)}</td>
                  <td className="r num">{fmtPct(c.combined_ratio.p50, 0)} / {fmtPct(c.combined_ratio.p90, 0)}</td>
                  <td className="r num">{m(c.net_income.mean)} / {m(c.net_income.p1)}</td>
                  <td className="r num">{m(c.capital.required)}</td>
                  <td className="r num">{fmtPct(c.capital.ruin_prob_pct, 2)}</td>
                  <td className="r num">{fmtPct(c.capital.loss_1in100_pct_of_capital, 0)}</td>
                  <td className="r num">{regime && c.regime?.ratio_pct != null ? fmtPct(c.regime.ratio_pct, 0) : (c.capital.solvency_ratio_pct == null ? '—' : fmtPct(c.capital.solvency_ratio_pct, 0))}</td>
                  <td>
                    <span className={`dfa-pill ${c.appetite.pass ? 'ok' : 'fail'}`} title={c.appetite.pass ? 'Passes every line of the appetite' : `Fails: ${failed.map((t) => `${t.label} ${t.kind === 'standing' ? t.value : `${fmtPct(t.value, t.kind === 'pct2' ? 2 : 0)} vs ${t.op} ${fmtPct(t.limit, t.kind === 'pct2' ? 2 : 0)}`}`).join('; ')}`}>
                      {c.appetite.pass ? 'fits' : `fails ${failed.length}`}
                    </span>
                  </td>
                  <td className="dfa-stress-pills">
                    {stresses.map((s) => (
                      <span key={s} className={`dfa-pill ${c.stress[s] ? stressTone(c.stress[s].standing) : ''}`} title={`${s}: ${c.stress[s]?.standing || '—'}`}>
                        {s.replace('A major cat year', 'cat').replace('Reserves deteriorate', 'reserves').replace('Rates inadequate', 'rates')}
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Note>
        Click a programme to read its full outcome range below. Hover “fails” for the lines it fails and by how much;
        the pills are its standing under each stress. Premium paid includes expected reinstatement premium; the expected
        cost is that premium less the recoveries and commission expected back.
      </Note>
    </Section>
  );
}

/** The full outcome range of the selected programme beside the current one. */
function Outcomes({ shared, candidate }) {
  const { sweep, ccy } = shared;
  const current = sweep.references.current;
  const gross = sweep.references.gross;
  const rows = (pick) => [
    { label: 'Selected', stats: pick(candidate), tone: 'sel' },
    ...(current ? [{ label: 'Current', stats: pick(current), tone: 'ref' }] : []),
    { label: 'Gross', stats: pick(gross), tone: 'gross' },
  ];
  const pct = (v, short) => (v == null ? '—' : `${Math.round(v)}%`);
  const money = (v) => (v == null ? '—' : fmtCompact(v));
  return (
    <Section title={`The full outcome range — ${candidate.label}`} hint="a distribution, not one point" testid="dfa-outcomes">
      <div className="blueprint dfa-panel">
        <RangeStrip title="Combined ratio" rows={rows((b) => b.combined_ratio)} format={pct} mark={100} markLabel="break-even" goodWhen="down" testid="dfa-range-cr" />
        <RangeStrip title={`Net income${ccy ? ` (${ccy})` : ''} — underwriting result plus investment income`} rows={rows((b) => b.net_income)} format={money} mark={0} goodWhen="up" testid="dfa-range-ni" />
        <RangeStrip title="Solvency position at the year end — capital held over capital needed" rows={rows((b) => b.solvency_end)} format={pct} mark={100} markLabel="100%" goodWhen="up" testid="dfa-range-solvency" />
        <div className="dfa-legend dfa-range-legend">
          <span className="dfa-range-key wide" /> 1-in-100 to 1-in-100
          <span className="dfa-range-key core" /> 1-in-10 to 1-in-10
          <span className="dfa-range-key median" /> median
          <span className="dfa-range-key mean" /> mean
        </div>
        <Note>
          The figure after the median is the bad-year end of the range: the 1-in-100 combined ratio, the 1-in-100 net
          income, the 1-in-100 solvency position. Net income adds investment income — the yield with its volatility from
          03 Assumptions — to the underwriting result.
        </Note>
      </div>
    </Section>
  );
}

/** The appetite, line by line, for the selected programme and the current one. */
function TestsTable({ shared, candidate }) {
  const { sweep } = shared;
  const current = sweep.references.current;
  const fmtVal = (t) => (t.value == null ? '—' : t.kind === 'standing' ? t.value : fmtPct(t.value, t.kind === 'pct2' ? 2 : 1));
  const fmtLimit = (t) => (t.kind === 'standing' ? 'holds' : `${t.op} ${fmtPct(t.limit, t.kind === 'pct2' ? 2 : 0)}`);
  return (
    <Section title={`The appetite, line by line — ${candidate.label}`} hint="current in grey" testid="dfa-tests">
      <div className="blueprint table-wrap">
        <table className="table dfa-compare">
          <thead>
            <tr>
              <th>Line</th>
              <th className="r">Limit</th>
              <th className="r">Selected</th>
              <th className="r">Current</th>
            </tr>
          </thead>
          <tbody>
            {candidate.appetite.tests.map((t, i) => {
              const c = current?.appetite.tests[i];
              return (
                <tr key={t.key}>
                  <td>{t.label}</td>
                  <td className="r num">{fmtLimit(t)}</td>
                  <td className="r num">{fmtVal(t)} <span className={`dfa-pill ${t.ok ? 'ok' : 'fail'}`}>{t.ok ? 'pass' : 'fail'}</span></td>
                  <td className="r num muted">{c ? <>{fmtVal(c)} <span className={`dfa-pill ${c.ok ? 'ok' : 'fail'}`}>{c.ok ? 'pass' : 'fail'}</span></> : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Note>
        {candidate.reinsurance?.risk_transfer_ok === false && <>This programme fails the 1% expected-reinsurer-deficit test of risk transfer. </>}
        {candidate.reinsurance?.efficient === false && <>Its implied cost of capital ({fmtPct(candidate.reinsurance.implied_coc_pct, 1)}) sits above the {fmtPct(candidate.reinsurance.hurdle_coc_pct, 0)} hurdle: dearer than holding the capital it frees. </>}
        {candidate.reinsurance?.efficient === true && <>Its implied cost of capital ({fmtPct(candidate.reinsurance.implied_coc_pct, 1)}) sits below the {fmtPct(candidate.reinsurance.hurdle_coc_pct, 0)} hurdle: cheaper than holding the capital it frees. </>}
        Value added {fmtKind(candidate.reinsurance?.value_added ?? 0, 'money', shared.ccy)} a year.
      </Note>
    </Section>
  );
}

export default function StructuringTab({ shared }) {
  const { portfolio, mode, cal, sweep, sweepError, sweepStale, sweeping, ccy, running } = shared;
  const [selected, setSelected] = useState(null);
  const [onePager, setOnePager] = useState(false);
  // A new test lands: read the pick first.
  useEffect(() => { setSelected(sweep?.defensible?.recommended || null); }, [sweep]);
  const candidate = useMemo(() => {
    if (!sweep) return null;
    return sweep.candidates.find((c) => c.label === selected) || sweep.candidates.find((c) => c.recommended) || sweep.candidates[0] || null;
  }, [sweep, selected]);

  if (!portfolio) return <div className="muted small">Reading the book…</div>;
  const nothing = (mode === 'contract' || mode === 'portfolio') && !portfolio.combined;
  if (mode === 'unchosen' || nothing || !cal) {
    return (
      <StageEmpty
        stage={stageOf('structuring')}
        title={mode === 'unchosen' ? 'Choose what to model first' : 'Nothing to structure yet'}
        note={mode === 'unchosen'
          ? 'A standalone book typed from scratch, one contract read from the placements, or the whole portfolio. Then this stage tests every structure across a range of retentions against the capital and the appetite.'
          : 'None of the placements in the selection carries a subject premium. Choose another on 01 Scope, or model a standalone book.'}
      >
        <button type="button" className="btn btn-secondary" onClick={() => shared.setTab('scope')}>Open 01 Scope</button>
      </StageEmpty>
    );
  }

  return (
    <>
      <div className="sechead dfa-structuring-head">
        <p className="dfa-lede dfa-lede-wide">
          From the simulation to a renewal decision. State the appetite, choose what to test, and every structure
          — quota share, surplus, excess of loss and a blend, each across a range of retentions — runs on the same
          simulated years as the current programme, re-run under the stresses, and is read against the capital held
          and the appetite. The pick is the cheapest that fits.
        </p>
        <span className="sechead-actions">
          {sweep && !sweepStale && !sweeping && <span className="muted small" data-testid="dfa-sweep-meta">tested {fmtStamp(sweep.at)}</span>}
          <TestButton shared={shared} />
        </span>
      </div>
      {sweepError && <div className="dfa-warn" role="alert" data-testid="dfa-sweep-error">{sweepError.message}</div>}
      <div className="dfa-grid dfa-grid-structuring-inputs">
        <AppetiteCard shared={shared} />
        <GridCard shared={shared} />
      </div>
      {!sweep ? (
        <StageEmpty
          stage={stageOf('structuring')}
          title={sweeping ? 'Testing the structures' : (runnable(cal) ? 'No test yet — the frontier, the defensible range and the pick appear here' : 'Type the subject premium to test the structures')}
          note={sweeping
            ? 'Every candidate is being run on the same simulated years, then again under each stress. The stage fills in the moment it lands.'
            : (runnable(cal)
              ? 'Check the appetite and the range above, then press Test the structures at the top of the stage. The desk’s own run is not needed first.'
              : 'The standalone loss model on 01 Scope starts from market defaults; the engine needs the premium before it can simulate a year.')}
        />
      ) : (
        <>
          <SweepBar shared={shared} />
          <div className={sweepStale ? 'dfa-stale dfa-stack' : 'dfa-stack'}>
            <Section title="The frontier" hint="what the cover costs against how much the result swings — every programme tested" testid="dfa-frontier">
              <div className="blueprint dfa-panel">
                <div className="dfa-chart-head">
                  <span className="dfa-legend dfa-legend-families">
                    {sweep.families.map((f) => <span key={f.key} className={`dfa-legend-fam fam-${FAMILY_TONES[f.key]}`}><i className="dfa-famkey" aria-hidden="true" /> {f.label}</span>)}
                    <span className="dfa-legend-fam fam-ref"><i className="dfa-famkey is-diamond" aria-hidden="true" /> Gross · current</span>
                    <span className="dfa-legend-fam"><i className="dfa-famkey is-hollow" aria-hidden="true" /> hollow: does not fit</span>
                    <span className="dfa-legend-fam"><i className="dfa-famkey is-ring" aria-hidden="true" /> the pick</span>
                  </span>
                </div>
                <FrontierCostChart candidates={sweep.candidates} references={sweep.references} selected={candidate?.label} onSelect={setSelected} ccy={ccy} />
                <Note>
                  Down and to the left is better: less cost for a steadier result. Pay more to reinsurers and the result
                  steadies; keep more and it swings. The dotted line joins the <Term k="efficient">efficient</Term> programmes;
                  click a point to read it below.
                </Note>
              </div>
            </Section>
            <div className="dfa-grid dfa-grid-decision">
              <Decision shared={shared} selected={candidate?.label} onSelect={setSelected} onOnePager={() => setOnePager(true)} />
              {candidate && <StressTable shared={shared} candidate={candidate} />}
            </div>
            <CandidatesTable shared={shared} selected={candidate?.label} onSelect={setSelected} />
            {candidate && (
              <div className="dfa-grid dfa-grid-outcomes">
                <Outcomes shared={shared} candidate={candidate} />
                <TestsTable shared={shared} candidate={candidate} />
              </div>
            )}
          </div>
          {onePager && candidate && <OnePager shared={shared} candidate={candidate} onClose={() => setOnePager(false)} />}
        </>
      )}
      {running && !sweep && <Note>The desk’s own run is in flight; the structuring test runs separately.</Note>}
    </>
  );
}
