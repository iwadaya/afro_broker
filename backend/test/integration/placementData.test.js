// The Data screen: the placement's screens read as one and compared with the
// prior year, or with the expiring pack uploaded for a placement new to the house.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool, getApp } from '../helpers.js';

let broker;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  getApp().locals.llmClients = {};
});

const LAYERS = (premium1) => [{ basis: 'NP', layers: [
  { name: 'Layer 1', limit: 5_000_000, attachment: 1_000_000, premium: premium1, rate_pct: 8 },
  { name: 'Layer 2', limit: 10_000_000, attachment: 6_000_000, premium: 250_000 },
], prop: {} }];
const RETENTIONS = (hazardous) => ({ treaty_limit: 15_000_000, rows: [{ klass: 'A', category: 'Residential', pct: 100 }, { klass: 'C', category: 'Hazardous', pct: hazardous }] });

async function seedPlacement(api, body = {}) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: `Data Cedant ${Math.random()}`, domicile: 'Kenya' } });
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, class: 'Property Cat XoL', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD', ...body },
  });
  assert.equal(placement.status, 201, JSON.stringify(placement.body));
  return placement.body;
}

test('a renewal compares this year\'s screens with the prior year\'s, figure by figure, without a model', async () => {
  await withServer(async (api) => {
    const prior = await seedPlacement(api);
    await api('PATCH', `/api/placements/${prior.id}`, { token: broker.token, body: { quote_structures: LAYERS(500_000), retentions: RETENTIONS(50) } });
    await api('PUT', `/api/placements/${prior.id}/modelling/large_losses`, { token: broker.token, body: { data: { rows: [{ year: 2024, insured: 'Mill', incurred: 1_200_000 }] } } });
    const renewal = (await api('POST', `/api/placements/${prior.id}/renew`, { token: broker.token, body: { inception: '2027-01-01', expiry: '2027-12-31' } })).body;
    await api('PATCH', `/api/placements/${renewal.id}`, { token: broker.token, body: { quote_structures: LAYERS(400_000), retentions: RETENTIONS(60) } });

    const res = await api('GET', `/api/placements/${renewal.id}/data-analysis`, { token: broker.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.comparison.basis, 'prior_year');
    assert.equal(res.body.comparison.compared_to, prior.id);
    assert.equal(res.body.comparison.prior.placement.reference, prior.reference);
    assert.equal(res.body.digest.placement.treaty_type, 'Risk XL');
    assert.equal(res.body.digest.screens.quote_structure, true);
    assert.equal(res.body.digest.screens.retentions, true);
    assert.equal(res.body.digest.screens.modelling_screens, 0, 'the renewal has no modelling data yet');
    assert.equal(res.body.digest.expiring_structure.recorded, false, 'nothing recorded → the prior year\'s layers are the expiring, read live');
    assert.equal(res.body.digest.expiring_structure.layers.length, 2);
    const premium = res.body.computed.changes.find((c) => c.area === 'Structure' && c.item === 'Layer 1' && c.field === 'premium');
    assert.deepEqual(premium, { area: 'Structure', item: 'Layer 1', field: 'premium', from: 500_000, to: 400_000, change_pct: -20 });
    assert.ok(res.body.computed.changes.some((c) => c.area === 'Retentions' && c.item === 'Hazardous' && c.from === 50 && c.to === 60));
    assert.ok(res.body.computed.changes.some((c) => c.area === 'Modelling' && c.item === 'large_losses'));
    assert.equal(res.body.analysis, null);
    assert.deepEqual(res.body.providers.map((p) => p.provider), ['openai']);
  });
});

test('with no provider the computed comparison still comes back; with one, the reading is stored', async () => {
  await withServer(async (api) => {
    const prior = await seedPlacement(api);
    await api('PATCH', `/api/placements/${prior.id}`, { token: broker.token, body: { quote_structures: LAYERS(500_000) } });
    const renewal = (await api('POST', `/api/placements/${prior.id}/renew`, { token: broker.token, body: { inception: '2027-01-01', expiry: '2027-12-31' } })).body;
    await api('PATCH', `/api/placements/${renewal.id}`, { token: broker.token, body: { quote_structures: LAYERS(450_000) } });

    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const out = await api('POST', `/api/placements/${renewal.id}/data-analysis`, { token: broker.token, body: {} });
      assert.equal(out.status, 503);
      assert.equal(out.body.code, 'llm_unavailable');
      assert.equal(out.body.computed.changes[0].field, 'premium');
    } finally {
      if (saved) process.env.OPENAI_API_KEY = saved;
    }

    // A stand-in model: the reading is whatever it says, kept with the digest it read.
    let prompt = null;
    getApp().locals.llmClients = {
      openai: async (req) => {
        prompt = req.prompt;
        return {
          model: 'stub-model',
          data: {
            headline: 'Premium down 10% on Layer 1 for the same cover.', programme: 'Two layers.', exposure_and_experience: 'No modelling data.', retentions_and_terms: 'None.',
            comparison: [{ area: 'Structure', change: 'Layer 1 premium 500k → 450k', direction: 'improved', significance: 'medium', commentary: 'Cheaper for the cedant.' }],
            gaps: ['No modelling screens entered.'], questions_for_cedant: [], recommendations: ['Enter the loss experience.'],
          },
        };
      },
    };
    const run = await api('POST', `/api/placements/${renewal.id}/data-analysis`, { token: broker.token, body: {} });
    assert.equal(run.status, 201, JSON.stringify(run.body));
    assert.equal(run.body.analysis.basis, 'prior_year');
    assert.equal(run.body.analysis.model, 'stub-model');
    assert.equal(run.body.analysis.narrative.comparison[0].direction, 'improved');
    assert.match(prompt, /BASIS OF COMPARISON — the prior year/);
    assert.match(prompt, /"premium"/);
    const again = await api('GET', `/api/placements/${renewal.id}/data-analysis`, { token: broker.token });
    assert.equal(again.body.analysis.id, run.body.analysis.id, 'the latest reading is kept');
    assert.equal(again.body.analysis.created_by_name, broker.user.name);
  });
});

test('a placement new to the house compares with the expiring pack uploaded on the Data screen, in any format', async () => {
  await withServer(async (api) => {
    const placement = await seedPlacement(api, { class: 'Property Quota Share' });
    let res = await api('GET', `/api/placements/${placement.id}/data-analysis`, { token: broker.token });
    assert.equal(res.body.comparison.basis, 'none');

    const csv = 'Programme,Expiring 2025\nLayer,Cover,Premium\nLayer 1,5m xs 1m,500000\n';
    const up = await api('POST', `/api/placements/${placement.id}/expiring-pack`, {
      token: broker.token, body: { filename: 'other-broker-pack.csv', mime_type: 'text/csv', content_base64: Buffer.from(csv).toString('base64') },
    });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.document.role, 'expiring');
    assert.equal(up.body.comparison.basis, 'expiring_pack');
    assert.equal(up.body.comparison.documents.length, 1);
    assert.equal(up.body.comparison.compared_to, up.body.analysis_id);

    // The upload is an uploaded pack linked to the placement — the desk and the pack builder see it too.
    const linked = await api('GET', `/api/renewal-analyses?placement_id=${placement.id}`, { token: broker.token });
    assert.equal(linked.body.length, 1);
    assert.equal(linked.body[0].class_of_business, 'Property');
    assert.equal(linked.body[0].treaty_type, 'Quota Share');
    assert.deepEqual(linked.body[0].doc_roles, ['expiring']);

    // A second file joins the same uploaded pack.
    const up2 = await api('POST', `/api/placements/${placement.id}/expiring-pack`, {
      token: broker.token, body: { filename: 'schedule.csv', mime_type: 'text/csv', content_base64: Buffer.from('a,b\n1,2\n').toString('base64') },
    });
    assert.equal(up2.body.analysis_id, up.body.analysis_id);
    assert.equal(up2.body.comparison.documents.length, 2);

    // The model reads the pack's own content beside the screens.
    let prompt = null;
    getApp().locals.llmClients = {
      openai: async (req) => {
        prompt = req.prompt;
        return { model: 'stub', data: { headline: 'h', programme: 'p', exposure_and_experience: 'e', retentions_and_terms: 'r', comparison: [], gaps: [], questions_for_cedant: [], recommendations: [] } };
      },
    };
    const run = await api('POST', `/api/placements/${placement.id}/data-analysis`, { token: broker.token, body: {} });
    assert.equal(run.status, 201, JSON.stringify(run.body));
    assert.equal(run.body.analysis.basis, 'expiring_pack');
    assert.match(prompt, /BASIS OF COMPARISON — the expiring renewal pack uploaded/);
    assert.match(prompt, /5m xs 1m/, 'the CSV is inlined for the model');

    // A renewal of a year in the book takes no upload.
    const prior = await seedPlacement(api);
    const renewal = (await api('POST', `/api/placements/${prior.id}/renew`, { token: broker.token, body: { inception: '2027-01-01', expiry: '2027-12-31' } })).body;
    const refused = await api('POST', `/api/placements/${renewal.id}/expiring-pack`, {
      token: broker.token, body: { filename: 'x.csv', mime_type: 'text/csv', content_base64: Buffer.from('a').toString('base64') },
    });
    assert.equal(refused.status, 422);
  });
});
