// SQL proofs for the bk_* constraints (step 02). Every case runs inside a
// transaction that is rolled back, so the suite leaves no rows behind. Expected
// failures run under a SAVEPOINT so the transaction stays usable afterwards.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { shouldSkipDb, pool, closePools, refIds, ORG_A, BROKER_USER_ID } from './helpers.js';

const CONTRACT_SQL = `INSERT INTO public.bk_contract (umr, business_type, org_id, created_by_user_id)
                      VALUES ($1, 'PROPORTIONAL', '${ORG_A}', '${BROKER_USER_ID}') RETURNING contract_id`;

async function withTx(fn) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); return await fn(client); }
  finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
}

/** Run `sql` under a savepoint and assert it fails with the SQLSTATE (and constraint). */
async function expectFail(client, sql, params, code, constraint) {
  await client.query('SAVEPOINT s');
  let caught = null;
  try { await client.query(sql, params); } catch (e) { caught = e; }
  await client.query('ROLLBACK TO SAVEPOINT s');
  expect(caught, `expected SQLSTATE ${code} for: ${sql.slice(0, 90)}`).not.toBeNull();
  expect(caught.code).toBe(code);
  if (constraint) expect(caught.constraint).toBe(constraint);
  return caught;
}

const newContract = async (client, umr) => (await client.query(CONTRACT_SQL, [umr])).rows[0].contract_id;

describe.skipIf(shouldSkipDb)('bk_* constraints (SQL proofs)', () => {
  let refs;
  beforeAll(async () => { refs = await refIds(); });
  afterAll(async () => { await closePools(); });

  it('rejects a duplicate UMR (unique_violation 23505)', () => withTx(async (client) => {
    await newContract(client, 'B0621DUPTEST001');
    await expectFail(client, CONTRACT_SQL, ['B0621DUPTEST001'], '23505', 'bk_contract_umr_unique');
  }));

  it('rejects a lowercase UMR (check_violation 23514)', () => withTx(async (client) => {
    await expectFail(client, CONTRACT_SQL, ['b0621dar26tr001'], '23514', 'bk_contract_umr_format');
  }));

  it('rejects badly formatted UMRs: wrong prefix, 3-digit broker no., spaces, too long, too short', () => withTx(async (client) => {
    for (const bad of ['X0621DAR26TR001', 'B621DAR26TR001', 'B0621 DAR26TR001', 'B0621', 'B0621DAR-26']) {
      await expectFail(client, CONTRACT_SQL, [bad], '23514', 'bk_contract_umr_format');
    }
    // 18+ characters never reach the CHECK: varchar(17) rejects them first (string_data_right_truncation).
    await expectFail(client, CONTRACT_SQL, ['B0621DAR26TR0012345'], '22001');
    await newContract(client, 'B0621DAR26TR999'); // the well-formed one is accepted
  }));

  it('rejects aad_amount without aad (check_violation 23514) and accepts it once aad is ticked', () => withTx(async (client) => {
    const id = await newContract(client, 'B0621AADTEST001');
    await expectFail(client,
      `INSERT INTO public.bk_np_layer (contract_id, layer_number, layer_limit, aad, aad_amount) VALUES ($1, 1, 1000000, false, 250000)`,
      [id], '23514', 'bk_np_layer_aad_amount');
    await client.query(`INSERT INTO public.bk_np_layer (contract_id, layer_number, layer_limit, aad, aad_amount) VALUES ($1, 1, 1000000, true, 250000)`, [id]);
    await client.query(`INSERT INTO public.bk_np_layer (contract_id, layer_number, layer_limit, aad, aad_amount) VALUES ($1, 2, 1000000, false, NULL)`, [id]);
  }));

  it('enforces layer_number uniqueness per contract (23505) while allowing the same number on another contract', () => withTx(async (client) => {
    const a = await newContract(client, 'B0621LAYTEST001');
    const b = await newContract(client, 'B0621LAYTEST002');
    await client.query(`INSERT INTO public.bk_np_layer (contract_id, layer_number, layer_limit) VALUES ($1, 1, 1)`, [a]);
    await client.query(`INSERT INTO public.bk_np_layer (contract_id, layer_number, layer_limit) VALUES ($1, 1, 1)`, [b]);
    await expectFail(client, `INSERT INTO public.bk_np_layer (contract_id, layer_number, layer_limit) VALUES ($1, 1, 2)`, [a], '23505', 'bk_np_layer_contract_id_layer_number_key');
  }));

  it('rejects leaving DRAFT with an incomplete header (bk_contract_header_complete)', () => withTx(async (client) => {
    const id = await newContract(client, 'B0621STATEST001');
    await expectFail(client, `UPDATE public.bk_contract SET status = 'SUBMITTED' WHERE contract_id = $1`, [id], '23514', 'bk_contract_header_complete');
    await client.query(
      `UPDATE public.bk_contract SET country_id=$2, cedant_id=$3, broker_id=$4, currency_id=$5, treaty_type_id=$6, uw_year=2026, inception_date='2026-01-01', status='SUBMITTED' WHERE contract_id=$1`,
      [id, refs.countryId, refs.cedantId, refs.brokerId, refs.currencyId, refs.type('Quota Share')]);
  }));

  it('rejects a renewal date on or before inception (bk_contract_dates)', () => withTx(async (client) => {
    const id = await newContract(client, 'B0621DATTEST001');
    await expectFail(client, `UPDATE public.bk_contract SET inception_date='2026-01-01', renewal_date='2026-01-01' WHERE contract_id=$1`, [id], '23514', 'bk_contract_dates');
    await client.query(`UPDATE public.bk_contract SET inception_date='2026-01-01', renewal_date='2027-01-01' WHERE contract_id=$1`, [id]);
  }));

  it('bounds percentages (pct100, loss cap 0–1000, lcf_years 0–20, ≤5 LP slides, % reinstatements 0–1000)', () => withTx(async (client) => {
    const id = await newContract(client, 'B0621PCTTEST001');
    await expectFail(client, `INSERT INTO public.bk_prop_details (contract_id, retention_pct) VALUES ($1, 101)`, [id], '23514');
    await expectFail(client, `INSERT INTO public.bk_prop_details (contract_id, loss_cap_pct) VALUES ($1, 1001)`, [id], '23514');
    await expectFail(client, `INSERT INTO public.bk_commissions (contract_id, lcf_years) VALUES ($1, 21)`, [id], '23514');
    await expectFail(client, `INSERT INTO public.bk_loss_participation (contract_id, slides) VALUES ($1, '[{},{},{},{},{},{}]'::jsonb)`, [id], '23514', 'bk_loss_participation_slides_shape');
    await expectFail(client, `INSERT INTO public.bk_np_layer (contract_id, layer_number, reinstatement_pct) VALUES ($1, 1, 1001)`, [id], '23514');
    await expectFail(client, `INSERT INTO public.bk_np_programme (contract_id, number_of_layers) VALUES ($1, 21)`, [id], '23514');
    await client.query(`INSERT INTO public.bk_prop_details (contract_id, retention_pct, loss_cap_pct) VALUES ($1, 100, 1000)`, [id]);
    await client.query(`INSERT INTO public.bk_np_layer (contract_id, layer_number, reinstatement_pct) VALUES ($1, 1, 1000)`, [id]);
  }));

  it('foreign keys point at the Universe reference tables', () => withTx(async (client) => {
    await expectFail(client,
      `INSERT INTO public.bk_contract (umr, business_type, org_id, created_by_user_id, country_id) VALUES ('B0621FKTEST0001', 'PROPORTIONAL', '${ORG_A}', '${BROKER_USER_ID}', '00000000-0000-0000-0000-0000000000ff')`,
      [], '23503', 'bk_contract_country_id_fkey');
    const id = await newContract(client, 'B0621FKTEST0002');
    await expectFail(client, `INSERT INTO public.bk_contract_class_of_business (contract_id, class_of_business_id) VALUES ($1, '00000000-0000-0000-0000-0000000000ff')`, [id], '23503');
    await client.query(`INSERT INTO public.bk_contract_class_of_business (contract_id, class_of_business_id) VALUES ($1, $2)`, [id, refs.classes[0].id]);
  }));

  it('bumps updated_at through the trigger on bk_contract', () => withTx(async (client) => {
    // Insert already backdated (INSERT does not fire the BEFORE UPDATE trigger), then
    // update: the trigger stamps now() (transaction time), which is an hour later.
    const { rows } = await client.query(
      `INSERT INTO public.bk_contract (umr, business_type, org_id, created_by_user_id, updated_at)
       VALUES ('B0621TRGTEST001', 'PROPORTIONAL', '${ORG_A}', '${BROKER_USER_ID}', now() - interval '1 hour') RETURNING contract_id`);
    const id = rows[0].contract_id;
    const before = (await client.query(`SELECT updated_at FROM public.bk_contract WHERE contract_id=$1`, [id])).rows[0].updated_at;
    await client.query(`UPDATE public.bk_contract SET alt_contract_id='x' WHERE contract_id=$1`, [id]);
    const after = (await client.query(`SELECT updated_at FROM public.bk_contract WHERE contract_id=$1`, [id])).rows[0].updated_at;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  }));

  it('seeded sample contracts are present with their derived columns', async () => {
    const { rows } = await pool.query(`SELECT umr, business_type, status, contract_description FROM public.bk_contract WHERE contract_id IN ('00000000-0000-0000-0000-00000000c001','00000000-0000-0000-0000-00000000c002') ORDER BY umr`);
    expect(rows.map((r) => r.umr)).toEqual(['B0621DAR26CX002', 'B0621DAR26TR001']);
    const { rows: layers } = await pool.query(`SELECT layer_number, attachment::float8 AS attachment, earned_premium::float8 AS ep, rol::float8 AS rol FROM public.bk_np_layer WHERE contract_id='00000000-0000-0000-0000-00000000c002' ORDER BY layer_number`);
    expect(layers.map((l) => l.attachment)).toEqual([2_500_000, 7_500_000, 17_500_000]);
    expect(layers.map((l) => l.ep)).toEqual([1_440_000, 1_080_000, 720_000]);
    expect(layers[0].rol).toBeCloseTo(0.288, 8);
  });
});
