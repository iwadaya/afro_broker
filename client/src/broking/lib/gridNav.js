// gridNav — arrow-key navigation between the editable cells of a layer table
// (Universe layer table: arrow keys move between cells). Up/Down always move to
// the same column of the adjacent row; Left/Right move once the caret sits at
// the start/end of the text. Derived (tabindex -1) and disabled cells are skipped.
const CELL = 'input:not([disabled]):not([tabindex="-1"]),select:not([disabled])';

function focusable(td) {
  return td ? td.querySelector(CELL) : null;
}

export function gridKeyDown(e) {
  const t = e.target;
  if (!t || !(t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;
  const dRow = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
  const dCol = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!dRow && !dCol) return;
  if (t.tagName === 'SELECT' && dRow) return;                       // let a select change its own value
  if (dCol && t.tagName === 'INPUT' && t.type !== 'checkbox') {
    const len = (t.value || '').length;
    if (dCol < 0 && t.selectionStart !== 0) return;
    if (dCol > 0 && t.selectionEnd !== len) return;
  }
  const td = t.closest('td'); const tr = td?.parentElement; const body = tr?.parentElement;
  if (!td || !tr || !body) return;
  const rows = Array.from(body.querySelectorAll(':scope > tr'));
  const rowIdx = rows.indexOf(tr);
  let target = null;
  if (dRow) {
    const row = rows[rowIdx + dRow];
    if (row) target = focusable(row.cells[td.cellIndex]);
  } else {
    let ci = td.cellIndex + dCol;
    while (ci >= 0 && ci < tr.cells.length && !target) { target = focusable(tr.cells[ci]); ci += dCol; }
  }
  if (!target) return;
  e.preventDefault();
  target.focus();
  if (target.tagName === 'INPUT' && target.type !== 'checkbox') target.select?.();
}
