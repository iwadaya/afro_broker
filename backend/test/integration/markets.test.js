import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

let broker;
let uw;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  uw = await makeUser('underwriter');
});

const addMarket = (api, body) =>
  api('POST', '/api/markets', { token: broker.token, body });

/** A layer with an authorised FOT, ready to take lines. */
async function readyLayer(api) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Register Cedant', domicile: 'Kenya' } });
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, class: 'Property', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
  });
  const pid = placement.body.id;
  const layer = await api('POST', `/api/placements/${pid}/layers`, {
    token: broker.token, body: { name: 'L1', type: 'XoL', order_pct: 100, premium100: 1_000_000, currency: 'USD' },
  });
  const lid = layer.body.id;
  for (const status of ['DATA', 'PACK', 'LEAD_MARKETING', 'QUOTED']) {
    await api('POST', `/api/placements/${pid}/transition`, { token: broker.token, body: { status } });
  }
  await api('POST', `/api/layers/${lid}/fot`, { token: broker.token, body: { agreed_terms: {} } });
  await api('POST', `/api/layers/${lid}/fot/authorise`, { token: uw.token });
  return { pid, lid, cedant: cedant.body };
}

test('the register splits into reinsurers, insurers and brokers', async () => {
  await withServer(async (api) => {
    await addMarket(api, { name: 'Capacity Re', type: 'reinsurer' });
    await addMarket(api, { name: 'Direct Insurance', type: 'insurer' });
    await addMarket(api, { name: 'Co-broker Ltd', type: 'broker' });

    const names = async (type) => {
      const r = await api('GET', `/api/markets?type=${type}`, { token: broker.token });
      assert.equal(r.status, 200);
      return r.body.map((m) => m.name);
    };
    assert.deepEqual(await names('reinsurer'), ['Capacity Re']);
    assert.deepEqual(await names('insurer'), ['Direct Insurance']);
    assert.deepEqual(await names('broker'), ['Co-broker Ltd']);

    const all = await api('GET', '/api/markets', { token: broker.token });
    assert.equal(all.body.length, 3, 'no type filter returns the whole register');
  });
});

test('a market defaults to reinsurer, so existing callers are unaffected', async () => {
  await withServer(async (api) => {
    const m = await addMarket(api, { name: 'Legacy Re' });
    assert.equal(m.body.type, 'reinsurer');
    assert.equal(m.body.kyc_status, 'not_started');
  });
});

test('creating a cedant creates its insurer entry in the register', async () => {
  await withServer(async (api) => {
    const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Nile Insurance', domicile: 'Egypt' } });
    assert.equal(cedant.status, 201);
    assert.ok(cedant.body.market_id, 'cedant links to its register entry');

    const insurers = await api('GET', '/api/markets?type=insurer', { token: broker.token });
    assert.deepEqual(insurers.body.map((m) => m.name), ['Nile Insurance']);

    const detail = await api('GET', `/api/markets/${cedant.body.market_id}`, { token: broker.token });
    assert.deepEqual(detail.body.cedants.map((c) => c.name), ['Nile Insurance']);
  });
});

test('region, country and rating filters compose', async () => {
  await withServer(async (api) => {
    await addMarket(api, { name: 'Bermuda A', type: 'reinsurer', region: 'Americas', domicile: 'Bermuda', rating: 'A+' });
    await addMarket(api, { name: 'Bermuda B', type: 'reinsurer', region: 'Americas', domicile: 'Bermuda', rating: 'BBB' });
    await addMarket(api, { name: 'Swiss A', type: 'reinsurer', region: 'EMEA', domicile: 'Switzerland', rating: 'A+' });

    const get = async (qs) => (await api('GET', `/api/markets?type=reinsurer&${qs}`, { token: broker.token })).body.map((m) => m.name);
    assert.deepEqual(await get('region=Americas'), ['Bermuda A', 'Bermuda B']);
    assert.deepEqual(await get('country=Switzerland'), ['Swiss A']);
    assert.deepEqual(await get('rating=A%2B'), ['Bermuda A', 'Swiss A']);
    assert.deepEqual(await get('region=Americas&rating=A%2B'), ['Bermuda A']);
    assert.deepEqual(await get('region=americas'), ['Bermuda A', 'Bermuda B'], 'filters are case-insensitive');
    assert.deepEqual(await get('q=Swiss'), ['Swiss A']);
    assert.deepEqual(await get('region=Americas&rating=A%2B&country=Switzerland'), []);
  });
});

test('facets list the filter values present on the active tab', async () => {
  await withServer(async (api) => {
    await addMarket(api, { name: 'R', type: 'reinsurer', region: 'Asia', domicile: 'Singapore', rating: 'A' });
    await addMarket(api, { name: 'B', type: 'broker', region: 'EMEA', domicile: 'UK', rating: 'BBB' });

    const re = await api('GET', '/api/markets/facets?type=reinsurer', { token: broker.token });
    assert.deepEqual(re.body.regions, ['Asia']);
    assert.deepEqual(re.body.countries, ['Singapore']);
    assert.deepEqual(re.body.ratings, ['A']);
    assert.equal(re.body.market_intel.configured, false, 'no provider configured in test');

    const all = await api('GET', '/api/markets/facets', { token: broker.token });
    assert.deepEqual(all.body.regions, ['Asia', 'EMEA']);
  });
});

test('business, lead and follow filters read off the line ledger', async () => {
  await withServer(async (api) => {
    const { lid } = await readyLayer(api);
    const lead = await addMarket(api, { name: 'Lead Re', type: 'reinsurer' });
    const follow = await addMarket(api, { name: 'Follow Re', type: 'reinsurer' });
    await addMarket(api, { name: 'Untouched Re', type: 'reinsurer' });

    for (const [market, role, written] of [[lead, 'lead', 60], [follow, 'follow', 40]]) {
      const approach = await api('POST', `/api/layers/${lid}/approaches`, {
        token: broker.token, body: { market_id: market.body.id, role },
      });
      assert.equal(approach.status, 201);
      const line = await api('POST', `/api/layers/${lid}/lines`, {
        token: broker.token,
        body: { market_id: market.body.id, approach_id: approach.body.id, written_pct: written },
      });
      assert.equal(line.status, 201);
    }

    const get = async (qs) => (await api('GET', `/api/markets?type=reinsurer&${qs}`, { token: broker.token })).body;

    assert.deepEqual((await get('has_business=true')).map((m) => m.name), ['Follow Re', 'Lead Re']);
    assert.deepEqual((await get('has_business=false')).map((m) => m.name), ['Untouched Re']);
    assert.deepEqual((await get('role=lead')).map((m) => m.name), ['Lead Re']);
    assert.deepEqual((await get('role=follow')).map((m) => m.name), ['Follow Re']);

    const [top] = await get('sort=share');
    assert.equal(top.name, 'Lead Re');
    assert.equal(top.business.lead_share, 60);
    assert.equal(top.business.follow_share, 0);
    assert.equal(top.business.total_share, 60);
    assert.equal(top.business.lines_count, 1);
    assert.equal(top.business.has_business, true);

    assert.deepEqual((await get('min_share=50')).map((m) => m.name), ['Lead Re']);
  });
});

test('lead/follow attribution survives a line written without naming its approach', async () => {
  await withServer(async (api) => {
    const { lid } = await readyLayer(api);
    const m = await addMarket(api, { name: 'Unlinked Re', type: 'reinsurer' });
    await api('POST', `/api/layers/${lid}/approaches`, { token: broker.token, body: { market_id: m.body.id, role: 'lead' } });
    // The write-line form sends only the market and the line, no approach_id.
    await api('POST', `/api/layers/${lid}/lines`, { token: broker.token, body: { market_id: m.body.id, written_pct: 35 } });

    const [row] = (await api('GET', '/api/markets?type=reinsurer&role=lead', { token: broker.token })).body;
    assert.equal(row.name, 'Unlinked Re');
    assert.equal(row.business.lead_share, 35);
    assert.equal(row.business.lead_lines, 1);

    const detail = await api('GET', `/api/markets/${m.body.id}`, { token: broker.token });
    assert.equal(detail.body.placements[0].role, 'lead');
  });
});

test('a market approached but not yet written still counts in its role', async () => {
  await withServer(async (api) => {
    const { lid } = await readyLayer(api);
    const m = await addMarket(api, { name: 'Out To Quote Re', type: 'reinsurer' });
    await api('POST', `/api/layers/${lid}/approaches`, { token: broker.token, body: { market_id: m.body.id, role: 'lead' } });

    const asLead = await api('GET', '/api/markets?type=reinsurer&role=lead', { token: broker.token });
    assert.deepEqual(asLead.body.map((x) => x.name), ['Out To Quote Re']);

    const withBusiness = await api('GET', '/api/markets?type=reinsurer&has_business=true', { token: broker.token });
    assert.equal(withBusiness.body.length, 0, 'an approach is not business until a line is written');
  });
});

test('only reinsurers can be approached for capacity', async () => {
  await withServer(async (api) => {
    const { lid } = await readyLayer(api);
    const insurer = await addMarket(api, { name: 'Not Capacity', type: 'insurer' });
    const r = await api('POST', `/api/layers/${lid}/approaches`, {
      token: broker.token, body: { market_id: insurer.body.id, role: 'follow' },
    });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /reinsurers/);
  });
});

test('a non-reinsurer cannot write a line either', async () => {
  await withServer(async (api) => {
    const { lid } = await readyLayer(api);
    const broking = await addMarket(api, { name: 'Co-broker', type: 'broker' });
    const r = await api('POST', `/api/layers/${lid}/lines`, {
      token: broker.token, body: { market_id: broking.body.id, written_pct: 10 },
    });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /reinsurers/);
  });
});

test('compliance blocks until KYC and rating are recorded, and is underwriter-gated', async () => {
  await withServer(async (api) => {
    const m = await addMarket(api, { name: 'New Re', type: 'reinsurer' });
    const before = await api('GET', `/api/markets/${m.body.id}`, { token: broker.token });
    assert.equal(before.body.compliance.overall, 'blocked');
    assert.equal(before.body.compliance.can_place, false);
    assert.equal(before.body.compliance.kyc.status, 'not_started');

    const denied = await api('PATCH', `/api/markets/${m.body.id}/compliance`, {
      token: broker.token, body: { kyc_status: 'approved' },
    });
    assert.equal(denied.status, 403, 'a broker cannot sign off its own counterparty');

    const today = new Date().toISOString().slice(0, 10);
    const next = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
    const ok = await api('PATCH', `/api/markets/${m.body.id}/compliance`, {
      token: uw.token,
      body: { kyc_status: 'approved', kyc_expires_at: next, rating: 'A+', rating_agency: 'AM Best', rating_as_of: today },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.compliance.overall, 'ok');
    assert.equal(ok.body.compliance.can_place, true);
    assert.equal(ok.body.kyc_reviewed_by, uw.user.id, 'the reviewer is recorded');
    assert.equal(String(ok.body.kyc_reviewed_at).slice(0, 10), today);
  });
});

test('declined security blocks the counterparty and the approach', async () => {
  await withServer(async (api) => {
    const { lid } = await readyLayer(api);
    const m = await addMarket(api, { name: 'Bad Re', type: 'reinsurer', security_status: 'declined' });
    const detail = await api('GET', `/api/markets/${m.body.id}`, { token: broker.token });
    assert.equal(detail.body.compliance.security.tone, 'blocked');

    const approach = await api('POST', `/api/layers/${lid}/approaches`, {
      token: broker.token, body: { market_id: m.body.id, role: 'follow' },
    });
    assert.equal(approach.status, 409);
  });
});

test('a hand-written group summary is stored as verified manual content', async () => {
  await withServer(async (api) => {
    const m = await addMarket(api, { name: 'Profile Re', type: 'reinsurer' });
    const saved = await api('PUT', `/api/markets/${m.body.id}/profile`, {
      token: broker.token,
      body: { market_position: 'Top-five regional writer', overview: 'Composite group.' },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.source, 'manual');
    assert.equal(saved.body.verified, true);

    const detail = await api('GET', `/api/markets/${m.body.id}`, { token: broker.token });
    assert.equal(detail.body.profile.market_position, 'Top-five regional writer');
  });
});

test('gathering with no provider configured fails rather than inventing figures', async () => {
  await withServer(async (api) => {
    const m = await addMarket(api, { name: 'Gather Re', type: 'reinsurer' });
    const r = await api('POST', `/api/markets/${m.body.id}/profile/enrich`, { token: broker.token });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /No AI provider is configured for internet research/);

    // Nothing was written: no half-made profile, no placeholder years.
    const detail = await api('GET', `/api/markets/${m.body.id}`, { token: broker.token });
    assert.equal(detail.body.profile, null);
    assert.equal(detail.body.financials.length, 0);
  });
});

test('a gathered profile can be signed off once checked', async () => {
  await withServer(async (api) => {
    const m = await addMarket(api, { name: 'Verify Re', type: 'reinsurer' });
    // Stand in for a gather: the profile row an enrich would have written.
    await pool.query(
      `INSERT INTO market_profile (market_id, market_position, source, verified, gathered_at)
       VALUES ($1, 'Researched position', 'ai', FALSE, now())`,
      [m.body.id],
    );
    const before = await api('GET', `/api/markets/${m.body.id}`, { token: broker.token });
    assert.equal(before.body.profile.source, 'ai');
    assert.equal(before.body.profile.verified, false, 'gathered content lands unverified');

    const verified = await api('POST', `/api/markets/${m.body.id}/profile/verify`, { token: uw.token });
    assert.equal(verified.body.verified, true);
    assert.equal(verified.body.verified_by, uw.user.id);
  });
});

test('financials upload by CSV, with blanks left null', async () => {
  await withServer(async (api) => {
    const m = await addMarket(api, { name: 'Csv Re', type: 'reinsurer' });
    const csv = [
      'year,currency,gwp,nwp,net_income,combined_ratio,roe',
      '2025,USD,"1,250,000",1000000,90000,94.2,11.5',
      '2024,USD,1100000,,80000,,',
    ].join('\n');
    const r = await api('POST', `/api/markets/${m.body.id}/financials/import`, { token: broker.token, body: { csv } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((f) => f.year), [2025, 2024]);
    assert.equal(Number(r.body[0].gwp), 1250000, 'thousands separators are tolerated');
    assert.equal(Number(r.body[0].combined_ratio), 94.2);
    assert.equal(r.body[1].nwp, null, 'a blank cell stays null rather than becoming zero');
    assert.equal(r.body[0].source, 'manual');

    const junk = await api('POST', `/api/markets/${m.body.id}/financials/import`, { token: broker.token, body: { csv: 'a,b\n1,2' } });
    assert.equal(junk.status, 409);

    const removed = await api('DELETE', `/api/markets/${m.body.id}/financials/2024`, { token: broker.token });
    assert.equal(removed.status, 204);
    const left = await api('GET', `/api/markets/${m.body.id}/financials`, { token: broker.token });
    assert.deepEqual(left.body.map((f) => f.year), [2025]);
  });
});

test('news items can be added and removed, and appear newest first', async () => {
  await withServer(async (api) => {
    const m = await addMarket(api, { name: 'News Re', type: 'reinsurer' });
    await api('POST', `/api/markets/${m.body.id}/news`, {
      token: broker.token, body: { headline: 'Older', published_at: '2026-01-01' },
    });
    const newer = await api('POST', `/api/markets/${m.body.id}/news`, {
      token: broker.token, body: { headline: 'Newer', published_at: '2026-05-01', url: 'https://example.test/a' },
    });

    const detail = await api('GET', `/api/markets/${m.body.id}`, { token: broker.token });
    assert.deepEqual(detail.body.news.map((n) => n.headline), ['Newer', 'Older']);

    assert.equal((await api('DELETE', `/api/markets/${m.body.id}/news/${newer.body.id}`, { token: broker.token })).status, 204);
    const after = await api('GET', `/api/markets/${m.body.id}`, { token: broker.token });
    assert.deepEqual(after.body.news.map((n) => n.headline), ['Older']);
  });
});

test('the detail view carries the business placed with the market', async () => {
  await withServer(async (api) => {
    const { lid } = await readyLayer(api);
    const m = await addMarket(api, { name: 'Detail Re', type: 'reinsurer' });
    const approach = await api('POST', `/api/layers/${lid}/approaches`, {
      token: broker.token, body: { market_id: m.body.id, role: 'lead' },
    });
    await api('POST', `/api/layers/${lid}/lines`, {
      token: broker.token, body: { market_id: m.body.id, approach_id: approach.body.id, written_pct: 45 },
    });

    const detail = await api('GET', `/api/markets/${m.body.id}`, { token: broker.token });
    assert.equal(detail.body.business.lines_count, 1);
    assert.equal(detail.body.business.lead_share, 45);
    assert.equal(detail.body.placements.length, 1);
    assert.equal(detail.body.placements[0].role, 'lead');
    assert.equal(detail.body.placements[0].cedant_name, 'Register Cedant');
    assert.equal(detail.body.placements[0].layer_name, 'L1');
  });
});

test('an unknown market is a 404', async () => {
  await withServer(async (api) => {
    const r = await api('GET', '/api/markets/00000000-0000-0000-0000-000000000000', { token: broker.token });
    assert.equal(r.status, 404);
  });
});
