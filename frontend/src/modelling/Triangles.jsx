import React, { useEffect, useMemo, useState } from 'react';
import { ModScreen, SaveBar, Toggle, Notice, useSaveMsg, pasteGrid } from './bits.jsx';
import { useModelling, useScreenSave, triangleCellsOf, incurredCellsOf } from './store.jsx';
import { parseFlexibleNumber } from './engine.js';

/* Triangle screen — ported from the modelling tool's TriangleScreen: the
   editable cumulative triangle shared by the Premium / Claims Paid / OS
   Claims tabs, with Modified and Actual variants held together and the
   Incurred tab a read-only derived (paid + OS) view. The grid is UW years ×
   development years; cells below the diagonal don't exist yet. Paste from
   Excel fills from the focused cell, skipping anything off the triangle. */

const TYPES = {
  premium: { title: 'Premium Triangle', pill: 'PROPORTIONAL TREATY: PREMIUM TRIANGLE' },
  paid: { title: 'Claims Paid Triangle', pill: 'PROPORTIONAL TREATY: CLAIMS PAID TRIANGLE' },
  os: { title: 'OS Claims Triangle', pill: 'PROPORTIONAL TREATY: OS CLAIMS TRIANGLE' },
  incurred: { title: 'Incurred Claims Triangle', pill: 'PROPORTIONAL TREATY: INCURRED CLAIMS TRIANGLE' },
};

const fmtCell = (v) => {
  if (v == null || v === '') return '';
  const n = typeof v === 'number' ? v : parseFlexibleNumber(v);
  if (n == null) return String(v);
  return n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: n % 1 === 0 ? 0 : 2 });
};

function cellsToGrid(cells, years, devLen) {
  const grid = years.map(() => new Array(devLen).fill(''));
  for (const c of cells) {
    const r = years.indexOf(Number(c.origin_year));
    const d = Math.round(Number(c.dev_months) / 12) - 1;
    if (r >= 0 && d >= 0 && d < devLen) grid[r][d] = fmtCell(c.cum_value);
  }
  return grid;
}

function gridToCells(grid, years, inTriangle) {
  const cells = [];
  grid.forEach((row, r) => {
    row.forEach((val, c) => {
      if (!inTriangle(r, c)) return;
      const n = parseFlexibleNumber(val);
      if (n !== null) cells.push({ origin_year: years[r], dev_months: (c + 1) * 12, cum_value: n });
    });
  });
  return cells;
}

export default function TriangleScreen({ type }) {
  const mod = useModelling();
  const { meta, get, save } = mod;
  const cfg = TYPES[type];
  const derived = type === 'incurred';
  const section = `triangle_${type}`;

  const { startYear, numDevYears, years } = meta;
  const devYears = useMemo(() => Array.from({ length: numDevYears }, (_, i) => i + 1), [numDevYears]);
  const inTriangle = (r, c) => c <= numDevYears - r - 1;

  const [variant, setVariant] = useState('MODIFIED');
  const [grids, setGrids] = useState({ MODIFIED: [], ACTUAL: [] });
  const [dirty, setDirty] = useState({ MODIFIED: false, ACTUAL: false });
  const [msg, flash] = useSaveMsg();
  const [skipNote, setSkipNote] = useState(null);

  // Hydrate from the store whenever the section (or shape) changes.
  useEffect(() => {
    if (derived) {
      setGrids({
        MODIFIED: cellsToGrid(incurredCellsOf(mod, 'MODIFIED'), years, numDevYears),
        ACTUAL: cellsToGrid(incurredCellsOf(mod, 'ACTUAL'), years, numDevYears),
      });
      return;
    }
    setGrids({
      MODIFIED: cellsToGrid(triangleCellsOf(mod, type, 'MODIFIED'), years, numDevYears),
      ACTUAL: cellsToGrid(triangleCellsOf(mod, type, 'ACTUAL'), years, numDevYears),
    });
    setDirty({ MODIFIED: false, ACTUAL: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.sections, type, startYear, numDevYears]);

  const updateCell = (r, c, val) => {
    setGrids((prev) => {
      const g = prev[variant].map((row) => [...row]);
      g[r][c] = val;
      return { ...prev, [variant]: g };
    });
    setDirty((d) => ({ ...d, [variant]: true }));
  };

  const handleBlur = (r, c) => {
    setGrids((prev) => {
      const raw = prev[variant]?.[r]?.[c];
      const n = parseFlexibleNumber(raw);
      if (n === null) return prev;
      const g = prev[variant].map((row) => [...row]);
      g[r][c] = fmtCell(n);
      return { ...prev, [variant]: g };
    });
  };

  const handlePaste = (e, r, c) => {
    const rows = pasteGrid(e);
    if (!rows) return;
    e.preventDefault();
    let droppedOutOfGrid = 0;
    let droppedOffTriangle = 0;
    let droppedNonNumeric = 0;
    const patches = [];
    rows.forEach((pr, ri) => {
      pr.forEach((val, ci) => {
        const tr = r + ri;
        const tc = c + ci;
        if (tr >= numDevYears || tc >= numDevYears) { droppedOutOfGrid++; return; }
        if (!inTriangle(tr, tc)) { droppedOffTriangle++; return; }
        const parsed = parseFlexibleNumber(val.trim());
        if (parsed === null) {
          if (String(val).trim() !== '') droppedNonNumeric++;
          return;
        }
        patches.push({ tr, tc, val: fmtCell(parsed) });
      });
    });
    if (patches.length) {
      setGrids((prev) => {
        const g = prev[variant].map((row) => [...row]);
        patches.forEach(({ tr, tc, val }) => { g[tr][tc] = val; });
        return { ...prev, [variant]: g };
      });
      setDirty((d) => ({ ...d, [variant]: true }));
    }
    const parts = [];
    if (droppedOutOfGrid) parts.push(`${droppedOutOfGrid} cell${droppedOutOfGrid === 1 ? '' : 's'} past the grid edge`);
    if (droppedOffTriangle) parts.push(`${droppedOffTriangle} cell${droppedOffTriangle === 1 ? '' : 's'} below the triangle diagonal`);
    if (droppedNonNumeric) parts.push(`${droppedNonNumeric} non-numeric value${droppedNonNumeric === 1 ? '' : 's'}`);
    setSkipNote(parts.length ? `Skipped ${parts.join(', ')}.` : null);
  };

  const doSave = async () => {
    if (derived) return true;
    if (!dirty.MODIFIED && !dirty.ACTUAL) return true;
    try {
      await save(section, {
        MODIFIED: { cells: gridToCells(grids.MODIFIED, years, inTriangle) },
        ACTUAL: { cells: gridToCells(grids.ACTUAL, years, inTriangle) },
      });
      setDirty({ MODIFIED: false, ACTUAL: false });
      flash('ok', 'Triangle saved');
      return true;
    } catch (e) {
      flash('err', `Save failed: ${e.message || 'server error'}`);
      return false;
    }
  };
  useScreenSave(mod, doSave);

  const activeGrid = grids[variant] || [];

  return (
    <ModScreen pill={cfg.pill} title={cfg.title}
      sub={derived
        ? 'Read-only derived view — incurred = claims paid + outstanding, cell by cell.'
        : 'Cumulative amounts by underwriting year × development year. Paste from Excel fills from the focused cell.'}
      actions={!derived && (
        <SaveBar dirty={dirty.MODIFIED || dirty.ACTUAL} msg={msg} onSave={doSave} canEdit={meta.canEdit} />
      )}>
      <div className="tri-info-bar">
        <div className="tri-info-item">Start Year <b>{startYear}</b></div>
        <div className="tri-info-item">Inception Year <b>{meta.inceptionYear}</b></div>
        <div className="tri-info-item tri-info-item--accent">Development Years <b>{numDevYears}</b></div>
        <Toggle value={variant} onChange={setVariant}
          options={[['MODIFIED', `Modified${!derived && dirty.MODIFIED ? ' •' : ''}`], ['ACTUAL', `Actual${!derived && dirty.ACTUAL ? ' •' : ''}`]]} />
      </div>

      {skipNote && <Notice tone="warn">{skipNote}</Notice>}

      <div className="np-table-wrap">
        <table className="tri-table">
          <thead>
            <tr>
              <th className="tri-hdr tri-yr-hdr">YEAR</th>
              {devYears.map((d) => <th key={d} className="tri-hdr">{d}</th>)}
            </tr>
          </thead>
          <tbody>
            {years.map((yr, r) => (
              <tr key={yr}>
                <td className="tri-yr">{yr}</td>
                {devYears.map((d, c) => {
                  if (!inTriangle(r, c)) return <td key={d} className="tri-off" />;
                  if (derived || !meta.canEdit) {
                    return (
                      <td key={d} className="tri-cell">
                        <div className="tri-inp tri-inp--derived">{activeGrid[r]?.[c] ?? ''}</div>
                      </td>
                    );
                  }
                  return (
                    <td key={d} className="tri-cell">
                      <input className="tri-inp" type="text" value={activeGrid[r]?.[c] ?? ''}
                        onChange={(e) => updateCell(r, c, e.target.value)}
                        onBlur={() => handleBlur(r, c)}
                        onPaste={(e) => handlePaste(e, r, c)} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {derived && (
        <Notice tone="info">
          Edit the Claims Paid and OS Claims triangles (their own tabs) to change these values —
          {' '}{variant === 'ACTUAL' ? 'Actual' : 'Modified'} incurred = {variant === 'ACTUAL' ? 'Actual' : 'Modified'} paid + outstanding.
        </Notice>
      )}
    </ModScreen>
  );
}
