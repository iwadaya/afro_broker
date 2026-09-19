// EpiSplitModal — the Universe PropTreatyModals.EpiSplitModal: premium per selected
// class, % of total, TOTAL row; the total must be within ±1 of QS EPI + Surplus EPI
// (amber warning otherwise, a second click confirms). Rows pre-fill with an equal
// split when the class has no premium yet.
import { useMemo, useState } from 'react';
import Modal from './Modal';
import Button from './Button';
import { numOrNull, fmtComma } from '../lib/format';
import { fmtCommaDecimal, stripNonNumeric } from '../../screens/proportional/treaty_detail/propTreatyHelpers';

export default function EpiSplitModal({ open, split, classIds = [], classList = [], qsEpi, surplusEpi, currency, onSave, onClose }) {
  const totalRef = (numOrNull(qsEpi) || 0) + (numOrNull(surplusEpi) || 0);
  const [rows, setRows] = useState(() => classIds.map((id) => {
    const existing = (split || []).find((r) => r.classId === id);
    const equalShare = totalRef && classIds.length ? String(Math.round(totalRef / classIds.length)) : '';
    return { classId: id, premium: existing?.premium || equalShare };
  }));
  const [confirm, setConfirm] = useState(false);
  const classMap = useMemo(() => new Map(classList.map((c) => [c.id, c.name])), [classList]);
  const totalSplit = rows.reduce((sum, r) => sum + (numOrNull(r.premium) || 0), 0);
  const mismatch = totalRef > 0 && Math.abs(totalSplit - totalRef) > 1;
  const update = (i, val) => { setConfirm(false); setRows((cur) => cur.map((r, j) => (j === i ? { ...r, premium: stripNonNumeric(val) } : r))); };
  const pct = (v) => (totalRef > 0 && numOrNull(v) ? `${((numOrNull(v) / totalRef) * 100).toFixed(1)}%` : '—');

  function save() {
    if (mismatch && !confirm) { setConfirm(true); return; }
    onSave(rows.map((r) => ({ classId: r.classId, premium: r.premium })));
  }

  return (
    <Modal open={open} onClose={onClose} title="EPI Split by Line of Business" tag={`${rows.length} class(es)`}
      footer={<><span className="ab-help">{currency || ''}</span><span className="ab-right"><Button onClick={onClose}>Cancel</Button><Button variant={mismatch && confirm ? 'warn' : 'primary'} onClick={save} data-testid="epi-split-save">{mismatch && confirm ? 'Save anyway' : 'Save split'}</Button></span></>}>
      <div className="ab-summary" style={{ margin: '0 0 12px' }}>
        <span>QS: <b>{fmtComma(qsEpi) || '—'}</b></span><span className="ab-sep">·</span>
        <span>Surplus: <b>{fmtComma(surplusEpi) || '—'}</b></span><span className="ab-sep">·</span>
        <span>Total: <b>{totalRef ? fmtComma(String(Math.round(totalRef))) : '—'}</b></span>
      </div>
      <div className="ab-table-wrap">
        <table className="ab-table" style={{ width: '100%' }}>
          <thead><tr><th>Line of Business</th><th>Premium</th><th className="ab-right-cell">% of Total</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.classId}>
                <td>{classMap.get(r.classId) || r.classId}</td>
                <td><input className="ab-cell" type="text" inputMode="decimal" placeholder="e.g. 1,000,000" aria-label={`${classMap.get(r.classId) || r.classId} premium`} value={fmtCommaDecimal(r.premium)} onChange={(e) => update(i, e.target.value)} /></td>
                <td className="ab-right-cell">{pct(r.premium)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ fontWeight: 700 }}>
              <td>TOTAL</td>
              <td data-testid="epi-split-total">{totalSplit ? fmtComma(String(Math.round(totalSplit))) : '—'}</td>
              <td className="ab-right-cell" style={{ color: mismatch ? 'var(--ab-warn)' : 'var(--accent-strong)' }}>{totalRef > 0 && totalSplit > 0 ? `${((totalSplit / totalRef) * 100).toFixed(1)}%` : '—'}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {mismatch && (
        <div className="ab-notice warn" role="alert" style={{ marginTop: 10 }}>
          Split total ({fmtComma(String(Math.round(totalSplit)))}) doesn't match EPI total ({fmtComma(String(Math.round(totalRef)))}).{confirm ? ' Save anyway?' : ''}
        </div>
      )}
    </Modal>
  );
}
