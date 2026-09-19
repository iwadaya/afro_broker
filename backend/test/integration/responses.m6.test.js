import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { seedDeclineReasons } from '../../src/db/seedDeclineReasons.js';

/**
 * M6 — quote response tracking on StructureVersion.
 */

let broker;
let uw;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await resetDb();
  await seedDeclineReasons();
  broker = await makeUser('broker');
  uw = await makeUser('underwriter');
});

const catXlTerms = (over = {}) => ({
  currency: 'USD',
  deductible: '5000000',
  limit: '20000000',
  rate_pct: 3.75,
  rate_type: 'FLAT',
  brokerage_pct: 10,
  ...over,
});

async function setup(api, { cedantName = 'Response Mutual' } = {}) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: cedantName } });
  const contract = await api('POST', '/api/contracts', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, name: 'Property Programme', cob: 'Property', territory: 'MENA' },
  });
  const year = await api('POST', `/api/contracts/${contract.body.id}/years`, {
    token: broker.token,
    body: { year_label: '2026', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
  });
  const structure = await api('POST', `/api/contract-years/${year.body.id}/structures`, {
    token: broker.token,
    body: {
      label: 'Cat XL Layer 1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property',
      status: 'SUBMITTED', terms: catXlTerms(),
    },
  });
  assert.equal(structure.status, 201, JSON.stringify(structure.body));
  const detail = await api('GET', `/api/structures/${structure.body.id}`, { token: uw.token });
  return {
    yearId: year.body.id,
    structureId: structure.body.id,
    versionId: detail.body.versions[0].id,
  };
}

const mkReinsurer = async (api, name) =>
  (await api('POST', '/api/markets', { token: broker.token, body: { name } })).body.id;

test('every outcome M6 names can be recorded, including the ones easy to lose', async () => {
  await withServer(async (api) => {
    const { versionId } = await setup(api);
    const outcomes = ['QUOTED', 'DECLINED', 'ABSTAINED'];
    const ids = [];
    for (const [i, outcome] of outcomes.entries()) {
      const id = await mkReinsurer(api, `Re ${i}`);
      ids.push(id);
      const res = await api('PUT', `/api/structure-versions/${versionId}/responses`, {
        token: broker.token,
        body: {
          reinsurer_id: id,
          outcome,
          ...(outcome === 'QUOTED' ? { quoted_rate_pct: 4.1, quoted_line_pct: 15 } : {}),
          ...(outcome === 'DECLINED' ? { decline_reason_code: 'CAPACITY' } : {}),
        },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.outcome, outcome);
    }

    const list = await api('GET', `/api/structure-versions/${versionId}/responses`, { token: uw.token });
    assert.deepEqual(list.body.map((r) => r.outcome).sort(), ['ABSTAINED', 'DECLINED', 'QUOTED']);
    assert.equal(list.body.find((r) => r.outcome === 'DECLINED').decline_reason_code, 'CAPACITY');
  });
});

test('a decline needs a reason code — D4 makes it one click plus a reason', async () => {
  await withServer(async (api) => {
    const { versionId } = await setup(api);
    const re = await mkReinsurer(api, 'Silent Re');

    const noReason = await api('PUT', `/api/structure-versions/${versionId}/responses`, {
      token: broker.token, body: { reinsurer_id: re, outcome: 'DECLINED' },
    });
    assert.equal(noReason.status, 409);
    assert.match(noReason.body.error, /reason code/i);

    // And the table refuses one even if the route is bypassed: without the code
    // the negative examples the model depends on carry no signal.
    await assert.rejects(
      pool.query(
        `INSERT INTO structure_response (structure_version_id, reinsurer_id, outcome)
         VALUES ($1,$2,'DECLINED')`,
        [versionId, re],
      ),
      /structure_response_decline_has_reason/,
    );
  });
});

test('an alternative quote becomes a StructureVersion, linked to what was submitted', async () => {
  await withServer(async (api) => {
    const { structureId, versionId } = await setup(api);
    const re = await mkReinsurer(api, 'Counter Re');

    const res = await api('PUT', `/api/structure-versions/${versionId}/responses`, {
      token: broker.token,
      body: {
        reinsurer_id: re,
        outcome: 'ALTERNATIVE_QUOTED',
        alternative_terms: catXlTerms({ deductible: '7500000' }),
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.alternative_version_id);

    const detail = await api('GET', `/api/structures/${structureId}`, { token: uw.token });
    assert.equal(detail.body.versions.length, 2);
    const alt = detail.body.versions[1];
    assert.equal(alt.status, 'ALTERNATIVE');
    assert.equal(alt.origin, 'REINSURER');
    assert.equal(alt.origin_party_name, 'Counter Re');
    assert.equal(alt.parent_version_id, versionId, 'linked to what it counters');
    assert.equal(alt.terms.deductible, 750000000);

    // "Reinsurer X always counters with a higher deductible" is now a query.
    const diff = await api('GET', `/api/structure-versions/${versionId}/diff/${alt.id}`, { token: uw.token });
    assert.deepEqual(diff.body.changes.map((c) => c.path), ['deductible']);
  });
});

test('an alternative quote without its terms is refused, and the table agrees', async () => {
  await withServer(async (api) => {
    const { versionId } = await setup(api);
    const re = await mkReinsurer(api, 'Vague Re');

    const res = await api('PUT', `/api/structure-versions/${versionId}/responses`, {
      token: broker.token, body: { reinsurer_id: re, outcome: 'ALTERNATIVE_QUOTED' },
    });
    assert.equal(res.status, 409);

    await assert.rejects(
      pool.query(
        `INSERT INTO structure_response (structure_version_id, reinsurer_id, outcome)
         VALUES ($1,$2,'ALTERNATIVE_QUOTED')`,
        [versionId, re],
      ),
      /structure_response_alternative_has_version/,
    );
  });
});

test('an alternative quote with terms that fail the schema is refused whole', async () => {
  await withServer(async (api) => {
    const { structureId, versionId } = await setup(api);
    const re = await mkReinsurer(api, 'Sloppy Re');
    const bad = catXlTerms();
    delete bad.limit;

    const res = await api('PUT', `/api/structure-versions/${versionId}/responses`, {
      token: broker.token,
      body: { reinsurer_id: re, outcome: 'ALTERNATIVE_QUOTED', alternative_terms: bad },
    });
    assert.equal(res.status, 422);

    const detail = await api('GET', `/api/structures/${structureId}`, { token: uw.token });
    assert.equal(detail.body.versions.length, 1, 'no half-written version left behind');
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM structure_response');
    assert.equal(rows[0].n, 0);
  });
});

test('NO_RESPONSE is recorded explicitly at close, not inferred from absent rows', async () => {
  await withServer(async (api) => {
    const { versionId } = await setup(api);
    const quoted = await mkReinsurer(api, 'Answered Re');
    const silentA = await mkReinsurer(api, 'Silent A Re');
    const silentB = await mkReinsurer(api, 'Silent B Re');

    await api('PUT', `/api/structure-versions/${versionId}/responses`, {
      token: broker.token, body: { reinsurer_id: quoted, outcome: 'QUOTED', quoted_rate_pct: 4 },
    });

    const close = await api('POST', `/api/structure-versions/${versionId}/close-quoting`, {
      token: broker.token,
      body: { approached_reinsurer_ids: [quoted, silentA, silentB] },
    });
    assert.equal(close.status, 200);
    assert.equal(close.body.no_response_recorded, 2, 'the two who never replied');

    const list = await api('GET', `/api/structure-versions/${versionId}/responses`, { token: uw.token });
    assert.equal(list.body.length, 3);
    assert.equal(list.body.find((r) => r.reinsurer_id === quoted).outcome, 'QUOTED',
      'closing does not overwrite an answer that was given');
    assert.equal(
      list.body.filter((r) => r.outcome === 'NO_RESPONSE').length, 2,
      'silence is a recorded outcome, distinguishable from never having asked',
    );
  });
});

test('closing twice is idempotent', async () => {
  await withServer(async (api) => {
    const { versionId } = await setup(api);
    const re = await mkReinsurer(api, 'Quiet Re');
    await api('POST', `/api/structure-versions/${versionId}/close-quoting`, {
      token: broker.token, body: { approached_reinsurer_ids: [re] },
    });
    const again = await api('POST', `/api/structure-versions/${versionId}/close-quoting`, {
      token: broker.token, body: { approached_reinsurer_ids: [re] },
    });
    assert.equal(again.body.no_response_recorded, 0);
  });
});

test('the response carries the context as it stood, because ratings move', async () => {
  await withServer(async (api) => {
    const cedant = await api('POST', '/api/cedants', {
      token: broker.token, body: { name: 'Rated Mutual' },
    });
    // A cedant's rating lives on its entry in the counterparty register, which
    // POST /cedants creates alongside it.
    await pool.query(
      `UPDATE market SET rating = 'A-', rating_agency = 'AM Best'
       WHERE id = (SELECT market_id FROM cedant WHERE id = $1)`,
      [cedant.body.id],
    );

    const contract = await api('POST', '/api/contracts', {
      token: broker.token,
      body: { cedant_id: cedant.body.id, name: 'P', cob: 'Property', territory: 'MENA' },
    });
    const year = await api('POST', `/api/contracts/${contract.body.id}/years`, {
      token: broker.token,
      body: { year_label: '2026', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
    });
    const structure = await api('POST', `/api/contract-years/${year.body.id}/structures`, {
      token: broker.token,
      body: { label: 'L1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property', terms: catXlTerms() },
    });
    const versionId = (await api('GET', `/api/structures/${structure.body.id}`, { token: uw.token }))
      .body.versions[0].id;

    const re = await mkReinsurer(api, 'Snapshot Re');
    await api('PUT', `/api/structure-versions/${versionId}/responses`, {
      token: broker.token, body: { reinsurer_id: re, outcome: 'QUOTED', quoted_rate_pct: 4 },
    });

    // The cedant is downgraded after the decision was made.
    await pool.query(
      "UPDATE market SET rating = 'BBB' WHERE id = (SELECT market_id FROM cedant WHERE id = $1)",
      [cedant.body.id],
    );

    const { rows } = await pool.query('SELECT * FROM structure_response WHERE reinsurer_id = $1', [re]);
    assert.equal(rows[0].snapshot_cedant_rating, 'A-',
      'the model must see the rating in front of the underwriter, not the current one');
    assert.equal(rows[0].snapshot_cedant_rating_agency, 'AM Best',
      'a rating without its agency is not a rating');
    assert.equal(rows[0].snapshot_cob, 'Property');
    assert.equal(rows[0].snapshot_treaty_type, 'PROPERTY_CAT_XL');
    assert.equal(rows[0].snapshot_territory, 'MENA');
    assert.equal(Number(rows[0].snapshot_deductible_minor), 500000000);
    assert.equal(Number(rows[0].snapshot_limit_minor), 2000000000);
    assert.equal(rows[0].market_conditions, null, 'reserved, and honestly empty');
  });
});

test('a reinsurer history reads across placements as a query', async () => {
  await withServer(async (api) => {
    const re = await mkReinsurer(api, 'Historic Re');

    const first = await setup(api, { cedantName: 'Cedant One' });
    await api('PUT', `/api/structure-versions/${first.versionId}/responses`, {
      token: broker.token, body: { reinsurer_id: re, outcome: 'QUOTED', quoted_rate_pct: 4.2 },
    });

    const second = await setup(api, { cedantName: 'Cedant Two' });
    await api('PUT', `/api/structure-versions/${second.versionId}/responses`, {
      token: broker.token,
      body: { reinsurer_id: re, outcome: 'DECLINED', decline_reason_code: 'PRICE' },
    });

    const history = await api('GET', `/api/reinsurers/${re}/response-history`, { token: uw.token });
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.by_outcome, { QUOTED: 1, DECLINED: 1 });
    assert.equal(history.body.responses.length, 2);
    assert.deepEqual(history.body.responses.map((r) => r.cedant_name).sort(), ['Cedant One', 'Cedant Two']);
    assert.equal(history.body.responses.find((r) => r.outcome === 'DECLINED').decline_reason_code, 'PRICE');
  });
});

test('re-recording a response replaces it rather than adding a second', async () => {
  await withServer(async (api) => {
    const { versionId } = await setup(api);
    const re = await mkReinsurer(api, 'Changed Mind Re');

    await api('PUT', `/api/structure-versions/${versionId}/responses`, {
      token: broker.token, body: { reinsurer_id: re, outcome: 'DECLINED', decline_reason_code: 'TIMING' },
    });
    await api('PUT', `/api/structure-versions/${versionId}/responses`, {
      token: broker.token, body: { reinsurer_id: re, outcome: 'QUOTED', quoted_rate_pct: 3.9 },
    });

    const list = await api('GET', `/api/structure-versions/${versionId}/responses`, { token: uw.token });
    assert.equal(list.body.length, 1, 'one market, one outcome');
    assert.equal(list.body[0].outcome, 'QUOTED');
    assert.equal(list.body[0].decline_reason_code, null, 'the decline reason does not linger');
  });
});

test('a quoted premium carries its currency, in minor units', async () => {
  await withServer(async (api) => {
    const { versionId } = await setup(api);
    const re = await mkReinsurer(api, 'Priced Re');
    await api('PUT', `/api/structure-versions/${versionId}/responses`, {
      token: broker.token,
      body: {
        reinsurer_id: re, outcome: 'QUOTED',
        quoted_premium: '750000.50', quoted_currency: 'USD',
      },
    });
    const { rows } = await pool.query('SELECT * FROM structure_response WHERE reinsurer_id = $1', [re]);
    assert.equal(Number(rows[0].quoted_premium_minor), 75000050);
    assert.equal(rows[0].quoted_currency, 'USD');

    await assert.rejects(
      pool.query('UPDATE structure_response SET quoted_currency = NULL WHERE reinsurer_id = $1', [re]),
      /structure_response_premium_currency/,
    );
  });
});
