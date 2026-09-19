import React, { useEffect } from 'react';
import { fmtCompact, fmtDate, fmtPct } from '../../components.jsx';
import { moneyFmt } from './bits.jsx';
import { returnPeriod, num } from './model.js';
import { FrontierCostChart } from './structuringCharts.jsx';
import { StandingPill } from './ScenariosTab.jsx';

/*
 * The renewal one-pager: the page underwriters and management take into
 * the room. One sheet — the recommendation in a sentence, the programme's
 * terms, its figures beside the current programme, the frontier, the
 * appetite line by line and the stresses — and the assumptions it rests
 * on in the footer. Printed straight from the browser; nothing else on the
 * screen prints.
 */

const costOf = (b) => b?.reinsurance?.expected_cost ?? 0;

function Terms({ structure, ccy }) {
  const m = moneyFmt(ccy);
  const qs = structure.quota_share;
  const sp = structure.surplus;
  const layers = structure.xol_layers || [];
  const agg = structure.aggregate_cover;
  return (
    <table className="table dfa-op-terms">
      <thead>
        <tr><th>Cover</th><th>Terms</th><th className="r">Premium</th></tr>
      </thead>
      <tbody>
        {qs && (
          <tr>
            <td>Quota share</td>
            <td>{fmtPct(qs.cession_pct, 0)} cession · {fmtPct(qs.commission_pct, 0)} commission{qs.event_limit ? ` · event limit ${m(qs.event_limit)}` : ''}</td>
            <td className="r num">{fmtPct(qs.cession_pct, 0)} of the premium</td>
          </tr>
        )}
        {sp && (
          <tr>
            <td>Surplus</td>
            <td>line {m(sp.retained_line)} · {num(sp.lines)} lines · {fmtPct(sp.commission_pct, 0)} commission · average cession {fmtPct(sp.average_cession_pct, 1)}</td>
            <td className="r num">{m(sp.premium100)}</td>
          </tr>
        )}
        {layers.map((l) => (
          <tr key={`${l.attachment}-${l.limit}`}>
            <td>{l.name || 'Layer'}</td>
            <td>{fmtCompact(l.limit)} xs {fmtCompact(l.attachment)} · {l.reinstatements === 'UNLIMITED' ? 'unlimited' : l.reinstatements} reinst.{l.placed_pct < 100 ? ` · ${fmtPct(l.placed_pct, 0)} placed` : ''}</td>
            <td className="r num">{m(l.premium100)}{l.priced === 'technical' ? <span className="muted small"> · model</span> : ''}</td>
          </tr>
        ))}
        {agg && (
          <tr>
            <td>{agg.name || 'Stop loss'}</td>
            <td>{fmtPct(agg.attachment_lr_pct, 0)} → {fmtPct(agg.exhaust_lr_pct, 0)} loss ratio</td>
            <td className="r num">{m(agg.premium100)}</td>
          </tr>
        )}
        {!qs && !sp && !layers.length && !agg && <tr><td colSpan="3" className="muted">No reinsurance — the book runs gross.</td></tr>}
      </tbody>
    </table>
  );
}

export default function OnePager({ shared, candidate, onClose }) {
  const { sweep, ccy, cal, portfolio, mode } = shared;
  const m = moneyFmt(ccy);
  const current = sweep.references.current;
  const d = sweep.defensible;
  const a = sweep.assumptions;
  const regime = sweep.regime;
  // Esc closes; while the sheet is open the body carries a class so that
  // printing puts the sheet, and nothing else, on the page.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('has-onepager');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('has-onepager');
    };
  }, [onClose]);
  const selected = portfolio?.placements?.filter((p) => (portfolio.selected || []).includes(p.id)) || [];
  const book = mode === 'standalone'
    ? `Standalone book${ccy ? ` · ${ccy}` : ''}`
    : selected.length === 1
      ? `${selected[0].reference} · ${selected[0].cedant_name} · ${selected[0].class}`
      : `${selected.length} contracts${ccy ? ` · ${ccy}` : ''}`;
  const figures = [
    ['Premium paid to reinsurers', (b) => m(b.reinsurance?.ceded_premium ?? 0)],
    ['Expected cost of the cover', (b) => m(costOf(b))],
    ['Capital needed (1-in-' + returnPeriod(a.capital_percentile) + ')', (b) => m(b.capital.required)],
    ['Chance of ruin', (b) => fmtPct(b.capital.ruin_prob_pct, 2)],
    ['1-in-100 net loss, % of capital', (b) => fmtPct(b.capital.loss_1in100_pct_of_capital, 0)],
    ['Combined ratio, median / 1-in-10', (b) => `${fmtPct(b.combined_ratio.p50, 0)} / ${fmtPct(b.combined_ratio.p90, 0)}`],
    ['Net income, expected / 1-in-100', (b) => `${m(b.net_income.mean)} / ${m(b.net_income.p1)}`],
    [regime ? regime.ratio.label : 'Solvency ratio', (b) => (regime && b.regime?.ratio_pct != null ? fmtPct(b.regime.ratio_pct, 0) : (b.capital.solvency_ratio_pct == null ? '—' : fmtPct(b.capital.solvency_ratio_pct, 0)))],
  ];
  const fmtVal = (t) => (t.value == null ? '—' : t.kind === 'standing' ? t.value : fmtPct(t.value, t.kind === 'pct2' ? 2 : 1));
  const fmtLimit = (t) => (t.kind === 'standing' ? 'holds' : `${t.op} ${fmtPct(t.limit, t.kind === 'pct2' ? 2 : 0)}`);
  return (
    <div className="dfa-op-overlay" role="dialog" aria-modal="true" aria-label="Renewal one-pager" data-testid="dfa-onepager">
      <div className="dfa-op-actions">
        <span className="muted small">One page for the renewal — print it, or save it as a PDF from the print dialog. Esc closes.</span>
        <span className="sechead-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => window.print()} data-testid="dfa-onepager-print">Print</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} data-testid="dfa-onepager-close">Close</button>
        </span>
      </div>
      <article className="dfa-onepager">
        <header className="dfa-op-head">
          <div>
            <div className="kicker accent">Reinsurance structure · renewal brief</div>
            <h2 className="dfa-op-title">{candidate.recommended && d.recommended_fits ? 'The recommended programme' : candidate.label}</h2>
            <div className="dfa-op-sub">{book} · as at {fmtDate(new Date().toISOString())} · draft for discussion</div>
          </div>
          <div className="dfa-op-badge">
            <span className={`dfa-pill ${candidate.appetite.pass ? 'ok' : 'fail'}`}>{candidate.appetite.pass ? 'Fits the appetite' : 'Outside the appetite'}</span>
          </div>
        </header>

        <p className="dfa-op-sentence">
          <b>{candidate.label}</b>: {m(candidate.reinsurance?.ceded_premium ?? 0)} a year to reinsurers for an expected cost of{' '}
          {m(costOf(candidate))}. It needs {m(candidate.capital.required)} of capital against {m(a.available_capital)} held,
          leaves a {fmtPct(candidate.capital.ruin_prob_pct, 2)} chance of ruin and a 1-in-100 net loss of{' '}
          {fmtPct(candidate.capital.loss_1in100_pct_of_capital, 0)} of capital.{' '}
          {d.fits > 0
            ? <>{d.fits} of {d.tested} programmes tested fit the appetite; {candidate.recommended ? 'this is the cheapest of them.' : `the cheapest is ${d.recommended}.`}</>
            : 'Nothing tested fits the appetite; this is the closest.'}
          {current && <> Against the current programme ({m(costOf(current))} expected cost, {fmtPct(current.capital.ruin_prob_pct, 2)} ruin), the cost moves by {m(costOf(candidate) - costOf(current))} a year.</>}
        </p>

        <div className="dfa-op-grid">
          <section>
            <h3 className="seclabel">The programme</h3>
            <Terms structure={candidate.structure} ccy={ccy} />
          </section>
          <section>
            <h3 className="seclabel">The figures — proposed beside current</h3>
            <table className="table dfa-op-figures">
              <thead><tr><th>Measure</th><th className="r">Proposed</th><th className="r">Current</th></tr></thead>
              <tbody>
                {figures.map(([label, get]) => (
                  <tr key={label}><td>{label}</td><td className="r num">{get(candidate)}</td><td className="r num muted">{current ? get(current) : '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>

        <div className="dfa-op-grid">
          <section>
            <h3 className="seclabel">The trade-off — cost against volatility, every programme tested</h3>
            <FrontierCostChart candidates={sweep.candidates} references={sweep.references} selected={candidate.label} ccy={ccy} compact />
            <p className="dfa-note">Filled points fit the appetite, hollow ones do not; the ringed point is the pick, the diamonds the gross book and the current programme.</p>
          </section>
          <section>
            <h3 className="seclabel">The appetite, line by line</h3>
            <table className="table dfa-op-figures">
              <thead><tr><th>Line</th><th className="r">Limit</th><th className="r">Proposed</th><th className="r">Current</th></tr></thead>
              <tbody>
                {candidate.appetite.tests.map((t, i) => {
                  const c = current?.appetite.tests[i];
                  return (
                    <tr key={t.key}>
                      <td>{t.label}</td>
                      <td className="r num">{fmtLimit(t)}</td>
                      <td className="r num">{fmtVal(t)} <span className={`dfa-pill ${t.ok ? 'ok' : 'fail'}`}>{t.ok ? 'pass' : 'fail'}</span></td>
                      <td className="r num muted">{c ? fmtVal(c) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <h3 className="seclabel dfa-op-gap">Stress-tested</h3>
            <table className="table dfa-op-figures">
              <thead><tr><th>Stress</th><th className="r">Expected result</th><th className="r">Chance of ruin</th><th>Standing</th></tr></thead>
              <tbody>
                <tr><td>Base case</td><td className="r num">{m(candidate.result.mean)}</td><td className="r num">{fmtPct(candidate.capital.ruin_prob_pct, 2)}</td><td><StandingPill standing={candidate.standing} /></td></tr>
                {d.stresses.map((s) => (
                  <tr key={s}>
                    <td>{s}</td>
                    <td className="r num">{candidate.stress[s] ? m(candidate.stress[s].result_mean) : '—'}</td>
                    <td className="r num">{candidate.stress[s] ? fmtPct(candidate.stress[s].ruin_prob_pct, 2) : '—'}</td>
                    <td>{candidate.stress[s] ? <StandingPill standing={candidate.stress[s].standing} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>

        <footer className="dfa-op-foot">
          <div>
            <b>The model.</b> Subject premium {m(num(cal.subject_premium))} at a {fmtPct(num(cal.expected_loss_ratio_pct), 0)} expected loss ratio;
            large losses {num(cal.large_frequency)} a year above {m(num(cal.large_loss_threshold))} averaging {m(num(cal.large_severity_mean))};
            cat events {num(cal.cat_frequency)} a year averaging {m(num(cal.cat_severity_mean))}
            {num(cal.opening_reserves) > 0 ? `; opening reserves ${m(num(cal.opening_reserves))}` : ''}.
            {' '}{fmtCompact(sweep.trials)} simulated treaty years, seed {sweep.seed}; capital at the 1-in-{returnPeriod(a.capital_percentile)} year;
            capital held {m(a.available_capital)} ({a.available_capital_source === 'given' ? 'as given' : 'assumed: the gross 1-in-N loss'});
            yield {fmtPct(a.investment_yield_pct, 1)} ± {fmtPct(a.asset_return_volatility_pct, 0)}{regime ? `; domicile ${regime.country} (${regime.regime})` : ''}.
          </div>
          <div>
            <b>Read it as.</b> Decision support at 100% of the programme: every programme is priced against the same simulated
            years, so a difference is the programme, never sampling noise. A cover without a quote is priced by the model
            (expected recovery plus a risk load, floored at a minimum rate on line) — the market’s price is the market’s.
            The loss model is an assumption, seeded from the book and stated above.
          </div>
        </footer>
      </article>
    </div>
  );
}
