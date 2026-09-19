import React from 'react';
import { ErrorBanner, fmtMoney, fmtPct, fmtStamp } from '../../components.jsx';
import { returnPeriod, runnable } from './model.js';
import { verdictTone } from './stages.js';
import { fmtKind, moneyFmt, Delta, Term } from './bits.jsx';

/*
 * The strip at the top of every stage: the answer, in one sentence, with
 * the five figures a buyer takes into the room under it, and the run
 * button. It never leaves the screen — change the programme on 02, run,
 * and the sentence moves without a scroll. Before there is anything to
 * run it says what the desk is waiting for instead.
 */

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** The sentence, and its tone. */
function verdictOf(results, sameAsCurrent, m) {
  const prop = results.structures.proposed;
  const r = prop.reinsurance;
  const subject = sameAsCurrent ? 'The current programme' : 'The proposed programme';
  const rp = returnPeriod(results.assumptions.capital_percentile);
  if (!r) {
    return {
      text: `${subject} carries no reinsurance: the book runs gross and needs ${m(prop.capital.required)} of capital to survive a 1-in-${rp} year.`,
    };
  }
  const cost = m(r.expected_cost + r.expected_credit_loss);
  if (r.capital_relief < 0) {
    return {
      text: `${subject} needs ${m(-r.capital_relief)} more capital than running gross, and costs ${cost} a year in expectation — on this loss model the certain premium outweighs what the covers return in the tail, so it does not earn its keep.`,
    };
  }
  const implied = r.implied_coc_pct != null
    ? ` — an implied ${fmtPct(r.implied_coc_pct, 1)} cost of capital against the ${fmtPct(r.hurdle_coc_pct, 0)} hurdle`
    : '';
  const call = r.efficient == null
    ? 'the capital relief is too small to price'
    : (r.efficient ? 'cheaper than holding the capital' : 'dearer than holding the capital');
  return {
    text: `${subject} frees ${m(r.capital_relief)} of capital for an expected cost of ${cost} a year${implied}: ${call}.`,
  };
}

export default function Headline({ shared }) {
  const {
    portfolio, mode, cal, results, stale, running, startedAt, now, run, runError, ccy, lastRun, setTab, sweep, sweepStale,
  } = shared;
  const m = moneyFmt(ccy);
  const can = runnable(cal);
  const nothing = portfolio && (mode === 'contract' || mode === 'portfolio') && !portfolio.combined;
  const canRun = Boolean(portfolio) && !running && mode !== 'unchosen'
    && (mode === 'standalone' ? can : Boolean(portfolio.combined));
  const goScope = (text) => (
    <button type="button" className="dfa-linkbtn" onClick={() => setTab('scope')}>{text}</button>
  );

  const controls = (
    <div className="dfa-run">
      {results && stale && !running && (
        <span className="dfa-stale-note" data-testid="dfa-stale">Edits not yet run</span>
      )}
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => run()}
        disabled={!canRun}
        data-testid="dfa-run"
      >
        {running ? 'Simulating…' : results ? (stale ? 'Run analysis' : 'Run again') : 'Run analysis'}
      </button>
    </div>
  );

  let body;
  if (!portfolio) {
    body = <div className="dfa-verdict dfa-verdict--quiet">Reading the book…</div>;
  } else if (mode === 'unchosen') {
    body = (
      <>
        <div className="dfa-verdict dfa-verdict--quiet" data-testid="dfa-choose">Choose what to model.</div>
        <div className="dfa-verdict-tail">
          A standalone book typed from scratch, one contract read from the placements, or the
          whole portfolio — pick on {goScope('01 Scope')}. A contract or the portfolio runs by itself;
          a standalone book runs once its premium is typed.
        </div>
      </>
    );
  } else if (mode === 'standalone' && !can) {
    body = (
      <>
        <div className="dfa-verdict dfa-verdict--quiet" data-testid="dfa-needs-premium">Type the subject premium to run the model.</div>
        <div className="dfa-verdict-tail">
          The standalone loss model on {goScope('01 Scope')} starts from market defaults; the
          premium is yours to type. Build the programme on 02, then run.
        </div>
      </>
    );
  } else if (nothing) {
    body = (
      <>
        <div className="dfa-verdict dfa-verdict--quiet">Nothing to analyse yet.</div>
        <div className="dfa-verdict-tail">
          None of the placements in the selection carries a subject premium.{' '}
          {goScope('Choose another on 01 Scope')}, or model a standalone book instead.
        </div>
      </>
    );
  } else if (!results) {
    body = (
      <div className="dfa-verdict dfa-verdict--quiet">
        {running ? 'Simulating the book — every programme through the same treaty years…' : 'Run the analysis to read the verdict.'}
      </div>
    );
  } else {
    const cur = results.structures.current;
    const prop = results.structures.proposed;
    const r = prop.reinsurance;
    const same = Boolean(lastRun?.sameAsCurrent);
    const v = verdictOf(results, same, m);
    const tone = verdictTone(results);
    const delta = !same && cur.reinsurance && r ? r.value_added - cur.reinsurance.value_added : null;
    // The regulatory reading and the scenarios, in a sentence each.
    const regime = results.regime;
    const reg = prop.regime;
    const tested = Object.values(results.scenarios || {});
    const breaches = tested.filter((s) => s.structures?.proposed?.standing === 'breach').length;
    const strained = tested.filter((s) => s.structures?.proposed?.standing === 'strained').length;
    const facts = [
      {
        k: 'Capital needed', term: 'required_capital', kind: 'money', goodWhen: 'down',
        cur: cur.capital.required, prop: prop.capital.required,
      },
      {
        k: 'Expected result a year', term: 'expected_result', kind: 'money', goodWhen: 'up',
        cur: cur.result.mean, prop: prop.result.mean,
      },
      {
        k: 'Cost of the cover a year', term: 'expected_cost', kind: 'money', goodWhen: 'down',
        cur: cur.reinsurance?.expected_cost ?? 0, prop: r?.expected_cost ?? 0,
        extra: r ? `${fmtPct(r.cost_pct_of_ceded_premium, 0)} of the ceded premium` : 'no reinsurance',
      },
      {
        k: 'Value added a year', term: 'value_added', kind: 'money', goodWhen: 'up',
        cur: cur.reinsurance?.value_added ?? 0, prop: r?.value_added ?? 0,
        extra: r?.implied_coc_pct != null ? `implied ${fmtPct(r.implied_coc_pct, 1)} vs ${fmtPct(r.hurdle_coc_pct, 0)} hurdle` : undefined,
      },
      {
        k: 'Chance of ruin', term: 'ruin', kind: 'pct2', goodWhen: 'down',
        cur: cur.capital.ruin_prob_pct, prop: prop.capital.ruin_prob_pct,
        extra: `one year, against ${m(results.assumptions.available_capital)} of capital`,
      },
    ];
    body = (
      <>
        <div className={`dfa-verdict ${tone}`} data-testid="dfa-verdict">{v.text}</div>
        <div className="dfa-verdict-tail">
          {delta != null && Math.abs(delta) >= 1 && (
            <>Against the current programme, value added moves by {delta > 0 ? '+' : '−'}{m(Math.abs(delta))} a year. </>
          )}
          {r && (
            <>Risk transfer: ERD {fmtPct(r.erd_pct, 1)}, which {r.risk_transfer_ok ? 'passes' : 'fails'} the 1% test. </>
          )}
          {regime && reg && !reg.needs_input && (
            <span data-testid="dfa-verdict-regime">
              Under {regime.regime} the proposed programme reads a {regime.ratio.label} of {fmtPct(reg.ratio_pct, 0)} ({reg.band.level.toLowerCase()}),
              current {fmtPct(cur.regime.ratio_pct, 0)}.{' '}
            </span>
          )}
          {regime && reg?.needs_input && (
            <span data-testid="dfa-verdict-regime">
              {regime.regime} needs its requirement typed on{' '}
              <button type="button" className="dfa-linkbtn" onClick={() => setTab('assumptions')}>03 Assumptions</button>
              {' '}to read the ratio.{' '}
            </span>
          )}
          {tested.length > 0 && (
            <span data-testid="dfa-verdict-scenarios">
              {breaches
                ? `${breaches} of ${tested.length} stress scenarios breach the capital`
                : strained
                  ? `${strained} of ${tested.length} stress scenarios strain the capital`
                  : `All ${tested.length} stress scenarios hold`}
              {' — '}
              <button type="button" className="dfa-linkbtn" onClick={() => setTab('scenarios')}>07 Scenarios</button>.{' '}
            </span>
          )}
          {sweep && (
            <span data-testid="dfa-verdict-structuring">
              Structuring: {sweep.defensible.fits} of {sweep.defensible.tested} programmes tested fit the appetite
              {sweep.defensible.recommended ? `; the ${sweep.defensible.recommended_fits ? 'pick' : 'closest'} is ${sweep.defensible.recommended}` : ''}
              {sweepStale ? ' (inputs changed since)' : ''}{' — '}
              <button type="button" className="dfa-linkbtn" onClick={() => setTab('structuring')}>08 Structuring</button>.{' '}
            </span>
          )}
          {same && (
            <>
              Change the proposed programme on{' '}
              <button type="button" className="dfa-linkbtn" onClick={() => setTab('programme')}>02 Programme</button>
              {' '}to test an alternative against it{sweep ? '' : ', or test every structure on 08 Structuring'}.
            </>
          )}
        </div>
        <div className={`dfa-facts${stale ? ' dfa-stale' : ''}`} data-testid="dfa-facts">
          {facts.map((f) => (
            <div key={f.k} className="dfa-fact">
              <div className="dfa-fact-k"><Term k={f.term}>{f.k}</Term></div>
              <div className="dfa-fact-v">{fmtKind(f.prop, f.kind, ccy)}</div>
              <div className="dfa-fact-s">
                current {fmtKind(f.cur, f.kind, ccy)} · <Delta cur={f.cur} prop={f.prop} kind={f.kind} ccy={ccy} goodWhen={f.goodWhen} arrows />
              </div>
              {f.extra && <div className="dfa-fact-s">{f.extra}</div>}
            </div>
          ))}
        </div>
        <div className="dfa-meta">
          {fmtMoney(results.trials)} simulated treaty years · seed {results.seed} · capital at the 1-in-{returnPeriod(results.assumptions.capital_percentile)} year
          {' · '}available capital {m(results.assumptions.available_capital)}
          {results.assumptions.available_capital_source === 'given' ? '' : ' (assumed: the gross 1-in-N loss)'}
          {regime ? ` · domicile ${regime.country}` : ''}
          {lastRun?.at ? ` · run ${fmtStamp(lastRun.at)}` : ''}
        </div>
      </>
    );
  }

  return (
    <section className="blueprint dfa-head" data-testid="dfa-head">
      <div className="dfa-head-top">
        <span className="kicker accent">The verdict</span>
        {controls}
      </div>
      {body}
      {running && (
        <div className="dfa-progress" data-testid="dfa-running">
          <div className="rpa-pipeline-bar" role="progressbar" aria-label="Analysis running">
            <span className="rpa-pipeline-sweep" />
          </div>
          <span className="dfa-progress-text">
            Simulating{startedAt ? ` · ${fmtElapsed(now - startedAt)}` : ''} — the losses are drawn once and every programme is applied to the same years, so a difference is the programme, never luck.
          </span>
        </div>
      )}
      <ErrorBanner error={runError} />
    </section>
  );
}
