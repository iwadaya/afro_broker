import { fmtPct } from '../../components.jsx';
import { payloadStructure, describeStructure, returnPeriod, num } from './model.js';

/*
 * The desk's eight stages, in order. The first three set the analysis up
 * (what is being modelled, the programmes, the assumptions); the next four
 * read the run; the last turns the run into a structure decision — every
 * family across a range of retentions, read against the appetite. Each is
 * a tab with an ordinal, and the sub-label under it is the desk's real
 * state — the scope, what the proposed programme is, whether the figures on
 * the result stages are current, and how many tested programmes fit.
 */
export const STAGES = [
  { value: 'scope', ordinal: '01', label: 'Scope' },
  { value: 'programme', ordinal: '02', label: 'Programme' },
  { value: 'assumptions', ordinal: '03', label: 'Assumptions' },
  { value: 'impact', ordinal: '04', label: 'Impact' },
  { value: 'capital', ordinal: '05', label: 'Capital' },
  { value: 'covers', ordinal: '06', label: 'Covers & panel' },
  { value: 'scenarios', ordinal: '07', label: 'Scenarios' },
  { value: 'structuring', ordinal: '08', label: 'Structuring' },
];

export const RESULT_STAGES = ['impact', 'capital', 'covers', 'scenarios'];

/** The stage a ?tab= value names, or null for anything else. */
export function stageOf(value) {
  return STAGES.find((s) => s.value === value) || null;
}

/** The verdict in three words, for a tab sub-label and the strip's pill. */
export function verdictShort(results) {
  const r = results?.structures?.proposed?.reinsurance;
  if (!results) return 'Not run';
  if (!r) return 'Gross only';
  if (r.capital_relief < 0) return 'No relief';
  if (r.efficient == null) return 'Relief too small';
  return r.efficient ? 'Cheaper than capital' : 'Dearer than capital';
}

/** The tone the verdict carries: good, bad, or neither. */
export function verdictTone(results) {
  const r = results?.structures?.proposed?.reinsurance;
  if (!r || r.efficient == null) return r && r.capital_relief < 0 ? 'bad' : '';
  return r.efficient ? 'good' : 'bad';
}

/** What the scope stage says under its label: the scope, in a word or a reference. */
export function scopeHint({ mode, portfolio, selection }) {
  if (mode === 'unchosen') return 'Choose';
  if (mode === 'standalone') return 'Standalone';
  if (!portfolio) return 'Loading';
  const selected = portfolio.selected?.length || 0;
  if (mode === 'contract') {
    return portfolio.placements.find((p) => p.id === portfolio.selected?.[0])?.reference || 'One contract';
  }
  const total = portfolio.placements.filter((p) => p.calibration.subject_premium > 0).length;
  return selection ? `${selected} of ${total} contracts` : `Whole portfolio · ${selected}`;
}

/** What the scenarios stage says under its label: how many strain or breach the capital. */
export function scenarioHint(results) {
  const rows = Object.values(results?.scenarios || {});
  if (!rows.length) return 'None chosen';
  const breach = rows.filter((r) => r.structures?.proposed?.standing === 'breach').length;
  const strained = rows.filter((r) => r.structures?.proposed?.standing === 'strained').length;
  if (breach) return `${breach} of ${rows.length} breach`;
  if (strained) return `${strained} of ${rows.length} strained`;
  return `All ${rows.length} hold`;
}

/** What the capital stage says: the regime's ratio when there is one, else the chance of ruin. */
export function capitalHint(results) {
  const prop = results.structures.proposed;
  const r = prop.regime;
  if (results.regime && r && !r.needs_input) return `${results.regime.ratio.label} ${fmtPct(r.ratio_pct, 0)}`;
  return `Ruin ${fmtPct(prop.capital.ruin_prob_pct, 2)}`;
}

/** What the structuring stage says: how many tested programmes fit, or where the sweep stands. */
export function structuringHint({ sweep, sweeping, sweepStale }) {
  if (sweeping) return 'Testing';
  if (!sweep) return 'Not tested';
  if (sweepStale) return 'Test needed';
  const d = sweep.defensible;
  return `${d.fits} of ${d.tested} fit`;
}

/**
 * The sub-label under each tab. Every one is the desk's real state: what is
 * being modelled, what the proposed programme is, the capital standard, and
 * whether the result stages show the edits or an older run.
 */
export function stageHints({ mode, portfolio, selection, proposed, assumptions, results, stale, running, sweep, sweeping, sweepStale }) {
  const programme = proposed ? describeStructure(payloadStructure(proposed)) : '—';
  const horizon = Math.max(1, Math.trunc(num(assumptions?.horizon_years, 1)));
  const standard = assumptions
    ? `1-in-${returnPeriod(assumptions.capital_percentile)} · ${horizon} ${horizon === 1 ? 'year' : 'years'}`
    : '—';
  const state = running ? 'Running' : !results ? 'Not run' : stale ? 'Run needed' : null;
  const prop = results?.structures?.proposed;
  const covers = prop?.layers?.length || 0;
  const markets = mode === 'standalone' ? 0 : (portfolio?.panel?.length || 0);
  return {
    scope: scopeHint({ mode, portfolio, selection }),
    programme,
    assumptions: standard,
    impact: state || verdictShort(results),
    capital: state || capitalHint(results),
    covers: state || `${covers} ${covers === 1 ? 'cover' : 'covers'} · ${markets} ${markets === 1 ? 'market' : 'markets'}`,
    scenarios: state || scenarioHint(results),
    structuring: structuringHint({ sweep, sweeping, sweepStale }),
  };
}
