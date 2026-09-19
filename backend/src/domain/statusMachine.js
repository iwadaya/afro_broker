/**
 * Placement & line status machines (design doc §1).
 *
 * Transitions are validated in the service layer before any status write.
 */

export const PLACEMENT_STATUS = {
  DRAFT: 'DRAFT',
  DATA: 'DATA',
  PACK: 'PACK',
  LEAD_MARKETING: 'LEAD_MARKETING',
  QUOTED: 'QUOTED',
  FOT_AGREED: 'FOT_AGREED',
  FOLLOW_MARKETING: 'FOLLOW_MARKETING',
  LINES_WRITTEN: 'LINES_WRITTEN',
  SIGNED: 'SIGNED',
  BOUND: 'BOUND',
  // terminal / branch
  DECLINED: 'DECLINED',
  NTU: 'NTU',
  LAPSED: 'LAPSED',
  INCOMPLETE: 'INCOMPLETE',
};

// Happy-path forward edges.
const FORWARD = {
  DRAFT: ['DATA'],
  DATA: ['PACK'],
  PACK: ['LEAD_MARKETING'],
  LEAD_MARKETING: ['QUOTED'],
  QUOTED: ['FOT_AGREED'],
  FOT_AGREED: ['FOLLOW_MARKETING'],
  FOLLOW_MARKETING: ['LINES_WRITTEN'],
  LINES_WRITTEN: ['SIGNED', 'INCOMPLETE'],
  SIGNED: ['BOUND'],
  INCOMPLETE: ['LINES_WRITTEN', 'SIGNED', 'FOLLOW_MARKETING'],
  BOUND: [],
};

// Branch/terminal edges reachable from most active states.
const TERMINAL_STATES = ['DECLINED', 'NTU', 'LAPSED'];
const ACTIVE_STATES = [
  'DRAFT', 'DATA', 'PACK', 'LEAD_MARKETING', 'QUOTED',
  'FOT_AGREED', 'FOLLOW_MARKETING', 'LINES_WRITTEN', 'INCOMPLETE',
];

/** Set of legal next states for a placement status. */
export function placementTransitions(status) {
  const next = new Set(FORWARD[status] || []);
  if (ACTIVE_STATES.includes(status)) {
    for (const t of TERMINAL_STATES) next.add(t);
  }
  return next;
}

export function canTransitionPlacement(from, to) {
  return placementTransitions(from).has(to);
}

export function assertPlacementTransition(from, to) {
  if (from === to) return;
  if (!Object.values(PLACEMENT_STATUS).includes(to)) {
    throw new StatusError(`Unknown placement status "${to}"`);
  }
  if (!canTransitionPlacement(from, to)) {
    throw new StatusError(`Illegal placement transition ${from} → ${to}`);
  }
}

// ---- Line ledger sub-status (per market, per layer) ----

export const LINE_STATUS = {
  APPROACHED: 'APPROACHED',
  QUOTED: 'QUOTED',
  AGREED: 'AGREED',
  WRITTEN: 'WRITTEN',
  SIGNED: 'SIGNED',
  DECLINED: 'DECLINED',
};

const LINE_FORWARD = {
  APPROACHED: ['QUOTED', 'DECLINED'],
  QUOTED: ['AGREED', 'DECLINED'],
  AGREED: ['WRITTEN', 'DECLINED'],
  WRITTEN: ['SIGNED'],
  SIGNED: [],
  DECLINED: [],
};

export function lineTransitions(status) {
  return new Set(LINE_FORWARD[status] || []);
}

export function canTransitionLine(from, to) {
  return from === to || lineTransitions(from).has(to);
}

export function assertLineTransition(from, to) {
  if (from === to) return;
  if (!Object.values(LINE_STATUS).includes(to)) {
    throw new StatusError(`Unknown line status "${to}"`);
  }
  if (!canTransitionLine(from, to)) {
    throw new StatusError(`Illegal line transition ${from} → ${to}`);
  }
}

export class StatusError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StatusError';
    this.status = 409;
  }
}
