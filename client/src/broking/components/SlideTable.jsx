// SlideTable — the manual-entry modal body for a sliding-scale commission
// (Loss Ratio % → Commission %, 10 rows pre-filled, + Add Row, ✕ per row,
// Provisional Commission % above; ≥2 complete rows to save) and for stepped loss
// participation (5 corridors: Min LR %, Max LR %, Re Share %; max > min).
// Behaviour follows Universe PropTreatyModals.SlidingScaleModal and the inline LP
// slides modal in PropTreatyDetail.jsx.
import { useState } from 'react';
import NumericInput from './NumericInput';
import Button from './Button';
import { numOrNull } from '../lib/format';

const has = (v) => v != null && String(v).trim() !== '';
const emptySlide = () => ({ lossRatioPct: '', commissionPct: '' });
const emptyCorridor = () => ({ minLr: '', maxLr: '', share: '' });

export function completeSlideRows(rows) {
  return (rows || []).filter((r) => has(r.lossRatioPct) && has(r.commissionPct));
}
export function completeCorridors(rows) {
  return (rows || []).filter((r) => has(r.minLr) || has(r.maxLr) || has(r.share));
}
export function corridorErrors(rows) {
  const errors = [];
  completeCorridors(rows).forEach((r, i) => {
    if (!(has(r.minLr) && has(r.maxLr) && has(r.share))) errors.push(`Corridor ${i + 1}: enter Min LR %, Max LR % and Re Share %`);
    else if (!(numOrNull(r.maxLr) > numOrNull(r.minLr))) errors.push(`Corridor ${i + 1}: Max LR % must be greater than Min LR %`);
  });
  return errors;
}

export default function SlideTable({ kind = 'sliding', rows: initialRows, provisional, onSave, onCancel }) {
  const [rows, setRows] = useState(() => {
    const r = Array.isArray(initialRows) ? initialRows.map((x) => ({ ...x })) : [];
    if (kind === 'sliding') { while (r.length < 10) r.push(emptySlide()); }
    else { while (r.length < 5) r.push(emptyCorridor()); r.length = 5; }
    return r;
  });
  const [provPct, setProvPct] = useState(provisional ?? '');
  const [error, setError] = useState('');
  const update = (i, key, val) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, [key]: val } : r)));
  const remove = (i) => setRows((cur) => cur.filter((_, j) => j !== i));

  function save() {
    if (kind === 'sliding') {
      const complete = completeSlideRows(rows);
      if (complete.length < 2) { setError('Enter at least 2 complete rows (Loss Ratio % and Commission %).'); return; }
      onSave(complete, provPct);
    } else {
      const errors = corridorErrors(rows);
      if (errors.length) { setError(errors[0]); return; }
      onSave(completeCorridors(rows));
    }
  }

  if (kind === 'corridors') {
    return (
      <>
        <p className="ab-help">Define up to 5 corridors with different reinsurer shares. Leave unused rows blank.</p>
        <div className="ab-inline-fields" role="table" aria-label="Loss participation corridors">
          <span /><span className="ab-th">Min LR %</span><span className="ab-th">Max LR %</span><span className="ab-th">Re Share %</span>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'contents' }}>
              <span className="ab-rn">{i + 1}</span>
              <NumericInput kind="pct" max={1000} value={r.minLr} onChange={(v) => update(i, 'minLr', v)} placeholder="e.g. 70%" aria-label={`Corridor ${i + 1} minimum loss ratio`} />
              <NumericInput kind="pct" max={1000} value={r.maxLr} onChange={(v) => update(i, 'maxLr', v)} placeholder="e.g. 100%" aria-label={`Corridor ${i + 1} maximum loss ratio`} />
              <NumericInput kind="pct" value={r.share} onChange={(v) => update(i, 'share', v)} placeholder="e.g. 50%" aria-label={`Corridor ${i + 1} reinsurer share`} />
            </div>
          ))}
        </div>
        {error && <div className="ab-umr-status is-bad" role="alert">{error}</div>}
        <div className="ab-actions">
          <Button onClick={() => setRows(Array.from({ length: 5 }, emptyCorridor))}>Clear all</Button>
          {onCancel && <Button onClick={onCancel}>Cancel</Button>}
          <Button variant="primary" onClick={save}>Save corridors</Button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="ab-fr"><label htmlFor="slide-prov">Provisional Commission %<span className="ab-req" aria-hidden="true">*</span></label>
        <NumericInput id="slide-prov" kind="pct" value={provPct} onChange={setProvPct} placeholder="e.g. 30%" /></div>
      <div className="ab-table-wrap">
        <table className="ab-table" style={{ width: '100%' }} aria-label="Sliding scale rows">
          <thead><tr><th>Loss ratio %</th><th>Commission %</th><th aria-label="Remove" /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><NumericInput kind="pct" max={1000} className="ab-cell" value={r.lossRatioPct} onChange={(v) => update(i, 'lossRatioPct', v)} placeholder="e.g. 65%" aria-label={`Row ${i + 1} loss ratio`} /></td>
                <td><NumericInput kind="pct" className="ab-cell" value={r.commissionPct} onChange={(v) => update(i, 'commissionPct', v)} placeholder="e.g. 30%" aria-label={`Row ${i + 1} commission`} /></td>
                <td className="ab-center"><button type="button" className="ab-btn ghost sm" aria-label={`Remove row ${i + 1}`} onClick={() => remove(i)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <div className="ab-umr-status is-bad" role="alert">{error}</div>}
      <div className="ab-actions" style={{ justifyContent: 'space-between' }}>
        <Button size="sm" onClick={() => setRows((cur) => [...cur, emptySlide()])}>+ Add Row</Button>
        <span className="ab-row-actions">
          <span className="ab-help">{completeSlideRows(rows).length} complete row(s)</span>
          {onCancel && <Button onClick={onCancel}>Cancel</Button>}
          <Button variant="primary" onClick={save}>Save table</Button>
        </span>
      </div>
    </>
  );
}
