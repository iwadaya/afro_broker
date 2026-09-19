import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import {
  ensureReferenceData, countries, currencies, brokers, treatyTypes, classes, cedantsByCountry,
} from '../../src/db/ensureReferenceData.js';
// The frontend's copy of the Universe seed — pinned so it cannot drift from
// what the migration and the boot step assert.
import { COUNTRIES, CURRENCIES, BROKERS, TREATY_TYPES, CLASSES } from '../../../frontend/src/refData.js';

let broker;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
});

test('the lookups serve the Universe reference data in the tool\'s shapes', async () => {
  await withServer(async (api) => {
    const t = { token: broker.token };

    const b = await api('GET', '/api/brokers', t);
    assert.equal(b.status, 200);
    assert.deepEqual(b.body.map((r) => r.name), [...brokers].sort());
    assert.ok(b.body.every((r) => /^[0-9a-f-]{36}$/.test(r.id)), 'brokers carry their row id');
    assert.deepEqual(Object.keys(b.body[0]), ['id', 'name']);

    const tt = await api('GET', '/api/treaty-types', t);
    assert.equal(tt.status, 200);
    assert.deepEqual(Object.keys(tt.body[0]), ['id', 'name', 'category']);
    const byCat = (cat) => tt.body.filter((r) => r.category === cat).map((r) => r.name);
    assert.deepEqual(byCat('PROPORTIONAL'), treatyTypes.filter(([, c]) => c === 'PROPORTIONAL').map(([n]) => n).sort());
    assert.deepEqual(byCat('NON_PROPORTIONAL'), treatyTypes.filter(([, c]) => c === 'NON_PROPORTIONAL').map(([n]) => n).sort());
    assert.equal(tt.body.length, 11);

    const cob = await api('GET', '/api/class-of-business', t);
    assert.equal(cob.status, 200);
    assert.deepEqual(Object.keys(cob.body[0]), ['id', 'name', 'code']);
    assert.deepEqual(cob.body.map((r) => [r.name, r.code]), [...classes].sort((a, b) => a[0].localeCompare(b[0])));

    const cty = await api('GET', '/api/ref/lists/country/items', t);
    assert.equal(cty.status, 200);
    assert.deepEqual(Object.keys(cty.body[0]), ['id', 'name', 'code']);
    for (const [name, code] of countries) {
      assert.ok(cty.body.some((r) => r.name === name && r.code === code), `${name} is a country`);
    }
    assert.equal(cty.body.length, 75, 'the tool\'s 45 seeded countries plus the 30 its region mapping adds');
    assert.deepEqual(cty.body.map((r) => r.name), [...cty.body.map((r) => r.name)].sort(), 'countries come by name');

    const ccy = await api('GET', '/api/ref/lists/currency/items', t);
    assert.equal(ccy.status, 200);
    assert.deepEqual(ccy.body.map((r) => r.code), currencies.map(([c]) => c).sort());
    assert.ok(ccy.body.every((r) => r.name === r.code), 'a currency item reads as its code');

    assert.deepEqual((await api('GET', '/api/ref/lists/colour/items', t)).body, []);

    const gb = cty.body.find((r) => r.code === 'GB');
    const one = await api('GET', `/api/countries/${gb.id}`, t);
    assert.equal(one.status, 200);
    assert.equal(one.body.country_name, 'United Kingdom');
    assert.equal(one.body.region, 'Europe');
    assert.equal(one.body.is_active, true);
    const ke = cty.body.find((r) => r.code === 'KE');
    assert.equal((await api('GET', `/api/countries/${ke.id}`, t)).body.region, 'Sub-Saharan Africa');
    assert.equal((await api('GET', '/api/countries/00000000-0000-0000-0000-000000000000', t)).status, 404);

    assert.deepEqual((await api('DELETE', '/api/ref/cache', t)).body, { ok: true, cleared: true });
    assert.equal((await api('GET', '/api/brokers')).status, 401);
  });
});

test('the frontend seed is the same reference data', async () => {
  const { rows: cty } = await pool.query('SELECT country_name, country_code, region FROM public.country ORDER BY country_name');
  assert.deepEqual(
    cty.map((r) => [r.country_name, r.country_code, r.region]),
    [...COUNTRIES].sort((a, b) => a.name.localeCompare(b.name)).map((c) => [c.name, c.code, c.region]),
  );
  const { rows: ccy } = await pool.query('SELECT currency_code, currency_name FROM public.currency ORDER BY currency_code');
  assert.deepEqual(ccy.map((r) => [r.currency_code, r.currency_name]), [...CURRENCIES].sort((a, b) => a[0].localeCompare(b[0])));
  const { rows: brk } = await pool.query('SELECT broker_name FROM public.brokers ORDER BY broker_name');
  assert.deepEqual(brk.map((r) => r.broker_name), [...BROKERS].sort());
  const { rows: tt } = await pool.query('SELECT treaty_type, category FROM public.treaty_type ORDER BY treaty_type');
  assert.deepEqual(tt.map((r) => [r.treaty_type, r.category]), [...TREATY_TYPES].sort((a, b) => a[0].localeCompare(b[0])));
  const { rows: cob } = await pool.query('SELECT class_of_business, code FROM public.class_of_business ORDER BY class_of_business');
  assert.deepEqual(cob.map((r) => [r.class_of_business, r.code]), [...CLASSES].sort((a, b) => a[0].localeCompare(b[0])));
});

test('a generic ref list takes precedence over the direct table', async () => {
  await withServer(async (api) => {
    const { rows: [list] } = await pool.query(
      "INSERT INTO public.ref_list (list_key, list_name) VALUES ('currency', 'Currencies') RETURNING list_id",
    );
    await pool.query(
      `INSERT INTO public.ref_list_item (list_id, name, code, sort_order, is_active) VALUES
         ($1, 'SAR', 'SAR', 2, true), ($1, 'USD', 'USD', 1, true), ($1, 'XXX', 'XXX', 3, false)`,
      [list.list_id],
    );
    const res = await api('GET', '/api/ref/lists/currency/items', { token: broker.token });
    assert.deepEqual(res.body.map((r) => r.code), ['USD', 'SAR'], 'in sort order, inactive items hidden');
  });
});

test('inactive rows leave the dropdowns but stay in the table', async () => {
  await withServer(async (api) => {
    await pool.query("UPDATE public.brokers SET is_active = false WHERE broker_name = 'Marsh'");
    await pool.query("UPDATE public.treaty_type SET is_active = false WHERE treaty_type = 'Stop Loss'");
    await pool.query("UPDATE public.class_of_business SET is_active = false WHERE class_of_business = 'Medical'");
    await pool.query("UPDATE public.country SET is_active = false WHERE country_code = 'RU'");
    const t = { token: broker.token };
    assert.ok(!(await api('GET', '/api/brokers', t)).body.some((r) => r.name === 'Marsh'));
    assert.ok(!(await api('GET', '/api/treaty-types', t)).body.some((r) => r.name === 'Stop Loss'));
    assert.ok(!(await api('GET', '/api/class-of-business', t)).body.some((r) => r.name === 'Medical'));
    assert.ok(!(await api('GET', '/api/ref/lists/country/items', t)).body.some((r) => r.code === 'RU'));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.brokers')).rows[0].n, brokers.length);
  });
});

test('ensureReferenceData converges a database and deactivates non-canonical treaty types', async () => {
  await pool.query("DELETE FROM public.brokers WHERE broker_name = 'UIB'");
  await pool.query("DELETE FROM public.country WHERE country_code = 'KE'");
  await pool.query("INSERT INTO public.treaty_type (treaty_type, category) VALUES ('Working XL', 'NON_PROPORTIONAL')");
  await pool.query("UPDATE public.brokers SET is_active = false WHERE broker_name = 'Marsh'");

  const first = await ensureReferenceData();
  assert.equal(first.deactivated, 1);
  const { rows: brk } = await pool.query('SELECT broker_name, is_active FROM public.brokers ORDER BY broker_name');
  assert.equal(brk.length, brokers.length, 'the missing broker is back');
  assert.equal(brk.find((r) => r.broker_name === 'Marsh').is_active, false, 'a soft-deleted row is left alone');
  const { rows: [ke] } = await pool.query("SELECT country_name FROM public.country WHERE country_code = 'KE'");
  assert.equal(ke.country_name, 'Kenya');
  const { rows: [wxl] } = await pool.query("SELECT is_active FROM public.treaty_type WHERE treaty_type = 'Working XL'");
  assert.equal(wxl.is_active, false, 'deactivated, never deleted');

  // A second run is a no-op.
  const second = await ensureReferenceData();
  assert.equal(second.deactivated, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.country')).rows[0].n, 75);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.treaty_type')).rows[0].n, 12);
});

test('ensureReferenceData carries the Universe cedants under their countries', async () => {
  const first = await ensureReferenceData();
  const total = Object.values(cedantsByCountry).reduce((n, list) => n + list.length, 0);
  assert.ok(first.cedantsAdded > 0 && first.cedantsAdded <= total, 'the cedants are asserted on boot');

  // The Saudi cedants sit under Saudi Arabia, as the placement page's
  // country → cedant filter reads the domicile.
  // Ordered by code unit, as JavaScript sorts, whatever collation the database
  // was created with — under en_US "Malath" sorts before "MEDGULF", under C after.
  const { rows: sa } = await pool.query(
    "SELECT name, domicile, market_id FROM cedant WHERE domicile = 'Saudi Arabia' ORDER BY name COLLATE \"C\"",
  );
  assert.deepEqual(sa.map((r) => r.name), [...cedantsByCountry.SA].sort());
  assert.ok(sa.every((r) => r.market_id), 'each carries its register entry');
  const { rows: [tawuniya] } = await pool.query(
    "SELECT m.type, m.region FROM market m JOIN cedant c ON c.market_id = m.id WHERE c.name = 'Tawuniya'",
  );
  assert.equal(tawuniya.type, 'insurer');
  assert.equal(tawuniya.region, 'GCC', 'the register entry carries the country region');

  // The register serves them for the dropdown, and a second run adds nothing.
  await withServer(async (api) => {
    const r = await api('GET', '/api/cedants?limit=500', { token: broker.token });
    assert.equal(r.status, 200);
    assert.ok(r.body.some((c) => c.name === 'Tawuniya' && c.domicile === 'Saudi Arabia'));
  });
  const second = await ensureReferenceData();
  assert.equal(second.cedantsAdded, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cedant WHERE name = 'Tawuniya'")).rows[0].n, 1);
});
