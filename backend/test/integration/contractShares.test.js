// The Shares step under Contracts: the broker share and the reinsurer
// shares of the programme, each with a written and a signed share — read
// by everyone signed in, replaced as a whole by a broker or admin.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });
beforeEach(async () => { await resetDb(); });

/** A cedant and a contract (placement) through the API, as the pages create them. */
async function seedContract(api, token) {
  const cedant = (await api('POST', '/api/cedants', { token, body: { name: 'Atlas Mutual', domicile: 'GB' } })).body;
  const res = await api('POST', '/api/placements', {
    token,
    body: { cedant_id: cedant.id, class: 'Property Quota Share', inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD' },
  });
  assert.equal(res.status, 201);
  return res.body;
}

/** A reinsurer on the market register. */
async function seedMarket(name, domicile, rating) {
  const { rows } = await pool.query(
    "INSERT INTO market (name, domicile, type, rating) VALUES ($1, $2, 'reinsurer', $3) RETURNING id",
    [name, domicile, rating],
  );
  return rows[0].id;
}

test('a broker writes the broker share and the reinsurer shares with written and signed columns; anyone signed in reads them', async () => {
  const broker = await makeUser('broker');
  const uw = await makeUser('underwriter');
  await withServer(async (api) => {
    const p = await seedContract(api, broker.token);
    const swissRe = await seedMarket('Swiss Re', 'Switzerland', 'AA-');

    const empty = await api('GET', `/api/placements/${p.id}/shares`, { token: uw.token });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, {
      broker: [], reinsurers: [],
      totals: { broker: { written_pct: 0, signed_pct: 0 }, reinsurers: { written_pct: 0, signed_pct: 0 } },
    });

    const put = await api('PUT', `/api/placements/${p.id}/shares`, {
      token: broker.token,
      body: {
        broker: [
          { name: 'Afro-Asian Insurance Services', role: 'lead', written_pct: 70, signed_pct: 70 },
          { name: 'Cornerstone Broking', role: 'follow', written_pct: 30, signed_pct: 30, note: 'Co-broker on the London order' },
        ],
        reinsurers: [
          { market_id: swissRe, name: 'Swiss Re', role: 'lead', written_pct: 40, signed_pct: 35.5, reference: 'SR/27/1' },
          { name: 'Munich Re', written_pct: 30, signed_pct: 30 },
          { name: 'Hannover Re', written_pct: 45, signed_pct: null },
        ],
      },
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.broker.map((s) => [s.name, s.role, s.written_pct, s.signed_pct, s.position]), [
      ['Afro-Asian Insurance Services', 'lead', 70, 70, 0],
      ['Cornerstone Broking', 'follow', 30, 30, 1],
    ]);
    assert.equal(put.body.broker[1].note, 'Co-broker on the London order');
    assert.deepEqual(put.body.reinsurers.map((s) => [s.name, s.role, s.written_pct, s.signed_pct]), [
      ['Swiss Re', 'lead', 40, 35.5],
      ['Munich Re', 'follow', 30, 30],
      ['Hannover Re', 'follow', 45, null],
    ]);
    assert.equal(put.body.reinsurers[0].market_id, swissRe);
    assert.equal(put.body.reinsurers[0].market_rating, 'AA-', 'the register reads through');
    assert.equal(put.body.reinsurers[0].reference, 'SR/27/1');
    assert.equal(put.body.reinsurers[1].market_id, null, 'a name off the register stands on its own');
    assert.deepEqual(put.body.totals, {
      broker: { written_pct: 100, signed_pct: 100 },
      reinsurers: { written_pct: 115, signed_pct: 65.5 },
    });

    const read = await api('GET', `/api/placements/${p.id}/shares`, { token: uw.token });
    assert.deepEqual(read.body, put.body, 'the same table on a read');

    // A PUT replaces the table: the rows dropped are gone.
    const again = await api('PUT', `/api/placements/${p.id}/shares`, {
      token: broker.token,
      body: { broker: [{ name: 'Afro-Asian Insurance Services', role: 'lead', written_pct: 100, signed_pct: 100 }], reinsurers: [{ name: 'Munich Re', written_pct: 100, signed_pct: 100 }] },
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.broker.length, 1);
    assert.equal(again.body.reinsurers.length, 1);
    assert.deepEqual(again.body.totals.reinsurers, { written_pct: 100, signed_pct: 100 });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM contract_share WHERE placement_id = $1', [p.id]);
    assert.equal(rows[0].n, 2);

    // The audit trail keeps the before and after.
    const audit = await pool.query(
      "SELECT before_state, after_state FROM audit_event WHERE entity_type = 'placement' AND action = 'shares' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1",
      [p.id],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].before_state.reinsurers.length, 3);
    assert.equal(audit.rows[0].after_state.reinsurers.length, 1);
  });
});

test('only a broker or admin writes; a share is a percentage of the programme; a market must be on the register', async () => {
  const broker = await makeUser('broker');
  const uw = await makeUser('underwriter');
  await withServer(async (api) => {
    const p = await seedContract(api, broker.token);
    const ok = { broker: [], reinsurers: [{ name: 'Munich Re', written_pct: 10, signed_pct: 10 }] };
    assert.equal((await api('PUT', `/api/placements/${p.id}/shares`, { token: uw.token, body: ok })).status, 403);
    assert.equal((await api('PUT', `/api/placements/${p.id}/shares`, { body: ok })).status, 401);
    assert.equal((await api('GET', `/api/placements/${p.id}/shares`)).status, 401);
    assert.equal((await api('PUT', '/api/placements/00000000-0000-0000-0000-000000000000/shares', { token: broker.token, body: ok })).status, 404);

    const bad = async (body, why) => {
      const res = await api('PUT', `/api/placements/${p.id}/shares`, { token: broker.token, body });
      assert.equal(res.status, 422, why);
    };
    await bad({ reinsurers: [{ name: '', written_pct: 10 }] }, 'a share needs a name');
    await bad({ reinsurers: [{ name: 'Munich Re', written_pct: 120 }] }, 'over 100%');
    await bad({ reinsurers: [{ name: 'Munich Re', signed_pct: -1 }] }, 'below zero');
    await bad({ reinsurers: [{ name: 'Munich Re', written_pct: '10' }] }, 'a number, not text');
    await bad({ reinsurers: [{ name: 'Munich Re', role: 'observer' }] }, 'lead or follow');
    await bad({ reinsurers: [{ name: 'Munich Re', market_id: '00000000-0000-0000-0000-000000000000' }] }, 'a market off the register');
    assert.deepEqual((await api('GET', `/api/placements/${p.id}/shares`, { token: broker.token })).body.reinsurers, [], 'nothing was written');

    const res = await api('PUT', `/api/placements/${p.id}/shares`, { token: broker.token, body: ok });
    assert.equal(res.status, 200);
    assert.equal(res.body.reinsurers[0].role, 'follow', 'follow unless said otherwise');
  });
});
