import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACK_SECTIONS, PACK_TEMPLATE, TEMPLATE_VERSION, sectionKeys, templateGroups,
} from '../../src/modules/packs/packs.template.js';
import { buildPack, buildSections, packBasis, diffSections } from '../../src/modules/packs/packs.build.js';
import { presentSection } from '../../src/modules/packs/packs.present.js';
import { aggregateBordereaux } from '../../src/modules/analysis/analysis.service.js';

const emptyCtx = (placement = {}) => ({
  placement: {
    reference: 'UB-2026-TEST', class: 'Property Surplus', currency: 'USD',
    inception: '2026-01-01', expiry: '2026-12-31', status: 'DATA', ...placement,
  },
  cedant: { name: 'Test Cedant', domicile: 'Kenya' },
  layers: [],
  documents: [],
  quotes: [],
  wording: null,
  technical: [],
  premiumRows: [],
  claimsRows: [],
  aggregates: aggregateBordereaux([]),
  generated_at: '2026-08-20T00:00:00.000Z',
});

test('every template section is declared, and every declared section is placed', () => {
  for (const basis of ['PROP', 'NP']) {
    for (const key of sectionKeys(basis)) {
      assert.ok(PACK_SECTIONS[key], `${key} has a spec`);
      assert.ok(PACK_SECTIONS[key].title, `${key} has a title`);
      assert.ok(PACK_SECTIONS[key].empty_note, `${key} says what would fill it`);
    }
  }
  const placed = new Set(Object.values(PACK_TEMPLATE).flatMap((t) => t.groups.flatMap((g) => g.keys)));
  for (const key of Object.keys(PACK_SECTIONS)) {
    assert.ok(placed.has(key), `${key} appears in a tab group`);
  }
});

test('basis-specific sections appear on their own side only', () => {
  assert.ok(sectionKeys('NP').includes('premiums_table'), 'premiums table is an NP screen');
  assert.ok(!sectionKeys('PROP').includes('premiums_table'));
  assert.ok(sectionKeys('PROP').includes('historical_epi'), 'historical EPIs is a prop screen');
  assert.ok(!sectionKeys('NP').includes('historical_epi'));
  assert.ok(sectionKeys('PROP').includes('commissions'), 'commissions is a prop screen');
  assert.ok(!sectionKeys('NP').includes('commissions'));
  assert.ok(sectionKeys('NP').includes('historical_performance'));
  // Groups drop to nothing rather than showing an empty tab.
  for (const basis of ['PROP', 'NP']) {
    for (const group of templateGroups(basis)) assert.ok(group.keys.length > 0);
  }
});

test('a pack with no data still carries every section for its basis', () => {
  for (const basis of ['PROP', 'NP']) {
    const { sections, filled, total } = buildSections(basis, emptyCtx());
    assert.equal(sections.length, sectionKeys(basis).length);
    assert.equal(total, sections.length);
    assert.deepEqual(sections.map((s) => s.key), sectionKeys(basis), 'in the template running order');
    // The info/treaty-detail page comes from the placement itself, so it is
    // the one filled.
    assert.equal(filled, 1);
    for (const s of sections) {
      if (['treaty_detail', 'info_page'].includes(s.key)) continue;
      assert.equal(s.status, 'empty', `${s.key} is empty`);
      assert.ok(s.note, `${s.key} explains what would fill it`);
      assert.equal(s.data, null);
    }
  }
});

test('basis follows structure 1, then the expiring structure, then the class', () => {
  assert.equal(packBasis({ quote_structures: [{ basis: 'PROP' }] }), 'PROP');
  assert.equal(packBasis({ quote_structures: [{ basis: 'NP' }], class: 'Property QS' }), 'NP',
    'an explicit structure wins over the class name');
  assert.equal(packBasis({ expiring_structure: { basis: 'PROP' } }), 'PROP');
  assert.equal(packBasis({ class: 'Property Surplus' }), 'PROP');
  assert.equal(packBasis({ class: 'Property Cat XoL' }), 'NP');
  assert.equal(packBasis({}), 'NP', 'unknown falls back to non-proportional');
});

const premiumRows = [
  { policy_ref: 'P-001', insured: 'Acme', class_of_business: 'Property', territory: 'Kenya',
    sum_insured_100: '5000000', si_ceded: '4000000', premium_ceded: '20000', gross_premium_100: '25000' },
  { policy_ref: 'P-002', insured: 'Borak', class_of_business: 'Property', territory: 'Kenya',
    sum_insured_100: '300000', si_ceded: '240000', premium_ceded: '2000', gross_premium_100: '2500' },
];
const claimsRows = [
  { claim_ref: 'C-001', policy_ref: 'P-001', date_of_loss: '2026-03-04', cause_of_loss: 'Fire',
    paid: '20000', outstanding: '5000' },
  { claim_ref: 'C-002', policy_ref: 'P-002', date_of_loss: '2026-05-01', cause_of_loss: 'Windstorm',
    paid: '500', outstanding: '0' },
];

const fullCtx = () => {
  const bordereaux = [
    { id: 'b1', type: 'premium', parsed_rows: premiumRows },
    { id: 'b2', type: 'claims', parsed_rows: claimsRows },
  ];
  return {
    // Layers with an attachment make this a non-proportional placement.
    ...emptyCtx({ quote_structures: [{ basis: 'NP' }] }),
    layers: [{
      id: 'l1', name: 'Layer 1', type: 'XoL', attachment: 5_000_000, limit_amt: 10_000_000,
      order_pct: 100, premium100: 1_500_000, status: 'OPEN',
      egnpi: 40_000_000, rate_pct: 3.75, reinstatements: '2', reinstatement_pct: 100, aad: 250_000,
    }],
    documents: [{ id: 'd1', type: 'mrc_slip', version: 1, layer_id: 'l1', created_at: '2026-08-01' }],
    premiumRows,
    claimsRows,
    aggregates: aggregateBordereaux(bordereaux, { currency: 'USD' }),
  };
};

test('sections fill from the data that is there, and only those', () => {
  const { sections, filled } = buildSections('NP', fullCtx());
  const by = Object.fromEntries(sections.map((s) => [s.key, s]));

  assert.equal(by.premium_experience.status, 'filled');
  assert.equal(by.premium_experience.data.premium_ceded, 22_000);
  assert.equal(by.claims_experience.data.incurred, 25_500);
  assert.equal(by.historical_performance.data.loss_ratio_pct, 115.91);
  assert.equal(by.premiums_table.data.layers[0].egnpi, 40_000_000);
  assert.equal(by.documents.data.documents.length, 1);

  // Risk profile bands the two risks into different bands.
  assert.equal(by.risk_profile.status, 'filled');
  assert.equal(by.risk_profile.data.bands.length, 2);
  assert.equal(by.risk_profile.data.bands.reduce((a, b) => a + b.risks, 0), 2);

  // Large loss: threshold is 5% of ceded premium = 1,100; C-001 clears it.
  assert.equal(by.large_loss_list.data.threshold, 1100);
  assert.equal(by.large_loss_list.data.losses.length, 1);
  assert.equal(by.large_loss_list.data.losses[0].claim_ref, 'C-001');
  assert.equal(by.large_loss_selection.data.attritional_incurred, 500);

  // Windstorm is a cat peril; fire is not.
  assert.equal(by.cat_loss_list.data.losses.length, 1);
  assert.equal(by.cat_loss_list.data.losses[0].cause_of_loss, 'Windstorm');

  // Nothing behind these yet — still present, still explained.
  for (const key of ['cresta_aggregates', 'event_loss_tables', 'wording', 'retentions', 'expiring_structure']) {
    assert.equal(by[key].status, 'empty', `${key} empty`);
    assert.ok(by[key].note);
  }
  assert.ok(filled > 5 && filled < sections.length, 'a real pack is partly filled');
});

test('a broken row empties its section instead of failing the pack', () => {
  const ctx = fullCtx();
  // A row shaped nothing like a bordereau row.
  ctx.premiumRows = [null];
  const { sections } = buildSections('NP', ctx);
  const risk = sections.find((s) => s.key === 'risk_profile');
  assert.equal(risk.status, 'empty');
  assert.equal(sections.length, sectionKeys('NP').length, 'the rest of the pack still built');
});

test('the snapshot carries the template version, basis, groups and summary', () => {
  const snapshot = buildPack(fullCtx());
  assert.equal(snapshot.template_version, TEMPLATE_VERSION);
  assert.equal(snapshot.basis, 'NP');
  assert.ok(snapshot.groups.length > 0);
  assert.equal(snapshot.summary.sections_total, snapshot.sections.length);
  assert.equal(snapshot.summary.premium_ceded, 22_000);
  assert.equal(snapshot.summary.loss_ratio_pct, 115.91);
  assert.equal(snapshot.summary.layers, 1);
  assert.equal(snapshot.placement.reference, 'UB-2026-TEST');
});

test('the diff against the previous version names what filled or changed', () => {
  // Diffed on the NP side, where the experience sections live.
  const np = { class: 'Property Cat XoL' };
  const before = buildPack(emptyCtx(np));
  const after = buildPack(fullCtx(np));
  const changes = diffSections(before, after);
  const by = Object.fromEntries(changes.map((c) => [c.key, c.change]));
  assert.equal(by.premium_experience, 'filled');
  assert.equal(by.claims_experience, 'filled');
  assert.equal(by.large_loss_list, 'filled');
  assert.ok(!('event_loss_tables' in by), 'a section empty in both versions is not a change');

  // Emptying is reported too.
  const backToEmpty = diffSections(after, before);
  assert.equal(backToEmpty.find((c) => c.key === 'premium_experience').change, 'emptied');

  // Same data twice is no change at all.
  assert.deepEqual(diffSections(after, buildPack(fullCtx())), []);
});

test('the retentions section presents the class each occupancy was graded into', () => {
  const ctx = emptyCtx({
    retentions: {
      limit: 100,
      // Stored rows key the class as `class` — what retentionsToPayload writes.
      rows: [
        { class: 'A', category: 'Dwellings', pct: 100 },
        { class: 'C', category: 'Hazardous Risks', pct: 50 },
      ],
    },
  });
  const section = buildSections('PROP', ctx).sections.find((s) => s.key === 'retentions');
  assert.equal(section.status, 'filled');
  const { tables } = presentSection(section);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].columns.map((c) => c.key), ['class', 'category', 'pct']);
  // Every row must actually carry a value under the column's key.
  for (const row of tables[0].rows) assert.ok(row[tables[0].columns[0].key], 'class renders');
  assert.deepEqual(tables[0].rows.map((r) => r.class), ['A', 'C']);
});
