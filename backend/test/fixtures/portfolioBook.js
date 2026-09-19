import assert from 'node:assert/strict';

/**
 * Scenario builders for the book Portfolio intelligence reads — shared by the
 * portfolio and programme-analysis tests. `users` is read lazily (a function
 * returning { broker, uw }) because each test file makes fresh users in its
 * beforeEach, after the builders are destructured at module level.
 */
export const suffix = () => Math.random().toString(36).slice(2, 8);

export function bookBuilders(users) {
  const broker = () => users().broker.token;
  const uw = () => users().uw.token;

  async function cedant(api, name) {
    const r = await api('POST', '/api/cedants', { token: broker(), body: { name, domicile: 'GB' } });
    assert.equal(r.status, 201);
    return r.body;
  }

  async function placement(api, cedantId, { inception = '2026-01-01', expiry = '2026-12-31', klass = 'Property Cat XoL', currency = 'USD' } = {}) {
    const r = await api('POST', '/api/placements', {
      token: broker(), body: { cedant_id: cedantId, class: klass, inception, expiry, currency },
    });
    assert.equal(r.status, 201);
    return r.body;
  }

  async function layer(api, pid, { order = 100, premium = 1_000_000, brokerage = 10, currency = 'USD', type = 'XoL' } = {}) {
    const r = await api('POST', `/api/placements/${pid}/layers`, {
      token: broker(),
      body: { name: 'Layer 1', type, attachment: 1_000_000, limit_amt: 5_000_000, order_pct: order, premium100: premium, brokerage_pct: brokerage, currency },
    });
    assert.equal(r.status, 201);
    return r.body;
  }

  async function market(api, name, type = 'reinsurer') {
    const r = await api('POST', '/api/markets', { token: broker(), body: { name, type, rating: 'A+' } });
    assert.equal(r.status, 201);
    return r.body;
  }

  async function toQuoted(api, pid) {
    for (const status of ['DATA', 'PACK', 'LEAD_MARKETING', 'QUOTED']) {
      const r = await api('POST', `/api/placements/${pid}/transition`, { token: broker(), body: { status } });
      assert.equal(r.status, 200, `transition to ${status}`);
    }
  }

  async function approach(api, lid, marketId, role) {
    const r = await api('POST', `/api/layers/${lid}/approaches`, { token: broker(), body: { market_id: marketId, role } });
    assert.equal(r.status, 201);
    return r.body;
  }

  /**
   * An account we lead: the full order on the layer, a lead and a follow market
   * quoting, both writing a line that signs — plus a second lead that declined,
   * which must never read as leading.
   */
  async function ledAccount(api) {
    const tag = suffix();
    const c = await cedant(api, `Led Cedant ${tag}`);
    const p = await placement(api, c.id);
    const l = await layer(api, p.id, { order: 100, premium: 1_000_000, brokerage: 10 });
    await toQuoted(api, p.id);

    const lead = await market(api, `Lead Re ${tag}`);
    const follow = await market(api, `Follow Re ${tag}`);
    const declined = await market(api, `Declined Lead Re ${tag}`);
    const byRole = {};
    for (const [m, role, premium, line] of [[lead, 'lead', 400_000, 60], [follow, 'follow', 300_000, 40]]) {
      const ap = await approach(api, l.id, m.id, role);
      const q = await api('POST', `/api/approaches/${ap.id}/quotes`, {
        token: broker(), body: { type: 'firm', premium, line_offered: line },
      });
      assert.equal(q.status, 201);
      byRole[role] = { approach_id: ap.id, market_id: m.id, line };
    }
    const apDeclined = await approach(api, l.id, declined.id, 'lead');
    const dec = await api('POST', `/api/approaches/${apDeclined.id}/decline`, { token: broker(), body: {} });
    assert.equal(dec.status, 200);

    await api('POST', `/api/layers/${l.id}/fot`, { token: broker(), body: { agreed_terms: { rol: 0.05 } } });
    await api('POST', `/api/layers/${l.id}/fot/authorise`, { token: uw() });
    for (const role of ['lead', 'follow']) {
      const w = await api('POST', `/api/layers/${l.id}/lines`, {
        token: broker(),
        body: { market_id: byRole[role].market_id, written_pct: byRole[role].line, approach_id: byRole[role].approach_id },
      });
      assert.equal(w.status, 201);
    }
    const signed = await api('POST', `/api/layers/${l.id}/signing/apply`, { token: broker(), body: {} });
    assert.equal(signed.status, 200);
    return { tag, placement: p, layer: l, lead, follow };
  }

  /**
   * An account another house leads: we hold 40% of the order, and Final
   * Placement has recorded the lead broker and the lead reinsurer.
   */
  async function followedAccount(api, leadReinsurerId, { leadBroker = 'Guy Carpenter' } = {}) {
    const tag = suffix();
    const c = await cedant(api, `Followed Cedant ${tag}`);
    const p = await placement(api, c.id, { klass: 'Motor Quota Share' });
    await layer(api, p.id, { order: 40, premium: 500_000, brokerage: 5 });
    const saved = await api('PUT', `/api/placements/${p.id}/final`, {
      token: broker(),
      body: { lead_won: false, lead_broker: leadBroker, lead_reinsurer_id: leadReinsurerId, treaty_type: 'Quota Share' },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.final.lead_won, false);
    return { tag, placement: p };
  }

  return { cedant, placement, layer, market, toQuoted, approach, ledAccount, followedAccount };
}
