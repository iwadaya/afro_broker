import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { withTransaction } from '../../src/db/pool.js';
import { createApproval, approve } from '../../src/lib/approvals.js';

/**
 * M3 (distribution) and M9 (lines and placement completion) on StructureVersion.
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

/** Complete enough to be firm order terms for a Cat XL layer. */
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
  const m = await api('POST', '/api/markets', {
    token: broker.token, body: { name, type: 'reinsurer', rating: 'A', rating_agency: 'AM Best' },
  });
  await pool.query(
    `INSERT INTO market_contact (market_id, name, email, role, is_primary)
     VALUES ($1,$2,$3,'Underwriter',true)`,
    [m.body.id, `UW ${name}`, `uw@${name.toLowerCase().replace(/\s+/g, '')}.example`],
  );
  return m.body.id;
}

/** A contract year with one structure whose FOT version is ready for lines. */
async function setup(api, { orderPct = 100, yearLabel = '2026', priorYearId = null } = {}) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: `Panel Mutual ${yearLabel}` } });
  const contract = await api('POST', '/api/contracts', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, name: `Property ${yearLabel}`, cob: 'Property' },
  });
  const year = await api('POST', `/api/contracts/${contract.body.id}/years`, {
    token: broker.token,
    body: {
      year_label: yearLabel,
      inception: `${yearLabel}-01-01`,
      expiry: `${yearLabel}-12-31`,
      currency: 'USD',
      ...(priorYearId ? { prior_contract_year_id: priorYearId } : {}),
    },
  });
  assert.equal(year.status, 201, JSON.stringify(year.body));

  const structure = await api('POST', `/api/contract-years/${year.body.id}/structures`, {
    token: broker.token,
    body: { label: 'Cat XL Layer 1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property', terms: fotTerms() },
  });
  assert.equal(structure.status, 201, JSON.stringify(structure.body));
  await pool.query('UPDATE structure SET order_pct = $1 WHERE id = $2', [orderPct, structure.body.id]);

  const submitted = (await api('GET', `/api/structures/${structure.body.id}`, { token: uw.token }))
    .body.versions[0];
  const fot = await api('POST', `/api/structure-versions/${submitted.id}/promote-fot`, { token: broker.token });
  assert.equal(fot.status, 201, JSON.stringify(fot.body));

  return {
    contractId: contract.body.id,
    yearId: year.body.id,
    structureId: structure.body.id,
    submittedId: submitted.id,
    fotId: fot.body.id,
  };
}

const approveFor = async (actionType, entityType, entityId) => {
  await withTransaction((client) => createApproval(client, {
    actionType, entityType, entityId, proposedBy: broker.user.id,
  }));
  await withTransaction((client) => approve(client, {
    actionType, entityType, entityId, approver: uw.user,
  }));
};

// ---------------------------------------------------------------------------
// M3 — distribution
// ---------------------------------------------------------------------------
test('a send is tied to the contract year and the exact versions that went out', async () => {
  await withServer(async (api) => {
    const { yearId, submittedId } = await setup(api);
    const re = await reinsurer(api, 'Quoting Re');

    const dist = await api('POST', `/api/contract-years/${yearId}/distributions`, {
      token: broker.token,
      body: {
        stage: 'QUOTING', subject: 'Property XL 2026', body: 'Terms attached.',
        structure_version_ids: [submittedId],
        recipients: [{ reinsurer_id: re, email: 'uw@quotingre.example', name: 'UW' }],
      },
    });
    assert.equal(dist.status, 201, JSON.stringify(dist.body));

    const detail = await api('GET', `/api/distributions/${dist.body.id}`, { token: uw.token });
    assert.equal(detail.body.versions.length, 1);
    assert.equal(detail.body.versions[0].id, submittedId);
    assert.equal(detail.body.recipients[0].status, 'PENDING');
  });
});

test('a follow-market approach carries firm order terms, not a quote', async () => {
  await withServer(async (api) => {
    const { yearId, submittedId, fotId } = await setup(api);
    const re = await reinsurer(api, 'Follow Re');
    const recipients = [{ reinsurer_id: re, email: 'uw@followre.example' }];

    const wrong = await api('POST', `/api/contract-years/${yearId}/distributions`, {
      token: broker.token,
      body: {
        stage: 'FOLLOW', subject: 'Follow', body: '...',
        structure_version_ids: [submittedId], recipients,
      },
    });
    assert.equal(wrong.status, 409);
    assert.match(wrong.body.error, /promote the versions to FOT/i);

    const right = await api('POST', `/api/contract-years/${yearId}/distributions`, {
      token: broker.token,
      body: {
        stage: 'FOLLOW', subject: 'Follow', body: '...',
        structure_version_ids: [fotId], recipients,
      },
    });
    assert.equal(right.status, 201);
  });
});

test('nothing goes to a market on one persons authority (D7)', async () => {
  await withServer(async (api) => {
    const { yearId, submittedId } = await setup(api);
    const re = await reinsurer(api, 'Gated Re');
    const dist = await api('POST', `/api/contract-years/${yearId}/distributions`, {
      token: broker.token,
      body: {
        stage: 'QUOTING', subject: 'S', body: 'B',
        structure_version_ids: [submittedId],
        recipients: [{ reinsurer_id: re, email: 'uw@gatedre.example' }],
      },
    });

    const ungated = await api('POST', `/api/distributions/${dist.body.id}/send`, { token: broker.token });
    assert.equal(ungated.status, 403);
    assert.match(ungated.body.error, /requires approval by a second user/i);

    await approveFor('submission_send', 'distribution', dist.body.id);
    const sent = await api('POST', `/api/distributions/${dist.body.id}/send`, { token: broker.token });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.status, 'SENT');
    assert.ok(sent.body.approval_id);

    const detail = await api('GET', `/api/distributions/${dist.body.id}`, { token: uw.token });
    assert.equal(detail.body.recipients[0].status, 'SENT');
    assert.ok(detail.body.recipients[0].sent_at);

    await assert.rejects(
      pool.query('UPDATE distribution SET approval_id = NULL WHERE id = $1', [dist.body.id]),
      /distribution_sent_has_approval/,
    );
  });
});

test('the two stages consume different approvals', async () => {
  await withServer(async (api) => {
    const { yearId, fotId } = await setup(api);
    const re = await reinsurer(api, 'Stage Re');
    const dist = await api('POST', `/api/contract-years/${yearId}/distributions`, {
      token: broker.token,
      body: {
        stage: 'FOLLOW', subject: 'S', body: 'B',
        structure_version_ids: [fotId],
        recipients: [{ reinsurer_id: re, email: 'uw@stagere.example' }],
      },
    });

    // An approval for the quoting stage does not authorise the follow release.
    await approveFor('submission_send', 'distribution', dist.body.id);
    const wrongGate = await api('POST', `/api/distributions/${dist.body.id}/send`, { token: broker.token });
    assert.equal(wrongGate.status, 403);

    await approveFor('fot_send', 'distribution', dist.body.id);
    assert.equal((await api('POST', `/api/distributions/${dist.body.id}/send`, { token: broker.token })).status, 200);
  });
});

test('delivery, opening and a response are each recorded with when', async () => {
  await withServer(async (api) => {
    const { yearId, submittedId } = await setup(api);
    const re = await reinsurer(api, 'Tracked Re');
    const dist = await api('POST', `/api/contract-years/${yearId}/distributions`, {
      token: broker.token,
      body: {
        stage: 'QUOTING', subject: 'S', body: 'B',
        structure_version_ids: [submittedId],
        recipients: [{ reinsurer_id: re, email: 'uw@trackedre.example' }],
      },
    });
    const recipientId = (await api('GET', `/api/distributions/${dist.body.id}`, { token: uw.token }))
      .body.recipients[0].id;

    const early = await api('POST', `/api/distribution-recipients/${recipientId}/event`, {
      token: broker.token, body: { event: 'DELIVERED' },
    });
    assert.equal(early.status, 409, 'a message that has not been sent cannot have been delivered');

    await approveFor('submission_send', 'distribution', dist.body.id);
    await api('POST', `/api/distributions/${dist.body.id}/send`, { token: broker.token });

    for (const event of ['DELIVERED', 'OPENED', 'RESPONDED']) {
      const res = await api('POST', `/api/distribution-recipients/${recipientId}/event`, {
        token: broker.token, body: { event, message_id: 'msg-1' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, event);
    }

    const { rows } = await pool.query('SELECT * FROM distribution_recipient WHERE id = $1', [recipientId]);
    assert.ok(rows[0].sent_at && rows[0].delivered_at && rows[0].opened_at && rows[0].responded_at,
      'each stage keeps its own timestamp — "when did it go quiet" is the question asked');
  });
});

test('a distribution cannot carry versions from another year', async () => {
  await withServer(async (api) => {
    const a = await setup(api, { yearLabel: '2026' });
    const b = await setup(api, { yearLabel: '2025' });
    const re = await reinsurer(api, 'Crossed Re');
    const res = await api('POST', `/api/contract-years/${a.yearId}/distributions`, {
      token: broker.token,
      body: {
        stage: 'QUOTING', subject: 'S', body: 'B',
        structure_version_ids: [a.submittedId, b.submittedId],
        recipients: [{ reinsurer_id: re, email: 'uw@crossedre.example' }],
      },
    });
    assert.equal(res.status, 409);
  });
});

test('candidate recipients come from the register and exclude declined security', async () => {
  await withServer(async (api) => {
    const { yearId } = await setup(api);
    const good = await reinsurer(api, 'Approved Re');
    const bad = await reinsurer(api, 'Declined Re');
    await pool.query("UPDATE market SET security_status = 'declined' WHERE id = $1", [bad]);

    const res = await api('GET', `/api/contract-years/${yearId}/distribution-candidates`, { token: broker.token });
    assert.equal(res.status, 200);
    const ids = res.body.candidates.map((c) => c.reinsurer_id);
    assert.ok(ids.includes(good));
    assert.ok(!ids.includes(bad), 'a recipient list is a thing people send from');
  });
});

// ---------------------------------------------------------------------------
// M9 — lines, signing down, completion
// ---------------------------------------------------------------------------
test('lines are written against firm order terms, not against a quote', async () => {
  await withServer(async (api) => {
    const { submittedId, fotId } = await setup(api);
    const re = await reinsurer(api, 'Writing Re');

    const early = await api('PUT', `/api/structure-versions/${submittedId}/lines`, {
      token: broker.token, body: { reinsurer_id: re, written_pct: 10 },
    });
    assert.equal(early.status, 409);
    assert.match(early.body.error, /firm order terms/i);

    const ok = await api('PUT', `/api/structure-versions/${fotId}/lines`, {
      token: broker.token, body: { reinsurer_id: re, written_pct: 10 },
    });
    assert.equal(ok.status, 200);
    assert.equal(Number(ok.body.written_pct), 10);
    assert.equal(ok.body.signed_pct, null, 'nothing is signed until signing runs');
  });
});

test('an oversubscribed order signs down to exactly the order (§1.4)', async () => {
  await withServer(async (api) => {
    const { fotId } = await setup(api);
    for (const [i, pct] of [40, 40, 40].entries()) {
      const re = await reinsurer(api, `Over Re ${i}`);
      await api('PUT', `/api/structure-versions/${fotId}/lines`, {
        token: broker.token, body: { reinsurer_id: re, written_pct: pct },
      });
    }

    const preview = await api('GET', `/api/structure-versions/${fotId}/signing/preview`, { token: uw.token });
    assert.equal(preview.body.state, 'OVERSUBSCRIBED');
    assert.equal(preview.body.writtenTotal, 120);
    assert.equal(preview.body.signedTotal, 100);

    const applied = await api('POST', `/api/structure-versions/${fotId}/signing/apply`, {
      token: broker.token, body: {},
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.signedTotal, 100, 'signed equals the order exactly');

    const { rows } = await pool.query(
      "SELECT COALESCE(SUM(signed_pct),0) AS total FROM structure_line WHERE structure_version_id = $1 AND status = 'SIGNED'",
      [fotId],
    );
    assert.equal(Number(rows[0].total), 100);
  });
});

test('a guaranteed line does not sign down; the factor applies to the rest', async () => {
  await withServer(async (api) => {
    const { fotId } = await setup(api);
    const guaranteed = await reinsurer(api, 'Guaranteed Re');
    const flexA = await reinsurer(api, 'Flex A Re');
    const flexB = await reinsurer(api, 'Flex B Re');

    await api('PUT', `/api/structure-versions/${fotId}/lines`, {
      token: broker.token, body: { reinsurer_id: guaranteed, written_pct: 30, to_stand: true },
    });
    for (const re of [flexA, flexB]) {
      await api('PUT', `/api/structure-versions/${fotId}/lines`, {
        token: broker.token, body: { reinsurer_id: re, written_pct: 50 },
      });
    }

    const applied = await api('POST', `/api/structure-versions/${fotId}/signing/apply`, {
      token: broker.token, body: {},
    });
    const byId = Object.fromEntries(applied.body.lines.map((l) => [l.id, l]));
    const lines = await api('GET', `/api/structure-versions/${fotId}/lines`, { token: uw.token });
    const guaranteedLine = lines.body.find((l) => l.reinsurer_id === guaranteed);

    assert.equal(Number(guaranteedLine.signed_pct), 30, 'held at its written line');
    assert.equal(Number(guaranteedLine.signing_factor), 1);
    assert.equal(applied.body.signedTotal, 100);
    assert.ok(Object.keys(byId).length === 3);
  });
});

test('an undersubscribed order will not sign silently', async () => {
  await withServer(async (api) => {
    const { fotId } = await setup(api);
    const re = await reinsurer(api, 'Thin Re');
    await api('PUT', `/api/structure-versions/${fotId}/lines`, {
      token: broker.token, body: { reinsurer_id: re, written_pct: 60 },
    });

    const refused = await api('POST', `/api/structure-versions/${fotId}/signing/apply`, {
      token: broker.token, body: {},
    });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /shortfall 40%/);

    const firmed = await api('POST', `/api/structure-versions/${fotId}/signing/apply`, {
      token: broker.token, body: { accept_shortfall: true },
    });
    assert.equal(firmed.status, 200);
    assert.equal(firmed.body.signedTotal, 60);
  });
});

test('premium is allocated by signed share in minor units', async () => {
  await withServer(async (api) => {
    const { fotId } = await setup(api);
    // MDP is USD 1,000,000 at 100%.
    for (const [i, pct] of [40, 40, 40].entries()) {
      const re = await reinsurer(api, `Priced Re ${i}`);
      await api('PUT', `/api/structure-versions/${fotId}/lines`, {
        token: broker.token, body: { reinsurer_id: re, written_pct: pct },
      });
    }
    const applied = await api('POST', `/api/structure-versions/${fotId}/signing/apply`, {
      token: broker.token, body: {},
    });
    assert.equal(applied.body.premium.currency, 'USD');
    assert.equal(applied.body.premium.at_hundred, '1000000.00');

    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(premium_signed_minor),0)::bigint AS total FROM structure_line
       WHERE structure_version_id = $1`,
      [fotId],
    );
    assert.equal(Number(rows[0].total), 100000000, 'the allocation sums to the premium, to the cent');
  });
});

test('re-writing a line clears the signed values that just became stale', async () => {
  await withServer(async (api) => {
    const { fotId } = await setup(api);
    const re = await reinsurer(api, 'Revised Re');
    await api('PUT', `/api/structure-versions/${fotId}/lines`, {
      token: broker.token, body: { reinsurer_id: re, written_pct: 100 },
    });
    await api('POST', `/api/structure-versions/${fotId}/signing/apply`, { token: broker.token, body: {} });

    await api('PUT', `/api/structure-versions/${fotId}/lines`, {
      token: broker.token, body: { reinsurer_id: re, written_pct: 80 },
    });
    const lines = await api('GET', `/api/structure-versions/${fotId}/lines`, { token: uw.token });
    assert.equal(lines.body[0].signed_pct, null,
      'a signed figure against a superseded written total is exactly what §1.4 forbids');
    assert.equal(lines.body[0].premium_signed_minor, null);
  });
});

test('completion reports signed against order per structure', async () => {
  await withServer(async (api) => {
    const { yearId, fotId } = await setup(api, { orderPct: 50 });
    const re = await reinsurer(api, 'Half Re');
    await api('PUT', `/api/structure-versions/${fotId}/lines`, {
      token: broker.token, body: { reinsurer_id: re, written_pct: 25 },
    });

    const completion = await api('GET', `/api/contract-years/${yearId}/completion`, { token: uw.token });
    assert.equal(completion.status, 200);
    assert.equal(completion.body[0].order_pct, 50);
    assert.equal(completion.body[0].written_total, 25);
    assert.equal(completion.body[0].pct_of_order_written, 50);
    assert.equal(completion.body[0].shortfall, 25);
  });
});

// ---------------------------------------------------------------------------
// M9 — the bordereau
// ---------------------------------------------------------------------------
test('the expiring-panel flag is derived from the renewal chain, not typed in', async () => {
  await withServer(async (api) => {
    const last = await setup(api, { yearLabel: '2025' });
    const incumbent = await reinsurer(api, 'Incumbent Re');
    await api('PUT', `/api/structure-versions/${last.fotId}/lines`, {
      token: broker.token, body: { reinsurer_id: incumbent, written_pct: 100 },
    });

    // This year renews from last, and adds a market that was not on the panel.
    const renewal = await api('POST', `/api/contract-years/${last.yearId}/renew`, {
      token: broker.token, body: { year_label: '2026' },
    });
    const structure = await api('POST', `/api/contract-years/${renewal.body.id}/structures`, {
      token: broker.token,
      body: { label: 'Cat XL Layer 1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property', terms: fotTerms() },
    });
    const submitted = (await api('GET', `/api/structures/${structure.body.id}`, { token: uw.token })).body.versions[0];
    const fot = await api('POST', `/api/structure-versions/${submitted.id}/promote-fot`, { token: broker.token });

    const newcomer = await reinsurer(api, 'Newcomer Re');
    for (const [re, pct] of [[incumbent, 60], [newcomer, 40]]) {
      await api('PUT', `/api/structure-versions/${fot.body.id}/lines`, {
        token: broker.token, body: { reinsurer_id: re, written_pct: pct },
      });
    }

    const bx = await api('GET', `/api/contract-years/${renewal.body.id}/bordereau`, { token: uw.token });
    assert.equal(bx.status, 200);
    assert.equal(bx.body.expiring_panel_known, true);
    const byName = Object.fromEntries(bx.body.lines.map((l) => [l.reinsurer_name, l]));
    assert.equal(byName['Incumbent Re'].on_expiring_panel, true);
    assert.equal(byName['Newcomer Re'].on_expiring_panel, false);
    assert.equal(byName['Incumbent Re'].rating, 'A');
  });
});

test('with no prior year the expiring panel is unknown, not empty', async () => {
  await withServer(async (api) => {
    const { yearId, fotId } = await setup(api);
    const re = await reinsurer(api, 'Fresh Re');
    await api('PUT', `/api/structure-versions/${fotId}/lines`, {
      token: broker.token, body: { reinsurer_id: re, written_pct: 100 },
    });
    const bx = await api('GET', `/api/contract-years/${yearId}/bordereau`, { token: uw.token });
    assert.equal(bx.body.expiring_panel_known, false,
      '"not on the expiring panel" and "there was no expiring panel" are different statements');
  });
});

test('the bordereau exports to Excel and PDF', async () => {
  await withServer(async (api) => {
    const { yearId, fotId } = await setup(api);
    const re = await reinsurer(api, 'Export Re');
    await api('PUT', `/api/structure-versions/${fotId}/lines`, {
      token: broker.token, body: { reinsurer_id: re, written_pct: 100 },
    });
    await api('POST', `/api/structure-versions/${fotId}/signing/apply`, { token: broker.token, body: {} });

    for (const [format, magic] of [['xlsx', 'PK'], ['pdf', '%PDF']]) {
      const resp = await api('GET', `/api/contract-years/${yearId}/bordereau/export?format=${format}`,
        { token: uw.token, raw: true });
      assert.equal(resp.status, 200, format);
      const buf = Buffer.from(await resp.arrayBuffer());
      assert.ok(buf.length > 0);
      assert.equal(buf.subarray(0, magic.length).toString(), magic, `${format} is a real ${format}`);
      assert.match(resp.headers.get('content-disposition'), /attachment; filename="written-lines-/);
    }

    const bad = await api('GET', `/api/contract-years/${yearId}/bordereau/export?format=doc`, { token: uw.token });
    assert.equal(bad.status, 422);
  });
});

// ---------------------------------------------------------------------------
// M9 — incremental advices to the cedant
// ---------------------------------------------------------------------------
test('written lines go to the cedant incrementally, each advice fixed at its date', async () => {
  await withServer(async (api) => {
    const { yearId, fotId } = await setup(api);
    const first = await reinsurer(api, 'First Re');
    await api('PUT', `/api/structure-versions/${fotId}/lines`, {
      token: broker.token, body: { reinsurer_id: first, written_pct: 40 },
    });

    const advice1 = await api('POST', `/api/contract-years/${yearId}/written-line-advices`, {
      token: broker.token, body: {},
    });
    assert.equal(advice1.status, 201);
    assert.equal(advice1.body.line_count, 1);

    // The line moves after the cedant was told.
    await api('PUT', `/api/structure-versions/${fotId}/lines`, {
      token: broker.token, body: { reinsurer_id: first, written_pct: 55 },
    });
    const second = await reinsurer(api, 'Second Re');
    await api('PUT', `/api/structure-versions/${fotId}/lines`, {
      token: broker.token, body: { reinsurer_id: second, written_pct: 45 },
    });

    const advice2 = await api('POST', `/api/contract-years/${yearId}/written-line-advices`, {
      token: broker.token, body: {},
    });
    assert.equal(advice2.body.line_count, 2);

    const { rows } = await pool.query(
      'SELECT written_pct FROM written_line_advice_line WHERE advice_id = $1', [advice1.body.id],
    );
    assert.equal(Number(rows[0].written_pct), 40,
      'the first advice still says what it said; a later change does not rewrite it');

    const list = await api('GET', `/api/contract-years/${yearId}/written-line-advices`, { token: uw.token });
    assert.equal(list.body.length, 2, 'not one final send');
  });
});

test('an advice is outbound, so it needs a second user (D7)', async () => {
  await withServer(async (api) => {
    const { yearId, fotId } = await setup(api);
    const re = await reinsurer(api, 'Advised Re');
    await api('PUT', `/api/structure-versions/${fotId}/lines`, {
      token: broker.token, body: { reinsurer_id: re, written_pct: 100 },
    });
    const advice = await api('POST', `/api/contract-years/${yearId}/written-line-advices`, {
      token: broker.token, body: {},
    });

    const ungated = await api('POST', `/api/written-line-advices/${advice.body.id}/send`, { token: broker.token });
    assert.equal(ungated.status, 403);

    await approveFor('written_line_advice', 'written_line_advice', advice.body.id);
    const sent = await api('POST', `/api/written-line-advices/${advice.body.id}/send`, { token: broker.token });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.status, 'SENT');

    await assert.rejects(
      pool.query('UPDATE written_line_advice SET approval_id = NULL WHERE id = $1', [advice.body.id]),
      /written_line_advice_sent_has_approval/,
    );
  });
});
