import React, { useRef, useState } from 'react';
import { Blueprint, fmtCompact, fmtPct } from '../../components.jsx';
import { num } from './model.js';

/*
 * The desk's pictures: the programme as a tower, the exceedance curve, the
 * risk/return frontier and the surplus path. All inline SVG on the theme's
 * chart tokens, each with a legend, an accessible label and the same words
 * under it every time — the picture never says something its table does not.
 */

export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/** Keep two end labels from overlapping when net hugs gross. */
function endLabelY(netY, grossY) {
  return netY - grossY < 12 ? grossY + 12 : netY + 4;
}

const money = (ccy) => (v) => `${ccy ? `${ccy} ` : ''}${fmtCompact(v)}`;

// ---- The tower: a programme as the buyer draws it on a whiteboard ----

/**
 * Loss size up the page; the quota share as a band on the left taking its
 * share of every loss, the excess-of-loss layers stacked up the retained
 * account at their attachment points, the retention underneath. Both
 * programmes are drawn to the same scale (`top`), so a moved retention or
 * a dropped layer is visible before a single number is read. Loss-ratio
 * covers (the stop loss) have no place on a per-event axis and are named
 * under the picture instead.
 */
export function Tower({ structure, top, ccy, empty }) {
  const layers = (structure?.xol_layers || [])
    .filter((l) => num(l.limit) > 0)
    .map((l) => ({ ...l, attachment: num(l.attachment), limit: num(l.limit) }))
    .sort((a, b) => a.attachment - b.attachment);
  const cession = structure?.quota_share ? Math.min(90, Math.max(0, num(structure.quota_share.cession_pct))) : 0;
  const agg = structure?.aggregate;
  const sp = structure?.surplus && num(structure.surplus.retained_line) > 0 ? structure.surplus : null;

  const W = 380;
  const H = 210;
  const M = { top: 12, right: 14, bottom: 22, left: 50 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;
  const yMax = top > 0 ? top : Math.max(1, ...layers.map((l) => l.attachment + l.limit));
  const y = (v) => M.top + innerH - (Math.min(v, yMax) / yMax) * innerH;
  const qsW = innerW * (cession / 100);
  const colX = M.left + qsW;
  const colW = innerW - qsW;
  const step = niceStep(yMax / 4);
  const ticks = [];
  for (let v = step; v <= yMax; v += step) ticks.push(v);
  const retention = layers.length ? layers[0].attachment : null;

  if (!layers.length && !cession && !sp) {
    return (
      <div className="dfa-tower dfa-tower-empty">
        {empty || 'No reinsurance — the book runs gross.'}
      </div>
    );
  }
  if (!layers.length && !cession && sp) {
    return (
      <div className="dfa-tower dfa-tower-empty">
        {`Surplus only: the cedant keeps a ${fmtCompact(num(sp.retained_line))} line of every risk and cedes up to ${num(sp.lines)} lines above it — big risks cede more, small ones nothing.`}
      </div>
    );
  }

  return (
    <div className="dfa-tower">
      <svg viewBox={`0 0 ${W} ${H}`} className="dfa-chart" role="img" aria-label="The programme drawn as a tower: quota share band, excess-of-loss layers by attachment and limit, retention underneath">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} className="dfa-gridline" />
            <text x={M.left - 5} y={y(v) + 3} textAnchor="end" className="dfa-ticklabel">{fmtCompact(v)}</text>
          </g>
        ))}
        <line x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} className="dfa-axis" />
        {cession > 0 && (
          <g>
            <rect x={M.left} y={M.top} width={qsW} height={innerH} className="dfa-tower-qs" />
            {qsW >= 30 && (
              <text x={M.left + qsW / 2} y={M.top + innerH / 2 + 4} textAnchor="middle" className="dfa-tower-label">
                {`QS ${cession}%`}
              </text>
            )}
          </g>
        )}
        {retention != null && retention > 0 && (
          <g>
            <rect x={colX} y={y(retention)} width={colW} height={y(0) - y(retention)} className="dfa-tower-retained" />
            {y(0) - y(retention) >= 16 && (
              <text x={colX + colW / 2} y={(y(0) + y(retention)) / 2 + 4} textAnchor="middle" className="dfa-tower-label muted">
                {`retained to ${fmtCompact(retention)}`}
              </text>
            )}
          </g>
        )}
        {layers.map((l, i) => {
          const y1 = y(l.attachment + l.limit);
          const y2 = y(l.attachment);
          const h = Math.max(2, y2 - y1);
          const placed = num(l.placed_pct, 100);
          const technical = !(num(l.premium100) > 0);
          return (
            <g key={l._key || i}>
              <rect
                x={colX + 6} y={y1} width={Math.max(0, colW - 12)} height={h}
                className={`dfa-tower-layer${technical ? ' is-technical' : ''}`}
                style={{ fillOpacity: 0.18 + 0.6 * (placed / 100) }}
              >
                <title>{`${l.name || `Layer ${i + 1}`}: ${fmtCompact(l.limit)} xs ${fmtCompact(l.attachment)}${placed < 100 ? ` · ${placed}% placed` : ''}${technical ? ' · priced by the model' : ''}`}</title>
              </rect>
              {h >= 15 && (
                <text x={colX + colW / 2} y={y1 + h / 2 + 4} textAnchor="middle" className="dfa-tower-label">
                  {`${fmtCompact(l.limit)} xs ${fmtCompact(l.attachment)}`}
                </text>
              )}
            </g>
          );
        })}
        <text x={W - M.right} y={H - 6} textAnchor="end" className="dfa-ticklabel">
          {ccy ? `loss size, ${ccy}` : 'loss size'}
        </text>
      </svg>
      <div className="dfa-tower-foot">
        {sp ? `Surplus: a ${fmtCompact(num(sp.retained_line))} line, ${num(sp.lines)} lines ceded above it, ahead of the layers. ` : ''}
        {agg
          ? `Stop loss on what is kept: attaches at ${fmtPct(num(agg.attachment_lr_pct), 0)} and exhausts at ${fmtPct(num(agg.exhaust_lr_pct), 0)} of the retained premium.`
          : layers.length
            ? `${layers.length} excess-of-loss ${layers.length === 1 ? 'layer' : 'layers'}${cession ? `, on the ${100 - cession}% kept after the quota share` : ''}. Darker is more fully placed; a dashed edge is a layer priced by the model.`
            : 'Quota share only — a share of every loss goes to the reinsurers.'}
      </div>
    </div>
  );
}

// ---- The exceedance chart ----

const RP_TICKS = [2, 5, 10, 25, 50, 100, 250, 500];

/** Gross against net for one structure; small multiples share one y-scale. */
export function EpPanel({ label, block, other, ccy }) {
  const yMax = Math.max(
    ...block.ep_curve.map((d) => d.gross),
    ...other.ep_curve.map((d) => d.gross),
  );
  return (
    <Blueprint className="dfa-panel">
      <div className="dfa-chart-head">
        <span className="seclabel">{label}</span>
        <span className="dfa-legend">
          <span className="dfa-chip dfa-chip-gross" /> Gross loss
          <span className="dfa-chip dfa-chip-net" /> Net loss
          <span className="dfa-chip dfa-chip-band" /> Ceded
        </span>
      </div>
      <EpChart data={block.ep_curve} yMax={yMax} ccy={ccy} />
      <div className="dfa-note">
        The whole year’s losses by how rare the year is. The band is what this
        programme hands to the reinsurers; hover for the figures at any return period.
      </div>
    </Blueprint>
  );
}

export function EpChart({ data, yMax, ccy }) {
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);

  const W = 560;
  const H = 260;
  const M = { top: 14, right: 58, bottom: 26, left: 8 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;

  const xDomain = [Math.log10(2), Math.log10(500)];
  const x = (rp) => M.left
    + ((Math.log10(Math.max(2, Math.min(500, rp))) - xDomain[0]) / (xDomain[1] - xDomain[0])) * innerW;
  const y = (v) => M.top + innerH - (Math.max(0, v) / (yMax || 1)) * innerH;

  const pts = data.filter((d) => d.return_period >= 2);
  const path = (field) => pts.map((d, i) => `${i ? 'L' : 'M'}${x(d.return_period).toFixed(1)},${y(d[field]).toFixed(1)}`).join('');
  const band = `${path('gross')}${[...pts].reverse().map((d) => `L${x(d.return_period).toFixed(1)},${y(d.net).toFixed(1)}`).join('')}Z`;

  const step = niceStep(yMax / 4);
  const yTicks = [];
  for (let v = step; v <= yMax; v += step) yTicks.push(v);

  function onMove(e) {
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestD = Infinity;
    pts.forEach((d, i) => {
      const dx = Math.abs(x(d.return_period) - px);
      if (dx < bestD) { bestD = dx; best = i; }
    });
    setHover(best);
  }

  const h = hover != null ? pts[hover] : null;
  const last = pts[pts.length - 1];
  const m = money(ccy);

  return (
    <div className="dfa-chartwrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="dfa-chart"
        role="img"
        aria-label="Gross and net aggregate loss by return period"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} className="dfa-gridline" />
            <text x={M.left + 2} y={y(v) - 3} className="dfa-ticklabel">{fmtCompact(v)}</text>
          </g>
        ))}
        {RP_TICKS.map((rp) => (
          <text key={rp} x={x(rp)} y={H - 8} textAnchor={rp === 2 ? 'start' : 'middle'} className="dfa-ticklabel">
            1-in-{rp}
          </text>
        ))}
        <line x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} className="dfa-axis" />

        <path d={band} className="dfa-band" />
        <path d={path('gross')} className="dfa-line dfa-line-gross" />
        <path d={path('net')} className="dfa-line dfa-line-net" />

        {last && (
          <>
            <text x={W - M.right + 5} y={y(last.gross) + 4} className="dfa-endlabel">Gross</text>
            <text x={W - M.right + 5} y={endLabelY(y(last.net), y(last.gross))} className="dfa-endlabel">Net</text>
          </>
        )}

        {h && (
          <g>
            <line x1={x(h.return_period)} x2={x(h.return_period)} y1={M.top} y2={M.top + innerH} className="dfa-crosshair" />
            <circle cx={x(h.return_period)} cy={y(h.gross)} r="3.5" className="dfa-dot dfa-dot-gross" />
            <circle cx={x(h.return_period)} cy={y(h.net)} r="3.5" className="dfa-dot dfa-dot-net" />
          </g>
        )}
      </svg>
      {h && (
        <div className="dfa-tooltip" style={{ left: `${(x(h.return_period) / W) * 100}%` }}>
          <div className="dfa-tooltip-title">1-in-{h.return_period} year (P{h.p})</div>
          <div>Gross <b>{m(h.gross)}</b></div>
          <div>Ceded <b>{m(h.gross - h.net)}</b></div>
          <div>Net <b>{m(h.net)}</b></div>
        </div>
      )}
    </div>
  );
}

// ---- The frontier chart ----

/**
 * Every structure as a point: required capital across, expected result up.
 * Up and to the left is better; the variants of a scan trace the frontier
 * along one dimension of the proposed structure.
 */
export function FrontierPanel({ results, ccy, scanned }) {
  const [hover, setHover] = useState(null);
  const pts = results.frontier;
  const W = 560;
  const H = 260;
  const M = { top: 16, right: 20, bottom: 28, left: 54 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;

  const xs = pts.map((p) => p.capital_required);
  const ys = pts.map((p) => p.result_mean);
  const xMax = Math.max(...xs, 1) * 1.08;
  const yMin = Math.min(...ys, 0);
  const yMax = Math.max(...ys, 0);
  const yPad = (yMax - yMin || 1) * 0.15;
  const x = (v) => M.left + (v / xMax) * innerW;
  const y = (v) => M.top + innerH - ((v - (yMin - yPad)) / ((yMax + yPad) - (yMin - yPad))) * innerH;

  const xStep = niceStep(xMax / 4);
  const xTicks = [];
  for (let v = xStep; v <= xMax; v += xStep) xTicks.push(v);
  const yStep = niceStep((yMax - yMin + 2 * yPad) / 4);
  const yTicks = [];
  for (let v = Math.ceil((yMin - yPad) / yStep) * yStep; v <= yMax + yPad; v += yStep) yTicks.push(v);

  const variants = pts.filter((p) => p.kind === 'variant').sort((a, b) => a.capital_required - b.capital_required);
  const variantPath = variants.length > 1
    ? variants.map((p, i) => `${i ? 'L' : 'M'}${x(p.capital_required).toFixed(1)},${y(p.result_mean).toFixed(1)}`).join('')
    : null;
  const h = hover != null ? pts[hover] : null;
  const m = money(ccy);
  // Two programmes on the same point (nothing changed yet) would print their
  // labels on top of each other; a label that lands on another steps down.
  const placed = [];
  const labelY = pts.map((p) => {
    if (p.kind === 'variant') return null;
    const px = x(p.capital_required);
    let py = y(p.result_mean) + 4;
    for (const l of placed) if (Math.abs(l.x - px) < 70 && Math.abs(l.y - py) < 12) py = l.y + 12;
    placed.push({ x: px, y: py });
    return py;
  });

  return (
    <Blueprint className="dfa-panel">
      <div className="dfa-chart-head">
        <span className="seclabel">Risk against return</span>
        <span className="dfa-legend">
          <span className="dfa-fchip dfa-f-gross" /> Gross
          <span className="dfa-fchip dfa-f-structure" /> Programmes
          <span className="dfa-fchip dfa-f-variant" /> Variants
        </span>
      </div>
      <div className="dfa-chartwrap">
        <svg viewBox={`0 0 ${W} ${H}`} className="dfa-chart" role="img" aria-label="Required capital against expected result for every structure">
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} className="dfa-gridline" />
              <text x={M.left - 4} y={y(v) + 3} textAnchor="end" className="dfa-ticklabel">{fmtCompact(v)}</text>
            </g>
          ))}
          {xTicks.map((v) => (
            <text key={`x${v}`} x={x(v)} y={H - 8} textAnchor="middle" className="dfa-ticklabel">{fmtCompact(v)}</text>
          ))}
          <line x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} className="dfa-axis" />
          <text x={W - M.right} y={H - 18} textAnchor="end" className="dfa-ticklabel">capital needed →</text>
          <text x={M.left + 4} y={M.top + 2} className="dfa-ticklabel">expected result ↑</text>
          {variantPath && <path d={variantPath} className="dfa-fpath" />}
          {pts.map((p, i) => (
            <g
              key={p.label}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <circle
                cx={x(p.capital_required)} cy={y(p.result_mean)}
                r={p.kind === 'variant' ? 4 : 6}
                className={`dfa-fdot dfa-f-${p.kind}`}
              />
              {p.kind !== 'variant' && (
                <text
                  x={x(p.capital_required) + (x(p.capital_required) > W - 80 ? -9 : 9)}
                  y={labelY[i]}
                  textAnchor={x(p.capital_required) > W - 80 ? 'end' : 'start'}
                  className="dfa-flabel"
                >
                  {p.label}
                </text>
              )}
            </g>
          ))}
        </svg>
        {h && (
          <div className="dfa-tooltip" style={{ left: `${(x(h.capital_required) / W) * 100}%` }}>
            <div className="dfa-tooltip-title">{h.label}</div>
            <div>Capital needed <b>{m(h.capital_required)}</b></div>
            <div>Expected result <b>{m(h.result_mean)}</b></div>
            <div>ROE <b>{h.roe_pct == null ? '—' : fmtPct(h.roe_pct, 1)}</b></div>
            <div>Cost of cover <b>{m(h.reinsurance_cost)}</b></div>
            <div>Value added <b>{m(h.value_added)}</b></div>
          </div>
        )}
      </div>
      <div className="dfa-note">
        Up and to the left is better: less capital for more result.
        {scanned
          ? ' The small dots are the variants of the proposed programme; the dotted line joins them.'
          : ' To trace variants of the proposed programme along one dimension, pick what to explore on 02 Programme.'}
      </div>
    </Blueprint>
  );
}

// ---- Surplus over the horizon ----

export function SurplusPanel({ results }) {
  const series = [
    { key: 'gross', label: 'Gross', h: results.gross.horizon, cls: 'gross' },
    { key: 'current', label: 'Current', h: results.structures.current.horizon, cls: 'current' },
    { key: 'proposed', label: 'Proposed', h: results.structures.proposed.horizon, cls: 'proposed' },
  ];
  const W = 560;
  const H = 260;
  const M = { top: 16, right: 70, bottom: 28, left: 54 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;
  const years = results.assumptions.horizon_years;
  const available = results.assumptions.available_capital;
  const all = series.flatMap((s) => s.h.by_year.flatMap((yr) => [yr.surplus_mean, yr.surplus_p1]));
  const yMin = Math.min(...all, 0);
  const yMax = Math.max(...all, available);
  const pad = (yMax - yMin || 1) * 0.1;
  const x = (yr) => M.left + (yr / years) * innerW;
  const y = (v) => M.top + innerH - ((v - (yMin - pad)) / ((yMax + pad) - (yMin - pad))) * innerH;
  const line = (h, field) => [`M${x(0).toFixed(1)},${y(available).toFixed(1)}`]
    .concat(h.by_year.map((yr) => `L${x(yr.year).toFixed(1)},${y(yr[field]).toFixed(1)}`)).join('');
  const yStep = niceStep((yMax - yMin + 2 * pad) / 4);
  const yTicks = [];
  for (let v = Math.ceil((yMin - pad) / yStep) * yStep; v <= yMax + pad; v += yStep) yTicks.push(v);

  return (
    <Blueprint className="dfa-panel">
      <div className="dfa-chart-head">
        <span className="seclabel">Surplus over {years} years</span>
        <span className="dfa-legend">
          <span className="dfa-fchip dfa-f-gross" /> Gross
          <span className="dfa-fchip dfa-f-current" /> Current
          <span className="dfa-fchip dfa-f-proposed" /> Proposed
          <span className="dfa-chip dfa-chip-dashed" /> 1-in-100
        </span>
      </div>
      <div className="dfa-chartwrap">
        <svg viewBox={`0 0 ${W} ${H}`} className="dfa-chart" role="img" aria-label="Expected and 1-in-100 surplus by year for each structure">
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} className="dfa-gridline" />
              <text x={M.left - 4} y={y(v) + 3} textAnchor="end" className="dfa-ticklabel">{fmtCompact(v)}</text>
            </g>
          ))}
          {Array.from({ length: years + 1 }, (_, i) => (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" className="dfa-ticklabel">{i === 0 ? 'now' : `year ${i}`}</text>
          ))}
          <line x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} className="dfa-axis" />
          <text x={W - M.right + 4} y={y(0) + 3} className="dfa-ticklabel">ruin</text>
          {series.map((s) => (
            <g key={s.key}>
              <path d={line(s.h, 'surplus_mean')} className={`dfa-line dfa-sline-${s.cls}`} />
              <path d={line(s.h, 'surplus_p1')} className={`dfa-line dfa-sline-${s.cls} dfa-line-dashed`} />
              <text
                x={W - M.right + 4} y={y(s.h.by_year[years - 1].surplus_mean) + 3}
                className="dfa-endlabel"
              >
                {s.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="dfa-note">
        Solid lines are the expected surplus, dashed the 1-in-100 year. Later
        years grow the book and trend the losses while the programme stays fixed.
      </div>
    </Blueprint>
  );
}
