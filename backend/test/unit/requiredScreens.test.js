// Which screens the quoting structure requires before a renewal pack goes
// for approval — the rule beside the wizard groups it applies to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiredScreens, modellingBases, modellingGroups } from '../../../frontend/src/modelling/workflow.js';

const has = (set, ...keys) => keys.every((k) => set.has(k));
const lacks = (set, ...keys) => keys.every((k) => !set.has(k));

test('the placement screens are always required', () => {
  for (const bases of [{ prop: true, np: false }, { prop: false, np: true }, 'PROP', 'NP', undefined]) {
    assert.ok(has(requiredScreens(bases), 'detail', 'expiring', 'structure'), JSON.stringify(bases));
    assert.ok(lacks(requiredScreens(bases), 'retentions', 'data'));
  }
});

test('a proportional structure requires the triangles, straight stats, dev factors, summaries and risk profile', () => {
  const r = requiredScreens({ prop: true, np: false });
  assert.ok(has(r, 'm:tri_premium', 'm:tri_paid', 'm:tri_os', 'm:straight_stats', 'm:dev_premium', 'm:dev_paid', 'm:dev_os',
    'm:projected_summary', 'm:quick_summary', 'm:risk_profile'));
  assert.ok(lacks(r, 'm:tri_incurred', 'm:dev_incurred', 'm:claims_profile', 'm:np_premiums', 'm:large_list', 'm:cat_list'));
});

test('a non-proportional structure requires the premiums table, the historical performance and both loss chains', () => {
  const r = requiredScreens({ prop: false, np: true });
  assert.ok(has(r, 'm:np_premiums', 'm:np_historical', 'm:large_list', 'm:large_selection', 'm:np_large_ldf', 'm:np_excess_dev',
    'm:risk_profile', 'm:cat_list', 'm:cat_selection', 'm:np_cat_ldf', 'm:cresta', 'm:event_loss_tables'));
  assert.ok(lacks(r, 'm:large_pareto', 'm:cat_pareto', 'm:tri_premium', 'm:straight_stats'));
});

test('all-CAT covers drop the large-loss chain; all-Risk covers drop the cat chain', () => {
  const cat = requiredScreens({ prop: false, np: true, riskDisabled: true });
  assert.ok(has(cat, 'm:cat_list', 'm:cresta', 'm:event_loss_tables', 'm:np_premiums'));
  assert.ok(lacks(cat, 'm:large_list', 'm:large_selection', 'm:np_large_ldf', 'm:np_excess_dev', 'm:risk_profile'));
  const risk = requiredScreens({ prop: false, np: true, catDisabled: true });
  assert.ok(has(risk, 'm:large_list', 'm:np_excess_dev', 'm:risk_profile'));
  assert.ok(lacks(risk, 'm:cat_list', 'm:np_cat_ldf', 'm:cresta', 'm:event_loss_tables'));
});

test('with both bases the union applies, and every required screen is one the wizard shows', () => {
  const mode = (t) => (t === 'CAT XL' ? 'CAT' : t === 'RISK XL' ? 'RISK' : 'BOTH');
  const bases = modellingBases('NON_PROPORTIONAL', [
    { basis: 'PROP', prop: { treatyType: 'QS', qsLimit: 1 } },
    { basis: 'NP', npTreatyType: 'CAT XL', layers: [{ name: 'L1', limit: 5 }] },
  ], mode);
  const r = requiredScreens(bases);
  assert.ok(has(r, 'm:tri_premium', 'm:quick_summary', 'm:np_premiums', 'm:cat_list', 'm:cresta'));
  assert.ok(lacks(r, 'm:np_large_ldf', 'm:np_excess_dev'), 'the NP large-loss chain goes with an all-CAT NP structure');
  assert.ok(has(r, 'm:risk_profile'), 'the proportional structure keeps the risk profile required');
  const shown = new Set(modellingGroups(bases).flatMap((g) => g.tabs.map(([k]) => k)));
  for (const key of r) if (key.startsWith('m:')) assert.ok(shown.has(key), `${key} is on the wizard`);
});
