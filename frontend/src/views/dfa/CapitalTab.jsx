import React from 'react';
import { fmtCompact, fmtPct } from '../../components.jsx';
import { returnPeriod } from './model.js';
import { stageOf } from './stages.js';
import { SurplusPanel } from './charts.jsx';
import { fmtKind, Term, Section, Note, StaleBar, EmptyResults } from './bits.jsx';
import { FamilyBadge, Ladder } from './RegimeCard.jsx';
import { StandingPill } from './ScenariosTab.jsx';

/*
 * 05 Capital — every programme against the capital the insurer holds: what
 * each needs, how much of the capital a bad year eats, whether the
 * retention sits inside the rule of thumb, where it stands on the
 * domicile's regulatory ladder (the strain the year can take before the
 * first action level, and the chance of getting there), the leverage
 * monitors and the reserve run-off, and over a horizon the surplus path
 * with the chance of ruin or a breach in any year.
 */

const ROWS = (results) => [
  ['Gross', results.gross],
  ['Current', results.structures.current],
  ['Proposed', results.structures.proposed],
];

const pillTone = (band) => (band.tone === 'good' ? 'ok' : band.tone === 'warn' ? 'warn' : 'fail');

/** The capital held against the domicile's ladder — or the way to choose a domicile. */
function RegimeSection({ results, ccy, setTab }) {
  const regime = results.regime;
  if (!regime) {
    return (
      <Section title="Regulatory capital" hint="no domicile chosen" testid="dfa-regime-nudge">
        <div className="blueprint dfa-panel">
          <p className="dfa-lede">
            Pick the insurer’s country of domicile on 03 Assumptions and this stage reads the capital
            against its regulator’s ladder — Solvency II, risk-based capital, a solvency margin or a
            minimum capital — with the strain the year can take before the first action level and the
            chance of reaching it.
          </p>
          <div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTab('assumptions')}>Open the assumptions</button>
          </div>
        </div>
      </Section>
    );
  }
  const rows = ROWS(results);
  const needsInput = rows.some(([, b]) => !b.regime || b.regime.needs_input);
  const money = (v) => fmtKind(v, 'money', ccy);
  const marks = needsInput ? [] : rows.map(([label, b]) => ({ label, ratio_pct: b.regime.ratio_pct }));
  const prop = results.structures.proposed.regime;
  const measure = regime.proxy?.measure === 'tvar' ? 'tail value at risk' : 'value at risk';
  return (
    <Section title={`Regulatory capital — ${regime.regime}`} hint={`${regime.country} · ${regime.regulator}`} testid="dfa-regime">
      <div className="blueprint dfa-panel">
        <div className="dfa-regime-head">
          <FamilyBadge family={regime.family} label={regime.family_label} />
          <span className="muted small">{regime.ratio.label}: {regime.ratio.numerator} over {regime.ratio.denominator}</span>
        </div>
        {needsInput ? (
          <div className="dfa-warn" data-testid="dfa-regime-needs-input">
            {regime.regime} sets a fixed requirement that nothing modelled can stand in for. Type it on
            03 Assumptions (“Regulatory requirement, if known”) in {ccy || 'the book’s currency'} to read the ladder.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table dfa-compare dfa-regime-table">
              <thead>
                <tr>
                  <th>Programme</th>
                  <th className="r"><Term k="regime_required">{regime.ratio.denominator}</Term></th>
                  <th className="r"><Term k="regime_ratio">{regime.ratio.label}</Term></th>
                  <th>Level</th>
                  <th className="r"><Term k="strain">Strain before action</Term></th>
                  <th className="r"><Term k="prob_breach">Chance of a breach</Term></th>
                  <th className="r"><Term k="ratio_end">Year end · expected / 1-in-10 / 1-in-100</Term></th>
                  <th><Term k="standing">Standing</Term></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([label, b]) => {
                  const r = b.regime;
                  return (
                    <tr key={label}>
                      <td>{label}</td>
                      <td className="r num">
                        {money(r.required)}
                        <div className="dfa-book-sub">{r.required_source === 'given' ? 'typed on 03' : 'modelled proxy'}</div>
                      </td>
                      <td className="r num">{fmtPct(r.ratio_pct, 0)}</td>
                      <td><span className={`dfa-pill ${pillTone(r.band)}`}>{r.band.level}</span></td>
                      <td className="r num">{r.strain_before_action >= 0 ? money(r.strain_before_action) : <span className="dfa-warn-inline">already below</span>}</td>
                      <td className="r num">{fmtPct(r.prob_breach_pct, 1)}</td>
                      <td className="r num">{fmtPct(r.ratio_end_mean_pct, 0)} / {fmtPct(r.ratio_end_p10_pct, 0)} / {fmtPct(r.ratio_end_p1_pct, 0)}</td>
                      <td><StandingPill standing={b.standing} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-wrap dfa-ladder-wrap">
          <Ladder regime={regime} marks={marks} compact />
        </div>
        <Note>
          {!needsInput && prop.required_source === 'modelled' && regime.proxy && (
            <>
              The requirement is the modelled {measure} at {fmtPct(regime.proxy.confidence, 1)}, read as the
              capital that puts the ratio at {fmtPct(regime.proxy.at_pct, 0)} — a proxy for the regulator’s own
              figure; type that on 03 for a true reading.{' '}
            </>
          )}
          The strain is the loss the year could carry before the ratio reaches the first action level
          ({fmtPct(regime.ladder[0].min_pct, 0)}) — the Handbook’s “maximum withstandable strain”; the chance
          of a breach is the share of simulated years that take it there. Reference summary as at {regime.as_at}.
        </Note>
      </div>
    </Section>
  );
}

/** Leverage against the capital held, and what the prior-year reserve does to the year. */
function MonitorsSection({ results, ccy }) {
  const rows = ROWS(results);
  const money = (v) => fmtKind(v, 'money', ccy);
  const res = results.structures.proposed.reserves;
  const cell = (b, key, limit) => {
    const v = b.leverage?.[key];
    return <td className={`r num${limit != null && v > limit ? ' dfa-iris-flag' : ''}`}>{fmtPct(v, 0)}</td>;
  };
  const lines = [
    ['Net premium to capital', 'net_premium_to_capital_pct', 300, 'IRIS: ≤ 300%'],
    ['Gross premium to capital', 'gross_premium_to_capital_pct', 900, 'IRIS: ≤ 900%'],
    ['Reserves to capital', 'reserves_to_capital_pct', null, '—'],
    ['Net leverage (premium + reserves)', 'net_leverage_pct', null, '—'],
  ];
  return (
    <Section title="Regulatory monitors" hint="leverage, and the reserve run-off" testid="dfa-monitors">
      <div className="blueprint dfa-panel">
        <div className="table-wrap">
          <table className="table dfa-compare">
            <thead>
              <tr>
                <th><Term k="leverage">Leverage</Term></th>
                <th className="r">Gross</th>
                <th className="r">Current</th>
                <th className="r">Proposed</th>
                <th className="r">Watch</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(([label, key, limit, watch]) => (
                <tr key={key}>
                  <td>{label}</td>
                  {rows.map(([l, b]) => <React.Fragment key={l}>{cell(b, key, limit)}</React.Fragment>)}
                  <td className="r muted small">{watch}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {res ? (
          <dl className="dfa-deflist">
            <div>
              <dt><Term k="reserve_development">Prior-year reserve run-off</Term></dt>
              <dd>
                {money(res.opening)} opening · expected {money(res.expected_development)} · 1-in-10 {money(res.development_p90)}
                {' '}· 1-in-200 {money(res.development_p99_5)}
                {res.development_1in100_pct_of_capital != null && <span className="muted"> · a 1-in-100 development is {fmtPct(res.development_1in100_pct_of_capital, 0)} of the capital held</span>}
              </dd>
            </div>
          </dl>
        ) : (
          <Note>
            No opening reserve on 01 Scope, so the year carries no prior-year run-off. Type one to add
            reserve risk — the Handbook’s largest balance-sheet item — to every programme’s capital.
          </Note>
        )}
      </div>
    </Section>
  );
}

function CapitalBars({ results, ccy }) {
  const rows = [
    { label: 'Gross', v: results.gross.capital.required },
    { label: 'Current', v: results.structures.current.capital.required },
    { label: 'Proposed', v: results.structures.proposed.capital.required },
  ];
  const available = results.assumptions.available_capital;
  const max = Math.max(...rows.map((r) => r.v), available, 1);
  return (
    <Section title="Capital needed" hint={`the underwriting loss in a 1-in-${returnPeriod(results.assumptions.capital_percentile)} year`} testid="dfa-capital-bars">
      <div className="blueprint dfa-panel">
        {rows.map((r) => (
          <div key={r.label} className="dfa-capbar">
            <span className="dfa-capbar-label">{r.label}</span>
            <span className="dfa-capbar-track">
              <span className="dfa-capbar-fill" style={{ width: `${(r.v / max) * 100}%` }} />
              <span className="dfa-capbar-mark" style={{ left: `${(available / max) * 100}%` }} title={`Available capital ${fmtKind(available, 'money', ccy)}`} />
            </span>
            <span className="dfa-capbar-value">{fmtKind(r.v, 'money', ccy)}</span>
          </div>
        ))}
        <Note>
          The line is the {fmtKind(available, 'money', ccy)} of capital the insurer holds
          {results.assumptions.available_capital_source === 'given' ? '' : ' (assumed: what the gross book needs)'}.
          A bar past it means the programme needs more capital than there is.
        </Note>
      </div>
    </Section>
  );
}

function RetentionTable({ results, ccy }) {
  const rows = [
    { label: 'Gross', b: results.gross },
    { label: 'Current', b: results.structures.current },
    { label: 'Proposed', b: results.structures.proposed },
  ];
  return (
    <Section title="A bad year against the capital held" hint={`available capital ${fmtKind(results.assumptions.available_capital, 'money', ccy)}`} testid="dfa-retention">
      <div className="blueprint table-wrap">
        <table className="table dfa-compare">
          <thead>
            <tr>
              <th>Programme</th>
              <th className="r"><Term k="earnings_at_risk">1-in-10 loss</Term></th>
              <th className="r">1-in-100 loss</th>
              <th className="r">as % of capital</th>
              <th className="r"><Term k="solvency">Solvency ratio</Term></th>
              <th className="r"><Term k="ruin">Chance of ruin</Term></th>
              <th className="r"><Term k="epd">EPD</Term></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td className="r num">{fmtKind(r.b.capital.earnings_at_risk, 'money', ccy)}</td>
                <td className="r num">{fmtKind(r.b.capital.loss_1in100, 'money', ccy)}</td>
                <td className="r num">{fmtKind(r.b.capital.loss_1in100_pct_of_capital, 'pct', ccy)}</td>
                <td className="r num">{r.b.capital.solvency_ratio_pct == null ? '—' : fmtPct(r.b.capital.solvency_ratio_pct, 0)}</td>
                <td className="r num">{fmtKind(r.b.capital.ruin_prob_pct, 'pct2', ccy)}</td>
                <td className="r num">{fmtKind(r.b.capital.epd_pct, 'pct2', ccy)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note>
        A retention rule of thumb: the 1-in-100 net loss should sit inside a set share of
        capital. Ruin is a year whose loss exceeds the capital; EPD is the average shortfall
        beyond it, as a share of premium. In the years there is an underwriting loss it
        averages {rows.map((r) => `${r.label.toLowerCase()} ${fmtKind(r.b.capital.consumption_mean, 'money', ccy)}`).join(', ')}.
      </Note>
    </Section>
  );
}

function HorizonTable({ results, ccy }) {
  const cur = results.structures.current.horizon;
  const prop = results.structures.proposed.horizon;
  const money = (v) => fmtKind(v, 'money', ccy);
  const both = (p, c) => <>{p} <span className="muted small">/ {c}</span></>;
  return (
    <Section
      title="Surplus by year — proposed, with current in grey"
      hint={`growth ${fmtPct(results.assumptions.premium_growth_pct, 0)} · trend ${fmtPct(results.assumptions.loss_trend_pct, 0)} · yield ${fmtPct(results.assumptions.investment_yield_pct, 1)}`}
      testid="dfa-horizon-table"
    >
      <div className="blueprint table-wrap">
        <table className="table dfa-compare">
          <thead>
            <tr>
              <th>Year</th>
              <th className="r">Premium</th>
              <th className="r">Expected result</th>
              <th className="r">Expected surplus</th>
              <th className="r">1-in-100 surplus</th>
              <th className="r">Chance below the capital needed</th>
              <th className="r">Chance of ruin</th>
            </tr>
          </thead>
          <tbody>
            {prop.by_year.map((y, i) => (
              <tr key={y.year}>
                <td>{y.year}</td>
                <td className="r num">{money(y.subject_premium)}</td>
                <td className="r num">{money(y.uw_result_mean)}</td>
                <td className="r num">{both(money(y.surplus_mean), money(cur.by_year[i].surplus_mean))}</td>
                <td className="r num">{both(money(y.surplus_p1), money(cur.by_year[i].surplus_p1))}</td>
                <td className="r num">{both(fmtPct(y.prob_below_required_pct, 1), fmtPct(cur.by_year[i].prob_below_required_pct, 1))}</td>
                <td className="r num">{both(fmtPct(y.prob_negative_pct, 2), fmtPct(cur.by_year[i].prob_negative_pct, 2))}</td>
              </tr>
            ))}
            <tr>
              <td><b>Over {prop.years} years</b></td>
              <td className="r" colSpan="2">cumulative result {money(prop.cumulative_result.mean)}</td>
              <td className="r" colSpan="2">worst year-end surplus, 1-in-100 {both(money(prop.min_surplus_p1), money(cur.min_surplus_p1))}</td>
              <td className="r">breach in any year {both(fmtPct(prop.prob_capital_breach_pct, 1), fmtPct(cur.prob_capital_breach_pct, 1))}</td>
              <td className="r">ruin in any year {both(fmtPct(prop.prob_ruin_pct, 2), fmtPct(cur.prob_ruin_pct, 2))}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Note>
        Grey figures are the current programme. A breach is a year-end surplus below the
        programme’s own capital needed; ruin is a negative surplus.
      </Note>
    </Section>
  );
}

function HorizonNudge({ shared }) {
  return (
    <Section title="Over several years" hint="one year is shown">
      <div className="blueprint dfa-panel">
        <p className="dfa-lede">
          Set a horizon above one year on 03 Assumptions and this stage adds the surplus path —
          expected and 1-in-100 — with the chance of ruin or a capital breach in any year while the
          book grows and losses trend.
        </p>
        <div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => shared.setTab('assumptions')}>Open the assumptions</button>
        </div>
      </div>
    </Section>
  );
}

export default function CapitalTab({ shared }) {
  const { results, stale, ccy, setTab } = shared;
  if (!results) return <EmptyResults shared={shared} stage={stageOf('capital')} what="the capital figures" />;
  const years = results.assumptions.horizon_years;
  return (
    <>
      <StaleBar shared={shared} />
      <div className={stale ? 'dfa-stale dfa-stack' : 'dfa-stack'}>
        <div className="dfa-grid dfa-grid-capital">
          <CapitalBars results={results} ccy={ccy} />
          <RetentionTable results={results} ccy={ccy} />
        </div>
        <div className="dfa-grid dfa-grid-regime">
          <RegimeSection results={results} ccy={ccy} setTab={setTab} />
          <MonitorsSection results={results} ccy={ccy} />
        </div>
        {years > 1 ? (
          <>
            <div className="dfa-grid">
              <SurplusPanel results={results} />
              <Section title="Reading the surplus path" hint={`${years} years`}>
                <div className="blueprint dfa-panel">
                  <p className="dfa-lede">
                    The surplus starts at the capital held and rolls forward each year with that
                    year’s underwriting result and investment income on the opening surplus and half
                    the premium. Later years grow the book by {fmtPct(results.assumptions.premium_growth_pct, 0)} and
                    trend losses by {fmtPct(results.assumptions.loss_trend_pct, 0)} a year while the programme stays
                    fixed in nominal terms — so a programme that looks generous today can run thin by year {years}.
                  </p>
                  <Note>Expected surplus at year {years}: proposed {fmtCompact(results.structures.proposed.horizon.surplus_end.mean)} · current {fmtCompact(results.structures.current.horizon.surplus_end.mean)} · gross {fmtCompact(results.gross.horizon.surplus_end.mean)}.</Note>
                </div>
              </Section>
            </div>
            <HorizonTable results={results} ccy={ccy} />
          </>
        ) : (
          <div className="dfa-grid">
            <HorizonNudge shared={shared} />
          </div>
        )}
      </div>
    </>
  );
}
