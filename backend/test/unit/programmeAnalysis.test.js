import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseProgrammes } from '../../src/modules/dashboards/programmeAnalysis.js';

/**
 * The programme analysis over a book as portfolioBook.js reads it — the pure
 * aggregation, on the cases the API test cannot reach cheaply: a line whose
 * approach carries no role, a Final Placement line with no layer premium,
 * a mixed-currency book, and the fold of the whole book into classes, years
 * and concentration.
 */

const money = (by_currency) => ({
  total: Object.values(by_currency).reduce((s, v) => s + v, 0),
  by_currency,
});

function account(over) {
  return {
    id: over.id, reference: over.id.toUpperCase(), cedant_id: over.cedant_id || `c-${over.id}`, cedant_name: 'Cedant',
    cedant_country: 'GB', cedant_region: 'EMEA', class: 'Property Cat XoL', treaty_types: 'XoL',
    status: 'SIGNED', inception: '2027-01-01', inception_year: 2027, expiry: '2027-12-31', currency: 'USD',
    est_gwp: null, layer_count: 1, total_premium100: 1_000_000, premium_order: 1_000_000, order_share_pct: 100,
    brokerage_pct: 10, brokerage_expected: 100_000, broker_role: 'Lead', lead_broker: 'Afro-Asian Insurance Services', role_source: 'order',
    lead_won: null, final_status: null, lead_reinsurers: [], lead_reinsurer: null, lead_source: null, panel: [], panel_size: 0,
    ...over,
  };
}

function line(over) {
  return {
    placement_id: over.placement_id, market_id: over.market_id, name: over.name, rating: 'A', region: 'EMEA', domicile: 'DE',
    role: 'follow', status: 'SIGNED', written_pct: 50, signed_pct: 50, premium_signed: null, currency: 'USD', premium100: 1_000_000,
    ...over,
  };
}

/** The reinsurer panel rows readBook would build for these lines (only the fields the analysis reads). */
function panelRow(market_id, name, lines, { accounts_led = 0 } = {}) {
  const share = lines.reduce((s, l) => s + Number(l.signed_pct ?? l.written_pct ?? 0), 0);
  const onLines = {};
  for (const l of lines) {
    if (l.premium100 == null) continue;
    onLines[l.currency] = (onLines[l.currency] || 0) + Number(l.premium100) * Number(l.signed_pct ?? l.written_pct ?? 0) / 100;
  }
  return {
    market_id, name, rating: 'A', region: 'EMEA', country: 'DE',
    accounts: new Set(lines.map((l) => l.placement_id)).size, lines: lines.length,
    lead_lines: lines.filter((l) => l.role === 'lead').length, follow_lines: lines.filter((l) => l.role === 'follow').length,
    signed_lines: lines.filter((l) => l.status === 'SIGNED').length, share_total: share,
    avg_line_pct: lines.length ? share / lines.length : null,
    premium_signed: money({}), premium_on_lines: money(onLines), accounts_led,
  };
}

function book(accounts, lines, { brokers = [] } = {}) {
  const panel = new Map();
  for (const l of lines) {
    if (!panel.has(l.market_id)) panel.set(l.market_id, []);
    panel.get(l.market_id).push(l);
  }
  return {
    year: null, house: 'Afro-Asian Insurance Services', summary: {}, lead_reinsurers: [],
    reinsurers: [...panel.entries()].map(([id, ls]) => panelRow(id, ls[0].name, ls)),
    brokers, accounts, lines,
  };
}

test('an empty book analyses to zeros and nulls, never NaN', () => {
  const r = analyseProgrammes(book([], []));
  assert.equal(r.summary.programmes, 0);
  assert.equal(r.summary.order_share_pct, null);
  assert.equal(r.summary.avg_panel_size, null);
  assert.equal(r.summary.concentration, null);
  assert.deepEqual([r.brokers, r.reinsurers, r.classes, r.years, r.programmes], [[], [], [], [], []]);
});

test('an account with no order to read is on the book but not a programme', () => {
  const r = analyseProgrammes(book([
    account({ id: 'a' }),
    account({ id: 'b', layer_count: 0, total_premium100: null, premium_order: null, broker_role: null, lead_broker: null, role_source: null }),
  ], []));
  assert.equal(r.summary.accounts_on_book, 2);
  assert.equal(r.summary.programmes, 1);
  assert.equal(r.summary.accounts_unstructured, 1);
  assert.deepEqual(r.programmes.map((p) => p.id), ['a']);
});

test('a line with no approach on record counts as a line and a share, but under no role', () => {
  const lines = [
    line({ placement_id: 'a', market_id: 'm1', name: 'Roleless Re', role: null, signed_pct: 30, written_pct: 30 }),
    line({ placement_id: 'a', market_id: 'm2', name: 'Lead Re', role: 'lead', signed_pct: 70, written_pct: 70 }),
  ];
  const r = analyseProgrammes(book([account({ id: 'a' })], lines));
  const byName = Object.fromEntries(r.reinsurers.map((x) => [x.name, x]));
  assert.deepEqual(
    [byName['Roleless Re'].programmes_lead, byName['Roleless Re'].programmes_follow, byName['Roleless Re'].programmes_unroled],
    [0, 0, 1],
  );
  assert.equal(byName['Roleless Re'].premium_unroled.total, 300_000);
  assert.equal(byName['Roleless Re'].premium_lead.total, 0);
  assert.deepEqual([byName['Lead Re'].programmes_lead, byName['Lead Re'].premium_lead.total], [1, 700_000]);
  // The bigger writer ranks first on equal programme counts.
  assert.deepEqual(r.reinsurers.map((x) => x.name), ['Lead Re', 'Roleless Re']);
  assert.equal(r.summary.concentration.top1_pct, 70);
});

test('a reinsurer holding lead and follow lines on one programme reads as its lead', () => {
  // Two layers on one programme: lead on the first, follow on the second.
  const lines = [
    line({ placement_id: 'a', market_id: 'm1', name: 'Both Re', role: 'lead', signed_pct: 20, written_pct: 20 }),
    line({ placement_id: 'a', market_id: 'm1', name: 'Both Re', role: 'follow', signed_pct: 10, written_pct: 10 }),
  ];
  const r = analyseProgrammes(book([account({ id: 'a', layer_count: 2 })], lines));
  const re = r.reinsurers[0];
  assert.deepEqual([re.programmes, re.programmes_lead, re.programmes_follow, re.lines, re.lead_lines, re.follow_lines], [1, 1, 0, 2, 1, 1]);
  assert.equal(re.premium_lead.total, 200_000);
  assert.equal(re.premium_follow.total, 100_000);
  assert.equal(re.premium_on_lines.total, 300_000);
});

test('a Final Placement line carries a share but no layer premium', () => {
  const lines = [
    line({ placement_id: 'a', market_id: 'm1', name: 'Final Re', role: 'follow', premium100: null, signed_pct: null, written_pct: 25, status: 'WRITTEN' }),
  ];
  const r = analyseProgrammes(book([account({ id: 'a' })], lines));
  assert.equal(r.summary.lines, 1);
  assert.equal(r.summary.signed_lines, 0);
  assert.equal(r.summary.premium_on_lines.total, 0);
  assert.equal(r.summary.concentration, null, 'no premium on lines, so no concentration to read');
  assert.equal(r.reinsurers[0].share_total, 25);
  assert.equal(r.programmes[0].lines, 1);
  assert.equal(r.programmes[0].premium_on_lines.total, 0);
});

test('brokers, classes and years fold a mixed-currency book, currency by currency', () => {
  const accounts = [
    account({ id: 'a', class: 'Property Cat XoL', currency: 'USD', total_premium100: 1_000_000, premium_order: 1_000_000, panel_size: 1 }),
    account({
      id: 'b', class: 'Motor Quota Share', treaty_types: 'QS + XoL', currency: 'EUR', total_premium100: 500_000, premium_order: 200_000, order_share_pct: 40,
      broker_role: 'Follow', lead_broker: 'Guy Carpenter', role_source: 'final', inception: '2026-01-01', inception_year: 2026, layer_count: 2, panel_size: 1,
    }),
    account({
      id: 'c', class: 'Property Cat XoL', currency: 'EUR', total_premium100: 300_000, premium_order: 300_000, inception: '2026-01-01', inception_year: 2026, panel_size: 1,
    }),
  ];
  const lines = [
    line({ placement_id: 'a', market_id: 'm1', name: 'Alpha Re', role: 'lead', signed_pct: 60, written_pct: 60, currency: 'USD' }),
    line({ placement_id: 'b', market_id: 'm1', name: 'Alpha Re', role: 'follow', signed_pct: 20, written_pct: 20, currency: 'EUR', premium100: 500_000 }),
    line({ placement_id: 'c', market_id: 'm2', name: 'Beta Re', role: 'lead', signed_pct: 50, written_pct: 50, currency: 'EUR', premium100: 300_000 }),
  ];
  const brokers = [
    { key: 'afro-asian insurance services', name: 'Afro-Asian Insurance Services', is_house: true, register_id: null },
    { key: 'guy carpenter', name: 'Guy Carpenter', is_house: false, register_id: 'reg-gc' },
  ];
  const r = analyseProgrammes(book(accounts, lines, { brokers }));

  // Brokers: this desk first; the other house's premium split into our order and the rest, per currency.
  assert.deepEqual(r.brokers.map((b) => [b.name, b.programmes, b.led, b.followed]), [['Afro-Asian Insurance Services', 2, 2, 0], ['Guy Carpenter', 1, 0, 1]]);
  assert.deepEqual(r.brokers[0].premium.by_currency, { USD: 1_000_000, EUR: 300_000 });
  assert.equal(r.brokers[0].premium_rest.total, 0);
  assert.equal(r.brokers[0].reinsurer_count, 2);
  assert.deepEqual(r.brokers[0].classes.map((c) => [c.class, c.programmes]), [['Property Cat XoL', 2]]);
  assert.equal(r.brokers[1].register_id, 'reg-gc');
  assert.deepEqual(r.brokers[1].premium_rest, { total: 300_000, by_currency: { EUR: 300_000 } });
  assert.deepEqual(r.brokers[1].treaty_types, [{ type: 'QS', programmes: 1 }, { type: 'XoL', programmes: 1 }]);
  assert.deepEqual(r.brokers[1].reinsurers.map((x) => [x.name, x.programmes, x.premium_on_lines.total]), [['Alpha Re', 1, 100_000]]);

  // Reinsurers: Alpha writes on both houses' programmes.
  const alpha = r.reinsurers.find((x) => x.name === 'Alpha Re');
  assert.equal(alpha.programmes, 2);
  assert.deepEqual(alpha.premium_on_lines.by_currency, { USD: 600_000, EUR: 100_000 });
  assert.deepEqual(alpha.brokers.map((b) => [b.name, b.is_house, b.programmes]), [['Afro-Asian Insurance Services', true, 1], ['Guy Carpenter', false, 1]]);
  // Equal programme counts rank by the premium the lines carry: 600k on the Property programme, 100k on the Motor one.
  assert.deepEqual(alpha.classes.map((c) => [c.class, c.programmes]), [['Property Cat XoL', 1], ['Motor Quota Share', 1]]);

  // Classes by weight, years in order.
  assert.deepEqual(r.classes.map((c) => [c.class, c.programmes, c.reinsurers, c.brokers]), [['Property Cat XoL', 2, 2, 1], ['Motor Quota Share', 1, 1, 1]]);
  assert.deepEqual(r.classes[0].premium.by_currency, { USD: 1_000_000, EUR: 300_000 });
  assert.deepEqual(r.years.map((y) => [y.year, y.programmes, y.led, y.followed, y.brokers, y.reinsurers, y.cedants]), [[2026, 2, 1, 1, 2, 2, 2], [2027, 1, 1, 0, 1, 1, 1]]);

  // The headline sums across currencies but keeps the split.
  assert.deepEqual(r.summary.premium_seen, { total: 1_800_000, by_currency: { USD: 1_000_000, EUR: 800_000 } });
  assert.equal(r.summary.order_share_pct, Math.round((1_500_000 / 1_800_000) * 10_000) / 100);
  assert.equal(r.summary.avg_panel_size, 1, 'one reinsurer on each programme with a line');
  // Concentration on the naive total: Alpha 700k of 850k.
  assert.equal(r.summary.concentration.reinsurers, 2);
  assert.equal(r.summary.concentration.top1_pct, Math.round((700_000 / 850_000) * 10_000) / 100);
  assert.equal(r.summary.concentration.top3_pct, 100);
});
