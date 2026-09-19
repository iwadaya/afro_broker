import React from 'react';
import { fmtCompact, fmtMoney, fmtPct } from '../../components.jsx';
import { stageOf } from './stages.js';
import { fmtKind, Term, Section, Note, StaleBar, EmptyResults } from './bits.jsx';

/*
 * 06 Covers & panel — each cover on its own: what it costs, what it pays
 * back, how often it is touched, and the capital the programme would need
 * without it. Then the other side of the slip: what the reinsurers make at
 * 100%, and the signed panel's cut of it.
 */

function LayerTable({ label, hint, block, ccy, hurdle, testid }) {
  const rows = block.layers || [];
  const money = (v) => fmtKind(v, 'money', ccy);
  return (
    <Section title={label} hint={hint} testid={testid}>
      <div className="blueprint table-wrap">
        <table className="table dfa-layertable">
          <thead>
            <tr>
              <th>Cover</th>
              <th className="r">Premium</th>
              <th className="r"><Term k="expected_recoveries">Expected recovery</Term></th>
              <th className="r"><Term k="expected_cost">Expected cost</Term></th>
              <th className="r"><Term k="rol">Rate / loss on line</Term></th>
              <th className="r"><Term k="payback">Payback</Term></th>
              <th className="r"><Term k="prob_attach">Years it pays</Term></th>
              <th className="r"><Term k="marginal_relief">Capital it frees</Term></th>
              <th className="r"><Term k="implied_coc">Implied cost of capital</Term></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={`${l.kind}-${l.name}`}>
                <td>
                  <div className="dfa-cover-name">{l.name}</div>
                  <div className="muted small">
                    {l.kind === 'aggregate'
                      ? `${fmtPct(l.attachment_lr_pct, 0)} → ${fmtPct(l.exhaust_lr_pct, 0)} loss ratio`
                      : `${fmtCompact(l.limit)} xs ${fmtCompact(l.attachment)}${l.aggregate_deductible > 0 ? ` · deductible ${fmtCompact(l.aggregate_deductible)}` : ''}`}
                    {l.placed_pct < 100 ? ` · ${fmtPct(l.placed_pct, 0)} placed` : ''}
                    {l.priced === 'technical' ? <span className="dfa-tag" title="No premium was keyed, so the model priced the cover off its own simulated recoveries."> priced by the model</span> : null}
                  </div>
                </td>
                <td className="r num">
                  {money(l.premium)}
                  {l.priced !== 'technical' && l.technical_premium100 > 0 && (
                    <div className="muted small" title="What the model would charge at 100%, from the simulated recoveries">model {money(l.technical_premium100)}</div>
                  )}
                </td>
                <td className="r num">{money(l.expected_recovery)}{l.expected_rip > 0 ? <div className="muted small">reinst. {money(l.expected_rip)}</div> : null}</td>
                <td className={`r num ${l.expected_cost < 0 ? 'dfa-delta good' : ''}`}>{money(l.expected_cost)}</td>
                <td className="r num">{fmtPct(l.rol_pct, 1)} / {fmtPct(l.lol_pct, 1)}</td>
                <td className="r num">{l.payback_years == null ? '—' : `${fmtMoney(l.payback_years, 1)}y`}</td>
                <td className="r num">{fmtPct(l.prob_attach_pct, 1)}<div className="muted small">exhausts {fmtPct(l.prob_exhaust_pct, 1)}</div></td>
                <td className="r num">{money(l.marginal_capital_relief)}</td>
                <td className="r num">
                  {l.implied_coc_pct == null ? <span className="muted">—</span>
                    : <span className={l.implied_coc_pct <= hurdle ? 'dfa-delta good' : 'dfa-delta bad'}>{fmtPct(l.implied_coc_pct, 1)}</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan="9" className="muted">No excess-of-loss or stop-loss covers in this programme.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Note>
        A cover earns its keep when its implied cost of capital sits below the {fmtPct(hurdle, 0)} hurdle:
        the capital it frees would cost more to hold than the cover costs to buy. A negative expected
        cost means the cover is expected to pay back more than it costs.
      </Note>
    </Section>
  );
}

const RI_ROWS = [
  { label: 'Premium taken (incl. reinstatements)', get: (r) => r.premium, kind: 'money' },
  { label: 'Expected claims paid', get: (r) => r.expected_loss, kind: 'money' },
  { label: 'Expected reinstatement premium', get: (r) => r.expected_rip, kind: 'money' },
  { label: 'Commission paid', get: (r) => r.commission_paid, kind: 'money' },
  { label: 'Loss ratio', get: (r) => r.loss_ratio_pct, kind: 'pct' },
  { label: 'Expected result', get: (r) => r.result.mean, kind: 'money' },
  { label: 'Margin on premium', get: (r) => r.margin_pct, kind: 'pct' },
  { label: 'Chance of a losing year', get: (r) => r.prob_loss_pct, kind: 'pct' },
  { label: 'Capital at the percentile', get: (r) => r.capital.required, kind: 'money' },
  { label: 'Return on that capital', get: (r) => r.capital.roe_pct, kind: 'pct' },
];

function ReinsurerBlock({ results, panel, ccy }) {
  const cur = results.structures.current.reinsurer;
  const prop = results.structures.proposed.reinsurer;
  if (!cur && !prop) return null;
  return (
    <div className="dfa-grid">
      <Section title="What the reinsurers make" hint="at 100% of the programme — the other side of the slip" testid="dfa-reinsurer">
        <div className="blueprint table-wrap">
          <table className="table dfa-compare">
            <thead>
              <tr>
                <th>Measure</th>
                <th className="r">Current</th>
                <th className="r">Proposed</th>
              </tr>
            </thead>
            <tbody>
              {RI_ROWS.map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td className="r num">{cur ? fmtKind(row.get(cur), row.kind, ccy) : '—'}</td>
                  <td className="r num">{prop ? fmtKind(row.get(prop), row.kind, ccy) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Note>A programme the market will not write at this price shows here first: a thin margin or a high chance of a losing year.</Note>
      </Section>

      <Section title="The signed panel’s share" hint="proposed programme, cut by each market’s signed premium" testid="dfa-panel">
        <div className="blueprint table-wrap">
          <table className="table dfa-compare">
            <thead>
              <tr>
                <th>Market</th>
                <th>Rating</th>
                <th className="r">Share</th>
                <th className="r">Premium</th>
                <th className="r">Expected result</th>
              </tr>
            </thead>
            <tbody>
              {panel.map((m) => (
                <tr key={m.market_id}>
                  <td>{m.name}</td>
                  <td>
                    {m.rating || <span className="muted">unrated</span>}
                    <span className="muted small" title="One-year default probability implied by the rating"> · PD {fmtPct(m.default_pd_pct, 2)}</span>
                  </td>
                  <td className="r num">{fmtPct(m.share_pct, 1)}</td>
                  <td className="r num">{prop ? fmtKind(prop.premium * (m.share_pct / 100), 'money', ccy) : '—'}</td>
                  <td className="r num">{prop ? fmtKind(prop.result.mean * (m.share_pct / 100), 'money', ccy) : '—'}</td>
                </tr>
              ))}
              {panel.length === 0 && (
                <tr>
                  <td colSpan="5" className="muted">
                    No signed lines on the selection yet — the panel’s cut appears once lines are signed.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Note>The panel’s ratings seed the default probability on 03 Assumptions.</Note>
      </Section>
    </div>
  );
}

export default function CoversTab({ shared }) {
  const { results, stale, ccy, portfolio } = shared;
  if (!results) return <EmptyResults shared={shared} stage={stageOf('covers')} what="the cover-by-cover figures" />;
  const hurdle = results.assumptions.cost_of_capital_pct;
  return (
    <>
      <StaleBar shared={shared} />
      <div className={stale ? 'dfa-stale dfa-stack' : 'dfa-stack'}>
        <LayerTable label="Proposed programme, cover by cover" hint="which cover earns its keep" block={results.structures.proposed} ccy={ccy} hurdle={hurdle} testid="dfa-covers-proposed" />
        <LayerTable label="Current programme, cover by cover" hint="the baseline" block={results.structures.current} ccy={ccy} hurdle={hurdle} testid="dfa-covers-current" />
        <ReinsurerBlock results={results} panel={portfolio?.panel || []} ccy={ccy} />
      </div>
    </>
  );
}
