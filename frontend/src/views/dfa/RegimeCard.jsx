import React from 'react';
import { fmtPct } from '../../components.jsx';
import { Note } from './bits.jsx';

/*
 * The capital regime of the insurer's domicile, as a card: which family it
 * is (Solvency II, risk-based capital, a solvency margin, a minimum
 * capital), who regulates, what the requirement is, the ratio the regulator
 * reads, and the ladder of action levels — with the insurer's own rung
 * marked once a run has read it.
 */

export const FAMILY_SHORT = {
  solvency_ii: 'Solvency II',
  rbc: 'RBC',
  solvency_margin: 'Solvency margin',
  minimum_capital: 'Minimum capital',
};

export function FamilyBadge({ family, label }) {
  return <span className={`dfa-badge fam-${family}`}>{label || FAMILY_SHORT[family] || family}</span>;
}

/** The band a ratio falls in on a ladder (top-down; the last catches everything). */
export const bandFor = (ladder, ratioPct) => (ratioPct == null
  ? null
  : (ladder.find((b) => ratioPct >= b.min_pct) || ladder[ladder.length - 1]));

/** The ladder as a table; `marks` are { label, ratio_pct } rungs to mark. */
export function Ladder({ regime, marks = [], compact = false }) {
  const rows = regime.ladder;
  return (
    <table className={`table dfa-ladder${compact ? ' is-compact' : ''}`} data-testid="dfa-ladder">
      <thead>
        <tr>
          <th>{regime.ratio.label}</th>
          <th>Level</th>
          {!compact && <th>What happens there</th>}
          {marks.length > 0 && <th>Who sits here</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((b, i) => {
          const upper = i === 0 ? null : rows[i - 1].min_pct;
          const range = i === 0
            ? `≥ ${fmtPct(b.min_pct, 0)}`
            : (b.min_pct === 0 ? `< ${fmtPct(upper, 0)}` : `${fmtPct(b.min_pct, 0)} – ${fmtPct(upper, 0)}`);
          const here = marks.filter((m) => m.ratio_pct != null && bandFor(rows, m.ratio_pct)?.min_pct === b.min_pct);
          return (
            <tr key={b.min_pct} className={`tone-${b.tone}${here.length ? ' is-here' : ''}`}>
              <td className="num">{range}</td>
              <td>{b.level}</td>
              {!compact && <td className="dfa-ladder-action">{b.action}</td>}
              {marks.length > 0 && (
                <td className="dfa-ladder-marks">
                  {here.map((m) => <span key={m.label} className={`dfa-mark is-${m.label.toLowerCase()}`}>{m.label} {fmtPct(m.ratio_pct, 0)}</span>)}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function calibrationWords(cal) {
  if (!cal) return null;
  const measure = cal.measure === 'tvar' ? 'tail value at risk' : 'value at risk';
  return `calibrated to the ${fmtPct(cal.confidence, 1)} ${measure} over ${cal.horizon_years === 1 ? 'one year' : `${cal.horizon_years} years`}`;
}

export default function RegimeCard({ regime, marks = [], hint }) {
  if (!regime) return null;
  const words = calibrationWords(regime.calibration);
  return (
    <div className="dfa-regime" data-testid="dfa-regime-card">
      <div className="dfa-regime-head">
        <FamilyBadge family={regime.family} label={regime.family_label} />
        <span className="dfa-regime-title">{regime.regime}</span>
        <span className="muted small">· {regime.country}</span>
      </div>
      <dl className="dfa-deflist">
        <div><dt>Regulator</dt><dd>{regime.regulator}</dd></div>
        <div><dt>Capital requirement</dt><dd>{regime.requirement}</dd></div>
        <div>
          <dt>How it is measured</dt>
          <dd>{regime.style_label}{words ? ` · ${words}` : ''}</dd>
        </div>
        <div><dt>The ratio the regulator reads</dt><dd>{regime.ratio.label}: {regime.ratio.numerator} over {regime.ratio.denominator}</dd></div>
        {regime.minimum && <div><dt>Minimum</dt><dd>{regime.minimum}</dd></div>}
        {regime.transition && <div><dt>In transition</dt><dd>{regime.transition}</dd></div>}
      </dl>
      <div className="table-wrap dfa-ladder-wrap">
        <Ladder regime={regime} marks={marks} />
      </div>
      <Note>
        {hint || (regime.proxy
          ? `Unless the regulatory figure is typed, the modelled ${regime.proxy.measure === 'tvar' ? 'tail value at risk' : 'value at risk'} at ${fmtPct(regime.proxy.confidence, 1)} stands in for the requirement: it is read as the capital that puts the ratio at ${fmtPct(regime.proxy.at_pct, 0)}.`
          : 'A fixed minimum: type the requirement in the book’s currency to read the ladder — nothing modelled can stand in for it.')}
        {' '}Reference summary as at {regime.as_at}; thresholds and minimums move, so confirm against the regulator’s current rules.
      </Note>
    </div>
  );
}
