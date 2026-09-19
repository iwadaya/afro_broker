import React, { useRef, useState } from 'react';

/** A "nice" axis step for a raw interval: 1, 2 or 5 × a power of ten. */
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/*
 * The programme analysis's pictures — horizontal stacked bars, columns over
 * the treaty years, a broker × reinsurer grid and a few meters — built in
 * plain HTML on the theme's chart tokens (--viz-1 … --viz-6, --viz-other).
 *
 * The rules every one of them keeps: thin marks with a 2px surface gap
 * between touching fills and a 4px rounded data-end; colour follows the
 * entity, never its rank, and never carries a value on its own — every
 * chart has a legend for two or more series, a value at the tip, a tooltip
 * on hover and focus, and a Figures table underneath that says the same
 * thing in numbers. Text wears text tokens; only the marks wear the series.
 */

export const seriesColor = (i) => (i == null || i > 5 ? 'var(--viz-other)' : `var(--viz-${i + 1})`);

/** A nice tick step and the domain end it rounds up to. */
export function scaleOf(max, { steps = 4, integer = false } = {}) {
  const top = Math.max(max, 0);
  if (!(top > 0)) return { step: 1, domain: 1, ticks: [] };
  // A count axis never ticks at halves: the step is at least one.
  const step = integer ? Math.max(1, niceStep(top / steps)) : niceStep(top / steps);
  const domain = Math.ceil(top / step) * step;
  const ticks = [];
  for (let v = step; v <= domain + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { step, domain, ticks };
}

// ---- Tooltip: one per chart, anchored to the mark under the pointer or focus ----

export function useTip() {
  const wrapRef = useRef(null);
  const [tip, setTip] = useState(null);
  const show = (target, content) => {
    const wrap = wrapRef.current?.getBoundingClientRect();
    if (!wrap || !target) return;
    const r = target.getBoundingClientRect();
    const x = Math.max(90, Math.min(wrap.width - 90, r.left - wrap.left + r.width / 2));
    // Above the mark, unless the mark sits near the top of the chart — then
    // below it, so the readout never covers the panel's title and legend.
    const top = r.top - wrap.top;
    const below = top < 120;
    setTip({ x, y: below ? r.bottom - wrap.top : top, below, ...content });
  };
  const hide = () => setTip(null);
  return { wrapRef, tip, show, hide };
}

/** { title, rows: [{ label, value, color, strong }] } — the value leads, the label follows. */
export function Tip({ tip }) {
  if (!tip) return null;
  return (
    <div className={`viz-tip${tip.below ? ' is-below' : ''}`} style={{ left: tip.x, top: tip.y }} role="status">
      <div className="viz-tip-title">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div key={i} className={`viz-tip-row${r.strong ? ' is-strong' : ''}`}>
          {r.color && <i className="viz-key" style={{ background: r.color }} aria-hidden="true" />}
          <b className="num">{r.value}</b>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Swatch + label per series. Two or more series always get one. */
export function Legend({ items, ariaLabel = 'Series' }) {
  if (!items?.length) return null;
  return (
    <ul className="viz-legend" aria-label={ariaLabel}>
      {items.map((it) => (
        <li key={it.label}>
          <i className="viz-swatch" style={{ background: it.color }} aria-hidden="true" />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

/** The chart's twin in numbers, folded under it. */
export function Figures({ columns, rows, summary = 'Figures' }) {
  return (
    <details className="viz-figures">
      <summary>{summary}</summary>
      <div className="table-wrap">
        <table className="table viz-table">
          <thead>
            <tr>{columns.map((c) => <th key={c.label} className={c.align === 'r' ? 'r' : ''}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key ?? i}>
                {r.cells.map((cell, j) => <td key={j} className={columns[j].align === 'r' ? 'r num' : ''}>{cell}</td>)}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={columns.length} className="muted">Nothing in this scope.</td></tr>}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ---- Horizontal stacked bars ----

/**
 * rows: [{ key, label, sub, total, segments: [{ label, value, color }], selectable }]
 * The longest bar takes ~82% of its track so its value sits at the tip.
 * Hover or focus reads every segment; a selectable row is a toggle button.
 */
export function HBars({ rows, format, integer, axisLabel, onSelect, selectedKey, ariaLabel, emptyNote }) {
  const { wrapRef, tip, show, hide } = useTip();
  const max = Math.max(0, ...rows.map((r) => r.total));
  const { domain, ticks } = scaleOf(max, { integer });
  const pct = (v) => `${(v / domain) * 82}%`;
  const readout = (r) => ({
    title: r.label,
    rows: [
      { value: format(r.total), label: r.totalLabel || 'in all', strong: true },
      ...r.segments.filter((s) => s.value > 0).map((s) => ({ value: format(s.value), label: s.label, color: s.color })),
    ],
  });
  if (!rows.length) return <p className="viz-empty muted">{emptyNote || 'Nothing on the book in this scope.'}</p>;
  return (
    <div className="viz-wrap" ref={wrapRef}>
      <div className="viz-hbars" role="img" aria-label={ariaLabel}>
        {rows.map((r) => {
          const selected = selectedKey != null && r.key === selectedKey;
          const clickable = !!onSelect && r.selectable !== false;
          return (
            <div key={r.key} className="viz-hrow">
              <div className="viz-hlabel" title={r.label}>
                <span className="viz-hname">{r.label}</span>
                {r.sub && <span className="viz-hsub">{r.sub}</span>}
              </div>
              <div className="viz-htrack">
                {ticks.map((t) => <i key={t} className="viz-grid-v" style={{ left: pct(t) }} aria-hidden="true" />)}
                <button
                  type="button"
                  className={`viz-hbar${selected ? ' is-selected' : ''}${clickable ? ' is-clickable' : ''}`}
                  style={{ width: pct(r.total) }}
                  aria-pressed={clickable ? selected : undefined}
                  aria-label={`${r.label}: ${format(r.total)}${clickable ? (selected ? ' — selected, press to clear' : ' — press to filter the programmes') : ''}`}
                  onClick={clickable ? () => onSelect(selected ? null : r.key) : undefined}
                  onPointerEnter={(e) => show(e.currentTarget, readout(r))}
                  onPointerLeave={hide}
                  onFocus={(e) => show(e.currentTarget, readout(r))}
                  onBlur={hide}
                >
                  {r.segments.filter((s) => s.value > 0).map((s) => (
                    <span key={s.label} className="viz-seg" style={{ flex: `${s.value} 1 0%`, background: s.color }} />
                  ))}
                </button>
                <span className="viz-hval num">{format(r.total)}</span>
              </div>
            </div>
          );
        })}
        <div className="viz-hrow viz-haxis-row" aria-hidden="true">
          <div />
          <div className="viz-haxis">
            {ticks.map((t) => <span key={t} className="viz-tick" style={{ left: pct(t) }}>{format(t)}</span>)}
          </div>
        </div>
        {axisLabel && <div className="viz-axis-label">{axisLabel}</div>}
      </div>
      <Tip tip={tip} />
    </div>
  );
}

// ---- Columns over an ordered axis (the treaty years) ----

/** groups: [{ key, label, total, segments: [{ label, value, color }] }] */
export function Columns({ groups, format, integer, ariaLabel, emptyNote }) {
  const { wrapRef, tip, show, hide } = useTip();
  const max = Math.max(0, ...groups.map((g) => g.total));
  const { domain, ticks } = scaleOf(max, { integer });
  const pct = (v) => `${(v / domain) * 100}%`;
  if (!groups.length) return <p className="viz-empty muted">{emptyNote || 'Nothing on the book in this scope.'}</p>;
  const readout = (g) => ({
    title: g.label,
    rows: [
      { value: format(g.total), label: g.totalLabel || 'in all', strong: true },
      ...g.segments.filter((s) => s.value > 0).map((s) => ({ value: format(s.value), label: s.label, color: s.color })),
    ],
  });
  return (
    <div className="viz-wrap" ref={wrapRef}>
      <div className="viz-cols" role="img" aria-label={ariaLabel}>
        <div className="viz-cols-plot">
          {ticks.map((t) => (
            <div key={t} className="viz-grid-h" style={{ bottom: pct(t) }} aria-hidden="true">
              <span className="viz-tick">{format(t)}</span>
            </div>
          ))}
          <div className="viz-cols-bars">
            {groups.map((g) => (
              <div key={g.key} className="viz-col">
                <span className="viz-colval num" style={{ bottom: pct(g.total) }}>{format(g.total)}</span>
                <button
                  type="button"
                  className="viz-colbar"
                  style={{ height: pct(g.total) }}
                  aria-label={`${g.label}: ${format(g.total)}`}
                  onPointerEnter={(e) => show(e.currentTarget, readout(g))}
                  onPointerLeave={hide}
                  onFocus={(e) => show(e.currentTarget, readout(g))}
                  onBlur={hide}
                >
                  {g.segments.filter((s) => s.value > 0).map((s) => (
                    <span key={s.label} className="viz-seg" style={{ flex: `${s.value} 1 0%`, background: s.color }} />
                  ))}
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="viz-cols-axis" aria-hidden="true">
          {groups.map((g) => <span key={g.key}>{g.label}</span>)}
        </div>
      </div>
      <Tip tip={tip} />
    </div>
  );
}

// ---- Meters: one ratio against its whole, on one hue ----

/** rows: [{ key, label, sub, pct, value, whole, valueLabel, wholeLabel }] */
export function Meters({ rows, ariaLabel, emptyNote }) {
  const { wrapRef, tip, show, hide } = useTip();
  if (!rows.length) return <p className="viz-empty muted">{emptyNote || 'Nothing on the book in this scope.'}</p>;
  return (
    <div className="viz-wrap" ref={wrapRef}>
      <div className="viz-meters" role="img" aria-label={ariaLabel}>
        {rows.map((r) => {
          const p = r.pct == null ? null : Math.max(0, Math.min(100, r.pct));
          const readout = {
            title: r.label,
            rows: [
              { value: p == null ? '—' : `${Math.round(p)}%`, label: r.valueLabel, strong: true, color: 'var(--viz-1)' },
              ...(r.value != null ? [{ value: r.value, label: r.valueLabel }] : []),
              ...(r.whole != null ? [{ value: r.whole, label: r.wholeLabel, color: 'var(--viz-other)' }] : []),
            ],
          };
          return (
            <div key={r.key} className="viz-hrow">
              <div className="viz-hlabel" title={r.label}>
                <span className="viz-hname">{r.label}</span>
                {r.sub && <span className="viz-hsub">{r.sub}</span>}
              </div>
              <div className="viz-htrack">
                <button
                  type="button"
                  className="viz-meter"
                  aria-label={`${r.label}: ${p == null ? 'no figure' : `${Math.round(p)}% ${r.valueLabel}`}`}
                  onPointerEnter={(e) => show(e.currentTarget, readout)}
                  onPointerLeave={hide}
                  onFocus={(e) => show(e.currentTarget, readout)}
                  onBlur={hide}
                >
                  <span className="viz-meter-track">
                    <span className="viz-meter-fill" style={{ width: `${p ?? 0}%` }} />
                  </span>
                </button>
                <span className="viz-hval num">{p == null ? '—' : `${Math.round(p)}%`}</span>
              </div>
            </div>
          );
        })}
      </div>
      <Tip tip={tip} />
    </div>
  );
}

// ---- The grid: reinsurers down, brokers across, one hue light → dark ----

const STEPS = [0.12, 0.26, 0.4, 0.54, 0.68];
export const gridAlpha = (v, max) => {
  if (!(v > 0) || !(max > 0)) return 0;
  const step = Math.min(STEPS.length, Math.max(1, Math.ceil((v / max) * STEPS.length)));
  return STEPS[step - 1];
};

/**
 * rows: [{ key, label, href?, total, cells: [{ colKey, value, readout }] }],
 * cols: [{ key, label, total }]. A cell is a button: hover or focus reads
 * it, a click selects its row and column together.
 */
export function Grid({ rows, cols, format, onSelect, selected, ariaLabel, rowHead, colHead, emptyNote, renderRowLabel }) {
  const { wrapRef, tip, show, hide } = useTip();
  const max = Math.max(0, ...rows.flatMap((r) => r.cells.map((c) => c.value)));
  if (!rows.length || !cols.length) return <p className="viz-empty muted">{emptyNote || 'Nothing on the book in this scope.'}</p>;
  return (
    <div className="viz-wrap" ref={wrapRef}>
      <div className="table-wrap viz-grid-wrap">
        <table className="table viz-grid" aria-label={ariaLabel}>
          <thead>
            <tr>
              <th className="viz-grid-corner">{rowHead} ↓ · {colHead} →</th>
              {cols.map((c) => (
                <th key={c.key} className={`c${selected?.col === c.key ? ' is-selected' : ''}`} title={c.label}>{c.label}</th>
              ))}
              <th className="r">All</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={selected?.row === r.key ? 'is-selected' : ''}>
                <th scope="row" className="viz-grid-rowhead">{renderRowLabel ? renderRowLabel(r) : r.label}</th>
                {cols.map((c) => {
                  const cell = r.cells.find((x) => x.colKey === c.key);
                  const v = cell?.value || 0;
                  const isSel = selected?.row === r.key && selected?.col === c.key;
                  return (
                    <td key={c.key} className="viz-grid-cell">
                      <button
                        type="button"
                        className={`viz-cell${isSel ? ' is-selected' : ''}${v ? '' : ' is-empty'}`}
                        style={{ background: v ? `rgba(var(--viz-1-rgb), ${gridAlpha(v, max)})` : undefined }}
                        aria-pressed={onSelect ? isSel : undefined}
                        aria-label={`${r.label} on ${c.label}: ${format(v)}`}
                        onClick={onSelect ? () => onSelect(isSel ? null : { row: r.key, col: c.key }) : undefined}
                        onPointerEnter={(e) => show(e.currentTarget, cell?.readout || { title: `${r.label} · ${c.label}`, rows: [{ value: format(v), label: '', strong: true }] })}
                        onPointerLeave={hide}
                        onFocus={(e) => show(e.currentTarget, cell?.readout || { title: `${r.label} · ${c.label}`, rows: [{ value: format(v), label: '', strong: true }] })}
                        onBlur={hide}
                      >
                        <span className="num">{v ? format(v) : '·'}</span>
                      </button>
                    </td>
                  );
                })}
                <td className="r num viz-grid-total">{format(r.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="viz-grid-rowhead">All</th>
              {cols.map((c) => <td key={c.key} className="c num viz-grid-total">{format(c.total)}</td>)}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="viz-scale" aria-hidden="true">
        <span>fewer</span>
        {STEPS.map((a) => <i key={a} style={{ background: `rgba(var(--viz-1-rgb), ${a})` }} />)}
        <span>more</span>
      </div>
      <Tip tip={tip} />
    </div>
  );
}
