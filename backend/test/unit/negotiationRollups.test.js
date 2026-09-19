// The quotes read by reinsurer, the programme they add up to, and the rate
// on line compared layer by layer — pure over the board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardWithQuotes, programmeRollup, quotesByUnderwriter, combinedQuotes, rolComparison,
  normaliseExpiringLayers, quotedPremium, quoteSheet, structureKind,
} from '../../src/domain/negotiation.js';

const NP = {
  basis: 'NP',
  layers: [
    { name: 'Layer 1', limit: 5_000_000, attachment: 1_000_000, premium: 400_000, rate_pct: 8 },
    { name: 'Layer 2', limit: 10_000_000, attachment: 6_000_000, premium: 250_000 },
  ],
  prop: {},
};
const PROP = { basis: 'PROP', layers: [], prop: { treatyType: 'QS', qsLimit: 4_000_000, commissionPct: 30, epi: 9_000_000 } };

const alpha = { id: 'n-alpha', market_id: 'm-alpha', market_name: 'Alpha Re', role: 'lead', status: 'QUOTED' };
const beta = { id: 'n-beta', market_id: 'm-beta', market_name: 'Beta Re', role: 'follow', status: 'QUOTED' };
const gamma = { id: 'n-gamma', market_id: 'm-gamma', market_name: 'Gamma Re', role: 'follow', status: 'SENT' };

const quote = (negotiation, fields) => ({
  id: `${negotiation.id}:${fields.structure_index}:${fields.layer_index ?? 'whole'}`,
  negotiation_id: negotiation.id, market_id: negotiation.market_id, market_name: negotiation.market_name, role: negotiation.role,
  status: 'quoted', terms: {}, original: {}, ...fields,
});

const QUOTES = [
  quote(alpha, { structure_index: 1, layer_index: 0, premium: 432_000, line_pct: 25 }),
  quote(alpha, { structure_index: 1, layer_index: 1, premium: 270_000, line_pct: 25 }),
  quote(alpha, { structure_index: 2, layer_index: null, commission_pct: 27.5, line_pct: 15 }),
  quote(beta, { structure_index: 1, layer_index: 0, premium: 450_000, line_pct: 20 }),
  quote(beta, { structure_index: 1, layer_index: 1, status: 'declined' }),
];
const markets = [alpha, beta, gamma];
const board = () => boardWithQuotes([NP, PROP], QUOTES, []);

test('a programme roll-up adds a market\'s layers into a premium, a limit and a rate on line', () => {
  const [np] = board();
  const alphaLines = np.lines.map((line) => ({ line, quote: line.quotes.find((q) => q.negotiation_id === alpha.id) || null }));
  const r = programmeRollup(alphaLines);
  assert.equal(r.layers, 2);
  assert.equal(r.quoted, 2);
  assert.equal(r.complete, true);
  assert.equal(r.premium_total, 702_000);
  assert.equal(r.limit_total, 15_000_000);
  assert.equal(r.rol_pct, 4.68, '702k over 15m');
  assert.equal(r.line_pct_min, 25);
  assert.equal(r.line_pct_max, 25);

  const betaLines = np.lines.map((line) => ({ line, quote: line.quotes.find((q) => q.negotiation_id === beta.id) || null }));
  const b = programmeRollup(betaLines);
  assert.equal(b.quoted, 1);
  assert.equal(b.declined, 1);
  assert.equal(b.complete, false);
  assert.equal(b.premium_total, 450_000);
  assert.equal(b.rol_pct, 9);
  assert.equal(quotedPremium(betaLines[0].quote), 450_000);
});

test('quotes by underwriter: each reinsurer with the structures it answered, per line, and its programme', () => {
  const by = quotesByUnderwriter(board(), markets);
  assert.deepEqual(by.map((m) => m.market_name), ['Alpha Re', 'Beta Re', 'Gamma Re']);
  const a = by[0];
  assert.equal(a.summary.structures_sent, 2);
  assert.equal(a.summary.answered, 2, 'Alpha answered both structures');
  assert.equal(a.structures[0].basis, 'NP');
  assert.equal(a.structures[0].rollup.premium_total, 702_000);
  assert.equal(a.structures[1].basis, 'PROP');
  assert.equal(a.structures[1].rollup, null, 'a proportional structure has no layer roll-up');
  assert.equal(a.structures[1].lines[0].quote.commission_pct, 27.5);
  const g = by[2];
  assert.equal(g.summary.answered, 0);
  assert.ok(g.structures.every((s) => !s.answered), 'nothing back from Gamma yet');
  const b = by[1];
  assert.equal(b.structures[0].declined, false, 'Beta declined one layer, not the structure');
});

test('the combined quote: every market\'s programme, and the best of the market layer by layer', () => {
  const [combined] = combinedQuotes(board(), markets);
  assert.equal(combined.label, 'Structure 1');
  assert.deepEqual(combined.by_market.map((m) => m.market_name), ['Alpha Re', 'Beta Re'], 'a market with nothing back is not a column');
  assert.equal(combined.by_market[0].rollup.rol_pct, 4.68);
  assert.deepEqual(combined.by_market[1].layers.map((l) => l.status), ['quoted', 'declined']);
  // Layer 1 is keenest from Alpha (432k < 450k); Layer 2 only Alpha priced it.
  assert.deepEqual(combined.best.layers.map((l) => l.market_name), ['Alpha Re', 'Alpha Re']);
  assert.equal(combined.best.premium_total, 702_000);
  assert.equal(combined.best.rol_pct, 4.68);
  assert.equal(combined.best.complete, true);
  assert.deepEqual(combined.best.markets, ['Alpha Re']);
  assert.equal(combinedQuotes(board(), markets).length, 1, 'only non-proportional structures combine');
});

test('the rate on line compared: layers down, the reinsurers that answered across, keenest marked', () => {
  const expiring = normaliseExpiringLayers({ basis: 'NP', layers: [
    { name: 'Layer 1', limit: 5_000_000, attachment: 1_000_000, premium: 500_000 },
    { name: 'Layer 2', limit: 10_000_000, attachment: 6_000_000, premium: 300_000 },
  ] });
  assert.equal(expiring[0].rol_pct, 10);
  const [cmp] = rolComparison(board(), expiring, markets);
  assert.deepEqual(cmp.markets.map((m) => m.market_name), ['Alpha Re', 'Beta Re']);
  const [l1, l2] = cmp.rows;
  assert.equal(l1.sent.rol_pct, 8, 'as sent: 400k over 5m');
  assert.equal(l1.expiring.rol_pct, 10);
  assert.equal(l1.cells['n-alpha'].rol_pct, 8.64);
  assert.equal(l1.cells['n-alpha'].measure, 'rol');
  assert.equal(l1.cells['n-beta'].rol_pct, 9);
  assert.equal(l1.cells['n-alpha'].best, true);
  assert.equal(l1.cells['n-beta'].best, false);
  assert.equal(l1.best_negotiation_id, 'n-alpha');
  assert.equal(l2.cells['n-beta'].status, 'declined');
  assert.equal(l2.cells['n-alpha'].rol_pct, 2.7);
  assert.equal(cmp.foot['n-alpha'].rol_pct, 4.68);
  assert.equal(cmp.has_expiring, true);
  assert.equal(cmp.expiring_programme.rol_pct, 5.3333, '800k over 15m');
  assert.equal(cmp.sent_programme.rol_pct, 4.3333, '650k over 15m');
});

test('expiring layers read the same from the recorded structure or the prior year\'s layer rows', () => {
  const fromRows = normaliseExpiringLayers(null, [{ name: 'L1', limit_amt: '2000000', attachment: '500000', premium100: '100000' }]);
  assert.deepEqual(fromRows, [{ name: 'L1', limit: 2_000_000, attachment: 500_000, premium: 100_000, rol_pct: 5 }]);
  assert.deepEqual(normaliseExpiringLayers({ basis: 'PROP', layers: [{ limit: 1 }] }, []), [], 'a proportional expiring has no layers');
  const [cmp] = rolComparison(board(), [], markets);
  assert.equal(cmp.rows[0].expiring, null);
  assert.equal(cmp.has_expiring, false);
});

test('a quote priced by rate alone compares by rate, and a market that only declined still gets a column', () => {
  const rated = [
    quote(alpha, { structure_index: 1, layer_index: 0, rate_pct: 7.5, premium: null, terms: { premium: null } }),
    quote(beta, { structure_index: 1, layer_index: 0, status: 'declined' }),
    quote(beta, { structure_index: 1, layer_index: 1, status: 'declined' }),
  ];
  // Layer terms as sent carry the premium, so a quote without one reads as accepting it.
  const b = boardWithQuotes([NP], rated, []);
  const [cmp] = rolComparison(b, [], markets);
  assert.deepEqual(cmp.markets.map((m) => m.market_name), ['Alpha Re', 'Beta Re']);
  const cell = cmp.rows[0].cells['n-alpha'];
  assert.equal(cell.status, 'quoted');
  assert.equal(cmp.rows[0].cells['n-beta'].status, 'declined');
  assert.equal(cmp.rows[1].cells['n-alpha'].status, 'awaited');
  assert.equal(cmp.foot['n-beta'].declined, 2);
});

test('a quote is a lead quote unless captured as an indication, and the reading says so everywhere', () => {
  const quotes = [
    quote(alpha, { structure_index: 1, layer_index: 0, premium: 432_000, kind: 'indicative' }),
    quote(alpha, { structure_index: 1, layer_index: 1, premium: 270_000, kind: 'indicative' }),
    quote(beta, { structure_index: 1, layer_index: 0, premium: 450_000 }),
    quote(beta, { structure_index: 1, layer_index: 1, status: 'declined' }),
  ];
  const b = boardWithQuotes([NP], quotes, []);
  const [np] = b;
  assert.equal(np.lines[0].quotes.find((q) => q.negotiation_id === alpha.id).kind, 'indicative');
  assert.equal(np.lines[0].quotes.find((q) => q.negotiation_id === beta.id).kind, 'lead', 'unsaid, a quote is a lead quote');
  assert.equal(np.lines[0].summary.indicative, 1);
  assert.equal(np.lines[0].summary.quoted, 2, 'an indication still counts as quoted');

  // The structure's kind: every line priced is an indication → indicative;
  // a decline carries no kind; nothing priced reads as lead by default.
  const by = quotesByUnderwriter(b, markets);
  assert.equal(by[0].structures[0].kind, 'indicative');
  assert.equal(by[1].structures[0].kind, 'lead');
  assert.equal(by[2].structures[0].kind, 'lead');
  assert.equal(structureKind([{ quote: { status: 'quoted', kind: 'indicative' } }, { quote: { status: 'quoted', kind: 'lead' } }]), 'lead',
    'one lead line among indications reads as a lead quote');

  const [combined] = combinedQuotes(b, markets);
  const alphaRow = combined.by_market.find((m) => m.negotiation_id === alpha.id);
  assert.equal(alphaRow.kind, 'indicative');
  assert.equal(alphaRow.layers[0].kind, 'indicative');
  assert.equal(combined.best.layers[0].kind, 'indicative', 'the keenest on layer 1 is Alpha\'s indication, and says so');
  assert.equal(combined.best.indicative, true);

  const [rol] = rolComparison(b, [], markets);
  assert.equal(rol.rows[0].cells[alpha.id].kind, 'indicative');
  assert.equal(rol.rows[0].cells[beta.id].kind, 'lead');

  // The sheet reads it back per structure.
  const sheet = quoteSheet([NP], [], quotes.filter((q) => q.negotiation_id === alpha.id));
  assert.equal(sheet[0].indicative, true);
  assert.equal(quoteSheet([NP], [], quotes.filter((q) => q.negotiation_id === beta.id))[0].indicative, false);
});
