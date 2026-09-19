import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

let broker;
let senior;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  senior = await makeUser('senior_broker');
});

/** The approval trail: the broker submits, the Senior Broker approves. */
async function approvePack(api, id) {
  await api('POST', `/api/packs/${id}/submit`, { token: broker.token, body: {} });
  const res = await api('POST', `/api/packs/${id}/approve`, { token: senior.token, body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

const PREMIUM_ROWS = [
  { policy_ref: 'P-001', insured: 'Acme Mills', class_of_business: 'Property', territory: 'Kenya',
    sum_insured_100: '5000000', si_ceded: '4000000', premium_ceded: '20000', gross_premium_100: '25000' },
  { policy_ref: 'P-002', insured: 'Rift Foods', class_of_business: 'Property', territory: 'Kenya',
    sum_insured_100: '3000000', si_ceded: '2400000', premium_ceded: '12000', gross_premium_100: '15000' },
];
const CLAIMS_ROWS = [
  { claim_ref: 'C-001', policy_ref: 'P-001', date_of_loss: '2026-03-04', cause_of_loss: 'Fire',
    paid: '20000', outstanding: '5000' },
];

async function seedPlacement(api, { cedantName = 'Store Cedant', reference } = {}) {
  const cedant = await api('POST', '/api/cedants', {
    token: broker.token, body: { name: cedantName, domicile: 'Kenya' },
  });
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: {
      cedant_id: cedant.body.id, class: 'Property Cat XoL', inception: '2026-01-01',
      expiry: '2026-12-31', currency: 'USD', ...(reference ? { reference } : {}),
    },
  });
  assert.equal(placement.status, 201);
  return { cedant: cedant.body, placement_id: placement.body.id };
}

async function addBordereaux(api, pid) {
  await api('POST', `/api/placements/${pid}/bordereaux`, {
    token: broker.token,
    body: { type: 'premium', source_file: '2025 premium bdx.xlsx', period_start: '2025-01-01', period_end: '2025-12-31', rows: PREMIUM_ROWS },
  });
  await api('POST', `/api/placements/${pid}/bordereaux`, {
    token: broker.token,
    body: { type: 'claims', source_file: '2025 claims bdx.xlsx', period_start: '2025-01-01', period_end: '2025-12-31', rows: CLAIMS_ROWS },
  });
}

test('a pack version holds the bordereaux it was built on, rows and all', async () => {
  await withServer(async (api) => {
    const { placement_id: pid } = await seedPlacement(api);
    await addBordereaux(api, pid);

    const built = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });
    assert.equal(built.status, 201);

    const bdx = built.body.snapshot.bordereaux;
    assert.equal(bdx.length, 2, 'both bordereaux are held with the version');

    const premium = bdx.find((b) => b.type === 'premium');
    assert.equal(premium.source_file, '2025 premium bdx.xlsx');
    assert.equal(premium.row_count, 2);
    assert.equal(premium.rows.length, 2, 'the parsed rows travel with the pack');
    assert.equal(premium.rows[0].policy_ref, 'P-001');
    assert.equal(premium.period_start.slice(0, 10), '2025-01-01');

    const claims = bdx.find((b) => b.type === 'claims');
    assert.equal(claims.rows.length, 1);
    assert.equal(claims.rows[0].claim_ref, 'C-001');
  });
});

test('a version keeps the bordereaux it was cut with after the source changes', async () => {
  await withServer(async (api) => {
    const { placement_id: pid } = await seedPlacement(api);
    await addBordereaux(api, pid);
    const v1 = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });
    assert.equal(v1.body.snapshot.bordereaux.length, 2);

    // A restated bordereau arrives; v1 must not move.
    await api('POST', `/api/placements/${pid}/bordereaux`, {
      token: broker.token,
      body: { type: 'premium', source_file: 'restated premium bdx.xlsx', rows: PREMIUM_ROWS.slice(0, 1) },
    });
    const v2 = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });
    assert.equal(v2.body.version, 2);
    assert.equal(v2.body.snapshot.bordereaux.length, 3, 'v2 sees the restatement');

    const reread = await api('GET', `/api/packs/${v1.body.id}`, { token: broker.token });
    assert.equal(reread.body.snapshot.bordereaux.length, 2, 'v1 is unchanged evidence');
  });
});

test('a version carries a title, notes, attachments and anything else', async () => {
  await withServer(async (api) => {
    const { placement_id: pid } = await seedPlacement(api);
    const built = await api('POST', `/api/placements/${pid}/packs`, {
      token: broker.token,
      body: {
        title: '2026 renewal submission',
        notes: 'Structure unchanged; rate discussion open with the lead.',
        attachments: [
          { name: 'exposure_2026.xlsx', kind: 'exposure', file: 's3://packs/exposure_2026.xlsx' },
          { name: 'cover_letter.pdf', kind: 'correspondence', note: 'Signed by the cedant' },
        ],
        extra: { broker_view: 'push for 7.5% off', prior_year_lead: 'Africa Re' },
      },
    });
    assert.equal(built.status, 201);
    assert.equal(built.body.title, '2026 renewal submission');
    assert.equal(built.body.attachments.length, 2);
    assert.deepEqual(built.body.extra, { broker_view: 'push for 7.5% off', prior_year_lead: 'Africa Re' });

    const listed = await api('GET', `/api/placements/${pid}/packs`, { token: broker.token });
    assert.equal(listed.body[0].contents.attachments, 2);
    assert.equal(listed.body[0].created_by_name, broker.user.name);
  });
});

test('draft metadata is amendable; an approved version is frozen', async () => {
  await withServer(async (api) => {
    const { placement_id: pid } = await seedPlacement(api);
    const built = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: { title: 'Draft' } });

    const amended = await api('PATCH', `/api/packs/${built.body.id}`, {
      token: broker.token, body: { notes: 'Lead agreed at 4.5%' },
    });
    assert.equal(amended.status, 200);
    assert.equal(amended.body.notes, 'Lead agreed at 4.5%');
    assert.equal(amended.body.title, 'Draft', 'an omitted field is left alone');

    await approvePack(api, built.body.id);
    const frozen = await api('PATCH', `/api/packs/${built.body.id}`, {
      token: broker.token, body: { notes: 'too late' },
    });
    assert.equal(frozen.status, 409, 'an approved pack is a new version, not an edit');
  });
});

test('the store groups every version under its cedant, newest first', async () => {
  await withServer(async (api) => {
    const a = await seedPlacement(api, { cedantName: 'Alpha Mutual' });
    const b = await seedPlacement(api, { cedantName: 'Beta Assurance' });
    await addBordereaux(api, a.placement_id);

    for (const title of ['v1 submission', 'v2 post-quote', 'v3 final']) {
      await api('POST', `/api/placements/${a.placement_id}/packs`, { token: broker.token, body: { title } });
    }
    await api('POST', `/api/placements/${b.placement_id}/packs`, { token: broker.token, body: {} });

    const store = await api('GET', '/api/packs/by-cedant', { token: broker.token });
    assert.equal(store.status, 200);
    assert.equal(store.body.pack_count, 4);
    assert.deepEqual(store.body.cedants.map((c) => c.cedant_name), ['Alpha Mutual', 'Beta Assurance']);

    const alpha = store.body.cedants[0];
    assert.equal(alpha.pack_count, 3);
    assert.equal(alpha.placements.length, 1);
    assert.deepEqual(alpha.placements[0].packs.map((p) => p.version), [3, 2, 1], 'newest version first');
    assert.deepEqual(alpha.placements[0].packs.map((p) => p.title), ['v3 final', 'v2 post-quote', 'v1 submission']);
    // Every version indexes what it holds without shipping the whole snapshot.
    assert.equal(alpha.placements[0].packs[0].contents.bordereaux, 2);
    assert.equal(alpha.placements[0].packs[0].contents.bordereau_rows, 3);
    assert.equal(alpha.placements[0].packs[0].snapshot, undefined);
  });
});

test('the store filters by cedant and by status', async () => {
  await withServer(async (api) => {
    const a = await seedPlacement(api, { cedantName: 'Alpha Mutual' });
    const b = await seedPlacement(api, { cedantName: 'Beta Assurance' });
    const draft = await api('POST', `/api/placements/${a.placement_id}/packs`, { token: broker.token, body: {} });
    await api('POST', `/api/placements/${b.placement_id}/packs`, { token: broker.token, body: {} });
    await approvePack(api, draft.body.id);

    const byCedant = await api('GET', `/api/packs/by-cedant?cedant_id=${a.cedant.id}`, { token: broker.token });
    assert.equal(byCedant.body.cedants.length, 1);
    assert.equal(byCedant.body.cedants[0].cedant_name, 'Alpha Mutual');

    const approved = await api('GET', '/api/packs/by-cedant?status=approved', { token: broker.token });
    assert.equal(approved.body.pack_count, 1);
    assert.equal(approved.body.cedants[0].cedant_name, 'Alpha Mutual');

    // The flat listing is the same store, newest first.
    const flat = await api('GET', '/api/packs', { token: broker.token });
    assert.equal(flat.status, 200);
    assert.equal(flat.body.length, 2);
    assert.ok(flat.body[0].cedant_name, 'the flat listing names the cedant');
  });
});

test('by-cedant is not read as a pack id', async () => {
  await withServer(async (api) => {
    // `/packs/by-cedant` must win over `/packs/:id`, which would otherwise
    // take "by-cedant" for a uuid.
    const store = await api('GET', '/api/packs/by-cedant', { token: broker.token });
    assert.equal(store.status, 200);
    assert.deepEqual(store.body, { cedants: [], pack_count: 0 });
  });
});
