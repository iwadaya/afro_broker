import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

/**
 * M10 / Phase 5 — the dashboard over the spine, computed from queries.
 */

let broker;
let uw;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  uw = await makeUser('underwriter');
});

const iso = (daysFromNow) =>
  new Date(Date.now() + daysFromNow * 86400000).toISOString().slice(0, 10);

const fotTerms = (over = {}) => ({
  currency: 'USD',
  deductible: '5000000',
  limit: '20000000',
  rate_pct: 3.75,
  rate_type: 'FLAT',
  brokerage_pct: 10,
  egnpi: '80000000',
  mdp: '1000000',
  reinstatements: [{ count: 1, rate_pct: 100 }],
  aggregate_limit: '40000000',
  ...over,
});

async function reinsurer(api, name) {
  const m = await api('POST', '/api/markets', { token: broker.token, body: { name, type: 'reinsurer' } });
  return m.body.id;
}

/** A year incepting `inceptionDays` out, with one structure promoted to FOT. */
async function setupYear(api, { cedantName, inceptionDays = 90 } = {}) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: cedantName } });
  const contract = await api('POST', '/api/contracts', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, name: 'Property Programme', cob: 'Property' },
  });
  const year = await api('POST', `/api/contracts/${contract.body.id}/years`, {
    token: broker.token,
    body: {
      year_label: 'next', inception: iso(inceptionDays), expiry: iso(inceptionDays + 365),
      currency: 'USD',
    },
  });
  assert.equal(year.status, 201, JSON.stringify(year.body));

  const structure = await api('POST', `/api/contract-years/${year.body.id}/structures`, {
    token: broker.token,
    body: { label: 'Cat XL Layer 1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property', terms: fotTerms() },
  });
  const submitted = (await api('GET', `/api/structures/${structure.body.id}`, { token: uw.token }))
    .body.versions[0];
  const fot = await api('POST', `/api/structure-versions/${submitted.id}/promote-fot`, { token: broker.token });
  return { contractId: contract.body.id, yearId: year.body.id, submittedId: submitted.id, fotId: fot.body.id };
}

test('the dashboard summarises quotes, FOTs, lines and brokerage from the spine', async () => {
  await withServer(async (api) => {
    const { yearId, submittedId, fotId } = await setupYear(api, { cedantName: 'Dashboard Mutual' });

    // A quoting round: one answer, one silence recorded at close (M6).
    const answered = await reinsurer(api, 'Answered Re');
    const silent = await reinsurer(api, 'Silent Re');
    await api('PUT', `/api/structure-versions/${submittedId}/responses`, {
      token: broker.token, body: { reinsurer_id: answered, outcome: 'QUOTED', quoted_rate_pct: 4 },
    });
    await api('POST', `/api/structure-versions/${submittedId}/close-quoting`, {
      token: broker.token, body: { approached_reinsurer_ids: [answered, silent] },
    });

    // Lines 40/40/40 on a USD 1m deposit premium, signed down to the order.
    for (const [i, pct] of [40, 40, 40].entries()) {
      const re = await reinsurer(api, `Panel Re ${i}`);
      await api('PUT', `/api/structure-versions/${fotId}/lines`, {
        token: broker.token, body: { reinsurer_id: re, written_pct: pct },
      });
    }
    await api('POST', `/api/structure-versions/${fotId}/signing/apply`, { token: broker.token, body: {} });

    const dash = await api('GET', '/api/dashboards/spine', { token: uw.token });
    assert.equal(dash.status, 200, JSON.stringify(dash.body));

    assert.deepEqual(dash.body.responses.by_outcome, { QUOTED: 1, NO_RESPONSE: 1 },
      'the silences count, because they were recorded');
    assert.equal(dash.body.fot_structures, 1);
    assert.deepEqual(dash.body.lines, { written: 0, signed: 3 });

    // D2: USD 1,000,000 premium fully allocated x 10% brokerage = USD 100,000.
    assert.deepEqual(dash.body.brokerage, [
      { currency: 'USD', amount_minor: 10000000, amount: '100000.00' },
    ]);

    // Upcoming renewals carry lead time to inception (M10).
    const up = dash.body.upcoming_renewals.find((u) => u.contract_year_id === yearId);
    assert.ok(up, 'the incepting year is listed');
    assert.equal(up.cedant_name, 'Dashboard Mutual');
    assert.ok(up.days_to_inception >= 88 && up.days_to_inception <= 91,
      `lead time ~90 days, got ${up.days_to_inception}`);
  });
});

test('a year expiring soon with no successor surfaces as a renewal not started', async () => {
  await withServer(async (api) => {
    // Expiring in ~30 days, renewal chain not extended.
    const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Lapsing Mutual' } });
    const contract = await api('POST', '/api/contracts', {
      token: broker.token,
      body: { cedant_id: cedant.body.id, name: 'Expiring Programme', cob: 'Property' },
    });
    const expiring = await api('POST', `/api/contracts/${contract.body.id}/years`, {
      token: broker.token,
      body: { year_label: 'current', inception: iso(-335), expiry: iso(30), currency: 'USD' },
    });
    assert.equal(expiring.status, 201, JSON.stringify(expiring.body));

    const before = await api('GET', '/api/dashboards/spine', { token: uw.token });
    const flagged = before.body.renewals_not_started.years
      .find((y) => y.contract_year_id === expiring.body.id);
    assert.ok(flagged, 'expiring with no successor -> renewal not started');
    assert.ok(flagged.days_to_expiry >= 28 && flagged.days_to_expiry <= 31);

    // Renewing it takes it off the list — the chain now has a successor.
    const renewed = await api('POST', `/api/contract-years/${expiring.body.id}/renew`, {
      token: broker.token, body: { year_label: 'renewal' },
    });
    assert.equal(renewed.status, 201, JSON.stringify(renewed.body));

    const after = await api('GET', '/api/dashboards/spine', { token: uw.token });
    assert.ok(
      !after.body.renewals_not_started.years.some((y) => y.contract_year_id === expiring.body.id),
      'derived from prior_contract_year_id, so renewing clears it with no bookkeeping',
    );
  });
});

test('an empty spine reports zeroes and empty lists, not errors', async () => {
  await withServer(async (api) => {
    const dash = await api('GET', '/api/dashboards/spine', { token: uw.token });
    assert.equal(dash.status, 200);
    assert.deepEqual(dash.body.responses, { by_outcome: {}, total: 0 });
    assert.equal(dash.body.fot_structures, 0);
    assert.deepEqual(dash.body.lines, { written: 0, signed: 0 });
    assert.deepEqual(dash.body.brokerage, [], 'no figure invented in a default currency');
    assert.deepEqual(dash.body.upcoming_renewals, []);
  });
});

test('unsigned written lines carry no brokerage yet', async () => {
  await withServer(async (api) => {
    const { fotId } = await setupYear(api, { cedantName: 'Unsigned Mutual' });
    const re = await reinsurer(api, 'Written Only Re');
    await api('PUT', `/api/structure-versions/${fotId}/lines`, {
      token: broker.token, body: { reinsurer_id: re, written_pct: 50 },
    });

    const dash = await api('GET', '/api/dashboards/spine', { token: uw.token });
    assert.deepEqual(dash.body.lines, { written: 1, signed: 0 });
    assert.deepEqual(dash.body.brokerage, [],
      'D2 sums over signed lines; a written line has no signed premium to take brokerage on');
  });
});
