/**
 * Placement lifecycle helpers.
 *
 * The stage list mirrors the backend status machine's happy path, so the UI
 * only ever describes transitions the server already defines.
 */
export const LIFECYCLE = [
  'DRAFT',
  'DATA',
  'PACK',
  'LEAD_MARKETING',
  'QUOTED',
  'FOT_AGREED',
  'FOLLOW_MARKETING',
  'LINES_WRITTEN',
  'SIGNED',
  'BOUND',
];

/** Branch statuses, and the forward stage each one branched from. */
const OFF_PATH = {
  INCOMPLETE: 'LINES_WRITTEN',
  DECLINED: null,
  NTU: null,
  LAPSED: null,
};

export const ACTIVE_STATUSES = [
  'DRAFT', 'DATA', 'PACK', 'LEAD_MARKETING', 'QUOTED',
  'FOT_AGREED', 'FOLLOW_MARKETING', 'LINES_WRITTEN', 'SIGNED', 'INCOMPLETE',
];

export const TERMINAL_STATUSES = ['DECLINED', 'NTU', 'LAPSED'];

/** Every status a filter can offer, in lifecycle order. */
export const ALL_STATUSES = [...LIFECYCLE, 'INCOMPLETE', ...TERMINAL_STATUSES];

/**
 * How far through the lifecycle a placement has travelled, 0–100.
 *
 * An off-path status reports the progress of the stage it branched from, so an
 * INCOMPLETE placement still reads as late-stage work rather than resetting.
 */
export function lifecycleProgress(status) {
  if (!status) return 0;
  if (status === 'BOUND') return 100;
  const anchor = status in OFF_PATH ? OFF_PATH[status] : status;
  if (!anchor) return 0;
  const i = LIFECYCLE.indexOf(anchor);
  return i < 0 ? 0 : Math.round((i / (LIFECYCLE.length - 1)) * 100);
}

/** Progress tone: red in exception, gold while a decision is owed. */
export function progressTone(status) {
  if (['INCOMPLETE', ...TERMINAL_STATUSES].includes(status)) return 'red';
  if (['FOT_AGREED', 'LINES_WRITTEN', 'SIGNED'].includes(status)) return 'gold';
  return 'emerald';
}

/** Whole months between two dates, for the placement period column. */
export function monthsBetween(from, to) {
  const a = from ? new Date(from) : null;
  const b = to ? new Date(to) : null;
  if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  // A period ending the day before its anniversary is still a full term.
  return b.getUTCDate() >= a.getUTCDate() ? months : months + 1;
}
