// npSlice — the non-proportional screens' state shapes: the Contract Details
// header slice (Universe npTreatyDetail left pane keys) and the Structure slice
// (programme strip + Universe LayerRow strings), hydrated from the API bundle,
// plus the PUT payloads. Pure, shared by the screens, the reducer and the tests.
import { cleanNum, numOrNull, dateInputValue } from './format';
import { strOrEmpty, strRate, emptyLayer } from '../../screens/non_proportional/structure/NpStructureHelpers';
import { defaultRenewalDate, isStopLossType, isAggregateXlType } from '../../../../shared/broking/calcs.js';

export const NP_TYPE_NAMES = new Set(['Risk XL', 'CAT XL', 'Risk & CAT XL', 'Stop Loss', 'Aggregate XL']);
export const MAX_LAYERS = 20;
export const XL_TYPES = ['Gross XL', 'Net XL'];
export const ACCOUNTING_METHODS = ['Losses Occurring', 'Risks Attaching'];
export const ACCOUNTS = ['Half yearly', 'Quarterly', 'Annual'];

/* ── Contract Details (header) ── */
export function headerSliceFromBundle(b) {
  const h = b?.header || {};
  const inceptionDate = dateInputValue(h.inceptionDate || '');
  const renewalDate = dateInputValue(h.renewalDate || '');
  return {
    countryId: h.countryId || '', cedantId: h.cedantId || '', treatyTypeId: h.treatyTypeId || '', classIds: h.classIds || [],
    brokerId: h.brokerId || '', currencyId: h.currencyId || '', altContractId: h.altContractId || '',
    inceptionDate, renewalDate, experienceStartYear: h.experienceStartYear ? String(h.experienceStartYear) : '',
    _renewalManual: !!(inceptionDate && renewalDate && defaultRenewalDate(inceptionDate) !== renewalDate),
  };
}

export function headerPayloadFromSlice(s) {
  return {
    header: {
      countryId: s.countryId || null, cedantId: s.cedantId || null, brokerId: s.brokerId || null, currencyId: s.currencyId || null,
      treatyTypeId: s.treatyTypeId || null, classIds: s.classIds || [], altContractId: s.altContractId || null,
      inceptionDate: s.inceptionDate || null, renewalDate: s.renewalDate || null, experienceStartYear: numOrNull(s.experienceStartYear),
    },
  };
}

/* ── Structure: API layer → Universe LayerRow (strings; Universe structureHydration) ── */
export function layerRowFromApi(l, i) {
  const n = l?.numReinstatements;
  return {
    ...emptyLayer(i),
    layer: i + 1,
    limit: strOrEmpty(l.limit), deductible: strOrEmpty(l.attachment), annualAggLimit: strOrEmpty(l.aggregateLimit), egnpi: strOrEmpty(l.egnpi),
    rate: strRate(l.rate),                                   // plain number from the DB → bare string for the rate cell
    earnedPremium: strOrEmpty(l.earnedPremium), mdp: strOrEmpty(l.mdp), mdpPct: '',
    reinstatements: n === -1 || n === 'UNLIMITED' ? 'UNLIMITED' : strOrEmpty(n),
    reinstatementPct: strOrEmpty(l.reinstatementPct),
    aad: l.aad === true, aadAmount: strOrEmpty(l.aadAmount),
    riskCover: l.riskCover !== undefined ? !!l.riskCover : true, catCover: l.catCover !== undefined ? !!l.catCover : true,
    rol: '', classOfBusinessIds: l.classIds || [],
    attachLrPct: strOrEmpty(l.attachLrPct), limitLrPct: strOrEmpty(l.limitLrPct), epi: strOrEmpty(l.epi), aggregateDeductible: strOrEmpty(l.aggregateDeductible),
  };
}

export function programmeFromBundle(b) {
  const p = b?.npStructure?.programme || {};
  return {
    deductible: cleanNum(p.deductible), xlType: p.xlType || '', accountingMethod: p.accountingMethod || '', accounts: p.accounts || '',
    estGnpi: cleanNum(p.estGnpi), brokeragePct: cleanNum(p.brokeragePct), taxesPct: cleanNum(p.taxesPct),
    noClaimsBonusPct: cleanNum(p.noClaimsBonusPct), profitCommissionPct: cleanNum(p.profitCommissionPct),
  };
}

/** Layer rows from the bundle; a contract with no layers yet starts with one blank layer (EGNPI = Est. GNPI). */
export function layersFromBundle(b) {
  const apiLayers = b?.npStructure?.layers || [];
  if (apiLayers.length) return apiLayers.map(layerRowFromApi);
  const first = emptyLayer(0);
  first.egnpi = cleanNum(b?.npStructure?.programme?.estGnpi);
  return [first];
}

const num = numOrNull;
/** Structure slice → PUT /contracts/:id/np-structure body. Derived columns are never sent. */
export function structurePayloadFromSlice({ programme, layers }, typeName) {
  const p = programme || {};
  const stopLoss = isStopLossType(typeName); const aggXl = isAggregateXlType(typeName);
  return {
    programme: {
      deductible: num(p.deductible), xlType: p.xlType || null, accountingMethod: p.accountingMethod || null, accounts: p.accounts || null,
      estGnpi: num(p.estGnpi), brokeragePct: num(p.brokeragePct), taxesPct: num(p.taxesPct), noClaimsBonusPct: num(p.noClaimsBonusPct), profitCommissionPct: num(p.profitCommissionPct),
    },
    layers: (layers || []).map((l, i) => ({
      layerNumber: i + 1,
      limit: stopLoss ? null : num(l.limit), aggregateLimit: num(l.annualAggLimit), egnpi: num(l.egnpi),
      rate: num(String(l.rate ?? '').replace(/%/g, '')), mdp: num(l.mdp),
      numReinstatements: l.reinstatements === 'UNLIMITED' ? 'UNLIMITED' : num(l.reinstatements),
      reinstatementPct: num(l.reinstatementPct),
      aad: l.aad === true, aadAmount: l.aad === true ? num(l.aadAmount) : null,
      riskCover: l.riskCover !== false, catCover: l.catCover !== false,
      ...(l.classOfBusinessIds?.length ? { classIds: l.classOfBusinessIds } : {}),
      attachLrPct: num(l.attachLrPct), limitLrPct: num(l.limitLrPct), epi: num(l.epi),
      aggregateDeductible: num(l.aggregateDeductible),
      ...(aggXl ? { attachment: num(l.deductible) } : {}),
    })),
  };
}

/** Missing required items on the Structure step (same rule as steps.missingByStep, on the live rows). */
export function structureMissing(layers, typeName) {
  const missing = [];
  if (!layers?.length) missing.push('Structure (at least one layer)');
  (layers || []).forEach((l, i) => {
    if (isStopLossType(typeName)) { if (!(num(l.epi) > 0)) missing.push(`Layer ${i + 1} EPI`); }
    else if (isAggregateXlType(typeName)) { if (!(num(l.annualAggLimit) > 0)) missing.push(`Layer ${i + 1} Aggregate Limit`); }
    else if (!(num(l.limit) > 0)) missing.push(`Layer ${i + 1} Limit`);
  });
  return missing;
}
