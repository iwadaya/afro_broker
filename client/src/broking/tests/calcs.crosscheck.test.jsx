// client/src/broking/tests/calcs.crosscheck.test.jsx — feeds the SAME inputs into the verbatim
// Universe copies under client/src and into shared/broking/calcs.js and compares
// the outputs. Runs in the client suite (jsdom) because the layer-table oracle is
// a React component. Universe formulas that live inline in PropTreatyDetail.jsx
// are quoted here verbatim with their source location.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import * as U from '../../screens/proportional/treaty_detail/propTreatyHelpers.js';
import { recomputeDeductibles, recomputeFinancials, fullRecalc, applyTreatyModeCovers } from '../../screens/non_proportional/structure/state/structureReducer.ts';
import { toNum as uToNum, rateToFloat as uRateToFloat, fmtPctMaybe as uFmtPctMaybe, emptyLayer } from '../../screens/non_proportional/structure/NpStructureHelpers.jsx';
import { getNpTreatyTypeMode, isNpStopLossTreaty, isNpAggregateXlTreaty } from '../../utils/npTreatyType.js';
import { addMonthsClamped as uAddMonths, yearFromDateInput, fmtComma } from '../../utils/format.js';
import LayerTableCard from '../../screens/non_proportional/structure/components/LayerTableCard.jsx';
import { REINSTATEMENT_OPTIONS } from '../../screens/non_proportional/reinstatementOptions.js';
import * as C from '../../../../shared/broking/calcs.js';

afterEach(cleanup);

// Deterministic pseudo-random inputs so the property loops are reproducible.
function rng(seed) { let x = seed; return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; }

describe('cross-check: treaty mode + required fields (propTreatyHelpers.js)', () => {
  const names = ['Quota Share', 'Quota Share & Surplus', 'First Surplus', 'Second Surplus', 'Third Surplus', 'Fac Oblig', 'CAT XL', '', null, 'quota SURPLUS x'];
  it('treatyModeFromType agrees on every canonical and odd name', () => {
    for (const n of names) expect(C.treatyModeFromType(n)).toBe(U.treatyModeFromType(n));
  });
  it('clampPct agrees', () => {
    for (const v of ['', null, '-3', '0', '33.3', '100', '150', 'abc', 42]) expect(C.clampPct(v)).toBe(U.clampPct(v));
  });
  it('getMissingRequiredFields agrees across modes on a grid of partial slices', () => {
    const full = { countryId: 'cy', cedantId: 'ce', treatyTypeId: 'tt', classIds: ['cob-1'], brokerId: 'br', currencyId: 'cu', inceptionDate: '2026-01-01', experienceStartYear: 2015,
      qsLimit: '1000000', retentionPct: '50', quotaShareEpi: '500000', surplusMaxRetention: '3000000', numLines: '5', surplusEpi: '600000',
      fixedCommissionQSPct: '30', fixedCommissionSurplusPct: '28', slidingMinLossRatio: '40', slidingMaxLossRatio: '80', slidingMinCommission: '20', slidingMaxCommission: '35', provisionalCommissionPct: '30',
      slidingTable: [{ lossRatioPct: '50', commissionPct: '25' }, { lossRatioPct: '70', commissionPct: '20' }], lossPartEnabled: true, minLossRatioPct: '70', maxLossRatioPct: '100', reinsurerSharePct: '50' };
    const keys = Object.keys(full);
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const s = { ...full };
      for (const k of keys) if (r() < 0.3) s[k] = Array.isArray(full[k]) ? [] : '';
      if (r() < 0.3) s.lossPartEnabled = false; if (r() < 0.2) delete s.lossPartEnabled;
      if (r() < 0.3) s.slidingTable = [{ lossRatioPct: '50', commissionPct: '25' }];
      const tMode = ['quota', 'surplus', 'both'][i % 3];
      const commMode = i % 2 ? 'fixed' : 'sliding';
      expect(C.propMissingRequiredFields(s, { tMode, commMode })).toEqual(U.getMissingRequiredFields(s, { tMode, commMode }));
    }
  });
});

describe('cross-check: dates (utils/format.js)', () => {
  it('addMonthsClamped agrees on month ends and leap days', () => {
    for (const d of ['2024-01-31', '2024-02-29', '2023-01-31', '2026-12-31', '2026-03-15', '', null]) {
      for (const m of [1, 12, 13, -1]) expect(C.addMonthsClamped(d, m)).toBe(uAddMonths(d, m));
      expect(C.defaultRenewalDate(d)).toBe(U.addMonths(d, 12));
    }
  });
  it('uwYearFromInception agrees with yearFromDateInput', () => {
    for (const d of ['2026-01-01', '2026-07-01T00:00:00Z', '', null, 'garbage']) expect(C.uwYearFromInception(d)).toBe(yearFromDateInput(d));
  });
});

describe('cross-check: PropTreatyDetail.jsx inline formulas (quoted verbatim)', () => {
  // PropTreatyDetail.jsx handleRetPctChange: cessionPct = String(+(100 - clampPct(v)).toFixed(6))
  const uCessionFromRet = (v) => String(+(100 - U.clampPct(v)).toFixed(6));
  // PropTreatyDetail.jsx auto-calc effect: retAmt = qs > 0 ? String(Math.round((qs * rPct) / 100)) : ''
  const uRetAmt = (qsLimit, retentionPct) => { const qs = U.numOrNull(qsLimit) || 0; const rPct = U.clampPct(retentionPct); return qs > 0 ? String(Math.round((qs * rPct) / 100)) : ''; };
  // PropTreatyDetail.jsx auto-calc effect: cap = tMode === 'quota' ? QS : tMode === 'both' ? QS + MR * N : MR + MR * N; capStr = cap ? String(Math.round(cap)) : ''
  const uCap = (tMode, s) => { const QS = U.numOrNull(s.qsLimit) || 0, MR = U.numOrNull(s.surplusMaxRetention) || 0, N = U.numOrNull(s.numLines) || 0; const cap = tMode === 'quota' ? QS : tMode === 'both' ? QS + MR * N : MR + MR * N; return cap ? String(Math.round(cap)) : ''; };
  // PropTreatyDetail.jsx contractDescription: [yr, cedantName, selectedTypeName, cobNames.length ? `(${cobNames.join(', ')})` : '', countryCode].filter(Boolean).join(' ') || ''
  const uDesc = ({ uwYear, cedantName, treatyTypeName, classNames, countryCode }) => [uwYear || '', cedantName, treatyTypeName, classNames.length ? `(${classNames.join(', ')})` : '', countryCode].filter(Boolean).join(' ') || '';

  it('retention/cession pairing, amounts and capacity agree on random inputs', () => {
    const r = rng(11);
    for (let i = 0; i < 500; i++) {
      const ret = r() < 0.1 ? '' : (r() * 130 - 10).toFixed(r() < 0.5 ? 0 : 4);
      expect(String(C.cessionFromRetention(ret))).toBe(uCessionFromRet(ret));
      const qs = r() < 0.1 ? '' : String(Math.floor(r() * 50_000_000));
      expect(String(C.retentionAmt(qs, ret) ?? '')).toBe(uRetAmt(qs, ret));
      const s = { qsLimit: qs, surplusMaxRetention: r() < 0.1 ? '' : String(Math.floor(r() * 5_000_000)), numLines: r() < 0.1 ? '' : String(Math.floor(r() * 10)) };
      for (const tMode of ['quota', 'both', 'surplus']) expect(String(C.totalCapacity({ mode: tMode, ...s }) ?? '')).toBe(uCap(tMode, s));
    }
  });
  it('contract description agrees', () => {
    for (const x of [
      { uwYear: 2026, cedantName: 'Kenya Re', treatyTypeName: 'Quota Share & Surplus', classNames: ['Fire', 'Engineering'], countryCode: 'KE' },
      { uwYear: '', cedantName: '', treatyTypeName: 'CAT XL', classNames: [], countryCode: '' },
      { uwYear: 2025, cedantName: 'Sanlam Re', treatyTypeName: '', classNames: ['Marine'], countryCode: 'ZA' },
    ]) expect(C.buildContractDescription(x)).toBe(uDesc(x));
  });
});

describe('cross-check: NP peril mode (utils/npTreatyType.js)', () => {
  it('agrees with getNpTreatyTypeMode / isNpStopLossTreaty / isNpAggregateXlTreaty', () => {
    for (const n of ['Risk XL', 'CAT XL', 'Risk & CAT XL', 'Stop Loss', 'Aggregate XL', 'cat xl', ' RISK  XL ', '', 'Quota Share']) {
      const shim = { npTreatyDetail: { treatyTypeName: n } };
      expect(C.perilModeFromTreatyType(n)).toBe(getNpTreatyTypeMode(shim));
      expect(C.isStopLossType(n)).toBe(isNpStopLossTreaty(shim));
      expect(C.isAggregateXlType(n)).toBe(isNpAggregateXlTreaty(shim));
    }
  });
  it('applyPerilMode agrees with applyTreatyModeCovers', () => {
    for (const mode of ['RISK', 'CAT', 'BOTH']) for (const l of [{}, { riskCover: false, catCover: true }, { riskCover: true, catCover: false }]) {
      const u = applyTreatyModeCovers([{ ...emptyLayer(0), ...l }], mode)[0];
      expect(C.applyPerilMode(mode, l)).toEqual({ riskCover: u.riskCover, catCover: u.catCover });
    }
  });
});

function universeLayer(i, over) {
  return { ...emptyLayer(i), ...over };
}

describe('cross-check: NP layer maths (structureReducer.ts + NpStructureHelpers.jsx)', () => {
  it('rateToFloat and fmtPctMaybe agree', () => {
    for (const v of ['3%', '3', '', null, '-1', '0.75%', 'abc', '1,000']) expect(C.rateToFloat(v)).toBe(uRateToFloat(v));
    for (const f of [0, 0.1, 0.125, 0.12345, 0.2, 1, 2.5, NaN, -1]) expect(C.fmtPctMaybe(f)).toBe(uFmtPctMaybe(f));
  });
  it('wholeAmount agrees with toNum', () => {
    for (const v of ['1,000,000.9', '12.5', '', null, 'x', '-3.7', 5]) expect(C.wholeAmount(v)).toBe(uToNum(v));
  });
  it('deductible cascade and financials agree on 400 random programmes', () => {
    const r = rng(23);
    for (let i = 0; i < 400; i++) {
      const n = 1 + Math.floor(r() * 6);
      const base = r() < 0.15 ? (r() < 0.5 ? '' : '0') : String(Math.floor(r() * 5_000_000));
      const layers = Array.from({ length: n }, (_, k) => universeLayer(k, {
        limit: r() < 0.1 ? '' : String(Math.floor(r() * 20_000_000)),
        deductible: r() < 0.5 ? String(Math.floor(r() * 3_000_000)) : '',
        egnpi: r() < 0.1 ? '' : String(Math.floor(r() * 100_000_000)),
        rate: r() < 0.1 ? '' : (r() * 5).toFixed(r() < 0.5 ? 2 : 4),
        mdp: r() < 0.2 ? '' : String(Math.floor(r() * 2_000_000)),
      }));
      const uDed = recomputeDeductibles(layers, base).map((l) => l.deductible);
      const cDed = C.cascadeDeductibles(layers.map((l) => ({ limit: l.limit, attachment: l.deductible })), base);
      expect(cDed.map((d) => (d == null ? '' : String(d)))).toEqual(uDed);
      const uFull = fullRecalc(layers, base);
      const cFull = C.computeLayers(layers.map((l) => ({ limit: l.limit, attachment: l.deductible, egnpi: l.egnpi, rate: l.rate, mdp: l.mdp })), base);
      uFull.forEach((ul, k) => {
        expect(String(cFull[k].earnedPremium ?? '')).toBe(ul.earnedPremium);
        expect(C.fmtPctMaybe(cFull[k].rol ?? 0)).toBe(ul.rol);
        expect(C.fmtPctMaybe(cFull[k].mdpPct ?? 0)).toBe(ul.mdpPct);
        expect(String(cFull[k].attachment ?? '')).toBe(ul.deductible);
      });
      const one = recomputeFinancials(layers[0]);
      const c1 = C.layerFinancials({ egnpi: layers[0].egnpi, rate: layers[0].rate, limit: layers[0].limit, mdp: layers[0].mdp });
      expect(String(c1.earnedPremium ?? '')).toBe(one.earnedPremium);
    }
  });
});

describe('cross-check: totals row (LayerTableCard.jsx rendered as the oracle)', () => {
  function universeTotals(layers) {
    const { container } = render(
      <LayerTableCard layers={layers} currency="USD" mode="BOTH" riskLocked={false} catLocked={false} riskPillOn catPillOn
        reinstatementOptions={REINSTATEMENT_OPTIONS} onUpdateLayer={() => {}} onAddLayer={() => {}} onDeleteLastLayer={() => {}} onPaste={() => {}} />,
    );
    const inputs = container.querySelectorAll('tfoot tr input');
    return { limit: inputs[0].value, deductible: inputs[1].value, aggLimit: inputs[2].value, egnpi: inputs[3].value, rate: inputs[4].value,
      earnedPremium: inputs[5].value, mdp: inputs[6].value, mdpPct: inputs[7].value, maxReinstatements: inputs[8].value, rol: inputs[9].value };
  }
  const money = (v) => (v ? fmtComma(String(v)) : '');
  it('sums, max EGNPI, MDP%, ROL and reinstatements agree on random tables', () => {
    const r = rng(31);
    for (let i = 0; i < 40; i++) {
      const n = 1 + Math.floor(r() * 5);
      const raw = Array.from({ length: n }, (_, k) => universeLayer(k, {
        limit: r() < 0.1 ? '' : String(Math.floor(r() * 20_000_000)),
        annualAggLimit: r() < 0.3 ? '' : String(Math.floor(r() * 40_000_000)),
        egnpi: r() < 0.1 ? '' : String(Math.floor(r() * 100_000_000)),
        rate: r() < 0.15 ? '' : (r() * 4).toFixed(2),
        mdp: r() < 0.3 ? '' : String(Math.floor(r() * 2_000_000)),
        reinstatements: r() < 0.1 ? 'UNLIMITED' : (r() < 0.2 ? '' : String(1 + Math.floor(r() * 10))),
      }));
      const layers = fullRecalc(raw, '2500000');
      const u = universeTotals(layers);
      const c = C.layerTotals(layers.map((l) => ({ limit: l.limit, attachment: l.deductible, aggregateLimit: l.annualAggLimit, egnpi: l.egnpi, rate: l.rate, earnedPremium: l.earnedPremium, mdp: l.mdp, reinstatements: l.reinstatements })));
      expect(money(c.limit)).toBe(u.limit);
      expect(money(c.deductible)).toBe(u.deductible);
      expect(money(c.aggregateLimit)).toBe(u.aggLimit);
      expect(money(c.egnpi)).toBe(u.egnpi);
      expect(c.rate != null ? `${c.rate}%` : '').toBe(u.rate);
      expect(money(c.earnedPremium)).toBe(u.earnedPremium);
      expect(money(c.mdp)).toBe(u.mdp);
      expect(C.fmtPctMaybe(c.mdpPct ?? 0)).toBe(u.mdpPct);
      expect(c.reinstatements == null ? '' : String(c.reinstatements)).toBe(u.maxReinstatements);
      expect(C.fmtPctMaybe(c.rol ?? 0)).toBe(u.rol);
    }
  });
});
