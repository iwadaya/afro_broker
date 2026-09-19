// client/src/broking/lib/format.js — the Universe formatting helpers the module
// reuses, re-exported from their verbatim copies so one import path serves the
// broking screens.
export { fmtComma, stripDigits, cleanNum, numOrNull, formatWithCommasDecimal, dateInputValue, formatDateTime, formatTime } from '../../utils/format';
export { fmtPctMaybe } from '../../screens/non_proportional/structure/NpStructureHelpers';

/** "Draft saved 14:02" clock. */
export function hhmm(d) {
  const t = d instanceof Date ? d : new Date(d);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

/** Number → input string ('' for null), for hydrating controlled inputs from the API. */
export function inputValue(v) {
  if (v == null || v === '') return '';
  return String(v);
}
