import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATTRIBUTION_MONTHS, isoDay, monthsAfter, attributeAccounts, readRoi, aggregateRoi } from '../../src/modules/intelligence/roi.js';

const countries = [{ code: 'GB', name: 'United Kingdom' }, { code: 'FR', name: 'France' }];
const countryOf = (d) => countries.find((c) => c.code === d || c.name === d || (d === 'UK' && c.code === 'GB')) || null;

const account = (over = {}) => ({
  id: 'a1', reference: 'GRV-27', cedant_id: 'c1', cedant_country: 'UK', inception: '2027-01-01',
  currency: 'USD', brokerage_expected: 100_000, ...over,
});
const visit = (over = {}) => ({
  country_code: 'GB', start_date: '2026-10-05', end_date: '2026-10-08', cost_amount: 8_000, cost_currency: 'USD', cedants: [], ...over,
});

test('dates: pg hands DATE columns over as local-midnight Dates, strings stay as written', () => {
  assert.equal(isoDay(new Date(2027, 0, 1)), '2027-01-01');
  assert.equal(isoDay('2027-01-01T00:00:00.000Z'), '2027-01-01');
  assert.equal(isoDay(null), null);
  assert.equal(monthsAfter('2026-10-08', ATTRIBUTION_MONTHS), '2027-10-08');
  assert.equal(monthsAfter('2026-01-31', 1), '2026-02-28', 'held to the end of a shorter month');
  assert.equal(monthsAfter('2026-12-15', 2), '2027-02-15');
});

test('a visit is credited with the country\'s accounts incepting from its first day to twelve months after its last', () => {
  const accounts = [
    account(),                                                        // 2027-01-01: inside the window
    account({ id: 'a2', reference: 'LATE', inception: '2027-10-09' }),  // a day past the window
    account({ id: 'a3', reference: 'EARLY', inception: '2026-10-04' }), // the day before the trip
    account({ id: 'a4', reference: 'FR', cedant_country: 'France', cedant_id: 'c9' }), // another country
    account({ id: 'a5', reference: 'DAY1', inception: new Date(2026, 9, 5) }),          // the trip's first day, as pg returns it
  ];
  assert.deepEqual(attributeAccounts(visit(), accounts, countryOf).map((a) => a.reference), ['GRV-27', 'DAY1']);
});

test('naming the cedants met narrows the credit to their accounts', () => {
  const accounts = [account(), account({ id: 'a2', reference: 'OTHER-GB', cedant_id: 'c2' })];
  assert.deepEqual(attributeAccounts(visit({ cedants: [{ id: 'c2', name: 'Other' }] }), accounts, countryOf).map((a) => a.reference), ['OTHER-GB']);
  assert.deepEqual(attributeAccounts(visit({ cedants: [{ id: 'c3', name: 'Nobody' }] }), accounts, countryOf), []);
});

test('the return is read in the cost\'s currency; other currencies stay unconverted', () => {
  const r = readRoi({ amount: 8_000, currency: 'USD' }, [account(), account({ id: 'a2', currency: 'EUR', brokerage_expected: 20_000 })]);
  assert.deepEqual(r.cost, { amount: 8_000, currency: 'USD' });
  assert.deepEqual(r.return, { total: 120_000, by_currency: { USD: 100_000, EUR: 20_000 } });
  assert.equal(r.return_in_cost_currency, 100_000);
  assert.deepEqual(r.unconverted, { EUR: 20_000 });
  assert.equal(r.net, 92_000);
  assert.equal(r.roi_pct, 1150);
  assert.equal(r.accounts, 2);
});

test('no cost means no ratio; a return only in another currency is unread, not a loss; no return is a loss', () => {
  assert.equal(readRoi({ amount: 0, currency: 'USD' }, [account()]).roi_pct, null);
  const elsewhere = readRoi({ amount: 8_000, currency: 'GBP' }, [account()]);
  assert.equal(elsewhere.roi_pct, null, 'USD 100k came back, and no rate turns it into pounds');
  assert.deepEqual(elsewhere.unconverted, { USD: 100_000 });
  assert.equal(elsewhere.net, -8_000, 'in pounds, nothing came back');
  assert.equal(readRoi({ amount: 8_000, currency: 'GBP' }, []).roi_pct, -100);
});

test('the scope total counts an account once however many trips it is credited to', () => {
  const a = account();
  const one = { roi: readRoi({ amount: 8_000, currency: 'USD' }, [a]), attributed: [a] };
  const two = { roi: readRoi({ amount: 2_000, currency: 'USD' }, [a]), attributed: [a] };
  const eur = { roi: readRoi({ amount: 1_500, currency: 'EUR' }, []), attributed: [] };
  const agg = aggregateRoi([one, two, eur]);
  assert.equal(agg.trips, 3);
  assert.equal(agg.accounts, 1);
  assert.deepEqual(agg.cost, { total: 11_500, by_currency: { USD: 10_000, EUR: 1_500 } });
  assert.deepEqual(agg.return, { total: 100_000, by_currency: { USD: 100_000 } });
  assert.deepEqual(agg.by_currency, [
    { currency: 'USD', cost: 10_000, return: 100_000, net: 90_000, roi_pct: 900 },
    // The euro trip brought nothing back in euros while the desk's return is in dollars: unread, not a loss.
    { currency: 'EUR', cost: 1_500, return: 0, net: -1_500, roi_pct: null },
  ]);
  const nothing = aggregateRoi([{ roi: readRoi({ amount: 500, currency: 'EUR' }, []), attributed: [] }]);
  assert.deepEqual(nothing.by_currency, [{ currency: 'EUR', cost: 500, return: 0, net: -500, roi_pct: -100 }]);
});
