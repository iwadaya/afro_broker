import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REGIMES, REGIME_FAMILIES, listRegimes, regimeFor, domicileCode, bandOf,
  interventionPct, controlPct, assessCapitalPosition,
} from '../../src/domain/capitalRegimes.js';

test('every regime is complete and its ladder runs top-down to zero', () => {
  assert.ok(REGIMES.length >= 70);
  const codes = new Set();
  for (const r of REGIMES) {
    assert.ok(!codes.has(r.code), `duplicate ${r.code}`);
    codes.add(r.code);
    assert.ok(REGIME_FAMILIES[r.family], `${r.code}: family`);
    assert.ok(['economic', 'factor', 'fixed'].includes(r.style), `${r.code}: style`);
    for (const k of ['country', 'regime', 'regulator', 'requirement']) assert.ok(r[k], `${r.code}: ${k}`);
    assert.ok(r.ratio?.label && r.ratio.numerator && r.ratio.denominator, `${r.code}: ratio`);
    const floors = r.ladder.map((b) => b.min_pct);
    assert.equal(floors[floors.length - 1], 0, `${r.code}: the ladder ends at 0`);
    for (let i = 1; i < floors.length; i += 1) assert.ok(floors[i] < floors[i - 1], `${r.code}: ladder order`);
    assert.equal(r.ladder[0].tone, 'good', `${r.code}: the top band is the good one`);
    for (const b of r.ladder) assert.ok(b.level && b.action && ['good', 'warn', 'bad'].includes(b.tone), `${r.code}: band`);
    if (r.family === 'minimum_capital') assert.equal(r.proxy, null, `${r.code}: nothing modelled stands in for a fixed minimum`);
    else assert.ok(r.proxy && r.proxy.at_pct > 0 && ['var', 'tvar'].includes(r.proxy.measure), `${r.code}: proxy`);
  }
});

test('the picker lists every country alphabetically with the regime in a word', () => {
  const list = listRegimes();
  assert.equal(list.length, REGIMES.length);
  const names = list.map((r) => r.country);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  const gb = list.find((r) => r.code === 'GB');
  assert.equal(gb.family, 'solvency_ii');
  assert.equal(gb.family_label, 'Solvency II');
  assert.equal(list.find((r) => r.code === 'US').family, 'rbc');
  assert.equal(list.find((r) => r.code === 'IN').family, 'solvency_margin');
  assert.equal(list.find((r) => r.code === 'ZW').family, 'minimum_capital');
});

test('a stored domicile finds its country by code, name or alias', () => {
  assert.equal(domicileCode('GB'), 'GB');
  assert.equal(domicileCode('gb'), 'GB');
  assert.equal(domicileCode('UK'), 'GB');
  assert.equal(domicileCode('United Kingdom'), 'GB');
  assert.equal(domicileCode('Norway'), 'NO');
  assert.equal(domicileCode('USA'), 'US');
  assert.equal(domicileCode('UAE'), 'AE');
  assert.equal(domicileCode('Bermuda'), 'BM');
  assert.equal(domicileCode('Atlantis'), null);
  assert.equal(domicileCode(''), null);
  assert.equal(domicileCode(null), null);
  assert.equal(regimeFor('Switzerland').regime, 'Swiss Solvency Test (SST)');
  assert.equal(regimeFor('nowhere'), null);
  assert.equal(regimeFor('DE').as_at, '2026');
});

test('a ratio lands in the right band and the action levels read off the ladder', () => {
  const us = regimeFor('US');
  assert.equal(bandOf(us.ladder, 250).level, 'No action');
  assert.equal(bandOf(us.ladder, 200).level, 'No action');
  assert.equal(bandOf(us.ladder, 199.9).level, 'Company Action Level');
  assert.equal(bandOf(us.ladder, 120).level, 'Regulatory Action Level');
  assert.equal(bandOf(us.ladder, 80).level, 'Authorized Control Level');
  assert.equal(bandOf(us.ladder, 10).level, 'Mandatory Control Level');
  assert.equal(bandOf(us.ladder, -5).level, 'Mandatory Control Level');
  assert.equal(bandOf(us.ladder, null), null);
  assert.equal(interventionPct(us), 200);
  assert.equal(controlPct(us), 70);
  const gb = regimeFor('GB');
  assert.equal(interventionPct(gb), 100);
  assert.equal(controlPct(gb), 25);
  assert.equal(bandOf(gb.ladder, 60).level, 'SCR breached');
  assert.equal(bandOf(gb.ladder, 30).tone, 'bad');
});

test('the capital position reads the modelled capital through the regime proxy', () => {
  // Solvency II: the modelled 1-in-200 loss is the SCR; 150 held against 100 needed.
  const gb = assessCapitalPosition(regimeFor('GB'), { available: 150, modelled: 100 });
  assert.equal(gb.required, 100);
  assert.equal(gb.required_source, 'modelled');
  assert.equal(gb.ratio_pct, 150);
  assert.equal(gb.band.level, 'SCR met');
  assert.equal(gb.strain_before_action, 50);   // down to 100% of the SCR
  assert.equal(gb.strain_before_control, 125); // down to 25% of the SCR
  assert.equal(gb.needs_input, false);

  // NAIC: the modelled capital is the RBC after covariance, twice the ACL.
  const us = assessCapitalPosition(regimeFor('US'), { available: 150, modelled: 100 });
  assert.equal(us.required, 50);
  assert.equal(us.ratio_pct, 300);
  assert.equal(us.band.level, 'No action');
  assert.equal(us.strain_before_action, 50);  // to 200% of the ACL
  assert.equal(us.strain_before_control, 115); // to 70% of the ACL

  // A typed regulatory figure wins over the proxy.
  const given = assessCapitalPosition(regimeFor('US'), { available: 150, modelled: 100, given: 100 });
  assert.equal(given.required, 100);
  assert.equal(given.required_source, 'given');
  assert.equal(given.ratio_pct, 150);
  assert.equal(given.band.level, 'Company Action Level');
  assert.equal(given.strain_before_action, -50); // already below it

  // A fixed minimum capital has nothing modelled to stand in for it.
  const zw = assessCapitalPosition(regimeFor('ZW'), { available: 150, modelled: 100 });
  assert.equal(zw.needs_input, true);
  assert.equal(zw.ratio_pct, null);
  const zwGiven = assessCapitalPosition(regimeFor('ZW'), { available: 150, given: 120 });
  assert.equal(zwGiven.ratio_pct, 125);
  assert.equal(zwGiven.band.level, 'Minimum capital held');
  assert.equal(assessCapitalPosition(null, { available: 1 }), null);
});
