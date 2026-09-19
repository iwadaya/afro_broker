import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

let broker;

before(async () => {
  await resetDb();
});

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
});

/* A slip that echoes one standard clause, rewords another, adds a clause of
   its own, and drops one entirely. */
const STANDARD_UNL =
  'The Reinsurers shall be liable for the amount by which the Ultimate Net Loss exceeds the retention.';

function slipText({ unl = STANDARD_UNL, extra = true } = {}) {
  return [
    'ARTICLE 1 — ULTIMATE NET LOSS',
    unl,
    '',
    'LMA5400 Cyber Exclusion',
    'This Contract excludes any cyber loss whatsoever.',
    '',
    ...(extra ? ['ARTICLE 9 — SANCTIONS BESPOKE', 'No cover is provided where a sanction would expose the Reinsurer.'] : []),
  ].join('\n');
}

/** Two standard clauses for the class: one the slips echo, one they drop. */
async function seedStandard(api) {
  for (const c of [
    { title: 'Ultimate Net Loss', category: 'definition', body: STANDARD_UNL },
    {
      title: 'Hours Clause',
      category: 'condition',
      body: 'Losses arising during any period of 72 consecutive hours shall be one loss.',
    },
  ]) {
    const res = await api('POST', '/api/wordings/clauses', {
      token: broker.token,
      body: { ...c, cob: 'SlipTest', source: 'standard' },
    });
    assert.equal(res.status, 201);
  }
}

const find = (rows, re) => rows.find((r) => new RegExp(re, 'i').test(r.title));

test('a slip is read into clauses before anything is compared', async () => {
  await withServer(async (api) => {
    const res = await api('POST', '/api/wordings/slips/parse', {
      token: broker.token,
      body: { name: 'Swiss Re slip', text: slipText() },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Swiss Re slip');
    assert.equal(res.body.clause_count, 3);
    assert.equal(find(res.body.clauses, 'cyber').clause_ref, 'LMA5400');
  });
});

test('one slip is measured against the market standard', async () => {
  await withServer(async (api) => {
    await seedStandard(api);
    const res = await api('POST', '/api/wordings/slips/compare', {
      token: broker.token,
      body: { cob: 'SlipTest', slips: [{ name: 'Swiss Re slip', text: slipText() }] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.mode, 'against_standard');
    const { rows, summary } = res.body;

    // Echoed verbatim, dropped, and invented.
    assert.equal(find(rows, 'ultimate net loss').flag, 'standard');
    assert.equal(find(rows, 'hours clause').flag, 'missing');
    assert.equal(find(rows, 'sanctions bespoke').flag, 'additional');
    assert.equal(summary.missing, 1);
    assert.equal(summary.standard, 1);
  });
});

test('a reworded clause reads as non-standard, and the diff names what moved', async () => {
  await withServer(async (api) => {
    await seedStandard(api);
    const res = await api('POST', '/api/wordings/slips/compare', {
      token: broker.token,
      body: {
        cob: 'SlipTest',
        slips: [{
          name: 'Reworded slip',
          text: slipText({ unl: `${STANDARD_UNL.slice(0, -1)}, subject to the annual aggregate deductible.` }),
        }],
      },
    });
    assert.equal(res.status, 200);
    const unl = find(res.body.rows, 'ultimate net loss');
    assert.equal(unl.flag, 'non_standard');
    assert.ok(
      unl.diff?.some((op) => op.op === 'add' && /aggregate deductible/i.test(op.text)),
      'the diff names the added words',
    );
  });
});

test('two slips are compared with each other and against the standard', async () => {
  await withServer(async (api) => {
    await seedStandard(api);
    const res = await api('POST', '/api/wordings/slips/compare', {
      token: broker.token,
      body: {
        cob: 'SlipTest',
        slips: [
          { name: 'Market A', text: slipText() },
          { name: 'Market B', text: slipText({ unl: `${STANDARD_UNL} Reinstatements are free.`, extra: false }) },
        ],
      },
    });
    assert.equal(res.status, 200);
    const { mode, rows, slips, summary } = res.body;
    assert.equal(mode, 'slip_vs_slip');
    assert.deepEqual(slips.map((s) => s.name), ['Market A', 'Market B']);

    // B moved the text: the row is non-standard, and the two slips disagree.
    const unl = find(rows, 'ultimate net loss');
    assert.equal(unl.flag, 'non_standard');
    assert.equal(unl.slip_match, 'differs');
    assert.ok(unl.slips[0].present && unl.slips[1].present);
    assert.ok(unl.diff?.length, 'the two slips are diffed against each other');

    // A's bespoke clause is in neither the standard set nor B.
    const bespoke = find(rows, 'sanctions bespoke');
    assert.equal(bespoke.flag, 'additional');
    assert.equal(bespoke.slip_match, 'one_only');
    assert.equal(bespoke.slips[1].present, false);

    // Both slips carry the cyber exclusion identically, and neither the hours clause.
    assert.equal(find(rows, 'cyber').slip_match, 'same');
    assert.equal(find(rows, 'hours clause').flag, 'missing');
    assert.ok(summary.slips_differ >= 1);
  });
});

test('an unreadable slip is refused with a reason', async () => {
  await withServer(async (api) => {
    const res = await api('POST', '/api/wordings/slips/compare', {
      token: broker.token,
      body: { slips: [{ name: 'Empty', text: '   ' }] },
    });
    assert.equal(res.status, 422);
    assert.match(JSON.stringify(res.body), /file or the slip text|empty/i);
  });
});
