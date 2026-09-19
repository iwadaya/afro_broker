import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { bookBuilders, suffix } from '../fixtures/portfolioBook.js';

/**
 * Portfolio intelligence: the book read by who leads it, who places it and
 * who writes it (GET /api/dashboards/portfolio).
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

const { cedant, placement, layer, market, approach, toQuoted, ledAccount, followedAccount } = bookBuilders(() => ({ broker, uw }));

const get = (api, qs = '') => api('GET', `/api/dashboards/portfolio${qs}`, { token: broker.token });

test('an empty book reads as empty, not as an error', async () => {
  await withServer(async (api) => {
    const r = await get(api, '?year=2026');
    assert.equal(r.status, 200);
    assert.equal(r.body.year, 2026);
    assert.equal(r.body.house, 'Afro-Asian Insurance Services');
    assert.equal(r.body.summary.accounts, 0);
    assert.equal(r.body.summary.order_share_pct, null, 'no premium seen means no share, not zero');
    assert.deepEqual(r.body.lead_reinsurers, []);
    assert.deepEqual(r.body.reinsurers, []);
    assert.deepEqual(r.body.brokers, []);
    assert.deepEqual(r.body.accounts, []);
  });
});

test('the book reads who leads, who places and which accounts we lead', async () => {
  await withServer(async (api) => {
    const led = await ledAccount(api);
    const otherLead = await market(api, `Other Lead Re ${led.tag}`);
    const followed = await followedAccount(api, otherLead.id);
    // The other house is on the register's Brokers tab, so its row can link there.
    const gc = await market(api, 'Guy Carpenter', 'broker');

    // An account with no layer yet: nothing to read a role from.
    const draftCedant = await cedant(api, `Draft Cedant ${led.tag}`);
    const draft = await placement(api, draftCedant.id);
    // A lapsed one: off the book, counted as lost.
    const lapsed = await placement(api, draftCedant.id);
    await pool.query("UPDATE placement SET status = 'LAPSED' WHERE id = $1", [lapsed.id]);
    // Next year's: outside the 2026 scope.
    const next = await placement(api, draftCedant.id, { inception: '2027-01-01', expiry: '2027-12-31' });

    const r = (await get(api, '?year=2026')).body;

    // ---- the headline ----
    assert.equal(r.summary.accounts, 3);
    assert.equal(r.summary.cedants, 3);
    assert.equal(r.summary.accounts_led, 1);
    assert.equal(r.summary.accounts_followed, 1);
    assert.equal(r.summary.accounts_unplaced, 1);
    assert.equal(r.summary.accounts_lost, 1);
    assert.equal(r.summary.premium_seen.total, 1_500_000);
    assert.deepEqual(r.summary.premium_seen.by_currency, { USD: 1_500_000 });
    // Our order: all of the 1m we lead, 40% of the 500k we follow.
    assert.equal(r.summary.premium_order.total, 1_200_000);
    assert.equal(r.summary.order_share_pct, 80);
    // Brokerage on our order at the layers' rates: 1m × 10% + 200k × 5%.
    assert.equal(r.summary.brokerage_expected.total, 110_000);
    assert.equal(r.summary.lead_reinsurers, 2);
    assert.equal(r.summary.reinsurers_on_panel, 2);
    assert.equal(r.summary.other_brokers, 1);

    // ---- who is leading ----
    // The lead furthest along on the account we lead, and the lead recorded
    // on the one we follow; the declined lead never counts. The bigger
    // account ranks first.
    assert.deepEqual(
      r.lead_reinsurers.map((l) => [l.name, l.accounts_led, l.confirmed]),
      [[`Lead Re ${led.tag}`, 1, 0], [`Other Lead Re ${led.tag}`, 1, 1]],
    );
    assert.equal(r.lead_reinsurers[0].premium_led.total, 1_000_000);
    assert.equal(r.lead_reinsurers[0].accounts[0].reference, led.placement.reference);
    assert.equal(r.lead_reinsurers[0].accounts[0].source, 'approach');
    // Signing marks the line, not the approach: the lead's stage reads as written.
    assert.equal(r.lead_reinsurers[0].accounts[0].stage, 'WRITTEN');
    assert.equal(r.lead_reinsurers[1].accounts[0].source, 'final');
    assert.ok(!r.lead_reinsurers.some((l) => l.name.startsWith('Declined')), 'a declined lead is not leading');

    // ---- who is writing ----
    const panel = Object.fromEntries(r.reinsurers.map((m) => [m.name, m]));
    const leadRow = panel[`Lead Re ${led.tag}`];
    assert.equal(leadRow.accounts, 1);
    assert.equal(leadRow.lines, 1);
    assert.equal(leadRow.lead_lines, 1);
    assert.equal(leadRow.follow_lines, 0);
    assert.equal(leadRow.signed_lines, 1);
    assert.equal(leadRow.avg_line_pct, 60);
    assert.equal(leadRow.share_total, 60);
    assert.equal(leadRow.premium_signed.total, 600_000);
    assert.equal(leadRow.premium_on_lines.total, 600_000);
    assert.equal(leadRow.accounts_led, 1);
    const followRow = panel[`Follow Re ${led.tag}`];
    assert.equal(followRow.follow_lines, 1);
    assert.equal(followRow.premium_signed.total, 400_000);
    assert.equal(followRow.accounts_led, 0);
    assert.ok(!panel[`Declined Lead Re ${led.tag}`], 'no line, not on the panel');

    // ---- who is placing ----
    // This desk first, then the other house — linked to its register entry.
    assert.deepEqual(
      r.brokers.map((b) => [b.name, b.is_house, b.accounts_count]),
      [['Afro-Asian Insurance Services', true, 1], ['Guy Carpenter', false, 1]],
    );
    assert.equal(r.brokers[0].register_id, null);
    assert.equal(r.brokers[0].premium.total, 1_000_000);
    assert.equal(r.brokers[1].register_id, gc.id);
    assert.equal(r.brokers[1].confirmed, 1);
    assert.equal(r.brokers[1].premium.total, 500_000);
    assert.equal(r.brokers[1].premium_order.total, 200_000);
    assert.equal(r.brokers[1].accounts[0].reference, followed.placement.reference);
    assert.equal(r.brokers[1].accounts[0].order_share_pct, 40);

    // ---- the accounts ----
    const byRef = Object.fromEntries(r.accounts.map((a) => [a.reference, a]));
    const a = byRef[led.placement.reference];
    assert.equal(a.broker_role, 'Lead');
    assert.equal(a.lead_broker, 'Afro-Asian Insurance Services');
    assert.equal(a.role_source, 'order');
    assert.equal(a.lead_reinsurer, `Lead Re ${led.tag}`);
    assert.equal(a.lead_source, 'approach');
    assert.equal(a.panel_size, 2);
    assert.deepEqual(a.panel.map((p) => [p.name, p.role, p.share, p.signed]),
      [[`Lead Re ${led.tag}`, 'lead', 60, true], [`Follow Re ${led.tag}`, 'follow', 40, true]]);
    assert.equal(a.order_share_pct, 100);
    assert.equal(a.total_premium100, 1_000_000);
    assert.equal(a.brokerage_pct, 10);
    assert.equal(a.treaty_types, 'XoL');

    const b = byRef[followed.placement.reference];
    assert.equal(b.broker_role, 'Follow');
    assert.equal(b.lead_broker, 'Guy Carpenter');
    assert.equal(b.role_source, 'final');
    assert.equal(b.lead_won, false);
    assert.equal(b.lead_reinsurer, `Other Lead Re ${led.tag}`);
    assert.equal(b.lead_source, 'final');
    assert.equal(b.order_share_pct, 40);
    assert.equal(b.premium_order, 200_000);
    assert.equal(b.panel_size, 0);

    const c = byRef[draft.reference];
    assert.equal(c.broker_role, null);
    assert.equal(c.lead_broker, null);
    assert.equal(c.lead_reinsurer, null);
    assert.equal(c.total_premium100, null);

    assert.ok(!byRef[lapsed.reference], 'a lapsed account is off the book');
    assert.ok(!byRef[next.reference], 'next year is outside the scope');

    // ---- the scope ----
    const all = (await get(api)).body;
    assert.equal(all.year, null);
    assert.equal(all.summary.accounts, 4, 'the whole book, every treaty year');
    assert.equal(all.summary.accounts_lost, 1);
    const y27 = (await get(api, '?year=2027')).body;
    assert.equal(y27.summary.accounts, 1);
    assert.equal(y27.summary.accounts_lost, 0);
    const junk = (await get(api, '?year=soon')).body;
    assert.equal(junk.year, null, 'an unreadable year reads the whole book rather than failing');
  });
});

test('co-leads at the same stage both lead; a lead further along outranks one behind it', async () => {
  await withServer(async (api) => {
    const tag = suffix();
    const c = await cedant(api, `Co-lead Cedant ${tag}`);
    const p = await placement(api, c.id);
    const l = await layer(api, p.id);
    await toQuoted(api, p.id);
    const first = await market(api, `First Lead ${tag}`);
    const second = await market(api, `Second Lead ${tag}`);
    const behind = await market(api, `Behind Lead ${tag}`);
    const quotes = {};
    for (const m of [first, second, behind]) {
      const ap = await approach(api, l.id, m.id, 'lead');
      const q = await api('POST', `/api/approaches/${ap.id}/quotes`, {
        token: broker.token, body: { type: 'firm', premium: 100_000, line_offered: 30 },
      });
      quotes[m.name] = q.body;
    }
    // Two quotes agreed take their approaches to AGREED; the third stays QUOTED.
    for (const m of [first, second]) {
      const agreed = await api('POST', `/api/quotes/${quotes[m.name].id}/agree`, { token: broker.token, body: {} });
      assert.equal(agreed.status, 200);
    }

    const r = (await get(api, '?year=2026')).body;
    const a = r.accounts.find((x) => x.reference === p.reference);
    assert.equal(a.lead_reinsurer, `First Lead ${tag} + Second Lead ${tag}`);
    assert.deepEqual(a.lead_reinsurers.map((x) => x.status), ['AGREED', 'AGREED']);
    assert.deepEqual(r.lead_reinsurers.map((x) => x.name).sort(), [`First Lead ${tag}`, `Second Lead ${tag}`]);
    assert.equal(r.summary.lead_reinsurers, 2);
  });
});

test('the reinsurers the pack went to as lead stand in until the layers are marketed', async () => {
  await withServer(async (api) => {
    const tag = suffix();
    const c = await cedant(api, `Pack Cedant ${tag}`);
    const p = await placement(api, c.id);
    const m = await market(api, `Pack Lead ${tag}`);
    await pool.query(
      "INSERT INTO negotiation (placement_id, market_id, role, status) VALUES ($1, $2, 'lead', 'SENT')",
      [p.id, m.id],
    );

    const r = (await get(api, '?year=2026')).body;
    const a = r.accounts.find((x) => x.reference === p.reference);
    assert.equal(a.broker_role, null, 'no layer, so no order to read our role from');
    assert.equal(a.lead_reinsurer, `Pack Lead ${tag}`);
    assert.equal(a.lead_source, 'negotiation');
    assert.equal(r.lead_reinsurers[0].name, `Pack Lead ${tag}`);
    assert.equal(r.lead_reinsurers[0].accounts[0].stage, 'SENT');
    assert.deepEqual(r.brokers, [], 'nothing to attribute to a broker yet');
  });
});

test('any signed-in user can read it, nobody can read it signed out', async () => {
  await withServer(async (api) => {
    const anon = await api('GET', '/api/dashboards/portfolio');
    assert.equal(anon.status, 401);
    const asUw = await api('GET', '/api/dashboards/portfolio', { token: uw.token });
    assert.equal(asUw.status, 200);
  });
});
