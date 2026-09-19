// shared/broking/calcs.test.js — unit tests for the pure calculation library.
// (Cross-checks against the verbatim Universe copies live in calcs.crosscheck.test.js,
// run by the client suite because they import React components.)
import { describe, it, expect } from 'vitest';
import {
  toNumber, clampPct, treatyModeFromType, isQsMode, isSurplusMode,
  cessionFromRetention, retentionFromCession, retentionAmt, cessionAmt, totalCapacity,
  addMonthsClamped, defaultRenewalDate, uwYearFromInception, buildContractDescription,
  perilModeFromTreatyType, isStopLossType, isAggregateXlType, applyPerilMode, perilScopeFromCovers, coversFromPerilScope,
  cascadeDeductibles, rateToFloat, normaliseRate, layerFinancials, computeLayers, layerTotals, fmtPctMaybe,
  stopLossResolve, normaliseUmr, isValidUmr, umrFormatMessage,
  propMissingRequiredFields, npMissingRequiredFields, allowedNextStatuses, canTransition,
} from './calcs.js';

describe('numbers', () => {
  it('toNumber strips commas and % and returns null for blanks', () => {
    expect(toNumber('1,000,000')).toBe(1_000_000);
    expect(toNumber('2.5%')).toBe(2.5);
    expect(toNumber('')).toBeNull(); expect(toNumber(null)).toBeNull(); expect(toNumber('abc')).toBeNull();
    expect(toNumber(7)).toBe(7); expect(toNumber(NaN)).toBeNull();
  });
  it('clampPct clamps to 0..100 and treats blank as 0', () => {
    expect(clampPct('150')).toBe(100); expect(clampPct(-5)).toBe(0); expect(clampPct('')).toBe(0); expect(clampPct('33.3')).toBe(33.3);
  });
});

describe('treatyModeFromType', () => {
  it.each([
    ['Quota Share', 'quota'], ['Quota Share & Surplus', 'both'], ['First Surplus', 'surplus'],
    ['Second Surplus', 'surplus'], ['Third Surplus', 'surplus'], ['Fac Oblig', 'surplus'], ['', 'quota'], [null, 'quota'],
  ])('%s → %s', (name, mode) => { expect(treatyModeFromType(name)).toBe(mode); });
  it('mode helpers', () => {
    expect(isQsMode('quota')).toBe(true); expect(isQsMode('both')).toBe(true); expect(isQsMode('surplus')).toBe(false);
    expect(isSurplusMode('surplus')).toBe(true); expect(isSurplusMode('both')).toBe(true); expect(isSurplusMode('quota')).toBe(false);
  });
});

describe('retention / cession', () => {
  it('always sum to 100 (6 dp)', () => {
    expect(cessionFromRetention('30')).toBe(70); expect(retentionFromCession('70')).toBe(30);
    expect(cessionFromRetention('33.333333')).toBe(66.666667);
    expect(cessionFromRetention('120')).toBe(0); expect(retentionFromCession('')).toBe(100);
  });
  it('amounts round to whole currency and blank without a QS limit', () => {
    expect(retentionAmt('10,000,000', '30')).toBe(3_000_000);
    expect(cessionAmt(10_000_000, 70)).toBe(7_000_000);
    expect(retentionAmt('', 30)).toBeNull(); expect(retentionAmt(0, 30)).toBeNull();
    expect(retentionAmt(1_000_001, 33.3333)).toBe(333_333); // round(333,333.66…)? no: 1,000,001 × 33.3333 / 100 = 333,333.33 → 333,333
  });
  it('total capacity by mode', () => {
    expect(totalCapacity({ mode: 'quota', qsLimit: 10_000_000, surplusMaxRetention: 3_000_000, numLines: 5 })).toBe(10_000_000);
    expect(totalCapacity({ mode: 'both', qsLimit: 10_000_000, surplusMaxRetention: 3_000_000, numLines: 5 })).toBe(25_000_000);
    expect(totalCapacity({ mode: 'surplus', qsLimit: 10_000_000, surplusMaxRetention: 3_000_000, numLines: 5 })).toBe(18_000_000);
    expect(totalCapacity({ mode: 'surplus', qsLimit: '', surplusMaxRetention: '', numLines: '' })).toBeNull();
  });
});

describe('dates and description', () => {
  it('renewal defaults to inception + 12 months, day-clamped', () => {
    expect(defaultRenewalDate('2026-01-01')).toBe('2027-01-01');
    expect(defaultRenewalDate('2024-02-29')).toBe('2025-02-28');
    expect(addMonthsClamped('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonthsClamped('2023-01-31', 1)).toBe('2023-02-28');
    expect(defaultRenewalDate('')).toBe(''); expect(defaultRenewalDate(null)).toBe('');
  });
  it('uw year is the inception year', () => {
    expect(uwYearFromInception('2026-07-01')).toBe(2026); expect(uwYearFromInception('2026-07-01T00:00:00Z')).toBe(2026);
    expect(uwYearFromInception('')).toBeNull(); expect(uwYearFromInception('nope')).toBeNull();
  });
  it('builds the contract description exactly like Universe', () => {
    expect(buildContractDescription({ uwYear: 2026, cedantName: 'Kenya Re', treatyTypeName: 'Quota Share & Surplus', classNames: ['Fire', 'Engineering'], countryCode: 'KE' }))
      .toBe('2026 Kenya Re Quota Share & Surplus (Fire, Engineering) KE');
    expect(buildContractDescription({ uwYear: 2026, cedantName: '', treatyTypeName: 'CAT XL', classNames: [], countryCode: 'KE' })).toBe('2026 CAT XL KE');
    expect(buildContractDescription({})).toBe('');
  });
});

describe('NP peril mode', () => {
  it.each([['Risk XL', 'RISK'], ['CAT XL', 'CAT'], ['cat  xl', 'CAT'], ['Risk & CAT XL', 'BOTH'], ['Stop Loss', 'BOTH'], ['Aggregate XL', 'BOTH'], ['', 'BOTH']])('%s → %s', (n, m) => {
    expect(perilModeFromTreatyType(n)).toBe(m);
  });
  it('detects Stop Loss and Aggregate XL', () => {
    expect(isStopLossType('Stop Loss')).toBe(true); expect(isStopLossType('Aggregate XL')).toBe(false);
    expect(isAggregateXlType('Aggregate XL')).toBe(true); expect(isAggregateXlType('CAT XL')).toBe(false);
  });
  it('forces covers in RISK / CAT and keeps the user choice in BOTH', () => {
    expect(applyPerilMode('RISK', { riskCover: false, catCover: true })).toEqual({ riskCover: true, catCover: false });
    expect(applyPerilMode('CAT', {})).toEqual({ riskCover: false, catCover: true });
    expect(applyPerilMode('BOTH', { riskCover: false, catCover: true })).toEqual({ riskCover: false, catCover: true });
    expect(applyPerilMode('BOTH', {})).toEqual({ riskCover: true, catCover: true });
  });
  it('maps peril_scope both ways', () => {
    expect(perilScopeFromCovers({ riskCover: true, catCover: true })).toBe('BOTH');
    expect(perilScopeFromCovers({ riskCover: false, catCover: true })).toBe('CAT');
    expect(perilScopeFromCovers({ riskCover: true, catCover: false })).toBe('RISK');
    expect(coversFromPerilScope('CAT')).toEqual({ riskCover: false, catCover: true });
  });
});

describe('NP layer maths', () => {
  const layers = [
    { limit: 5_000_000, aggregateLimit: 10_000_000, egnpi: 80_000_000, rate: 1.8, mdp: 1_200_000, reinstatements: '1' },
    { limit: 10_000_000, aggregateLimit: 20_000_000, egnpi: 80_000_000, rate: 1.35, mdp: 900_000, reinstatements: '1' },
    { limit: 15_000_000, aggregateLimit: 30_000_000, egnpi: 80_000_000, rate: 0.9, mdp: 600_000, reinstatements: '2' },
  ];
  it('cascades the deductible: layer 1 = programme deductible, layer n = prev + prev limit', () => {
    expect(cascadeDeductibles(layers, 2_500_000)).toEqual([2_500_000, 7_500_000, 17_500_000]);
  });
  it('keeps the loaded layer-1 attachment when the programme deductible is blank or 0 (Universe audit F2)', () => {
    expect(cascadeDeductibles([{ attachment: 500_000, limit: 1_000_000 }, { limit: 2_000_000 }], '')).toEqual([500_000, 1_500_000]);
    expect(cascadeDeductibles([{ attachment: 500_000, limit: 1_000_000 }], '0')).toEqual([500_000]);
    expect(cascadeDeductibles([{ attachment: 500_000, limit: 1_000_000 }], 600_000)).toEqual([600_000]);
  });
  it('earned premium, MDP% and ROL per layer', () => {
    expect(layerFinancials(layers[0])).toEqual({ earnedPremium: 1_440_000, mdpPct: 1_200_000 / 1_440_000, rol: 1_440_000 / 5_000_000 });
    expect(layerFinancials({ egnpi: 1_000_000, rate: '5%', limit: 500_000, mdp: 10_000 })).toEqual({ earnedPremium: 50_000, mdpPct: 0.2, rol: 0.1 });
    expect(layerFinancials({ egnpi: 0, rate: 5 })).toEqual({ earnedPremium: null, mdpPct: null, rol: null });
    expect(layerFinancials({ egnpi: 1_000_000, rate: 5, limit: 0, mdp: 0 })).toEqual({ earnedPremium: 50_000, mdpPct: null, rol: null });
    // Universe NpStructureHelpers.toNum truncates money inputs to whole currency (EGNPI 1,000,000.9 → 1,000,000).
    expect(layerFinancials({ egnpi: '1,000,000.9', rate: 5 }).earnedPremium).toBe(50_000);
  });
  it('rates: "3%" → 3, blank → 0, normalised to 6 significant figures', () => {
    expect(rateToFloat('3%')).toBe(3); expect(rateToFloat('')).toBe(0); expect(rateToFloat('-1')).toBe(0); expect(rateToFloat('1,000')).toBe(1);
    expect(normaliseRate('1.2345678')).toBe(1.23457); expect(normaliseRate('abc')).toBeNull();
  });
  it('computeLayers sets every derived field', () => {
    const out = computeLayers(layers, 2_500_000);
    expect(out.map((l) => l.attachment)).toEqual([2_500_000, 7_500_000, 17_500_000]);
    expect(out.map((l) => l.earnedPremium)).toEqual([1_440_000, 1_080_000, 720_000]);
    expect(out[2].rol).toBeCloseTo(0.048, 10);
  });
  it('totals row matches the Universe LayerTableCard formulas', () => {
    const t = layerTotals(computeLayers(layers, 2_500_000));
    expect(t.limit).toBe(30_000_000); expect(t.deductible).toBe(2_500_000); expect(t.aggregateLimit).toBe(60_000_000);
    expect(t.egnpi).toBe(80_000_000); expect(t.rate).toBe(4.05); expect(t.earnedPremium).toBe(3_240_000); expect(t.mdp).toBe(2_700_000);
    expect(t.mdpPct).toBeCloseTo(2_700_000 / 3_240_000, 12);
    expect(t.rol).toBeCloseTo((0.018 * 80e6 + 0.0135 * 80e6 + 0.009 * 80e6) / 30e6, 12);
    expect(t.reinstatements).toBe(2);
    expect(layerTotals([layers[0], { ...layers[1], reinstatements: 'UNLIMITED' }]).reinstatements).toBe('Unlimited');
    expect(layerTotals([{ ...layers[0], reinstatements: undefined, numReinstatements: -1 }]).reinstatements).toBe('Unlimited');
    // Universe quirk carried over: a numeric layer AFTER an Unlimited one wins the totals cell.
    expect(layerTotals([{ ...layers[0], reinstatements: 'UNLIMITED' }, layers[1]]).reinstatements).toBe(1);
    expect(layerTotals([]).limit).toBeNull();
  });
  it('ROL total falls back to ΣEP / Σlimit when no rates were entered', () => {
    const t = layerTotals([{ limit: 1_000_000, earnedPremium: 50_000 }, { limit: 1_000_000, earnedPremium: 30_000 }]);
    expect(t.rol).toBeCloseTo(0.04, 12);
  });
  it('fmtPctMaybe formats like Universe', () => {
    expect(fmtPctMaybe(0.2)).toBe('20%'); expect(fmtPctMaybe(0.1)).toBe('10%'); expect(fmtPctMaybe(0.125)).toBe('12.5%');
    expect(fmtPctMaybe(0.12345)).toBe('12.35%'); expect(fmtPctMaybe(0)).toBe(''); expect(fmtPctMaybe(NaN)).toBe('');
  });
});

describe('Stop Loss', () => {
  it('resolves limit and attachment from EPI and the loss ratios', () => {
    expect(stopLossResolve({ epi: 50_000_000, limitLrPct: 20, attachLrPct: 80 })).toEqual({ limit: 10_000_000, attachment: 40_000_000 });
    expect(stopLossResolve({ epi: '', limitLrPct: 20, attachLrPct: 80 })).toEqual({ limit: null, attachment: null });
    expect(stopLossResolve({ epi: 50_000_000, limitLrPct: 20 })).toEqual({ limit: 10_000_000, attachment: null });
  });
});

describe('UMR', () => {
  it('normalises: uppercase, no whitespace', () => {
    expect(normaliseUmr(' b0621 dar26 tr001 ')).toBe('B0621DAR26TR001');
    expect(normaliseUmr(null)).toBe('');
  });
  it('validates the Lloyd\'s format', () => {
    expect(isValidUmr('B0621DAR26TR001')).toBe(true); expect(isValidUmr('b0621dar26tr001')).toBe(true);
    expect(isValidUmr('B0621A')).toBe(true); expect(isValidUmr('B0621ABCDEFGHIJKL')).toBe(true);
    expect(isValidUmr('B0621ABCDEFGHIJKLM')).toBe(false); expect(isValidUmr('B0621')).toBe(false);
    expect(isValidUmr('X0621DAR26TR001')).toBe(false); expect(isValidUmr('B621DAR26TR001')).toBe(false); expect(isValidUmr('B0621DAR-26')).toBe(false);
  });
  it('explains the format as the user types', () => {
    expect(umrFormatMessage('')).toMatch(/B \+ 4-digit/); expect(umrFormatMessage('A123')).toMatch(/starts with B/);
    expect(umrFormatMessage('B12')).toMatch(/4-digit broker/); expect(umrFormatMessage('B0621')).toMatch(/Add 1–12/);
    expect(umrFormatMessage('B0621DAR26TR001')).toBeNull(); expect(umrFormatMessage('B0621' + 'A'.repeat(13))).toMatch(/at most 17/);
    expect(umrFormatMessage('B0621DAR-26')).toMatch(/Format:/);
  });
});

describe('required fields', () => {
  const fullQs = { countryId: 'cy', cedantId: 'ce', treatyTypeId: 'tt', classIds: ['cob-1'], brokerId: 'br', currencyId: 'cu',
    inceptionDate: '2026-01-01', experienceStartYear: 2015, qsLimit: '1000000', retentionPct: '50', quotaShareEpi: '500000',
    commissionMode: 'fixed', fixedCommissionQSPct: '30', lossPartEnabled: false };
  it('empty QS/fixed slice lists every required label but not the surplus or LP fields', () => {
    const m = propMissingRequiredFields({}, { tMode: 'quota', commMode: 'fixed' });
    expect(m).toEqual(expect.arrayContaining(['Country', 'Cedant Name', 'Treaty Type', 'Line of Business', 'Broker', 'Currency', 'Treaty Inception Date', 'Experience Start Year', 'QS 100% Limit', 'Retention %', 'Quota Share EPI', 'Fixed QS Commission %']));
    expect(m).not.toContain('Surplus Max Retention'); expect(m).not.toContain('LP Min Loss Ratio %');
  });
  it('fully-filled QS returns []', () => { expect(propMissingRequiredFields(fullQs, { tMode: 'quota', commMode: 'fixed' })).toEqual([]); });
  it('sliding needs two complete rows', () => {
    const s = { ...fullQs, commissionMode: 'sliding', slidingMinLossRatio: '40', slidingMaxLossRatio: '80', slidingMinCommission: '20', slidingMaxCommission: '35', provisionalCommissionPct: '30', slidingTable: [{ lossRatioPct: '50', commissionPct: '25' }, { lossRatioPct: '60', commissionPct: '' }] };
    expect(propMissingRequiredFields(s, { tMode: 'quota', commMode: 'sliding' })).toContain('Sliding Scale table (need ≥2 complete rows)');
  });
  it('NP contract details', () => {
    expect(npMissingRequiredFields({})).toEqual(['Country', 'Cedant Name', 'Treaty Type', 'Classes of Business', 'Broker', 'Currency', 'Treaty Inception Date', 'Experience Start Year']);
    expect(npMissingRequiredFields({ countryId: 'a', cedantId: 'b', treatyTypeId: 'c', classIds: ['d'], brokerId: 'e', currencyId: 'f', inceptionDate: '2026-01-01', experienceStartYear: 2016 })).toEqual([]);
  });
});

describe('status pipeline', () => {
  it('moves one step forward or exits', () => {
    expect(allowedNextStatuses('DRAFT')).toEqual(['SUBMITTED', 'NTU', 'CANCELLED']);
    expect(allowedNextStatuses('BOUND')).toEqual(['SIGNED', 'NTU', 'CANCELLED']);
    expect(allowedNextStatuses('SIGNED')).toEqual(['NTU', 'CANCELLED']);
    expect(allowedNextStatuses('NTU')).toEqual([]);
    expect(canTransition('DRAFT', 'QUOTED')).toBe(false); expect(canTransition('QUOTED', 'FIRM_ORDER')).toBe(true);
  });
});
