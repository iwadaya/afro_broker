// npStructureReducer — deductible cascade, totals and Excel paste, driven through
// the Universe structureReducer maths (verbatim) plus the AABI programme strip.
import { describe, it, expect } from 'vitest';
import { npStructureReducer, hydrateFromBundle, MAX_LAYERS } from '../state/npStructureReducer';
import { structurePayloadFromSlice, structureMissing, layerRowFromApi } from '../lib/npSlice';
import { layerTotals } from '../../../../shared/broking/calcs.js';

const layer = (n, over = {}) => ({ layerNumber: n, limit: null, attachment: null, aggregateLimit: null, egnpi: null, rate: null, earnedPremium: null, mdp: null, mdpPct: null, numReinstatements: null, reinstatementPct: null, aad: false, aadAmount: null, riskCover: false, catCover: true, perilScope: 'CAT', rol: null, classIds: [], attachLrPct: null, limitLrPct: null, epi: null, aggregateDeductible: null, ...over });
const SEED_CAT = {
  contractId: '00000000-0000-0000-0000-00000000c002', umr: 'B0621DAR26CX002', businessType: 'NON_PROPORTIONAL', status: 'DRAFT', rowVersion: 3,
  header: { treatyTypeName: 'CAT XL', currencyCode: 'USD', classIds: [], classNames: [] },
  npStructure: {
    programme: { numberOfLayers: 3, deductible: 2500000, accountingMethod: 'Losses Occurring', xlType: 'Gross XL', accounts: 'Quarterly', estGnpi: 80000000, brokeragePct: 10, taxesPct: 0, noClaimsBonusPct: null, profitCommissionPct: null },
    layers: [
      layer(1, { limit: 5000000, attachment: 2500000, aggregateLimit: 10000000, egnpi: 80000000, rate: 1.8, earnedPremium: 1440000, mdp: 1200000, numReinstatements: 1, reinstatementPct: 100 }),
      layer(2, { limit: 10000000, attachment: 7500000, aggregateLimit: 20000000, egnpi: 80000000, rate: 1.35, earnedPremium: 1080000, mdp: 900000, numReinstatements: 1, reinstatementPct: 100 }),
      layer(3, { limit: 15000000, attachment: 17500000, aggregateLimit: 30000000, egnpi: 80000000, rate: 0.9, earnedPremium: 720000, mdp: 600000, numReinstatements: 2, reinstatementPct: 100, aad: true, aadAmount: 2000000 }),
    ],
  },
};

describe('hydrateFromBundle', () => {
  it('maps the API layers to Universe rows, locks covers for CAT XL and recomputes the derived columns', () => {
    const s = hydrateFromBundle(SEED_CAT);
    expect(s.mode).toBe('CAT');
    expect(s.programme).toMatchObject({ deductible: '2500000', estGnpi: '80000000', xlType: 'Gross XL', accounts: 'Quarterly', brokeragePct: '10', taxesPct: '0', noClaimsBonusPct: '' });
    expect(s.layers.map((l) => l.deductible)).toEqual(['2500000', '7500000', '17500000']);
    expect(s.layers.map((l) => l.earnedPremium)).toEqual(['1440000', '1080000', '720000']);
    expect(s.layers.map((l) => l.rol)).toEqual(['28.8%', '10.8%', '4.8%']);
    expect(s.layers.map((l) => l.mdpPct)).toEqual(['83.33%', '83.33%', '83.33%']);
    expect(s.layers.map((l) => l.rate)).toEqual(['1.8', '1.35', '0.9']);
    expect(s.layers.map((l) => l.reinstatements)).toEqual(['1', '1', '2']);
    expect(s.layers.every((l) => l.riskCover === false && l.catCover === true)).toBe(true);
    expect(s.layers[2]).toMatchObject({ aad: true, aadAmount: '2000000' });
    expect(s.dirty).toBe(false);
  });
  it('a contract with no layers starts with one blank layer whose EGNPI is the Est. GNPI', () => {
    const s = hydrateFromBundle({ header: { treatyTypeName: 'Risk & CAT XL' }, npStructure: { programme: { estGnpi: 50000000, deductible: 1000000 }, layers: [] } });
    expect(s.mode).toBe('BOTH');
    expect(s.layers).toHaveLength(1);
    expect(s.layers[0]).toMatchObject({ layer: 1, egnpi: '50000000', deductible: '1000000', riskCover: true, catCover: true });
  });
  it('layerRowFromApi keeps the UNLIMITED sentinel and blanks zeros like Universe strOrEmpty', () => {
    expect(layerRowFromApi(layer(1, { numReinstatements: -1, limit: 0, rate: 0 }), 0)).toMatchObject({ reinstatements: 'UNLIMITED', limit: '', rate: '' });
    expect(layerRowFromApi(layer(1, { numReinstatements: 3 }), 0).reinstatements).toBe('3');
  });
});

describe('npStructureReducer', () => {
  const base = hydrateFromBundle(SEED_CAT);

  it('cascades attachments from the programme Deductible and from each layer limit', () => {
    let s = npStructureReducer(base, { type: 'programme/edited', key: 'deductible', value: '3000000' });
    expect(s.layers.map((l) => l.deductible)).toEqual(['3000000', '8000000', '18000000']);
    expect(s.dirty).toBe(true);
    s = npStructureReducer(s, { type: 'layer/fieldEdited', idx: 0, field: 'limit', value: '6000000' });
    expect(s.layers.map((l) => l.deductible)).toEqual(['3000000', '9000000', '19000000']);
    expect(s.layers[0]).toMatchObject({ earnedPremium: '1440000', rol: '24%' });          // 1,440,000 / 6,000,000
  });

  it('recomputes Earned Premium, MDP% and ROL on rate / EGNPI / MDP edits', () => {
    let s = npStructureReducer(base, { type: 'layer/fieldEdited', idx: 1, field: 'rate', value: '2' });
    expect(s.layers[1]).toMatchObject({ earnedPremium: '1600000', rol: '16%', mdpPct: '56.25%' });
    s = npStructureReducer(s, { type: 'layer/fieldEdited', idx: 1, field: 'mdp', value: '' });
    expect(s.layers[1].mdpPct).toBe('');
    s = npStructureReducer(s, { type: 'layer/fieldEdited', idx: 1, field: 'egnpi', value: '' });
    expect(s.layers[1]).toMatchObject({ earnedPremium: '', rol: '' });
  });

  it('keeps Risk / Cat locked to the treaty type on every edit', () => {
    const s = npStructureReducer(base, { type: 'layer/fieldEdited', idx: 0, field: 'riskCover', value: true });
    expect(s.layers[0]).toMatchObject({ riskCover: false, catCover: true });
    const both = hydrateFromBundle({ ...SEED_CAT, header: { treatyTypeName: 'Risk & CAT XL' } });
    const t = npStructureReducer(both, { type: 'layer/fieldEdited', idx: 0, field: 'catCover', value: false });
    expect(t.layers[0]).toMatchObject({ riskCover: false, catCover: false });               // BOTH: user choice kept
  });

  it('adds layers (EGNPI defaults to Est. GNPI, attachment cascades) up to 20 and deletes down to 1', () => {
    let s = npStructureReducer(base, { type: 'layer/added' });
    expect(s.layers).toHaveLength(4);
    expect(s.layers[3]).toMatchObject({ layer: 4, egnpi: '80000000', deductible: '32500000', riskCover: false, catCover: true, limit: '' });
    for (let i = 0; i < 30; i++) s = npStructureReducer(s, { type: 'layer/added' });
    expect(s.layers).toHaveLength(MAX_LAYERS);
    for (let i = 0; i < 30; i++) s = npStructureReducer(s, { type: 'layer/lastDeleted' });
    expect(s.layers).toHaveLength(1);
    expect(s.layers[0].deductible).toBe('2500000');
  });

  it('Est. GNPI fills blank EGNPI cells only', () => {
    let s = npStructureReducer(base, { type: 'layer/fieldEdited', idx: 2, field: 'egnpi', value: '' });
    s = npStructureReducer(s, { type: 'programme/edited', key: 'estGnpi', value: '90000000' });
    expect(s.layers.map((l) => l.egnpi)).toEqual(['80000000', '80000000', '90000000']);
    expect(s.layers[2].earnedPremium).toBe('810000');
  });

  it('an Excel multi-cell paste fills across limit, aggregate limit, EGNPI, rate, MDP, % reinst., AAD amount from the target cell', () => {
    const one = npStructureReducer(base, { type: 'layer/lastDeleted' });
    const two = npStructureReducer(npStructureReducer(one, { type: 'layer/lastDeleted' }), { type: 'layer/added' });
    const matrix = [['5,000,000', '10,000,000', '80,000,000', '2.5', '1,000,000', '150', '250,000'], ['(7,500,000)', '15,000,000', '80,000,000', '1.25%', '500,000', '100', '']];
    const s = npStructureReducer(two, { type: 'layer/pasted', startRow: 0, field: 'limit', matrix });
    expect(s.layers[0]).toMatchObject({ limit: '5000000', annualAggLimit: '10000000', egnpi: '80000000', rate: '2.5%', mdp: '1000000', reinstatementPct: '150', aadAmount: '250000', earnedPremium: '2000000', rol: '40%', deductible: '2500000' });
    expect(s.layers[1]).toMatchObject({ limit: '-7500000', annualAggLimit: '15000000', rate: '1.25%', mdp: '500000', reinstatementPct: '100', aadAmount: '', earnedPremium: '1000000', deductible: '7500000' });
    // paste starting in a later column spreads from that column
    const t = npStructureReducer(two, { type: 'layer/pasted', startRow: 1, field: 'egnpi', matrix: [['60,000,000', '3']] });
    expect(t.layers[1]).toMatchObject({ egnpi: '60000000', rate: '3%', earnedPremium: '1800000' });
    expect(t.layers[0].egnpi).toBe('80000000');
    // a single cell is a normal paste (the table handler never dispatches) — rows beyond the table are ignored
    const u = npStructureReducer(two, { type: 'layer/pasted', startRow: 1, field: 'limit', matrix: [['1', '2'], ['3', '4'], ['5', '6']] });
    expect(u.layers).toHaveLength(2);
  });
});

describe('totals + payload', () => {
  const s = hydrateFromBundle(SEED_CAT);
  it('totals match the Universe LayerTableCard row', () => {
    const t = layerTotals(s.layers);
    expect(t).toMatchObject({ limit: 30000000, deductible: 2500000, aggregateLimit: 60000000, egnpi: 80000000, rate: 4.05, earnedPremium: 3240000, mdp: 2700000, reinstatements: 2 });
    expect(t.mdpPct).toBeCloseTo(2700000 / 3240000, 10);
    expect(t.rol).toBeCloseTo(3240000 / 30000000, 10);        // Σ(rate/100 × EGNPI) / Σ limit
    const unlimited = layerTotals([{ ...s.layers[0], reinstatements: 'UNLIMITED' }, s.layers[1]]);
    expect(unlimited.reinstatements).toBe(1);                   // Universe order-dependent reduce (a later numeric layer wins), carried over on purpose
    expect(layerTotals([s.layers[1], { ...s.layers[0], reinstatements: 'UNLIMITED' }]).reinstatements).toBe('Unlimited');
  });
  it('builds the PUT body without derived columns and with the UNLIMITED sentinel / AAD rule', () => {
    const rows = s.layers.map((l, i) => (i === 1 ? { ...l, reinstatements: 'UNLIMITED' } : l));
    const p = structurePayloadFromSlice({ programme: s.programme, layers: rows }, 'CAT XL');
    expect(p.programme).toEqual({ deductible: 2500000, xlType: 'Gross XL', accountingMethod: 'Losses Occurring', accounts: 'Quarterly', estGnpi: 80000000, brokeragePct: 10, taxesPct: 0, noClaimsBonusPct: null, profitCommissionPct: null });
    expect(p.layers[0]).toMatchObject({ layerNumber: 1, limit: 5000000, aggregateLimit: 10000000, egnpi: 80000000, rate: 1.8, mdp: 1200000, numReinstatements: 1, reinstatementPct: 100, aad: false, aadAmount: null, riskCover: false, catCover: true });
    expect(p.layers[0]).not.toHaveProperty('attachment');
    expect(p.layers[0]).not.toHaveProperty('earnedPremium');
    expect(p.layers[1].numReinstatements).toBe('UNLIMITED');
    expect(p.layers[2]).toMatchObject({ aad: true, aadAmount: 2000000 });
    // Stop Loss / Aggregate XL carry their own inputs
    const sl = structurePayloadFromSlice({ programme: s.programme, layers: [{ ...s.layers[0], epi: '50000000', attachLrPct: '80', limitLrPct: '30' }] }, 'Stop Loss');
    expect(sl.layers[0]).toMatchObject({ limit: null, epi: 50000000, attachLrPct: 80, limitLrPct: 30 });
    const ax = structurePayloadFromSlice({ programme: s.programme, layers: [{ ...s.layers[0], annualAggLimit: '40000000', aggregateDeductible: '5000000', deductible: '1000000' }] }, 'Aggregate XL');
    expect(ax.layers[0]).toMatchObject({ aggregateLimit: 40000000, aggregateDeductible: 5000000, attachment: 1000000 });
  });
  it('structureMissing names the first missing driver per treaty family', () => {
    expect(structureMissing([{ limit: '' }, { limit: '5' }], 'CAT XL')).toEqual(['Layer 1 Limit']);
    expect(structureMissing([{ epi: '' }], 'Stop Loss')).toEqual(['Layer 1 EPI']);
    expect(structureMissing([{ annualAggLimit: '' }], 'Aggregate XL')).toEqual(['Layer 1 Aggregate Limit']);
    expect(structureMissing([], 'CAT XL')).toEqual(['Structure (at least one layer)']);
  });
});
