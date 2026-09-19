import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { bookBuilders } from '../fixtures/portfolioBook.js';

/**
 * Programme analysis: the book's programmes read by who places each one and
 * who writes it (GET /api/dashboards/portfolio/programmes) — the figures
 * behind the charts on Portfolio intelligence's "Analyse programmes" screen.
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

const { cedant, placement, layer, market, ledAccount, followedAccount } = bookBuilders(() => ({ broker, uw }));

const get = (api, qs = '') => api('GET', `/api/dashboards/portfolio/programmes${qs}`, { token: broker.token });
const portfolio = (api, qs = '') => api('GET', `/api/dashboards/portfolio${qs}`, { token: broker.token });

test('an empty book analyses as empty, not as an error', async () => {
  await withServer(async (api) => {
    const r = await get(api, '?year=2026');
    assert.equal(r.status, 200);
    assert.equal(r.body.year, 2026);
    assert.equal(r.body.house, 'Universe Broking');
    assert.equal(r.body.summary.programmes, 0);
    assert.equal(r.body.summary.order_share_pct, null);
    assert.equal(r.body.summary.avg_panel_size, null);
    assert.equal(r.body.summary.concentration, null, 'no premium on lines means no concentration, not zero');
    for (const key of ['brokers', 'reinsurers', 'classes', 'years', 'programmes']) assert.deepEqual(r.body[key], [], key);
  });
});

test('the programmes read by who places them and who writes them', async () => {
  await withServer(async (api) => {
    const led = await ledAccount(api);
    const otherLead = await market(api, `Other Lead Re ${led.tag}`);
    const followed = await followedAccount(api, otherLead.id);
    const gc = await market(api, 'Guy Carpenter', 'broker');
    // Follow Re also writes 25% on the followed programme, so one reinsurer
    // sits on both houses' programmes and the broker × reinsurer grid has
    // two columns. The line is written, not yet signed.
    const { rows: fl } = await pool.query('SELECT id FROM layer WHERE placement_id = $1', [followed.placement.id]);
    const { rows: fa } = await pool.query(
      "INSERT INTO approach (layer_id, market_id, role, sent_date, status) VALUES ($1, $2, 'follow', '2026-01-05', 'WRITTEN') RETURNING id",
      [fl[0].id, led.follow.id],
    );
    await pool.query(
      "INSERT INTO line (layer_id, market_id, approach_id, written_pct, status) VALUES ($1, $2, $3, 25, 'WRITTEN')",
      [fl[0].id, led.follow.id, fa[0].id],
    );
    // On the book, but with neither a layer nor a Final Placement: not a programme yet.
    const draftCedant = await cedant(api, `Draft Cedant ${led.tag}`);
    const draft = await placement(api, draftCedant.id);
    // Next year's programme: outside the 2026 scope, inside the whole book.
    const nextCedant = await cedant(api, `Next Cedant ${led.tag}`);
    const next = await placement(api, nextCedant.id, { inception: '2027-01-01', expiry: '2027-12-31', klass: 'Marine Risk XL' });
    await layer(api, next.id, { order: 100, premium: 250_000, brokerage: 8 });

    const r = (await get(api, '?year=2026')).body;

    // ---- the headline ----
    const s = r.summary;
    assert.equal(s.programmes, 2);
    assert.equal(s.accounts_on_book, 3);
    assert.equal(s.accounts_unstructured, 1, 'the draft is on the book but not yet a programme');
    assert.equal(s.cedants, 2);
    assert.equal(s.layers, 2);
    assert.equal(s.programmes_led, 1);
    assert.equal(s.programmes_followed, 1);
    assert.equal(s.programmes_with_lines, 2);
    assert.equal(s.programmes_unnamed_broker, 0);
    assert.equal(s.brokers, 2);
    assert.equal(s.other_brokers, 1);
    assert.equal(s.reinsurers, 2);
    assert.equal(s.lines, 3);
    assert.equal(s.signed_lines, 2);
    assert.equal(s.premium_seen.total, 1_500_000);
    assert.equal(s.premium_order.total, 1_200_000);
    assert.equal(s.order_share_pct, 80);
    // The lines carry 60% and 40% of the 1m layer we lead, and 25% of the 500k layer we follow.
    assert.equal(s.premium_on_lines.total, 1_125_000);
    assert.deepEqual(s.premium_on_lines.by_currency, { USD: 1_125_000 });
    assert.equal(s.premium_signed.total, 1_000_000);
    assert.equal(s.brokerage_expected.total, 110_000);
    assert.equal(s.avg_panel_size, 1.5, 'two reinsurers on one programme, one on the other');
    // Concentration: the lead carries 600k of the 1.125m on lines, the two together all of it.
    assert.equal(s.concentration.basis, 'premium_on_lines');
    assert.equal(s.concentration.reinsurers, 2);
    assert.equal(s.concentration.top1_pct, 53.33);
    assert.equal(s.concentration.top3_pct, 100);
    assert.equal(s.concentration.top10_pct, 100);
    assert.deepEqual(
      s.concentration.curve.map((c) => [c.rank, c.name, c.share_pct, c.cumulative_pct]),
      [[1, `Lead Re ${led.tag}`, 53.33, 53.33], [2, `Follow Re ${led.tag}`, 46.67, 100]],
    );

    // ---- by broker: this desk first, then the other house ----
    assert.deepEqual(
      r.brokers.map((b) => [b.name, b.is_house, b.programmes, b.led, b.followed]),
      [['Universe Broking', true, 1, 1, 0], ['Guy Carpenter', false, 1, 0, 1]],
    );
    const house = r.brokers[0];
    assert.equal(house.key, 'universe broking');
    assert.equal(house.register_id, null);
    assert.equal(house.layers, 1);
    assert.equal(house.lines, 2);
    assert.equal(house.signed_lines, 2);
    assert.equal(house.programmes_with_lines, 1);
    assert.equal(house.reinsurer_count, 2);
    assert.equal(house.avg_panel_size, 2);
    assert.equal(house.premium.total, 1_000_000);
    assert.equal(house.premium_order.total, 1_000_000);
    assert.equal(house.premium_rest.total, 0, 'we lead, so nothing is left to the lead house');
    assert.deepEqual(house.premium_rest.by_currency, {});
    assert.equal(house.order_share_pct, 100);
    assert.equal(house.premium_on_lines.total, 1_000_000);
    assert.deepEqual(house.classes.map((c) => [c.class, c.programmes, c.premium.total]), [['Property Cat XoL', 1, 1_000_000]]);
    assert.deepEqual(house.treaty_types, [{ type: 'XoL', programmes: 1 }]);
    assert.deepEqual(
      house.reinsurers.map((x) => [x.name, x.programmes, x.lines, x.lead_lines, x.follow_lines, x.share_total, x.premium_on_lines.total]),
      [[`Lead Re ${led.tag}`, 1, 1, 1, 0, 60, 600_000], [`Follow Re ${led.tag}`, 1, 1, 0, 1, 40, 400_000]],
    );
    assert.deepEqual(house.programme_ids, [led.placement.id]);

    const other = r.brokers[1];
    assert.equal(other.key, 'guy carpenter');
    assert.equal(other.register_id, gc.id, 'the other house links to its register entry');
    assert.equal(other.premium.total, 500_000);
    assert.equal(other.premium_order.total, 200_000);
    assert.equal(other.premium_rest.total, 300_000, 'the 60% of the order the lead house places');
    assert.deepEqual(other.premium_rest.by_currency, { USD: 300_000 });
    assert.equal(other.order_share_pct, 40);
    assert.equal(other.lines, 1);
    assert.equal(other.signed_lines, 0);
    assert.equal(other.reinsurer_count, 1);
    assert.equal(other.avg_panel_size, 1);
    assert.equal(other.premium_on_lines.total, 125_000);
    assert.deepEqual(other.classes.map((c) => [c.class, c.programmes]), [['Motor Quota Share', 1]]);
    assert.deepEqual(
      other.reinsurers.map((x) => [x.name, x.programmes, x.lines, x.lead_lines, x.follow_lines, x.share_total, x.premium_on_lines.total]),
      [[`Follow Re ${led.tag}`, 1, 1, 0, 1, 25, 125_000]],
    );

    // ---- by reinsurer: the role each holds, and whose programmes it writes ----
    const byRe = Object.fromEntries(r.reinsurers.map((x) => [x.name, x]));
    const leadRe = byRe[`Lead Re ${led.tag}`];
    assert.equal(leadRe.programmes, 1);
    assert.equal(leadRe.programmes_lead, 1);
    assert.equal(leadRe.programmes_follow, 0);
    assert.equal(leadRe.programmes_unroled, 0);
    assert.equal(leadRe.programmes_led, 1, 'it is the lead reinsurer on the account as the portfolio reads it');
    assert.equal(leadRe.lines, 1);
    assert.equal(leadRe.signed_lines, 1);
    assert.equal(leadRe.share_total, 60);
    assert.equal(leadRe.premium_on_lines.total, 600_000);
    assert.equal(leadRe.premium_signed.total, 600_000);
    assert.equal(leadRe.premium_lead.total, 600_000);
    assert.equal(leadRe.premium_follow.total, 0);
    assert.deepEqual(
      leadRe.brokers.map((b) => [b.name, b.is_house, b.programmes, b.lines, b.premium_on_lines.total]),
      [['Universe Broking', true, 1, 1, 600_000]],
    );
    assert.deepEqual(leadRe.classes.map((c) => [c.class, c.programmes, c.lines, c.premium_on_lines.total]), [['Property Cat XoL', 1, 1, 600_000]]);
    assert.deepEqual(leadRe.programme_ids, [led.placement.id]);
    const followRe = byRe[`Follow Re ${led.tag}`];
    assert.equal(followRe.programmes, 2);
    assert.equal(followRe.programmes_follow, 2);
    assert.equal(followRe.lines, 2);
    assert.equal(followRe.signed_lines, 1);
    assert.equal(followRe.share_total, 65);
    assert.equal(followRe.premium_on_lines.total, 525_000);
    assert.equal(followRe.premium_signed.total, 400_000, 'the written line carries no signed premium yet');
    assert.equal(followRe.premium_follow.total, 525_000);
    assert.equal(followRe.programmes_led, 0);
    // It writes on both houses' programmes — this desk's first.
    assert.deepEqual(
      followRe.brokers.map((b) => [b.name, b.is_house, b.programmes, b.lines, b.premium_on_lines.total]),
      [['Universe Broking', true, 1, 1, 400_000], ['Guy Carpenter', false, 1, 1, 125_000]],
    );
    assert.deepEqual(
      followRe.classes.map((c) => [c.class, c.programmes, c.premium_on_lines.total]),
      [['Property Cat XoL', 1, 400_000], ['Motor Quota Share', 1, 125_000]],
    );
    assert.ok(!byRe[`Declined Lead Re ${led.tag}`], 'no line, so not writing');
    assert.ok(!byRe[`Other Lead Re ${led.tag}`], 'leading an account is not writing a line on it');
    // The reinsurer on most programmes ranks first.
    assert.equal(r.reinsurers[0].name, `Follow Re ${led.tag}`);

    // ---- by class and by treaty year ----
    assert.deepEqual(
      r.classes.map((c) => [c.class, c.programmes, c.led, c.followed, c.premium.total, c.lines, c.reinsurers, c.brokers]),
      [['Property Cat XoL', 1, 1, 0, 1_000_000, 2, 2, 1], ['Motor Quota Share', 1, 0, 1, 500_000, 1, 1, 1]],
    );
    assert.deepEqual(
      r.years.map((y) => [y.year, y.programmes, y.led, y.followed, y.premium.total, y.premium_order.total, y.lines, y.reinsurers, y.brokers, y.cedants]),
      [[2026, 2, 1, 1, 1_500_000, 1_200_000, 3, 2, 2, 2]],
    );

    // ---- the programmes ----
    const byRef = Object.fromEntries(r.programmes.map((p) => [p.reference, p]));
    const a = byRef[led.placement.reference];
    assert.equal(a.year, 2026);
    assert.equal(a.broker_role, 'Lead');
    assert.equal(a.lead_broker, 'Universe Broking');
    assert.equal(a.broker_key, 'universe broking');
    assert.equal(a.lead_reinsurer, `Lead Re ${led.tag}`);
    assert.equal(a.layers, 1);
    assert.equal(a.lines, 2);
    assert.equal(a.signed_lines, 2);
    assert.equal(a.panel_size, 2);
    assert.equal(a.premium100, 1_000_000);
    assert.equal(a.premium_on_lines.total, 1_000_000);
    const b = byRef[followed.placement.reference];
    assert.equal(b.broker_role, 'Follow');
    assert.equal(b.broker_key, 'guy carpenter');
    assert.equal(b.lines, 1);
    assert.equal(b.panel_size, 1);
    assert.equal(b.premium_on_lines.total, 125_000);
    assert.equal(b.treaty_types, 'XoL');
    assert.ok(!byRef[draft.reference], 'an account with no order to read is not a programme');
    assert.ok(!byRef[next.reference], 'next year is outside the scope');

    // ---- the scope, and agreement with the portfolio screen ----
    const all = (await get(api)).body;
    assert.equal(all.year, null);
    assert.equal(all.summary.programmes, 3, 'the whole book, every treaty year');
    assert.equal(all.summary.accounts_unstructured, 1);
    assert.deepEqual(all.years.map((y) => [y.year, y.programmes]), [[2026, 2], [2027, 1]]);
    assert.deepEqual(all.classes.map((c) => c.class), ['Property Cat XoL', 'Motor Quota Share', 'Marine Risk XL']);
    const y27 = (await get(api, '?year=2027')).body;
    assert.equal(y27.summary.programmes, 1);
    assert.equal(y27.summary.reinsurers, 0);
    assert.equal(y27.summary.concentration, null);

    const port = (await portfolio(api, '?year=2026')).body;
    assert.equal(port.summary.premium_seen.total, r.summary.premium_seen.total, 'the same reading of the book');
    assert.equal(port.summary.reinsurers_on_panel, r.summary.reinsurers);
    assert.deepEqual(port.brokers.map((x) => x.name), r.brokers.map((x) => x.name));
    assert.ok(!('lines' in port), 'the portfolio payload keeps its shape');
  });
});

test('a followed account whose lead house is not yet named sits in its own bucket', async () => {
  await withServer(async (api) => {
    const tag = Math.random().toString(36).slice(2, 8);
    const c = await cedant(api, `Unnamed Cedant ${tag}`);
    const p = await placement(api, c.id);
    // A share of the order, and no Final Placement: we follow, and nobody has named the lead.
    await layer(api, p.id, { order: 30, premium: 800_000 });

    const r = (await get(api, '?year=2026')).body;
    assert.equal(r.summary.programmes, 1);
    assert.equal(r.summary.programmes_followed, 1);
    assert.equal(r.summary.programmes_unnamed_broker, 1);
    assert.equal(r.summary.brokers, 0, 'an unnamed house is not a broker on the book');
    assert.deepEqual(r.brokers.map((b) => [b.key, b.name, b.is_house, b.programmes, b.premium_order.total, b.premium_rest.total]),
      [['__unnamed__', null, false, 1, 240_000, 560_000]]);
    assert.equal(r.programmes[0].broker_key, '__unnamed__');
  });
});

test('any signed-in user can read it, nobody can read it signed out', async () => {
  await withServer(async (api) => {
    const anon = await api('GET', '/api/dashboards/portfolio/programmes');
    assert.equal(anon.status, 401);
    const asUw = await api('GET', '/api/dashboards/portfolio/programmes', { token: uw.token });
    assert.equal(asUw.status, 200);
  });
});
