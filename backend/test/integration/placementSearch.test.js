// The register's search — country, cedant, treaty type, class, free text —
// and the renewal chain read from both ends.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

let broker;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
});

async function seedBook(api) {
  const cedant = async (name, domicile) => (await api('POST', '/api/cedants', { token: broker.token, body: { name, domicile } })).body;
  const place = async (c, cls, year = 2027) => {
    const r = await api('POST', '/api/placements', {
      token: broker.token,
      body: { cedant_id: c.id, class: cls, inception: `${year}-01-01`, expiry: `${year}-12-31`, currency: 'USD' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const kenya = await cedant('Atlas Mutual', 'Kenya');
  const uk = await cedant('Thames Assurance', 'UK');
  return {
    kenya, uk,
    atlasQs: await place(kenya, 'Property / Motor Quota Share'),
    atlasCat: await place(kenya, 'Property Cat XoL'),
    thamesMarine: await place(uk, 'Marine Risk XL'),
  };
}

test('a placement carries its treaty type and classes of business as columns, from the class string', async () => {
  await withServer(async (api) => {
    const { atlasQs, atlasCat } = await seedBook(api);
    assert.equal(atlasQs.treaty_type, 'Quota Share');
    assert.equal(atlasQs.class_of_business, 'Property / Motor');
    assert.equal(atlasCat.treaty_type, 'Risk XL', 'the wizard\'s older code resolves to the Universe name');
    assert.equal(atlasCat.class_of_business, 'Property Cat');
    const patched = await api('PATCH', `/api/placements/${atlasCat.id}`, { token: broker.token, body: { class: 'Property CAT XL' } });
    assert.equal(patched.body.treaty_type, 'CAT XL');
    assert.equal(patched.body.class_of_business, 'Property');
  });
});

test('the register searches by country, cedant, treaty type, class and free text', async () => {
  await withServer(async (api) => {
    const { kenya, uk, atlasQs, atlasCat, thamesMarine } = await seedBook(api);
    const list = async (qs) => {
      const r = await api('GET', `/api/placements?${qs}`, { token: broker.token });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body;
    };
    const ids = (rows) => rows.map((p) => p.id).sort();

    const all = await list('limit=50');
    assert.equal(all.length, 3);
    assert.equal(all.find((p) => p.id === atlasQs.id).cedant_name, 'Atlas Mutual', 'the list carries the cedant');

    assert.deepEqual(ids(await list('country=Kenya')), ids([atlasQs, atlasCat]));
    assert.deepEqual(ids(await list('country=United%20Kingdom')), [thamesMarine.id], 'a domicile stored as "UK" is found by the country name');
    assert.deepEqual(ids(await list('country=GB')), [thamesMarine.id], '…and by its code');
    assert.deepEqual(ids(await list(`cedant_id=${uk.id}`)), [thamesMarine.id]);
    assert.deepEqual(ids(await list('treaty_type=Quota%20Share')), [atlasQs.id]);
    assert.deepEqual(ids(await list('treaty_type=risk%20xl')), ids([atlasCat, thamesMarine]), 'case does not matter');
    assert.deepEqual(ids(await list('class=Motor')), [atlasQs.id], 'one of the classes named');
    assert.deepEqual(ids(await list('class=Property')), [atlasQs.id]);
    assert.deepEqual(ids(await list('q=marine')), [thamesMarine.id]);
    assert.deepEqual(ids(await list('q=atlas')), ids([atlasQs, atlasCat]), 'free text reaches the cedant name');
    assert.deepEqual(ids(await list(`country=Kenya&treaty_type=Risk%20XL&cedant_id=${kenya.id}`)), [atlasCat.id]);
    assert.deepEqual(await list('country=Narnia'), []);
  });
});

test('the facets narrow as the renewal wizard cascades: country, then cedant, then treaty type, then class', async () => {
  await withServer(async (api) => {
    const { kenya } = await seedBook(api);
    const facets = async (qs = '') => {
      const r = await api('GET', `/api/placements/facets${qs ? `?${qs}` : ''}`, { token: broker.token });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body;
    };
    const whole = await facets();
    assert.deepEqual(whole.countries.map((c) => c.name), ['Kenya', 'United Kingdom'], 'a domicile of "UK" reads as United Kingdom');
    assert.deepEqual(whole.countries.map((c) => c.count), [2, 1]);
    assert.deepEqual(whole.cedants.map((c) => c.name), ['Atlas Mutual', 'Thames Assurance']);
    assert.deepEqual(whole.treaty_types.map((t) => t.name), ['Quota Share', 'Risk XL']);
    assert.deepEqual(whole.classes.map((c) => c.name), ['Marine', 'Motor', 'Property', 'Property Cat']);

    const kenyan = await facets('country=Kenya');
    assert.deepEqual(kenyan.cedants.map((c) => c.name), ['Atlas Mutual']);
    assert.deepEqual(kenyan.treaty_types.map((t) => t.name), ['Quota Share', 'Risk XL']);
    assert.deepEqual(kenyan.countries.map((c) => c.name), ['Kenya', 'United Kingdom'], 'the country list is never narrowed by itself');

    const atlasQs = await facets(`cedant_id=${kenya.id}&treaty_type=Quota%20Share`);
    assert.deepEqual(atlasQs.classes.map((c) => c.name), ['Motor', 'Property']);
  });
});

test('renewing links the new year to the one it renews, and the link reads from both ends', async () => {
  await withServer(async (api) => {
    const { atlasCat } = await seedBook(api);
    const renewed = await api('POST', `/api/placements/${atlasCat.id}/renew`, { token: broker.token, body: { inception: '2028-01-01', expiry: '2028-12-31' } });
    assert.equal(renewed.status, 201);
    assert.equal(renewed.body.renewal_of, atlasCat.id);
    assert.equal(renewed.body.treaty_type, 'Risk XL', 'the class columns carry over');

    const next = await api('GET', `/api/placements/${renewed.body.id}`, { token: broker.token });
    assert.equal(next.body.renewal_of_placement.reference, atlasCat.reference, 'the renewal names the year it renews');
    const prior = await api('GET', `/api/placements/${atlasCat.id}`, { token: broker.token });
    assert.deepEqual(prior.body.renewed_by.map((p) => p.id), [renewed.body.id], 'the expiring year names the year that renews it');

    const listed = await api('GET', `/api/placements?renewal_of=${atlasCat.id}`, { token: broker.token });
    assert.deepEqual(listed.body.map((p) => p.id), [renewed.body.id]);
    assert.equal(listed.body[0].renewal_of_reference, atlasCat.reference);
    const priorRow = (await api('GET', '/api/placements?q=atlas', { token: broker.token })).body.find((p) => p.id === atlasCat.id);
    assert.equal(priorRow.renewed_by_count, 1);
  });
});

test('a renewal created by hand names its prior year too, and the link is checked', async () => {
  await withServer(async (api) => {
    const { kenya, atlasQs } = await seedBook(api);
    const created = await api('POST', '/api/placements', {
      token: broker.token,
      body: { cedant_id: kenya.id, class: 'Property / Motor Quota Share', inception: '2028-01-01', expiry: '2028-12-31', currency: 'USD', renewal_of: atlasQs.id },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.renewal_of, atlasQs.id);
    const bad = await api('POST', '/api/placements', {
      token: broker.token,
      body: { cedant_id: kenya.id, class: 'Property Quota Share', inception: '2028-01-01', expiry: '2028-12-31', currency: 'USD', renewal_of: '00000000-0000-0000-0000-000000000000' },
    });
    assert.equal(bad.status, 404);
    const self = await api('PATCH', `/api/placements/${created.body.id}`, { token: broker.token, body: { renewal_of: created.body.id } });
    assert.equal(self.status, 409);
    const linked = await api('PATCH', `/api/placements/${created.body.id}`, { token: broker.token, body: { renewal_of: null } });
    assert.equal(linked.body.renewal_of, null, 'the link can be cleared');
  });
});
