// The Data screen's deterministic comparison of this year with the prior year.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeChanges } from '../../src/modules/analysis/placementData.service.js';

const digest = (over = {}) => ({
  placement: { reference: 'R', currency: 'USD', treaty_type: 'Risk XL', class: 'Property Risk XL', ...(over.placement || {}) },
  structures: over.structures || [{ label: 'Structure 1', basis: 'NP', layers: [
    { name: 'Layer 1', limit: 5_000_000, attachment: 1_000_000, premium: 400_000, rate_pct: 8, rol_pct: 8 },
    { name: 'Layer 2', limit: 10_000_000, attachment: 6_000_000, premium: 250_000, rate_pct: null, rol_pct: 2.5 },
  ], prop: null }],
  retentions: over.retentions || { treaty_limit: 15_000_000, rows: [{ category: 'Residential', pct: 100 }, { category: 'Hazardous', pct: 60 }] },
  modelling: over.modelling || [{ class: 'Property', screens: [{ key: 'large_losses' }] }],
});

test('nothing to compare with is no change', () => {
  assert.deepEqual(computeChanges(digest(), null), { changes: [], basis_layers: 0 });
});

test('layers compare by name, retentions by category, and the treaty detail field by field', () => {
  const prior = digest({
    structures: [{ label: 'Structure 1', basis: 'NP', layers: [
      { name: 'Layer 1', limit: 5_000_000, attachment: 1_000_000, premium: 500_000, rate_pct: 10, rol_pct: 10 },
      { name: 'Layer 2', limit: 8_000_000, attachment: 6_000_000, premium: 250_000, rate_pct: null, rol_pct: 3.125 },
    ], prop: null }],
    retentions: { treaty_limit: 13_000_000, rows: [{ category: 'Residential', pct: 100 }, { category: 'Hazardous', pct: 50 }, { category: 'Industrial', pct: 80 }] },
    modelling: [{ class: 'Property', screens: [{ key: 'large_losses' }, { key: 'triangle_paid' }] }],
    placement: { currency: 'EUR' },
  });
  const { changes, basis_layers } = computeChanges(digest(), prior);
  assert.equal(basis_layers, 2);
  const find = (area, item, field) => changes.find((c) => c.area === area && c.item === item && c.field === field);
  assert.deepEqual(find('Structure', 'Layer 1', 'premium'), { area: 'Structure', item: 'Layer 1', field: 'premium', from: 500_000, to: 400_000, change_pct: -20 });
  assert.equal(find('Structure', 'Layer 1', 'rol_pct').to, 8);
  assert.equal(find('Structure', 'Layer 2', 'limit').change_pct, 25);
  assert.equal(find('Structure', 'Layer 2', 'attachment'), undefined, 'unchanged figures are not movements');
  assert.equal(find('Retentions', 'Hazardous', 'pct').to, 60);
  assert.equal(find('Retentions', 'Industrial', 'category').to, 'removed');
  assert.equal(find('Retentions', 'Treaty limit', 'treaty_limit').from, 13_000_000);
  assert.deepEqual(find('Treaty detail', 'currency', 'currency'), { area: 'Treaty detail', item: 'currency', field: 'currency', from: 'EUR', to: 'USD', change_pct: null });
  assert.equal(find('Modelling', 'triangle_paid', 'screen').to, 'not entered this year');
});

test('a change of basis, or a structure added, is reported as such', () => {
  const prior = digest({ structures: [{ label: 'Structure 1', basis: 'PROP', layers: [], prop: { treaty_type: 'Quota Share', commission_pct: 30, epi: 9_000_000 } }] });
  const { changes } = computeChanges(digest(), prior);
  assert.ok(changes.some((c) => c.field === 'basis' && c.from === 'PROP' && c.to === 'NP'));
  const { changes: added } = computeChanges(digest({ structures: [...digest().structures, { label: 'Structure 2', basis: 'NP', layers: [], prop: null }] }), digest());
  assert.ok(added.some((c) => c.field === 'count' && c.from === 1 && c.to === 2));
});
