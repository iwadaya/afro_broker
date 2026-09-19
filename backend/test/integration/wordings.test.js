import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { seedWordingLibrary } from '../../src/db/seedWordings.js';
import { seedMarketClauses, MARKET_CLAUSES } from '../../src/db/seedMarketClauses.js';

let broker;
let uw;

before(async () => {
  await resetDb();
});

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  uw = await makeUser('underwriter');
});

/** The seeded library, and the ids of two reinsurers to compare. */
async function seeded(api) {
  const counts = await seedWordingLibrary();
  const meta = await api('GET', '/api/wordings/meta', { token: broker.token });
  assert.equal(meta.status, 200);
  const market = (name) => meta.body.markets.find((m) => m.name === name).id;
  return { counts, meta: meta.body, swiss: market('Swiss Re'), munich: market('Munich Re') };
}

test('the seeded library is organised by class, category and reinsurer', async () => {
  await withServer(async (api) => {
    const { counts, meta } = await seeded(api);
    assert.ok(counts.standard > 50, 'standard corpus seeded');
    assert.ok(counts.market > 10, 'reinsurer house wordings seeded');

    // Every category is represented, including the three the brief names.
    for (const c of ['coverage', 'extension', 'exclusion']) {
      assert.ok(meta.categories.find((x) => x.category === c).count > 0, `${c} clauses present`);
    }
    // Classes, plus the general (cob null) clauses that apply to all of them.
    const cobs = meta.cobs.map((c) => c.cob);
    assert.ok(cobs.includes('Property'));
    assert.ok(cobs.includes('Marine'));
    assert.ok(cobs.includes(null), 'treaty-wide clauses are held against no class');
    assert.ok(meta.markets.find((m) => m.name === "Lloyd's").clause_count > 0);
  });
});

test('re-seeding never duplicates or overwrites an edited clause', async () => {
  await withServer(async (api) => {
    const first = await seedWordingLibrary();
    const clause = (await api('GET', '/api/wordings/clauses?q=Sanctions&source=standard', { token: broker.token })).body[0];
    await api('PATCH', `/api/wordings/clauses/${clause.id}`, {
      token: broker.token,
      body: { body: 'Our own house sanctions drafting, materially different from the seeded text.' },
    });

    const second = await seedWordingLibrary();
    assert.equal(second.standard, 0, 'second run inserts nothing');
    assert.equal(second.market, 0);

    const after = (await api('GET', `/api/wordings/clauses/${clause.id}`, { token: broker.token })).body;
    assert.match(after.body, /our own house sanctions drafting/i);
    assert.equal(after.version, 2, 'the edit was versioned');
    assert.equal(after.revisions.length, 1, 'the seeded text is kept as revision 1');
    assert.match(after.revisions[0].body, /sanction, prohibition or restriction/i);
    assert.ok(first.standard > 0);
  });
});

test('a class filter returns the class clauses plus the treaty-wide ones', async () => {
  await withServer(async (api) => {
    await seeded(api);
    const all = await api('GET', '/api/wordings/clauses?cob=Marine&limit=200', { token: broker.token });
    assert.equal(all.status, 200);
    const cobs = new Set(all.body.map((c) => c.cob));
    assert.equal(cobs.size, 2);
    assert.ok(cobs.has('Marine'));
    assert.ok(cobs.has(null), 'treaty-wide clauses come back with the class');

    const strict = await api('GET', '/api/wordings/clauses?cob=Marine&strict_cob=true&limit=200', { token: broker.token });
    assert.ok(strict.body.every((c) => c.cob === 'Marine'));
    assert.ok(strict.body.length < all.body.length);

    // Coverages, extensions and exclusions all present for the class.
    for (const category of ['coverage', 'extension', 'exclusion']) {
      assert.ok(strict.body.some((c) => c.category === category), `Marine ${category}`);
    }
  });
});

test('a draft is built from the standard wording with the base reinsurer written over it', async () => {
  await withServer(async (api) => {
    const { swiss } = await seeded(api);

    const created = await api('POST', '/api/wordings/drafts', {
      token: broker.token,
      body: { title: 'Acme Property XoL 2027', cob: 'Property', treaty_type: 'XoL', base_market_id: swiss },
    });
    assert.equal(created.status, 201);
    const draft = created.body;
    assert.ok(draft.clauses.length > 20, 'draft seeded from the library');

    // Positions are contiguous and the wording reads coverage → … → definition.
    assert.deepEqual(draft.clauses.map((c) => c.position), draft.clauses.map((_, i) => i + 1));
    const order = ['coverage', 'extension', 'exclusion', 'condition', 'definition'];
    const ranks = draft.clauses.map((c) => order.indexOf(c.category));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));

    // Swiss Re's house clauses replaced the standard ones of the same title,
    // and nothing is duplicated.
    const debris = draft.clauses.filter((c) => c.title === 'Debris Removal');
    assert.equal(debris.length, 1);
    assert.equal(debris[0].source_market_name, 'Swiss Re');
    const standardSanctions = draft.clauses.filter((c) => c.title === 'Sanctions Limitation and Exclusion');
    assert.equal(standardSanctions.length, 1);
    assert.equal(standardSanctions[0].source_market_name, 'Swiss Re');
    // Clauses Swiss Re has no version of still come from the standard library.
    assert.equal(draft.clauses.find((c) => c.title === 'Asbestos Exclusion').source_market_name, null);
  });
});

test('a draft can be seeded to selected categories only', async () => {
  await withServer(async (api) => {
    await seeded(api);
    const created = await api('POST', '/api/wordings/drafts', {
      token: broker.token,
      body: { title: 'Exclusions schedule', cob: 'Casualty', categories: ['exclusion'] },
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.clauses.length > 5);
    assert.ok(created.body.clauses.every((c) => c.category === 'exclusion'));
  });
});

test('editing a draft clause never touches the library, and can be reverted', async () => {
  await withServer(async (api) => {
    await seeded(api);
    const draft = (await api('POST', '/api/wordings/drafts', {
      token: broker.token,
      body: { title: 'Property draft', cob: 'Property' },
    })).body;
    const row = draft.clauses.find((c) => c.title === 'Debris Removal');
    const libraryBefore = (await api('GET', `/api/wordings/clauses/${row.clause_id}`, { token: broker.token })).body;

    const amended = await api('PATCH', `/api/wordings/drafts/${draft.id}/clauses/${row.id}`, {
      token: broker.token,
      body: { body: 'Debris removal is sub-limited to 25% of the sum insured on the damaged property.' },
    });
    assert.equal(amended.status, 200);

    const reloaded = (await api('GET', `/api/wordings/drafts/${draft.id}`, { token: broker.token })).body;
    const amendedRow = reloaded.clauses.find((c) => c.id === row.id);
    assert.equal(amendedRow.amended, true, 'the draft is flagged as amended off the library');

    const libraryAfter = (await api('GET', `/api/wordings/clauses/${row.clause_id}`, { token: broker.token })).body;
    assert.equal(libraryAfter.body, libraryBefore.body, 'the library clause is untouched');
    assert.equal(libraryAfter.version, libraryBefore.version);

    const reverted = await api('POST', `/api/wordings/drafts/${draft.id}/clauses/${row.id}/revert`, { token: broker.token });
    assert.equal(reverted.status, 200);
    assert.equal(reverted.body.body, libraryBefore.body);
    const afterRevert = (await api('GET', `/api/wordings/drafts/${draft.id}`, { token: broker.token })).body;
    assert.equal(afterRevert.clauses.find((c) => c.id === row.id).amended, false);
  });
});

test('a draft flags clauses whose library text has moved on since', async () => {
  await withServer(async (api) => {
    await seeded(api);
    const draft = (await api('POST', '/api/wordings/drafts', {
      token: broker.token, body: { title: 'Last year’s wording', cob: 'Property' },
    })).body;
    const row = draft.clauses.find((c) => c.title === 'Asbestos Exclusion');
    assert.equal(row.library_updated, false);

    await api('PATCH', `/api/wordings/clauses/${row.clause_id}`, {
      token: broker.token,
      body: { body: 'The market has tightened this exclusion for the 2027 renewal season.' },
    });

    const reloaded = (await api('GET', `/api/wordings/drafts/${draft.id}`, { token: broker.token })).body;
    const stale = reloaded.clauses.find((c) => c.id === row.id);
    assert.equal(stale.library_updated, true, 'the draft is flagged as behind the library');
    assert.equal(stale.amended, false, 'but the broker has not amended it');
  });
});

test('free-text clauses can be added, reordered and removed', async () => {
  await withServer(async (api) => {
    await seeded(api);
    const draft = (await api('POST', '/api/wordings/drafts', {
      token: broker.token, body: { title: 'Motor draft', cob: 'Motor', categories: ['coverage'] },
    })).body;

    const added = await api('POST', `/api/wordings/drafts/${draft.id}/clauses`, {
      token: broker.token,
      body: { title: 'Aggregate Deductible', category: 'condition', body: 'An annual aggregate deductible of USD 5,000,000 applies.' },
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.clause_id, null, 'not linked to a library clause');
    assert.equal(added.body.source_body, null);

    // A free-text clause has no library text to revert to.
    const revert = await api('POST', `/api/wordings/drafts/${draft.id}/clauses/${added.body.id}/revert`, { token: broker.token });
    assert.equal(revert.status, 422);

    const before = (await api('GET', `/api/wordings/drafts/${draft.id}`, { token: broker.token })).body.clauses;
    const reversed = [...before].reverse().map((c) => c.id);
    const reordered = await api('POST', `/api/wordings/drafts/${draft.id}/reorder`, {
      token: broker.token, body: { clause_ids: reversed },
    });
    assert.equal(reordered.status, 200);
    assert.deepEqual(reordered.body.map((c) => c.id), reversed);
    assert.deepEqual(reordered.body.map((c) => c.position), reversed.map((_, i) => i + 1));

    // A partial reorder is rejected rather than silently dropping clauses.
    const partial = await api('POST', `/api/wordings/drafts/${draft.id}/reorder`, {
      token: broker.token, body: { clause_ids: [reversed[0]] },
    });
    assert.equal(partial.status, 422);

    const removed = await api('DELETE', `/api/wordings/drafts/${draft.id}/clauses/${added.body.id}`, { token: broker.token });
    assert.equal(removed.status, 204);
    const after = (await api('GET', `/api/wordings/drafts/${draft.id}`, { token: broker.token })).body;
    assert.ok(!after.clauses.some((c) => c.id === added.body.id));
  });
});

test('comparing the standard wording with a reinsurer names the clauses they changed', async () => {
  await withServer(async (api) => {
    const { swiss } = await seeded(api);
    const res = await api(
      'GET',
      `/api/wordings/compare?left_type=standard&left_cob=Property&right_type=market&right_id=${swiss}&right_cob=Property`,
      { token: broker.token },
    );
    assert.equal(res.status, 200);
    const { summary, rows, left, right } = res.body;
    assert.equal(left.label, 'Standard library wording');
    assert.equal(right.label, 'Swiss Re');
    assert.ok(summary.changed > 0, 'Swiss Re deviates on some clauses');
    assert.ok(summary.identical > summary.changed, 'but follows the standard on most');
    assert.equal(summary.total, rows.length);

    const changed = rows.find((r) => r.title === 'Sanctions Limitation and Exclusion');
    assert.equal(changed.status, 'changed');
    assert.ok(changed.diff.some((d) => d.op === 'add'), 'the diff shows what they added');
    assert.ok(changed.diff.some((d) => d.op === 'same'), 'and what survived');
    assert.ok(changed.similarity > 0 && changed.similarity < 1);

    // Identical clauses carry no diff payload.
    const identical = rows.find((r) => r.status === 'identical');
    assert.equal(identical.diff, null);
    assert.equal(identical.similarity, 1);
  });
});

test('two reinsurers can be compared on their house clauses alone', async () => {
  await withServer(async (api) => {
    const { swiss, munich } = await seeded(api);
    const res = await api(
      'GET',
      `/api/wordings/compare?left_type=market&left_id=${swiss}&left_layered=false&right_type=market&right_id=${munich}&right_layered=false`,
      { token: broker.token },
    );
    assert.equal(res.status, 200);
    const { summary, rows } = res.body;
    // Each has house clauses the other does not, and both rewrite cyber.
    assert.ok(summary.only_left > 0 && summary.only_right > 0);
    const cyber = rows.find((r) => r.title === 'Cyber Loss Absolute Exclusion');
    assert.equal(cyber.status, 'changed');
    assert.equal(cyber.left.market_name, 'Swiss Re');
    assert.equal(cyber.right.market_name, 'Munich Re');
  });
});

test('a draft can be compared back against the market it was built from', async () => {
  await withServer(async (api) => {
    const { swiss } = await seeded(api);
    const draft = (await api('POST', '/api/wordings/drafts', {
      token: broker.token,
      body: { title: 'Acme Property 2027', cob: 'Property', base_market_id: swiss },
    })).body;

    const clean = await api(
      'GET',
      `/api/wordings/compare?left_type=draft&left_id=${draft.id}&right_type=market&right_id=${swiss}&right_cob=Property`,
      { token: broker.token },
    );
    assert.equal(clean.body.summary.changed, 0, 'a freshly seeded draft matches its base market');
    assert.equal(clean.body.summary.only_left, 0);

    const row = draft.clauses.find((c) => c.title === 'Asbestos Exclusion');
    await api('PATCH', `/api/wordings/drafts/${draft.id}/clauses/${row.id}`, {
      token: broker.token,
      body: { body: 'Asbestos liability is excluded, save for pre-1980 exposures declared to and accepted by the Reinsurer.' },
    });

    const dirty = await api(
      'GET',
      `/api/wordings/compare?left_type=draft&left_id=${draft.id}&right_type=market&right_id=${swiss}&right_cob=Property`,
      { token: broker.token },
    );
    assert.equal(dirty.body.summary.changed, 1);
    assert.equal(dirty.body.rows.find((r) => r.status === 'changed').title, 'Asbestos Exclusion');
  });
});

test('two individual clauses can be compared directly', async () => {
  await withServer(async (api) => {
    const { swiss } = await seeded(api);
    const standard = (await api('GET', '/api/wordings/clauses?q=Sanctions&source=standard', { token: broker.token })).body[0];
    const house = (await api('GET', `/api/wordings/clauses?q=Sanctions&source=market&market_id=${swiss}`, { token: broker.token })).body[0];

    const res = await api(
      'GET',
      `/api/wordings/compare?left_type=clause&left_id=${standard.id}&right_type=clause&right_id=${house.id}`,
      { token: broker.token },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.rows.length, 1);
    assert.equal(res.body.rows[0].status, 'changed');
    assert.equal(res.body.right.label, house.title);
    assert.equal(res.body.right.sub, 'Swiss Re');
  });
});

test('comparison rejects a side that names no target', async () => {
  await withServer(async (api) => {
    await seeded(api);
    const res = await api('GET', '/api/wordings/compare?left_type=draft&right_type=standard', { token: broker.token });
    assert.equal(res.status, 422);
    assert.ok(res.body.details.fieldErrors.left_id);
  });
});

test('the library is readable by everyone but writable only by brokers and admins', async () => {
  await withServer(async (api) => {
    await seeded(api);
    assert.equal((await api('GET', '/api/wordings/clauses?limit=1', { token: uw.token })).status, 200);
    assert.equal((await api('GET', '/api/wordings/meta', { token: uw.token })).status, 200);
    assert.equal((await api('GET', '/api/wordings/clauses?limit=1')).status, 401);

    const asUw = await api('POST', '/api/wordings/clauses', {
      token: uw.token,
      body: { title: 'Underwriter clause', category: 'exclusion', body: 'Not allowed.' },
    });
    assert.equal(asUw.status, 403);

    const asBroker = await api('POST', '/api/wordings/clauses', {
      token: broker.token,
      body: { title: 'House aggregate clause', category: 'condition', cob: 'Property', body: 'An aggregate applies.', source: 'house' },
    });
    assert.equal(asBroker.status, 201);

    // Only an admin may delete a clause outright.
    assert.equal((await api('DELETE', `/api/wordings/clauses/${asBroker.body.id}`, { token: broker.token })).status, 403);
    const admin = await makeUser('admin');
    assert.equal((await api('DELETE', `/api/wordings/clauses/${asBroker.body.id}`, { token: admin.token })).status, 204);
  });
});

test('a market clause must name its reinsurer', async () => {
  await withServer(async (api) => {
    const { swiss } = await seeded(api);
    const orphan = await api('POST', '/api/wordings/clauses', {
      token: broker.token,
      body: { title: 'Orphan market clause', category: 'exclusion', body: 'Text.', source: 'market' },
    });
    assert.equal(orphan.status, 422);

    const named = await api('POST', '/api/wordings/clauses', {
      token: broker.token,
      body: { title: 'Named market clause', category: 'exclusion', body: 'Text.', source: 'market', market_id: swiss },
    });
    assert.equal(named.status, 201);
    assert.equal(named.body.market_id, swiss);
  });
});

test('deleting a draft leaves the library intact', async () => {
  await withServer(async (api) => {
    await seeded(api);
    const before = (await api('GET', '/api/wordings/meta', { token: broker.token })).body.totals.clauses;
    const draft = (await api('POST', '/api/wordings/drafts', {
      token: broker.token, body: { title: 'Throwaway', cob: 'Energy' },
    })).body;
    assert.equal((await api('DELETE', `/api/wordings/drafts/${draft.id}`, { token: broker.token })).status, 204);
    assert.equal((await api('GET', `/api/wordings/drafts/${draft.id}`, { token: broker.token })).status, 404);
    const after = (await api('GET', '/api/wordings/meta', { token: broker.token })).body.totals;
    assert.equal(after.clauses, before);
    assert.equal(after.drafts, 0);
  });
});

/* ------------------------------------------------- market-standard clauses */

test('the authentic market forms are loaded over the illustrative placeholders', async () => {
  await withServer(async (api) => {
    await seedWordingLibrary();
    const result = await seedMarketClauses();
    assert.equal(result.total, MARKET_CLAUSES.length);
    assert.ok(result.upgraded > 10, 'placeholders were upgraded in place');
    assert.equal(result.skipped, 0);

    const clauses = (await api('GET', '/api/wordings/clauses?provenance=market_standard&limit=200', { token: broker.token })).body;
    assert.equal(clauses.length, MARKET_CLAUSES.length);

    // Every market form carries its reference, publisher and a source to follow.
    for (const c of clauses) {
      assert.equal(c.provenance, 'market_standard');
      assert.ok(c.clause_ref, `${c.title} has a market reference`);
      assert.ok(c.source_org, `${c.title} names its publisher`);
      assert.ok(c.source_url, `${c.title} has a source URL`);
      assert.ok(c.source_note, `${c.title} carries a usage note`);
    }

    // The well-known forms are present and are the real text, not a paraphrase.
    const byRef = Object.fromEntries(clauses.map((c) => [c.clause_ref, c]));
    assert.match(byRef['NMA 464'].body, /^Notwithstanding anything to the contrary contained herein/);
    assert.match(byRef['LMA 3100'].body, /No \(re\)insurer shall be deemed to provide cover/);
    assert.match(byRef['CL 380'].body, /as a means for inflicting harm/);
    assert.match(byRef['CL 370'].body, /This clause shall be paramount/);
    assert.match(byRef['BRMA 23A'].body, /shall be deemed to constitute payment to the Reinsurer/);
    assert.match(byRef['LMA 5394'].body, /whether deemed living or not/);
  });
});

test('upgrading in place keeps drafts pointed at the same clause', async () => {
  await withServer(async (api) => {
    await seedWordingLibrary();
    // A draft built before the market forms arrived.
    const draft = (await api('POST', '/api/wordings/drafts', {
      token: broker.token, body: { title: 'Pre-upgrade draft', cob: 'Property' },
    })).body;
    const row = draft.clauses.find((c) => c.title === 'War and Civil War Exclusion');
    assert.ok(row, 'the draft carries the war exclusion');
    assert.equal(row.library_updated, false);

    await seedMarketClauses();

    const after = (await api('GET', `/api/wordings/drafts/${draft.id}`, { token: broker.token })).body;
    const sameRow = after.clauses.find((c) => c.id === row.id);
    assert.ok(sameRow, 'the draft clause survives the upgrade');
    assert.equal(sameRow.clause_id, row.clause_id, 'still linked to the same library clause');
    assert.equal(sameRow.amended, false, 'the broker has not amended it');
    assert.equal(sameRow.library_updated, true, 'but the draft is flagged as behind the new library text');
  });
});

test('a clause a firm has edited is never overwritten by the market form', async () => {
  await withServer(async (api) => {
    await seedWordingLibrary();
    const clause = (await api('GET', '/api/wordings/clauses?q=Sanctions&source=standard', { token: broker.token })).body[0];
    await api('PATCH', `/api/wordings/clauses/${clause.id}`, {
      token: broker.token,
      body: { body: 'Our own approved sanctions drafting, agreed with compliance.' },
    });

    const result = await seedMarketClauses();
    assert.equal(result.skipped, 1, 'the edited clause is left alone');

    const after = (await api('GET', `/api/wordings/clauses/${clause.id}`, { token: broker.token })).body;
    assert.match(after.body, /agreed with compliance/);
    assert.equal(after.provenance, 'illustrative', 'and is not mislabelled as a market form');
  });
});

test('provenance is filterable and reaches the comparison rows', async () => {
  await withServer(async (api) => {
    await seedWordingLibrary();
    await seedMarketClauses();

    const meta = (await api('GET', '/api/wordings/meta', { token: broker.token })).body;
    assert.equal(meta.totals.market_standard, MARKET_CLAUSES.length);

    const illustrative = (await api('GET', '/api/wordings/clauses?provenance=illustrative&limit=300', { token: broker.token })).body;
    assert.ok(illustrative.every((c) => c.provenance === 'illustrative'));
    assert.ok(illustrative.length > 50, 'the class-specific corpus stays illustrative');

    const swiss = meta.markets.find((m) => m.name === 'Swiss Re').id;
    const cmp = (await api(
      'GET',
      `/api/wordings/compare?left_type=standard&left_cob=Marine&right_type=market&right_id=${swiss}&right_cob=Marine`,
      { token: broker.token },
    )).body;
    const cl380 = cmp.rows.find((r) => r.clause_ref === 'CL 380');
    assert.ok(cl380, 'the Institute cyber clause appears in the comparison');
    assert.equal(cl380.left.provenance, 'market_standard');
    assert.equal(cl380.left.source_org, 'Institute of London Underwriters / IUA');
  });
});

test('a curator can record provenance on their own clause', async () => {
  await withServer(async (api) => {
    const created = await api('POST', '/api/wordings/clauses', {
      token: broker.token,
      body: {
        title: 'House Aggregate Clause',
        category: 'condition',
        body: 'An annual aggregate deductible applies.',
        provenance: 'market_standard',
        source_org: 'Our compliance team',
        source_url: 'https://example.com/wordings/aggregate',
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.provenance, 'market_standard');
    assert.equal(created.body.source_url, 'https://example.com/wordings/aggregate');

    // A bad URL is rejected rather than stored.
    const bad = await api('POST', '/api/wordings/clauses', {
      token: broker.token,
      body: { title: 'Bad source', category: 'condition', body: 'x', source_url: 'not-a-url' },
    });
    assert.equal(bad.status, 422);
  });
});
