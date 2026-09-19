// client/src/broking/steps.js — the capture path per business type (WizardShell README):
// Setup (Identify, Treaty Detail | Contract Details), Structure (NP only), Placement (later).
import { propMissingRequiredFields, npMissingRequiredFields, treatyModeFromType, isStopLossType, isAggregateXlType } from '../../../shared/broking/calcs.js';

const PLACEMENT = [
  { key: 'documents', label: 'Documents', group: 'Placement', disabled: true, title: 'Placement steps arrive later' },
  { key: 'markets', label: 'Markets', group: 'Placement', disabled: true, title: 'Placement steps arrive later' },
];

export const STEP_DEFS = {
  PROPORTIONAL: [
    { key: 'identify', label: 'Identify', group: 'Setup' },
    { key: 'treaty-detail', label: 'Treaty Detail', group: 'Setup' },
    ...PLACEMENT,
  ],
  NON_PROPORTIONAL: [
    { key: 'identify', label: 'Identify', group: 'Setup' },
    { key: 'contract-details', label: 'Contract Details', group: 'Setup' },
    { key: 'structure', label: 'Layers', group: 'Structure' },
    ...PLACEMENT,
  ],
};

export function stepsFor(businessType) { return STEP_DEFS[businessType] || STEP_DEFS.PROPORTIONAL; }
export function firstCaptureStep(businessType) { return businessType === 'NON_PROPORTIONAL' ? 'contract-details' : 'treaty-detail'; }
export function isValidStep(businessType, key) { return stepsFor(businessType).some((s) => s.key === key && !s.disabled); }
export function adjacentSteps(businessType, key) {
  const steps = stepsFor(businessType).filter((s) => !s.disabled);
  const i = steps.findIndex((s) => s.key === key);
  return { prev: i > 0 ? steps[i - 1] : null, next: i >= 0 && i < steps.length - 1 ? steps[i + 1] : null };
}

/** Header pill text per screen (capture-flow.md). */
export function headerPill(businessType, step) {
  if (step === 'identify') return `${businessType === 'NON_PROPORTIONAL' ? 'NON-PROPORTIONAL' : 'PROPORTIONAL'} TREATY: IDENTIFY`;
  if (step === 'treaty-detail') return 'PROPORTIONAL TREATY: TREATY DETAIL';
  if (step === 'contract-details') return 'NON-PROPORTIONAL TREATY: CONTRACT DETAILS';
  if (step === 'structure') return 'NON-PROPORTIONAL TREATY: STRUCTURE';
  return 'TREATY';
}

/** Universe camelCase slice from an API bundle (the shape propMissingRequiredFields reads). */
export function propSliceFromBundle(b) {
  const h = b?.header || {}, d = b?.propDetail?.detail || {}, c = b?.propDetail?.commissions || {}, lp = b?.propDetail?.lossParticipation || {};
  return {
    countryId: h.countryId, cedantId: h.cedantId, treatyTypeId: h.treatyTypeId, classIds: h.classIds || [], brokerId: h.brokerId, currencyId: h.currencyId,
    inceptionDate: h.inceptionDate, experienceStartYear: h.experienceStartYear,
    qsLimit: d.qsLimit, retentionPct: d.retentionPct, quotaShareEpi: d.quotaShareEpi, surplusMaxRetention: d.surplusMaxRetention, numLines: d.numLines, surplusEpi: d.surplusEpi,
    commissionMode: String(c.mode || 'FIXED').toLowerCase(), fixedCommissionQSPct: c.fixedCommissionQSPct, fixedCommissionSurplusPct: c.fixedCommissionSurplusPct,
    slidingMinLossRatio: c.slidingMinLossRatio, slidingMaxLossRatio: c.slidingMaxLossRatio, slidingMinCommission: c.slidingMinCommission, slidingMaxCommission: c.slidingMaxCommission,
    provisionalCommissionPct: c.provisionalCommissionPct, slidingTable: c.slidingTable || [],
    lossPartEnabled: lp.enabled === true, minLossRatioPct: lp.minLossRatioPct, maxLossRatioPct: lp.maxLossRatioPct, reinsurerSharePct: lp.reinsurerSharePct,
  };
}

export function headerSliceFromBundle(b) {
  const h = b?.header || {};
  return { countryId: h.countryId, cedantId: h.cedantId, treatyTypeId: h.treatyTypeId, classIds: h.classIds || [], brokerId: h.brokerId, currencyId: h.currencyId, inceptionDate: h.inceptionDate, experienceStartYear: h.experienceStartYear };
}

/** Missing required labels per step, from the saved bundle. */
export function missingByStep(bundle) {
  if (!bundle) return {};
  const out = { identify: [] };
  if (bundle.businessType === 'PROPORTIONAL') {
    const s = propSliceFromBundle(bundle);
    out['treaty-detail'] = propMissingRequiredFields(s, { tMode: treatyModeFromType(bundle.header?.treatyTypeName), commMode: s.commissionMode });
  } else {
    out['contract-details'] = npMissingRequiredFields(headerSliceFromBundle(bundle));
    const typeName = bundle.header?.treatyTypeName || '';
    const layers = bundle.npStructure?.layers || [];
    const missing = [];
    if (!layers.length) missing.push('Structure (at least one layer)');
    layers.forEach((l, i) => {
      if (isStopLossType(typeName)) { if (!(l.epi > 0)) missing.push(`Layer ${i + 1} EPI`); }
      else if (isAggregateXlType(typeName)) { if (!(l.aggregateLimit > 0)) missing.push(`Layer ${i + 1} Aggregate Limit`); }
      else if (!(l.limit > 0)) missing.push(`Layer ${i + 1} Limit`);
    });
    out.structure = missing;
  }
  return out;
}

/** Sidebar steps with their dot state. `attempted` = steps whose last save found missing fields. */
export function stepsWithState(bundle, attempted = new Set()) {
  const missing = missingByStep(bundle);
  return stepsFor(bundle?.businessType).map((s) => {
    if (s.disabled) return { ...s, state: 'todo' };
    if (s.key === 'identify') return { ...s, state: bundle ? 'done' : 'todo' };
    const m = missing[s.key];
    const state = m && m.length === 0 ? 'done' : attempted.has(s.key) ? 'missing' : 'todo';
    return { ...s, state };
  });
}
