// propSlice — the Universe `propTreatyDetail` slice (same camelCase keys as
// PropTreatyDetail.jsx) hydrated from the broking API bundle, and the PUT
// /prop-detail payload built from it. Pure, so the screen and its tests share it.
import { cleanNum, numOrNull, dateInputValue } from './format';
import { ALLOWED_PROP_TYPES } from '../../screens/proportional/treaty_detail/propTreatyHelpers';
import { defaultRenewalDate } from '../../../../shared/broking/calcs.js';

export const PROP_TYPE_NAMES = ALLOWED_PROP_TYPES;
export const EMPTY_LP_SLIDES = () => Array.from({ length: 5 }, () => ({ minLr: '', maxLr: '', share: '' }));

const has = (v) => v != null && String(v).trim() !== '';

/** Universe propTreatyHelpers.extractLpSlides, in the API's camelCase shape. */
export function extractLpSlides(lpSlides) {
  return (lpSlides || [])
    .filter((r) => r && (has(r.minLr) || has(r.maxLr) || has(r.share)))
    .map((r) => ({ minLr: numOrNull(r.minLr), maxLr: numOrNull(r.maxLr), share: numOrNull(r.share) }));
}

/** Bundle (GET /contracts/:id) → slice. Mirrors the Universe hydration block. */
export function sliceFromBundle(b) {
  const h = b?.header || {}; const pd = b?.propDetail || {};
  const d = pd.detail || {}; const cm = pd.commissions || {}; const lp = pd.lossParticipation || {};
  const inceptionDate = dateInputValue(h.inceptionDate || '');
  const renewalDate = dateInputValue(h.renewalDate || '');
  const slides = Array.isArray(lp.slides) ? lp.slides : [];
  return {
    countryId: h.countryId || '', cedantId: h.cedantId || '', treatyTypeId: h.treatyTypeId || '', classIds: h.classIds || [],
    brokerId: h.brokerId || '', currencyId: h.currencyId || '', altContractId: h.altContractId || '',
    inceptionDate, renewalDate, experienceStartYear: h.experienceStartYear ? String(h.experienceStartYear) : '',
    // Universe: a saved renewal that is not inception + 12 months was set by hand — keep it on inception edits.
    _renewalManual: !!(inceptionDate && renewalDate && defaultRenewalDate(inceptionDate) !== renewalDate),
    triangulationsAvailable: d.triangulationsAvailable !== false,
    qsLimit: cleanNum(d.qsLimit), retentionPct: cleanNum(d.retentionPct), cessionPct: cleanNum(d.cessionPct),
    surplusMaxRetention: cleanNum(d.surplusMaxRetention), numLines: cleanNum(d.numLines),
    eventLimit: cleanNum(d.eventLimit), aal: cleanNum(d.aal), quotaShareEpi: cleanNum(d.quotaShareEpi), surplusEpi: cleanNum(d.surplusEpi),
    brokeragePct: cleanNum(d.brokeragePct), taxesPct: cleanNum(d.taxesPct), lossCapPct: cleanNum(d.lossCapPct),
    commissionMode: String(cm.mode || 'FIXED').toLowerCase().includes('slid') ? 'sliding' : 'fixed',
    fixedCommissionQSPct: cleanNum(cm.fixedCommissionQSPct), fixedCommissionSurplusPct: cleanNum(cm.fixedCommissionSurplusPct),
    provisionalCommissionPct: cleanNum(cm.provisionalCommissionPct),
    slidingMinLossRatio: cleanNum(cm.slidingMinLossRatio), slidingMaxLossRatio: cleanNum(cm.slidingMaxLossRatio),
    slidingMinCommission: cleanNum(cm.slidingMinCommission), slidingMaxCommission: cleanNum(cm.slidingMaxCommission),
    slidingTable: (cm.slidingTable || []).map((r) => ({ lossRatioPct: cleanNum(r.lossRatioPct), commissionPct: cleanNum(r.commissionPct) })),
    mgmtExpensesPct: cleanNum(cm.mgmtExpensesPct), profitCommissionPct: cleanNum(cm.profitCommissionPct),
    lcfYears: cm.lcfExtinction && !cm.lcfYears ? 'extinction' : (cm.lcfYears ? String(cm.lcfYears) : ''),
    lossPartEnabled: lp.enabled === true,
    minLossRatioPct: cleanNum(lp.minLossRatioPct), maxLossRatioPct: cleanNum(lp.maxLossRatioPct), reinsurerSharePct: cleanNum(lp.reinsurerSharePct),
    lpSlides: slides.length
      ? [...slides.map((r) => ({ minLr: cleanNum(r.minLr), maxLr: cleanNum(r.maxLr), share: cleanNum(r.share) })), ...EMPTY_LP_SLIDES()].slice(0, 5)
      : EMPTY_LP_SLIDES(),
    epiSplit: (pd.epiSplit || []).map((r) => ({ classId: r.classId, premium: cleanNum(r.premium) })),
  };
}

/** Slice → PUT /contracts/:id/prop-detail body (header + detail + commissions + LP + EPI split). */
export function payloadFromSlice(s) {
  const classIds = s.classIds || [];
  const totalEpi = (numOrNull(s.quotaShareEpi) || 0) + (numOrNull(s.surplusEpi) || 0);
  let epiSplit = (s.epiSplit || []).filter((r) => classIds.includes(r.classId)).map((r) => ({ classId: r.classId, premium: numOrNull(r.premium) }));
  // Universe: never opened the split → equal split across the classes.
  if (!epiSplit.length && classIds.length && totalEpi > 0) {
    const share = totalEpi / classIds.length;
    epiSplit = classIds.map((cid) => ({ classId: cid, premium: share }));
  }
  const sliding = (s.slidingTable || []).filter((r) => has(r.lossRatioPct) && has(r.commissionPct))
    .map((r) => ({ lossRatioPct: numOrNull(r.lossRatioPct), commissionPct: numOrNull(r.commissionPct) }));
  return {
    header: {
      countryId: s.countryId || null, cedantId: s.cedantId || null, brokerId: s.brokerId || null, currencyId: s.currencyId || null,
      treatyTypeId: s.treatyTypeId || null, classIds, altContractId: s.altContractId || null,
      inceptionDate: s.inceptionDate || null, renewalDate: s.renewalDate || null, experienceStartYear: numOrNull(s.experienceStartYear),
    },
    detail: {
      triangulationsAvailable: s.triangulationsAvailable !== false,
      qsLimit: numOrNull(s.qsLimit), retentionPct: numOrNull(s.retentionPct), cessionPct: numOrNull(s.cessionPct),
      surplusMaxRetention: numOrNull(s.surplusMaxRetention), numLines: numOrNull(s.numLines),
      eventLimit: numOrNull(s.eventLimit), aal: numOrNull(s.aal), quotaShareEpi: numOrNull(s.quotaShareEpi), surplusEpi: numOrNull(s.surplusEpi),
      brokeragePct: numOrNull(s.brokeragePct), taxesPct: numOrNull(s.taxesPct), lossCapPct: numOrNull(s.lossCapPct),
    },
    commissions: {
      mode: s.commissionMode === 'sliding' ? 'SLIDING' : 'FIXED',
      fixedCommissionQSPct: numOrNull(s.fixedCommissionQSPct), fixedCommissionSurplusPct: numOrNull(s.fixedCommissionSurplusPct),
      provisionalCommissionPct: numOrNull(s.provisionalCommissionPct),
      slidingMinLossRatio: numOrNull(s.slidingMinLossRatio), slidingMaxLossRatio: numOrNull(s.slidingMaxLossRatio),
      slidingMinCommission: numOrNull(s.slidingMinCommission), slidingMaxCommission: numOrNull(s.slidingMaxCommission),
      mgmtExpensesPct: numOrNull(s.mgmtExpensesPct), profitCommissionPct: numOrNull(s.profitCommissionPct),
      lcfYears: s.lcfYears === 'extinction' ? null : numOrNull(s.lcfYears), lcfExtinction: s.lcfYears === 'extinction',
      slidingTable: sliding,
    },
    lossParticipation: {
      enabled: s.lossPartEnabled === true,
      minLossRatioPct: numOrNull(s.minLossRatioPct), maxLossRatioPct: numOrNull(s.maxLossRatioPct), reinsurerSharePct: numOrNull(s.reinsurerSharePct),
      slides: extractLpSlides(s.lpSlides),
    },
    epiSplit,
  };
}
