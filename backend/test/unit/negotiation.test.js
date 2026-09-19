import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  negotiationBoard, boardWithQuotes, propCapacity, marketStanding, quoteSheet,
  marketStructureBoard, isDeclined,
} from '../../src/domain/negotiation.js';

const NP = {
  basis: 'NP',
  layers: [
    { name: 'Layer 1', limit: 5_000_000, attachment: 1_000_000, premium: 400_000, rate_pct: 8 },
    { name: 'Layer 2', limit: 10_000_000, attachment: 6_000_000, premium: 250_000, rate_pct: 2.5 },
  ],
  prop: {},
};
const PROP = {
  basis: 'PROP',
  layers: [],
  prop: { treatyType: 'QS + Surplus', qsLimit: 4_000_000, surplusMaxRetention: 1_000_000, numLines: 6, commissionPct: 30, epi: 9_000_000 },
};

test('a non-proportional structure is quoted layer by layer', () => {
  const [structure] = negotiationBoard([NP]);
  assert.equal(structure.index, 1);
  assert.equal(structure.basis, 'NP');
  assert.deepEqual(structure.lines.map((l) => l.layer_index), [0, 1]);
  assert.equal(structure.lines[0].label, 'Layer 1');
  assert.equal(structure.lines[0].limit, 5_000_000);
  assert.equal(structure.lines[0].attachment, 1_000_000);
  // What the cedant asked for rides along, so a quote reads against it.
  assert.deepEqual(structure.lines[0].asked, { premium: 400_000, rate_pct: 8 });
});

test('a proportional structure is quoted as a whole, with no layer index', () => {
  const [structure] = negotiationBoard([PROP]);
  assert.equal(structure.basis, 'PROP');
  assert.equal(structure.lines.length, 1);
  assert.equal(structure.lines[0].layer_index, null);
  assert.equal(structure.lines[0].label, 'QS + Surplus');
  // QS limit 4m + six lines of 1m surplus.
  assert.equal(structure.lines[0].capacity, 10_000_000);
  assert.deepEqual(structure.lines[0].asked, { commission_pct: 30, epi: 9_000_000 });
});

test('capacity covers each proportional shape', () => {
  assert.equal(propCapacity({ treatyType: 'QS', qsLimit: 3_000_000 }), 3_000_000);
  // Surplus capacity as the modelling tool's treaty detail: the max retention
  // plus max retention × lines.
  assert.equal(propCapacity({ treatyType: 'Surplus', surplusMaxRetention: 500_000, numLines: 8 }), 4_500_000);
  assert.equal(propCapacity({ treatyType: 'First Surplus', surplusMaxRetention: 500_000, numLines: 8 }), 4_500_000);
  assert.equal(propCapacity({ treatyType: 'Fac Oblig', surplusMaxRetention: 500_000, numLines: 8 }), 4_500_000);
  assert.equal(propCapacity({ treatyType: 'Quota Share & Surplus', qsLimit: 3_000_000, surplusMaxRetention: 500_000, numLines: 8 }), 7_000_000);
  assert.equal(propCapacity({ treatyType: 'Quota Share', qsLimit: 3_000_000, surplusMaxRetention: 500_000, numLines: 8 }), 3_000_000);
  assert.equal(propCapacity({ treatyType: 'QS', qsLimit: 3_000_000, surplusMaxRetention: 500_000, numLines: 8 }), 3_000_000);
  assert.equal(propCapacity({}), 0);
});

test('structures are numbered as stored, and empty ones are not put to market', () => {
  const board = negotiationBoard([{ basis: 'NP', layers: [] }, NP, { basis: 'PROP', prop: {} }]);
  assert.deepEqual(board.map((s) => s.index), [2], 'structure 2 keeps its number');
  assert.deepEqual(negotiationBoard([]), []);
  assert.deepEqual(negotiationBoard(), []);
});

test('quotes hang off the line they were given for', () => {
  const quotes = [
    { negotiation_id: 'm1', structure_index: 1, layer_index: 0, status: 'quoted', premium: 380_000, rate_pct: 7.6, line_pct: 25 },
    { negotiation_id: 'm2', structure_index: 1, layer_index: 0, status: 'quoted', premium: 410_000, rate_pct: 8.2, line_pct: 15 },
    { negotiation_id: 'm1', structure_index: 1, layer_index: 1, status: 'declined' },
  ];
  const [structure] = boardWithQuotes([NP], quotes);
  const [first, second] = structure.lines;
  assert.equal(first.quotes.length, 2);
  assert.equal(first.summary.quoted, 2);
  assert.equal(first.summary.best_premium, 380_000, 'the keenest premium');
  assert.equal(first.summary.best_rate_pct, 7.6);
  assert.equal(first.summary.line_pct_total, 40, 'what has been offered in total');
  assert.equal(second.summary.quoted, 0);
  assert.equal(second.summary.declined, 1);
  assert.equal(second.summary.best_premium, null);
});

test('a proportional quote is matched on the structure, not a layer', () => {
  const [structure] = boardWithQuotes([PROP], [
    { negotiation_id: 'm1', structure_index: 1, layer_index: null, status: 'quoted', commission_pct: 27.5, premium: 8_500_000 },
    { negotiation_id: 'm2', structure_index: 1, layer_index: 0, status: 'quoted', premium: 1 },
  ]);
  assert.equal(structure.lines[0].quotes.length, 1, 'a stray layer quote does not attach');
  assert.equal(structure.lines[0].quotes[0].commission_pct, 27.5);
});

test('the keenest quote is the lowest price and the highest commission', () => {
  const [np] = boardWithQuotes([NP], [
    { negotiation_id: 'm1', structure_index: 1, layer_index: 0, status: 'quoted', premium: 380_000, rate_pct: 7.6 },
    { negotiation_id: 'm2', structure_index: 1, layer_index: 0, status: 'quoted', premium: 350_000, rate_pct: 7 },
    // A declined answer never counts toward the best.
    { negotiation_id: 'm3', structure_index: 1, layer_index: 0, status: 'declined', premium: 1 },
  ]);
  assert.equal(np.lines[0].summary.best_premium, 350_000);
  assert.equal(np.lines[0].summary.best_rate_pct, 7);
  assert.equal(np.lines[0].summary.best_commission_pct, null);

  const [prop] = boardWithQuotes([PROP], [
    { negotiation_id: 'm1', structure_index: 1, layer_index: null, status: 'quoted', commission_pct: 27.5 },
    { negotiation_id: 'm2', structure_index: 1, layer_index: null, status: 'quoted', commission_pct: 32.5 },
  ]);
  assert.equal(prop.lines[0].summary.best_commission_pct, 32.5, 'more commission back is better');
});

test('quotes for one structure never leak into another', () => {
  const board = boardWithQuotes([NP, PROP], [
    { negotiation_id: 'm1', structure_index: 2, layer_index: null, status: 'quoted', commission_pct: 30 },
  ]);
  assert.equal(board[0].lines[0].quotes.length, 0);
  assert.equal(board[1].lines[0].quotes.length, 1);
});

test('a market stands where its answers put it', () => {
  assert.equal(marketStanding([]), 'SENT');
  assert.equal(marketStanding([{ status: 'declined' }]), 'DECLINED');
  assert.equal(marketStanding([{ status: 'declined' }, { status: 'quoted' }]), 'QUOTED');
});

/* ── One market's sheet ── */

const OWN = {
  id: 'own-1',
  negotiation_id: 'm1',
  label: 'Lead’s own tower',
  basis: 'NP',
  market_name: 'Alpha Re',
  structure: { layers: [{ name: 'A', limit: 4_000_000, attachment: 2_000_000 }] },
};

test('a sheet pulls through every structure sent, with what was said filled in', () => {
  const sheet = quoteSheet([NP, PROP], [], [
    { negotiation_id: 'm1', structure_index: 1, layer_index: 0, status: 'quoted', premium: 372_000 },
  ]);
  assert.equal(sheet.length, 2);
  assert.equal(sheet[0].source, 'sent');
  assert.equal(sheet[0].lines[0].quote.premium, 372_000);
  assert.equal(sheet[0].lines[1].quote, null, 'a line not yet answered stays blank');
  assert.equal(sheet[1].lines[0].layer_index, null);
});

test('a structure reads as declined only when every line was declined', () => {
  const [np] = quoteSheet([NP], [], [
    { negotiation_id: 'm1', structure_index: 1, layer_index: 0, status: 'declined' },
  ]);
  assert.equal(np.declined, false, 'one layer of two');

  const [all] = quoteSheet([NP], [], [
    { negotiation_id: 'm1', structure_index: 1, layer_index: 0, status: 'declined' },
    { negotiation_id: 'm1', structure_index: 1, layer_index: 1, status: 'declined' },
  ]);
  assert.equal(all.declined, true);
  assert.equal(isDeclined([]), false, 'nothing said is not a decline');
});

test('a market’s own structure resolves into lines like any other', () => {
  const [own] = marketStructureBoard([OWN]);
  assert.equal(own.source, 'market');
  assert.equal(own.id, 'own-1');
  assert.equal(own.market_name, 'Alpha Re');
  assert.equal(own.lines.length, 1);
  assert.equal(own.lines[0].market_structure_id, 'own-1');
  assert.equal(own.lines[0].structure_index, null, 'it answers to no sent structure');
  assert.equal(own.lines[0].attachment, 2_000_000);
});

test('quotes on a market’s own structure never land on a sent one', () => {
  const quotes = [
    { negotiation_id: 'm1', structure_index: 1, layer_index: 0, status: 'quoted', premium: 372_000 },
    { negotiation_id: 'm1', market_structure_id: 'own-1', layer_index: 0, status: 'quoted', premium: 300_000 },
  ];
  const board = boardWithQuotes([NP], quotes, [OWN]);
  assert.equal(board.length, 2);
  assert.equal(board[0].lines[0].quotes.length, 1);
  assert.equal(board[0].lines[0].summary.best_premium, 372_000);
  const own = board[1];
  assert.equal(own.source, 'market');
  assert.equal(own.lines[0].quotes.length, 1);
  assert.equal(own.lines[0].summary.best_premium, 300_000);

  const sheet = quoteSheet([NP], [OWN], quotes);
  assert.equal(sheet[1].lines[0].quote.premium, 300_000);
});

test('a sheet for a market that has said nothing is simply empty', () => {
  const sheet = quoteSheet([NP, PROP], [], []);
  assert.ok(sheet.every((s) => s.lines.every((l) => l.quote === null)));
  assert.ok(sheet.every((s) => s.declined === false));
  assert.deepEqual(quoteSheet([], [], []), []);
});
