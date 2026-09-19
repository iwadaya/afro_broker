import React from 'react';
import { fmtPct } from '../../components.jsx';
import { stageOf } from './stages.js';
import { EpPanel, FrontierPanel } from './charts.jsx';
import { fmtKind, Delta, Term, Section, Note, StaleBar, EmptyResults } from './bits.jsx';

/*
 * 04 Impact — what the change in the programme does: the losses gross and
 * net by return period, the insurer's own figures side by side, what the
 * cover costs against what it buys, and where every programme sits on the
 * risk/return frontier. Every table carries the change, coloured by whether
 * the move is the one a buyer wants.
 */

const IMPACT_ROWS = [
  { label: 'Net premium kept', get: (b) => b.net_premium_mean, kind: 'money', goodWhen: null },
  { label: 'Expected net loss', get: (b) => b.loss.mean, kind: 'money', goodWhen: 'down' },
  { label: 'Net loss ratio', get: (b) => b.loss_ratio.mean, kind: 'pct', goodWhen: 'down' },
  { label: 'Combined ratio', term: 'combined_ratio', get: (b) => b.combined_ratio_pct, kind: 'pct', goodWhen: 'down' },
  { label: 'Expected result', term: 'expected_result', get: (b) => b.result.mean, kind: 'money', goodWhen: 'up' },
  { label: 'How much the result swings', term: 'volatility', get: (b) => b.result.sd, kind: 'money', goodWhen: 'down' },
  { label: 'Chance of an underwriting loss', get: (b) => b.prob_uw_loss_pct, kind: 'pct', goodWhen: 'down' },
  { label: 'Earnings at risk (1-in-10 year)', term: 'earnings_at_risk', get: (b) => b.capital.earnings_at_risk, kind: 'money', goodWhen: 'down' },
  { label: 'Loss at the capital percentile (VaR)', term: 'required_capital', get: (b) => b.capital.var, kind: 'money', goodWhen: 'down' },
  { label: 'Average loss beyond it (TVaR)', term: 'tvar', get: (b) => b.capital.tvar, kind: 'money', goodWhen: 'down' },
  { label: 'Capital needed', term: 'required_capital', get: (b) => b.capital.required, kind: 'money', goodWhen: 'down' },
  { label: 'Capital freed vs gross', term: 'capital_relief', get: (b) => b.capital.relief, kind: 'money', goodWhen: 'up' },
  { label: 'Solvency ratio', term: 'solvency', get: (b) => b.capital.solvency_ratio_pct, kind: 'pct', goodWhen: 'up' },
  { label: 'Chance of ruin', term: 'ruin', get: (b) => b.capital.ruin_prob_pct, kind: 'pct2', goodWhen: 'down' },
  { label: 'Expected policyholder deficit', term: 'epd', get: (b) => b.capital.epd_pct, kind: 'pct2', goodWhen: 'down' },
  { label: 'Return on the capital needed', term: 'roe', get: (b) => b.capital.roe_pct, kind: 'pct', goodWhen: 'up' },
  { label: 'Economic value added', term: 'eva', get: (b) => b.capital.eva, kind: 'money', goodWhen: 'up' },
];

const ECON_ROWS = [
  { label: 'Premium paid to reinsurers', term: 'ceded_premium', get: (r) => r.ceded_premium, kind: 'money', goodWhen: null },
  { label: 'Expected recoveries', term: 'expected_recoveries', get: (r) => r.expected_recoveries, kind: 'money', goodWhen: 'up' },
  { label: 'Commission received', get: (r) => r.expected_commission, kind: 'money', goodWhen: 'up' },
  { label: 'Expected cost of the cover', term: 'expected_cost', get: (r) => r.expected_cost, kind: 'money', goodWhen: 'down' },
  { label: 'Cost as a share of premium paid', get: (r) => r.cost_pct_of_ceded_premium, kind: 'pct', goodWhen: 'down' },
  { label: 'Expected loss to a reinsurer default', get: (r) => r.expected_credit_loss, kind: 'money', goodWhen: 'down' },
  { label: 'Capital freed', term: 'capital_relief', get: (r) => r.capital_relief, kind: 'money', goodWhen: 'up' },
  { label: 'Cost of that capital, saved', term: 'coc_saved', get: (r) => r.coc_saved, kind: 'money', goodWhen: 'up' },
  { label: 'Value added (saving less cost)', term: 'value_added', get: (r) => r.value_added, kind: 'money', goodWhen: 'up' },
  { label: 'Implied cost of the capital freed', term: 'implied_coc', get: (r) => r.implied_coc_pct, kind: 'pct', goodWhen: 'down' },
  { label: 'Expected reinsurer deficit (ERD)', term: 'erd', get: (r) => r.erd_pct, kind: 'pct', goodWhen: null },
  { label: 'Years the reinsurer loses 10%+', term: 'ten_ten', get: (r) => r.ten_ten_pct, kind: 'pct', goodWhen: null },
];

function pill(ok, yes, no) {
  return <span className={`dfa-pill ${ok ? 'ok' : 'fail'}`}>{ok ? yes : no}</span>;
}

function efficientCell(r) {
  if (!r) return <span className="muted">no reinsurance</span>;
  if (r.capital_relief < 0) return <span className="dfa-pill fail">frees no capital</span>;
  if (r.efficient == null) return <span className="muted">relief too small to price</span>;
  return pill(r.efficient, 'yes — cheaper than capital', 'no — dearer than capital');
}

function transferCell(r) {
  if (!r || r.risk_transfer_ok == null) return <span className="muted">—</span>;
  return pill(r.risk_transfer_ok, 'passes', 'fails');
}

function ImpactTable({ results, ccy }) {
  const cur = results.structures.current;
  const prop = results.structures.proposed;
  return (
    <Section title="The insurer’s figures" hint="net of each programme, same simulated years" testid="dfa-impact-table">
      <div className="blueprint table-wrap">
        <table className="table dfa-compare">
          <thead>
            <tr>
              <th>Measure</th>
              <th className="r">Gross</th>
              <th className="r">Current</th>
              <th className="r">Proposed</th>
              <th className="r">Change</th>
            </tr>
          </thead>
          <tbody>
            {IMPACT_ROWS.map((row) => (
              <tr key={row.label}>
                <td><Term k={row.term}>{row.label}</Term></td>
                <td className="r num">{fmtKind(row.get(results.gross), row.kind, ccy)}</td>
                <td className="r num">{fmtKind(row.get(cur), row.kind, ccy)}</td>
                <td className="r num">{fmtKind(row.get(prop), row.kind, ccy)}</td>
                <td className="r num"><Delta cur={row.get(cur)} prop={row.get(prop)} kind={row.kind} ccy={ccy} goodWhen={row.goodWhen} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note>Green is a move the buyer wants, red one it does not. Hover a measure for what it means.</Note>
    </Section>
  );
}

function EconomicsTable({ results, ccy }) {
  const cur = results.structures.current.reinsurance;
  const prop = results.structures.proposed.reinsurance;
  return (
    <Section title="What the cover costs, and what it buys" hint={`hurdle ${fmtPct(results.assumptions.cost_of_capital_pct, 0)} cost of capital`} testid="dfa-economics">
      <div className="blueprint table-wrap">
        <table className="table dfa-compare">
          <thead>
            <tr>
              <th>Measure</th>
              <th className="r">Current</th>
              <th className="r">Proposed</th>
              <th className="r">Change</th>
            </tr>
          </thead>
          <tbody>
            {ECON_ROWS.map((row) => {
              const c = cur ? row.get(cur) : null;
              const p = prop ? row.get(prop) : null;
              return (
                <tr key={row.label}>
                  <td><Term k={row.term}>{row.label}</Term></td>
                  <td className="r num">{fmtKind(c, row.kind, ccy)}</td>
                  <td className="r num">{fmtKind(p, row.kind, ccy)}</td>
                  <td className="r num"><Delta cur={c} prop={p} kind={row.kind} ccy={ccy} goodWhen={row.goodWhen} /></td>
                </tr>
              );
            })}
            <tr>
              <td>Worth buying at the hurdle?</td>
              <td className="r">{efficientCell(cur)}</td>
              <td className="r">{efficientCell(prop)}</td>
              <td />
            </tr>
            <tr>
              <td>Real risk transfer (ERD ≥ 1%)?</td>
              <td className="r">{transferCell(cur)}</td>
              <td className="r">{transferCell(prop)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <Note>
        Reinsurance is worth buying when the capital it frees would cost more to hold than the
        cover costs to buy. The implied rate is that cost per unit of capital, a year.
      </Note>
    </Section>
  );
}

const PCT_ROWS = [
  ['p50', 'Median year (1-in-2)'], ['p75', '1-in-4'], ['p90', '1-in-10'],
  ['p95', '1-in-20'], ['p99', '1-in-100'], ['p99_5', '1-in-200'],
];

function PercentileTable({ results, ccy }) {
  const cur = results.structures.current;
  const prop = results.structures.proposed;
  return (
    <Section title="The year’s losses, by how rare the year is" hint="the chart as numbers" testid="dfa-percentiles">
      <div className="blueprint table-wrap">
        <table className="table dfa-compare">
          <thead>
            <tr>
              <th>Year</th>
              <th className="r">Gross</th>
              <th className="r">Net — current</th>
              <th className="r">Net — proposed</th>
              <th className="r">Change</th>
            </tr>
          </thead>
          <tbody>
            {PCT_ROWS.map(([key, label]) => (
              <tr key={key}>
                <td>{label}</td>
                <td className="r num">{fmtKind(results.gross.loss[key], 'money', ccy)}</td>
                <td className="r num">{fmtKind(cur.loss[key], 'money', ccy)}</td>
                <td className="r num">{fmtKind(prop.loss[key], 'money', ccy)}</td>
                <td className="r num"><Delta cur={cur.loss[key]} prop={prop.loss[key]} kind="money" ccy={ccy} goodWhen="down" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note>Net of reinsurance, including any loss to a reinsurer default.</Note>
    </Section>
  );
}

export default function ImpactTab({ shared }) {
  const { results, stale, ccy, lastRun } = shared;
  if (!results) return <EmptyResults shared={shared} stage={stageOf('impact')} what="the losses, the figures and the frontier" />;
  const cur = results.structures.current;
  const prop = results.structures.proposed;
  return (
    <>
      <StaleBar shared={shared} />
      <div className={stale ? 'dfa-stale dfa-stack' : 'dfa-stack'}>
        <div className="dfa-grid">
          <EpPanel label="Current programme — the year’s losses" block={cur} other={prop} ccy={ccy} />
          <EpPanel label="Proposed programme — the year’s losses" block={prop} other={cur} ccy={ccy} />
        </div>
        <div className="dfa-grid">
          <ImpactTable results={results} ccy={ccy} />
          <div className="dfa-stack">
            <EconomicsTable results={results} ccy={ccy} />
            <PercentileTable results={results} ccy={ccy} />
          </div>
        </div>
        <div className="dfa-grid">
          <FrontierPanel results={results} ccy={ccy} scanned={lastRun?.scan && lastRun.scan !== 'none'} />
        </div>
      </div>
    </>
  );
}
