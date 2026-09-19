import React, { useState } from 'react';
import { fmtCompact, fmtPct } from '../../components.jsx';
import { niceStep } from './charts.jsx';
import { FAMILY_TONES, num } from './model.js';

/*
 * The structuring stage's pictures: the frontier of cost against volatility
 * with every programme tested on it, the range of retentions each family
 * fits at, and the outcome ranges — the combined ratio, the net income and
 * the year-end solvency of a programme as a band from a good year to a bad
 * one. Inline SVG on the theme's tokens, a legend on each, and the same
 * words under every picture as in its table.
 */

const money = (ccy) => (v) => `${ccy ? `${ccy} ` : ''}${fmtCompact(v)}`;
const toneOf = (family) => FAMILY_TONES[family] || 'ref';
const costOf = (b) => b.reinsurance?.expected_cost ?? 0;
const swingOf = (b) => b.result?.sd ?? 0;

/** Money or a percentage on an axis, by the family's axis kind. */
export const axisText = (kind, v) => (kind === 'cession' ? `${num(v)}%` : fmtCompact(v));

// ---- The frontier: what the cover costs against how much the result swings ----

/**
 * Every programme tested as a point — the expected cost of the cover up the
 * page, the swing of the net result across — coloured by family, filled
 * when it fits the appetite and hollow when it does not, the pick ringed,
 * the current programme and the gross book marked for bearings. Down and
 * to the left is better; the dotted line joins the efficient ones.
 */
export function FrontierCostChart({ candidates, references, selected, onSelect, ccy, compact = false }) {
  const [hover, setHover] = useState(null);
  const refs = Object.entries(references || {}).map(([key, b]) => ({ ...b, label: key === 'gross' ? 'Gross' : key === 'current' ? 'Current' : 'Proposed', key, ref: true }));
  const pts = [...refs, ...candidates];
  const W = compact ? 520 : 640;
  const H = compact ? 240 : 300;
  const M = { top: 18, right: 22, bottom: 36, left: 62 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;
  const xs = pts.map(swingOf);
  const ys = pts.map(costOf);
  const xMin = Math.min(...xs) * 0.92;
  const xMax = Math.max(...xs, 1) * 1.05;
  const yLo = Math.min(0, ...ys);
  const yHi = Math.max(...ys, 1);
  const yPad = (yHi - yLo || 1) * 0.12;
  const x = (v) => M.left + ((v - xMin) / (xMax - xMin || 1)) * innerW;
  const y = (v) => M.top + innerH - ((v - (yLo - yPad)) / ((yHi + yPad) - (yLo - yPad))) * innerH;
  const xStep = niceStep((xMax - xMin) / 4);
  const xTicks = [];
  for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax; v += xStep) xTicks.push(v);
  const yStep = niceStep((yHi - yLo + 2 * yPad) / 4);
  const yTicks = [];
  for (let v = Math.ceil((yLo - yPad) / yStep) * yStep; v <= yHi + yPad; v += yStep) yTicks.push(v);
  const efficient = candidates.filter((c) => c.efficient).sort((a, b) => swingOf(a) - swingOf(b));
  const path = efficient.length > 1
    ? efficient.map((c, i) => `${i ? 'L' : 'M'}${x(swingOf(c)).toFixed(1)},${y(costOf(c)).toFixed(1)}`).join('') : null;
  const h = hover != null ? pts[hover] : null;
  const m = money(ccy);
  const pick = candidates.find((c) => c.recommended);
  const labelled = [...refs, ...(pick ? [pick] : [])];
  const placed = [];
  const labelY = (p) => {
    const px = x(swingOf(p));
    let py = y(costOf(p)) - 10;
    for (const l of placed) if (Math.abs(l.x - px) < 80 && Math.abs(l.y - py) < 12) py = l.y - 12;
    placed.push({ x: px, y: py });
    return py;
  };

  return (
    <div className="dfa-chartwrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="dfa-chart" role="img" aria-label="Expected cost of the cover against the swing of the net result, for every programme tested">
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} className="dfa-gridline" />
            <text x={M.left - 5} y={y(v) + 3} textAnchor="end" className="dfa-ticklabel">{fmtCompact(v)}</text>
          </g>
        ))}
        {xTicks.map((v) => (
          <text key={`x${v}`} x={x(v)} y={H - 10} textAnchor="middle" className="dfa-ticklabel">{fmtCompact(v)}</text>
        ))}
        <line x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} className="dfa-axis" />
        <text x={W - M.right} y={H - 22} textAnchor="end" className="dfa-ticklabel">net retained volatility →</text>
        <text x={M.left + 4} y={M.top + 2} className="dfa-ticklabel">expected cost of the cover ↑</text>
        {path && <path d={path} className="dfa-fpath" />}
        {pts.map((p, i) => {
          const cx = x(swingOf(p));
          const cy = y(costOf(p));
          const tone = p.ref ? 'ref' : toneOf(p.family);
          const fits = p.appetite?.pass;
          const isSel = !p.ref && p.label === selected;
          return (
            <g
              key={p.label}
              className={`dfa-sdot fam-${tone}${fits ? ' is-fit' : ' is-unfit'}${p.ref ? ' is-ref' : ''}${isSel ? ' is-selected' : ''}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onClick={() => { if (!p.ref && onSelect) onSelect(p.label); }}
              style={{ cursor: p.ref ? 'default' : 'pointer' }}
            >
              {p.recommended && <circle cx={cx} cy={cy} r={11} className="dfa-sdot-ring" />}
              {p.ref
                ? <rect x={cx - 5} y={cy - 5} width={10} height={10} transform={`rotate(45 ${cx} ${cy})`} className="dfa-sdot-shape" />
                : <circle cx={cx} cy={cy} r={isSel ? 7 : 5} className="dfa-sdot-shape" />}
            </g>
          );
        })}
        {labelled.map((p) => (
          <text
            key={`l-${p.label}`}
            x={x(swingOf(p)) + (x(swingOf(p)) > W - 120 ? -12 : 12)}
            y={labelY(p)}
            textAnchor={x(swingOf(p)) > W - 120 ? 'end' : 'start'}
            className={`dfa-flabel${p.recommended ? ' is-pick' : ''}`}
          >
            {p.recommended ? `Pick · ${p.label}` : p.label}
          </text>
        ))}
      </svg>
      {h && (
        <div className="dfa-tooltip" style={{ left: `${(x(swingOf(h)) / W) * 100}%` }}>
          <div className="dfa-tooltip-title">{h.label}</div>
          <div>Expected cost <b>{m(costOf(h))}</b></div>
          <div>Premium paid <b>{m(h.reinsurance?.ceded_premium ?? 0)}</b></div>
          <div>Result swings <b>{m(swingOf(h))}</b></div>
          <div>Chance of ruin <b>{fmtPct(h.capital?.ruin_prob_pct, 2)}</b></div>
          {h.appetite && (
            <div>{h.appetite.pass ? <b>Fits the appetite</b> : <>Fails: <b>{h.appetite.failed.join(', ')}</b></>}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- The range each family fits at ----

/**
 * One track a family: what was tested from left to right, the part that
 * fits highlighted, a tick a candidate (filled when it fits), the pick
 * ringed.
 */
export function FamilyRanges({ families, candidates, ccy }) {
  const W = 420;
  const M = { left: 8, right: 8 };
  const innerW = W - M.left - M.right;
  return (
    <div className="dfa-famranges">
      {families.map((f) => {
        const rows = candidates.filter((c) => c.family === f.family);
        const lo = f.tested_from;
        const hi = f.tested_to;
        const x = (v) => (hi > lo ? M.left + ((v - lo) / (hi - lo)) * innerW : M.left + innerW / 2);
        const fits = f.fits > 0;
        const kind = f.axis;
        return (
          <div key={f.family} className={`dfa-famrange fam-${toneOf(f.family)}`} data-testid={`dfa-famrange-${f.family}`}>
            <div className="dfa-famrange-head">
              <span className="dfa-famrange-label"><i className="dfa-famkey" aria-hidden="true" /> {f.label}</span>
              <span className="dfa-famrange-text">
                {fits
                  ? `${f.fits} of ${f.tested} fit · ${kind === 'cession' ? 'cession' : kind === 'line' ? 'line' : 'retention'} ${axisText(kind, f.fits_from)}${f.fits_to !== f.fits_from ? ` – ${axisText(kind, f.fits_to)}` : ''}`
                  : `none of ${f.tested} fits`}
              </span>
            </div>
            <svg viewBox={`0 0 ${W} 22`} className="dfa-chart dfa-famrange-svg" role="img" aria-label={`${f.label}: ${fits ? `${f.fits} of ${f.tested} fit` : 'none fits'}`}>
              <line x1={M.left} x2={W - M.right} y1={11} y2={11} className="dfa-famrange-track" />
              {fits && f.fits_to > f.fits_from && (
                <line x1={x(f.fits_from)} x2={x(f.fits_to)} y1={11} y2={11} className="dfa-famrange-fit" />
              )}
              {rows.map((c) => (
                <g key={c.label}>
                  {c.recommended && <circle cx={x(c.axis.value)} cy={11} r={9} className="dfa-sdot-ring" />}
                  <circle cx={x(c.axis.value)} cy={11} r={4.5} className={`dfa-famrange-tick${c.appetite.pass ? ' is-fit' : ''}`}>
                    <title>{`${c.label}: ${c.appetite.pass ? 'fits' : `fails ${c.appetite.failed.join(', ')}`}`}</title>
                  </circle>
                </g>
              ))}
            </svg>
            <div className="dfa-famrange-axis">
              <span>{axisText(kind, lo)}</span>
              <span>{axisText(kind, hi)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- The outcome ranges ----

/**
 * A distribution as a band: the 1-in-100 to 1-in-100 span faint, the
 * 1-in-10 span solid, the median a tick, the mean a dot — one row a
 * programme, on one scale, with a marker where the reader's line is
 * (100% combined, zero income, 100% solvency).
 */
export function RangeStrip({ title, rows, format, mark, markLabel, goodWhen, testid }) {
  const W = 520;
  const rowH = 30;
  const M = { left: 118, right: 96, top: 6 };
  const innerW = W - M.left - M.right;
  const H = M.top + rows.length * rowH + 18;
  const all = rows.flatMap((r) => [r.stats?.p1, r.stats?.p99, r.stats?.p0_5, r.stats?.mean].filter((v) => v != null));
  if (mark != null) all.push(mark);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = (hi - lo || 1) * 0.06;
  const x = (v) => M.left + ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * innerW;
  const step = niceStep((hi - lo + 2 * pad) / 4);
  const ticks = [];
  for (let v = Math.ceil((lo - pad) / step) * step; v <= hi + pad; v += step) ticks.push(v);
  return (
    <div className="dfa-range" data-testid={testid}>
      <div className="dfa-range-title">{title}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="dfa-chart" role="img" aria-label={`${title}: ${rows.map((r) => `${r.label} median ${format(r.stats?.p50)}, 1-in-100 ${format(goodWhen === 'down' ? r.stats?.p99 : r.stats?.p1)}`).join('; ')}`}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={M.top} y2={H - 16} className="dfa-gridline" />
            <text x={x(v)} y={H - 4} textAnchor="middle" className="dfa-ticklabel">{format(v, true)}</text>
          </g>
        ))}
        {mark != null && (
          <g>
            <line x1={x(mark)} x2={x(mark)} y1={M.top} y2={H - 16} className="dfa-range-mark" />
            {markLabel && <text x={x(mark) + 4} y={M.top + 8} className="dfa-ticklabel">{markLabel}</text>}
          </g>
        )}
        {rows.map((r, i) => {
          const s = r.stats;
          const cy = M.top + i * rowH + rowH / 2 + 2;
          if (!s) return null;
          const bad = goodWhen === 'down' ? s.p99 : s.p1;
          return (
            <g key={r.label} className={`dfa-range-row is-${r.tone || 'ref'}`}>
              <text x={M.left - 8} y={cy + 4} textAnchor="end" className="dfa-range-label">{r.label}</text>
              <line x1={x(s.p1)} x2={x(s.p99)} y1={cy} y2={cy} className="dfa-range-wide" />
              <line x1={x(s.p10)} x2={x(s.p90)} y1={cy} y2={cy} className="dfa-range-core" />
              <line x1={x(s.p50)} x2={x(s.p50)} y1={cy - 7} y2={cy + 7} className="dfa-range-median" />
              <circle cx={x(s.mean)} cy={cy} r={3} className="dfa-range-mean" />
              <text x={W - M.right + 8} y={cy + 4} className="dfa-range-value">
                {format(s.p50)} <tspan className="muted">· bad {format(bad)}</tspan>
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
