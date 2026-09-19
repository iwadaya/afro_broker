import React, { useEffect, useState } from 'react';
import { ModScreen, SaveBar, useSaveMsg, pasteGrid, basisLabel } from './bits.jsx';
import { useModelling, useScreenSave } from './store.jsx';

/* Event Loss Tables — ported from the modelling tool's PropEventLossTables:
   capture and review catastrophe vendor event loss tables (AIR / RMS) for
   the treaty. One event set per placement: vendor, model version, peril set,
   then the event rows keyed by the vendor's event ID. */

const COLS = [
  ['eventId', 'EVENT ID'],
  ['peril', 'PERIL'],
  ['region', 'REGION / CRESTA'],
  ['returnPeriod', 'RETURN PERIOD (YRS)'],
  ['grossLoss', 'GROSS LOSS'],
  ['netQs', 'NET OF QS'],
  ['netXl', 'NET OF XL'],
  ['ultimateNetLoss', 'ULTIMATE NET LOSS'],
  ['comment', 'COMMENT'],
];

const defaultRows = () => Array.from({ length: 4 }, () => Object.fromEntries(COLS.map(([k]) => [k, ''])));

export default function EventLossTablesScreen() {
  const mod = useModelling();
  const { meta, get, save } = mod;
  const section = 'event_loss_tables';

  const [vendor, setVendor] = useState('');
  const [modelVersion, setModelVersion] = useState('');
  const [perilSet, setPerilSet] = useState('');
  const [rows, setRows] = useState(defaultRows());
  const [dirty, setDirty] = useState(false);
  const [msg, flash] = useSaveMsg();

  useEffect(() => {
    const data = get(section);
    setVendor(data?.vendor || '');
    setModelVersion(data?.modelVersion || '');
    setPerilSet(data?.perilSet || '');
    setRows(Array.isArray(data?.rows) && data.rows.length ? data.rows : defaultRows());
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.sections]);

  const updateRow = (idx, col, val) => {
    setRows((prev) => {
      const n = [...prev];
      n[idx] = { ...n[idx], [col]: val };
      if (idx >= n.length - 1 && val) n.push(Object.fromEntries(COLS.map(([k]) => [k, ''])));
      return n;
    });
    setDirty(true);
  };

  const handlePaste = (e, ri, ci) => {
    const grid = pasteGrid(e);
    if (!grid) return;
    e.preventDefault();
    setRows((prev) => {
      const n = [...prev];
      grid.forEach((pr, rOff) => {
        const rowIdx = ri + rOff;
        while (n.length <= rowIdx) n.push(Object.fromEntries(COLS.map(([k]) => [k, ''])));
        pr.forEach((val, cOff) => {
          const colIdx = ci + cOff;
          if (colIdx < COLS.length) n[rowIdx] = { ...n[rowIdx], [COLS[colIdx][0]]: val.trim() };
        });
      });
      return n;
    });
    setDirty(true);
  };

  const doSave = async () => {
    if (!dirty) return true;
    try {
      const valid = rows.filter((r) => COLS.some(([k]) => String(r[k] || '').trim()));
      await save(section, { vendor, modelVersion, perilSet, rows: valid, updatedAt: new Date().toISOString() });
      setDirty(false);
      flash('ok', 'Event set saved');
      return true;
    } catch (e) {
      flash('err', `Save failed: ${e.message || 'server error'}`);
      return false;
    }
  };
  useScreenSave(mod, doSave);

  return (
    <ModScreen pill={`${basisLabel(meta)} TREATY: EVENT LOSS TABLES`}
      title="Event Loss Capture — Vendor Models"
      sub="Capture and review event loss tables from catastrophe vendor models (AIR, RMS) for this treaty."
      actions={(
        <SaveBar dirty={dirty} msg={msg} onSave={doSave} canEdit={meta.canEdit}
          extra={meta.canEdit && (
            <button type="button" className="np-struct-btn" onClick={() => { setRows(defaultRows()); setDirty(true); }}>
              Clear events
            </button>
          )} />
      )}>
      <div className="tri-info-bar">
        <div className="tri-info-item">Vendor{' '}
          <select className="np-mini-input" style={{ width: 110 }} value={vendor} disabled={!meta.canEdit}
            onChange={(e) => { setVendor(e.target.value); setDirty(true); }}>
            <option value="">Select…</option>
            <option value="AIR">AIR</option>
            <option value="RMS">RMS</option>
          </select>
        </div>
        <div className="tri-info-item">Model / Version{' '}
          <input className="np-mini-input" style={{ width: 220 }} placeholder="e.g. AIR Touchstone v2024.1"
            value={modelVersion} readOnly={!meta.canEdit}
            onChange={(e) => { setModelVersion(e.target.value); setDirty(true); }} />
        </div>
        <div className="tri-info-item">Peril Set / Layer{' '}
          <input className="np-mini-input" style={{ width: 220 }} placeholder="e.g. EQ All CRESTA — Layer"
            value={perilSet} readOnly={!meta.canEdit}
            onChange={(e) => { setPerilSet(e.target.value); setDirty(true); }} />
        </div>
      </div>

      <div className="np-table-wrap">
        <table className="mod-table">
          <thead>
            <tr>{COLS.map(([k, label]) => <th key={k}>{label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {COLS.map(([k], ci) => (
                  <td key={k}>
                    <input className="mod-cell mod-cell--left" value={r[k] || ''} readOnly={!meta.canEdit}
                      onChange={(e) => updateRow(i, k, e.target.value)}
                      onPaste={(e) => handlePaste(e, i, ci)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ModScreen>
  );
}
