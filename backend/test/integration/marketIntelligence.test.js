import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { bookBuilders } from '../fixtures/portfolioBook.js';
import { gather } from '../../src/modules/intelligence/marketIntelligence.service.js';

/**
 * Market intelligence (/api/market-intelligence): a market by country or
 * region — the book there, the AI's brief, and the brokers' own visits
 * with their return and the notes they keep on a cedant, a country or a
 * region.
 */
let broker;
let other;
let uw;
let admin;
const savedKey = process.env.OPENAI_API_KEY;

before(async () => {
  // The gather must fail honestly with no provider, whatever the shell holds.
  delete process.env.OPENAI_API_KEY;
  await resetDb();
});
after(async () => {
  if (savedKey) process.env.OPENAI_API_KEY = savedKey;
  await pool.end();
});
beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  other = await makeUser('broker');
  uw = await makeUser('underwriter');
  admin = await makeUser('admin');
});

const { cedant, ledAccount } = bookBuilders(() => ({ broker, uw }));

const BASE = '/api/market-intelligence';
const scopeQs = (type, key) => `scope_type=${type}&scope_key=${encodeURIComponent(key)}`;
const view = (api, type, key, extra = '') => api('GET', `${BASE}/scope?${scopeQs(type, key)}${extra}`, { token: broker.token });
const trip = (api, body, token = broker.token) => api('POST', `${BASE}/visits`, { token, body });
const note = (api, body, token = broker.token) => api('POST', `${BASE}/notes`, { token, body });

const TRIP = {
  country_code: 'GB', city: 'London', purpose: 'Renewal roadshow',
  start_date: '2025-11-10', end_date: '2025-11-12', cost_amount: 8000, cost_currency: 'USD', notes: 'Met the CFO.',
};

test('the map: every region and country on the reference list, with what the desk holds on each', async () => {
  await withServer(async (api) => {
    const r = await api('GET', BASE, { token: uw.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.ai.configured, false);
    assert.equal(r.body.attribution_months, 12);
    const europe = r.body.regions.find((x) => x.region === 'Europe');
    assert.ok(europe, 'Europe is a region of the list');
    const gb = europe.countries.find((c) => c.code === 'GB');
    assert.equal(gb.name, 'United Kingdom');
    assert.deepEqual([gb.accounts, gb.cedants, gb.visits, gb.notes, gb.brief], [0, 0, 0, 0, null]);
    assert.deepEqual(r.body.totals, { accounts: 0, accounts_unresolved: 0, visits: 0, notes: 0, briefs: 0 });
    assert.deepEqual(r.body.cedants, []);
  });
});

test('a broker logs a trip; its return is the brokerage the book expects from the cedants met', async () => {
  await withServer(async (api) => {
    const led = await ledAccount(api);   // USD 1m at 100% order, 10% brokerage, incepting 2026-01-01
    const cedantId = led.placement.cedant_id;

    const created = await trip(api, { ...TRIP, cedant_ids: [cedantId] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const v = created.body;
    assert.equal(v.user_id, broker.user.id);
    assert.equal(v.broker_name, broker.user.name);
    assert.equal(v.country_code, 'GB');
    assert.equal(v.country_name, 'United Kingdom');
    assert.equal(v.region, 'Europe', 'the region comes from the reference list');
    assert.equal(v.start_date, '2025-11-10');
    assert.equal(v.cost_amount, 8000);
    assert.deepEqual(v.cedants.map((c) => c.id), [cedantId]);
    assert.equal(v.notes_count, 0);

    // The country's view: the trip, credited with the account, against its cost.
    const gb = (await view(api, 'country', 'GB')).body;
    assert.equal(gb.scope.key, 'GB');
    assert.equal(gb.scope.label, 'United Kingdom');
    assert.equal(gb.scope.region, 'Europe');
    assert.equal(gb.book.summary.accounts, 1);
    assert.equal(gb.book.accounts[0].reference, led.placement.reference);
    assert.equal(gb.book.summary.brokerage_expected.total, 100_000);
    assert.equal(gb.visits.length, 1);
    assert.deepEqual(gb.visits[0].attributed.map((a) => a.reference), [led.placement.reference]);
    assert.equal(gb.visits[0].roi.return_in_cost_currency, 100_000);
    assert.equal(gb.visits[0].roi.net, 92_000);
    assert.equal(gb.visits[0].roi.roi_pct, 1150);
    assert.deepEqual(gb.roi.by_currency, [{ currency: 'USD', cost: 8000, return: 100_000, net: 92_000, roi_pct: 1150 }]);
    assert.equal(gb.cedants.length, 1, 'the register\'s cedants in the country');
    assert.equal(gb.brief, null);

    // The region's view sees the same trip; the treaty year narrows the book alone.
    const europe = (await view(api, 'region', 'Europe')).body;
    assert.equal(europe.visits.length, 1);
    assert.equal(europe.book.summary.accounts, 1);
    const narrowed = (await view(api, 'country', 'GB', '&year=2027')).body;
    assert.equal(narrowed.book.summary.accounts, 0, 'nothing incepts in 2027');
    assert.equal(narrowed.roi.by_currency[0].return, 100_000, 'the trip\'s return is not narrowed by the year');

    // The map counts it.
    const map = (await api('GET', BASE, { token: broker.token })).body;
    const row = map.regions.find((x) => x.region === 'Europe').countries.find((c) => c.code === 'GB');
    assert.deepEqual([row.accounts, row.cedants_on_book, row.cedants, row.visits], [1, 1, 1, 1]);

    // The trips log, and only mine.
    const log = (await api('GET', `${BASE}/visits`, { token: other.token })).body;
    assert.equal(log.visits.length, 1);
    assert.equal(log.roi.trips, 1);
    const mine = (await api('GET', `${BASE}/visits?mine=true`, { token: other.token })).body;
    assert.equal(mine.visits.length, 0);
  });
});

test('a stored spelling of a country resolves: "uk" is the United Kingdom', async () => {
  await withServer(async (api) => {
    const r = await view(api, 'country', 'uk');
    assert.equal(r.status, 200);
    assert.equal(r.body.scope.key, 'GB');
    assert.equal((await view(api, 'country', 'Narnia')).status, 404);
    assert.equal((await view(api, 'region', 'Atlantis')).status, 404);
    const c = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Albion Mutual', domicile: 'UK' } });
    assert.equal(c.status, 201);
    const gb = (await view(api, 'country', 'GB')).body;
    assert.deepEqual(gb.cedants.map((x) => [x.name, x.country_code, x.region]), [['Albion Mutual', 'GB', 'Europe']]);
  });
});

test('a trip is checked: real dates in order, a country on the list, cedants on the register', async () => {
  await withServer(async (api) => {
    const back = await trip(api, { ...TRIP, start_date: '2025-11-12', end_date: '2025-11-10' });
    assert.equal(back.status, 422);
    assert.match(back.body.error, /end on or after/);
    const nowhere = await trip(api, { ...TRIP, country_code: 'Narnia' });
    assert.equal(nowhere.status, 422);
    const nobody = await trip(api, { ...TRIP, cedant_ids: ['00000000-0000-0000-0000-000000000001'] });
    assert.equal(nobody.status, 404);
    const malformed = await trip(api, { ...TRIP, start_date: '10/11/2025' });
    assert.equal(malformed.status, 422);
    // An underwriter oversees; the trips are the brokers'.
    assert.equal((await trip(api, TRIP, uw.token)).status, 403);
  });
});

test('what a trip is credited with: the window, the country, the cedants named, the currency', async () => {
  await withServer(async (api) => {
    const led = await ledAccount(api);
    const ref = led.placement.reference;
    const stranger = await cedant(api, 'Stranger Cedant');   // on the register in GB, nothing on the book

    const byCountry = (await trip(api, TRIP)).body;                                       // no cedant named: the country's accounts
    const late = (await trip(api, { ...TRIP, start_date: '2026-06-01', end_date: '2026-06-03' })).body; // after the inception
    const inEur = (await trip(api, { ...TRIP, cost_amount: 1500, cost_currency: 'EUR' })).body;      // cost in another currency
    const wrongCedant = (await trip(api, { ...TRIP, cedant_ids: [stranger.id] })).body;             // a cedant with no account

    const gb = (await view(api, 'country', 'GB')).body;
    const byId = new Map(gb.visits.map((v) => [v.id, v]));
    assert.deepEqual(byId.get(byCountry.id).attributed.map((a) => a.reference), [ref]);
    assert.equal(byId.get(byCountry.id).roi.roi_pct, 1150);
    assert.deepEqual(byId.get(late.id).attributed, []);
    assert.equal(byId.get(late.id).roi.roi_pct, -100);
    assert.equal(byId.get(inEur.id).roi.roi_pct, null, 'no FX rate, so no ratio across currencies');
    assert.deepEqual(byId.get(inEur.id).roi.unconverted, { USD: 100_000 });
    assert.deepEqual(byId.get(wrongCedant.id).attributed, []);
    // The scope total: four trips, the one account counted once, the ratio per cost currency.
    assert.equal(gb.roi.trips, 4);
    assert.equal(gb.roi.accounts, 1);
    assert.deepEqual(gb.roi.cost, { total: 25_500, by_currency: { USD: 24_000, EUR: 1500 } });
    assert.deepEqual(gb.roi.by_currency, [
      { currency: 'USD', cost: 24_000, return: 100_000, net: 76_000, roi_pct: 316.67 },
      { currency: 'EUR', cost: 1500, return: 0, net: -1500, roi_pct: null },
    ]);
  });
});

test('a trip is its author\'s to correct or remove; an admin may tidy anyone\'s', async () => {
  await withServer(async (api) => {
    const v = (await trip(api, TRIP)).body;
    const path = `${BASE}/visits/${v.id}`;
    assert.equal((await api('PATCH', path, { token: other.token, body: { cost_amount: 1 } })).status, 403);
    assert.equal((await api('DELETE', path, { token: other.token })).status, 403);

    const fixed = await api('PATCH', path, { token: broker.token, body: { cost_amount: 9500, cost_currency: 'gbp', city: 'Leeds', end_date: '2025-11-14' } });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.equal(fixed.body.cost_amount, 9500);
    assert.equal(fixed.body.cost_currency, 'GBP');
    assert.equal(fixed.body.city, 'Leeds');
    assert.equal(fixed.body.end_date, '2025-11-14');
    assert.equal(fixed.body.start_date, '2025-11-10');
    const backwards = await api('PATCH', path, { token: broker.token, body: { end_date: '2025-11-01' } });
    assert.equal(backwards.status, 422);
    const moved = await api('PATCH', path, { token: broker.token, body: { country_code: 'France' } });
    assert.equal(moved.body.country_code, 'FR');
    assert.equal(moved.body.region, 'Europe');

    assert.equal((await api('DELETE', path, { token: admin.token })).status, 204);
    assert.equal((await api('DELETE', path, { token: admin.token })).status, 404);
  });
});

test('notes roll up: a cedant\'s note counts for its country and region, a region\'s for the region alone', async () => {
  await withServer(async (api) => {
    const c = await cedant(api, 'Noted Cedant');   // domiciled GB
    const onCedant = await note(api, { level: 'cedant', cedant_id: c.id, noted_on: '2026-03-01', title: 'Retention', body: 'Retention moving up to 15m.' });
    assert.equal(onCedant.status, 201, JSON.stringify(onCedant.body));
    assert.equal(onCedant.body.cedant_name, 'Noted Cedant');
    assert.equal(onCedant.body.country_code, 'GB');
    assert.equal(onCedant.body.country_name, 'United Kingdom');
    assert.equal(onCedant.body.region, 'Europe');
    assert.equal(onCedant.body.author_name, broker.user.name);
    assert.equal(onCedant.body.noted_on, '2026-03-01');
    const onCountry = (await note(api, { level: 'country', country_code: 'uk', body: 'Motor XL capacity tightening.' })).body;
    assert.equal(onCountry.country_code, 'GB');
    assert.equal(onCountry.region, 'Europe');
    const onRegion = (await note(api, { level: 'region', region: 'europe', body: 'Cat rates softening across the continent.' })).body;
    assert.equal(onRegion.region, 'Europe');
    assert.equal(onRegion.country_code, null);

    const bodies = (rows) => rows.map((n) => n.body).sort();
    const gb = (await api('GET', `${BASE}/notes?${scopeQs('country', 'GB')}`, { token: uw.token })).body;
    assert.deepEqual(bodies(gb), ['Cat rates softening across the continent.', 'Motor XL capacity tightening.', 'Retention moving up to 15m.'],
      'a country reads its own notes, its cedants\' and its region\'s');
    const fr = (await api('GET', `${BASE}/notes?${scopeQs('country', 'FR')}`, { token: uw.token })).body;
    assert.deepEqual(bodies(fr), ['Cat rates softening across the continent.'], 'another country in the region reads the region\'s note only');
    const europe = (await api('GET', `${BASE}/notes?${scopeQs('region', 'Europe')}`, { token: uw.token })).body;
    assert.equal(europe.length, 3);
    const asia = (await api('GET', `${BASE}/notes?${scopeQs('region', 'South Asia')}`, { token: uw.token })).body;
    assert.equal(asia.length, 0);
    const byCedant = (await api('GET', `${BASE}/notes?cedant_id=${c.id}`, { token: uw.token })).body;
    assert.equal(byCedant.length, 1);
    const byLevel = (await api('GET', `${BASE}/notes?${scopeQs('country', 'GB')}&level=country`, { token: uw.token })).body;
    assert.equal(byLevel.length, 1);
    // The scope view carries them, and the map counts them.
    assert.equal((await view(api, 'country', 'GB')).body.notes.length, 3);
    const map = (await api('GET', BASE, { token: broker.token })).body;
    const eu = map.regions.find((x) => x.region === 'Europe');
    assert.equal(eu.notes, 3);
    assert.equal(eu.countries.find((x) => x.code === 'GB').notes, 2, 'the region\'s own note is not a country\'s');
    assert.equal(map.totals.notes, 3);

    // What a note must say.
    assert.equal((await note(api, { level: 'cedant', body: 'no cedant' })).status, 422);
    assert.equal((await note(api, { level: 'country', country_code: 'Narnia', body: 'x' })).status, 422);
    assert.equal((await note(api, { level: 'region', region: 'Atlantis', body: 'x' })).status, 422);
    assert.equal((await note(api, { level: 'country', country_code: 'GB' })).status, 422, 'a note needs text');
    assert.equal((await note(api, { level: 'country', country_code: 'GB', body: 'x' }, uw.token)).status, 403);
  });
});

test('a note can be uploaded: the file is read into the note and remembered by name', async () => {
  await withServer(async (api) => {
    const text = 'Trip report\n\nMet the CEO and the reinsurance manager. Programme renews 1/1.';
    const uploaded = await note(api, {
      level: 'country', country_code: 'GB', file: { filename: 'uk-visit.txt', data: Buffer.from(text).toString('base64') },
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.body, text);
    assert.equal(uploaded.body.attachment_name, 'uk-visit.txt');
    // Typed text and an upload go together, typed first.
    const both = await note(api, {
      level: 'country', country_code: 'GB', body: 'Summary first.', file: { filename: 'more.md', data: Buffer.from('# Detail').toString('base64') },
    });
    assert.equal(both.body.body, 'Summary first.\n\n# Detail');
    const word = await note(api, { level: 'country', country_code: 'GB', file: { filename: 'report.docx', data: Buffer.from('x').toString('base64') } });
    assert.equal(word.status, 422);
    assert.match(word.body.error, /Word documents/);

    // Its author amends it; nobody else does.
    const path = `${BASE}/notes/${uploaded.body.id}`;
    assert.equal((await api('PATCH', path, { token: other.token, body: { title: 'Mine now' } })).status, 403);
    const amended = await api('PATCH', path, { token: broker.token, body: { title: 'UK visit', noted_on: '2026-02-02' } });
    assert.equal(amended.body.title, 'UK visit');
    assert.equal(amended.body.noted_on, '2026-02-02');
    assert.equal(amended.body.body, text, 'the text is untouched');
    assert.equal((await api('DELETE', path, { token: other.token })).status, 403);
    assert.equal((await api('DELETE', path, { token: broker.token })).status, 204);
  });
});

test('a trip\'s notes go with the trip; a note on its own stays', async () => {
  await withServer(async (api) => {
    const v = (await trip(api, TRIP)).body;
    const onTrip = (await note(api, { level: 'country', country_code: 'GB', visit_id: v.id, body: 'Taken on the trip.' })).body;
    assert.equal(onTrip.visit_id, v.id);
    assert.equal(onTrip.visit_purpose, 'Renewal roadshow');
    assert.equal(onTrip.visit_start_date, '2025-11-10');
    await note(api, { level: 'country', country_code: 'GB', body: 'Standing observation.' });
    const withNotes = (await view(api, 'country', 'GB')).body;
    assert.equal(withNotes.visits[0].notes_count, 1);
    const ghost = await note(api, { level: 'country', country_code: 'GB', visit_id: '00000000-0000-0000-0000-000000000001', body: 'x' });
    assert.equal(ghost.status, 404);

    assert.equal((await api('DELETE', `${BASE}/visits/${v.id}`, { token: broker.token })).status, 204);
    const left = (await api('GET', `${BASE}/notes?${scopeQs('country', 'GB')}`, { token: broker.token })).body;
    assert.deepEqual(left.map((n) => n.body), ['Standing observation.']);
  });
});

/** A complete answer, as the live model returns one. */
const ANSWER = {
  headline: 'The UK is Europe\'s largest reinsurance buyer.',
  market_dynamics: [{ topic: 'pricing', detail: 'Property cat rates softened at 1/1/2026.' }],
  cedants: [{ name: 'Aviva', overview: 'Composite insurer.', reinsurance: 'Buys cat XL through Aon.', url: 'https://aviva.com' }],
  regulatory: [{ headline: 'Solvency UK', summary: 'Risk margin reduced.', regulator: 'PRA', effective_date: '2024-12-31', url: 'https://bankofengland.co.uk' }],
  developments: [{ headline: 'Aviva completes Direct Line deal', summary: 'Programmes to merge.', url: 'https://example.com/dl', published_at: '2025-07-01' }],
  opportunities: [{ title: 'Approach Direct Line on the merged motor XL', rationale: 'Programme consolidating at 1/1.' }],
  from_the_desk: 'The desk\'s notes confirm the retention is moving up.',
  citations: [{ title: 'PRA', url: 'https://bankofengland.co.uk' }],
};

test('with no provider the gather fails and writes nothing; with one it stores the brief, folding in the desk\'s notes', async () => {
  await withServer(async (api) => {
    const led = await ledAccount(api);
    await trip(api, { ...TRIP, cedant_ids: [led.placement.cedant_id] });
    await note(api, { level: 'cedant', cedant_id: led.placement.cedant_id, body: 'Retention moving up to 15m.' });
    await note(api, { level: 'region', region: 'Europe', body: 'Cat rates softening.' });

    const failed = await api('POST', `${BASE}/brief/gather`, { token: broker.token, body: { scope_type: 'country', scope_key: 'GB' } });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.code, 'llm_unavailable');
    assert.match(failed.body.error, /No AI provider is configured for internet research/);
    assert.equal((await view(api, 'country', 'GB')).body.brief, null, 'nothing was written');
    assert.equal((await api('POST', `${BASE}/brief/gather`, { token: uw.token, body: { scope_type: 'country', scope_key: 'GB' } })).status, 403);

    // A provider answering: the service stores what came back, unverified.
    let request = null;
    const clients = { openai: async (req) => { request = req; return { data: ANSWER, model: 'gpt-test' }; } };
    const stored = await gather({ type: 'country', key: 'gb' }, broker.user, clients);
    assert.equal(request.schemaName, 'market_brief');
    assert.equal(request.webSearch, true, 'the market is researched on the internet');
    assert.match(request.prompt, /Research the reinsurance market of United Kingdom \(Europe\)/);
    assert.match(request.prompt, new RegExp(led.placement.reference), 'our book rides in the prompt');
    assert.match(request.prompt, /Renewal roadshow/, 'the trips ride in the prompt');
    assert.match(request.prompt, /Retention moving up to 15m\./, 'the cedant\'s note rides in the prompt');
    assert.match(request.prompt, /Cat rates softening\./, 'the region\'s note rides in the country\'s prompt');
    assert.deepEqual(stored.gather, { provider: 'openai', model: 'gpt-test' });
    const b = stored.brief;
    assert.equal(b.scope_key, 'GB');
    assert.equal(b.scope_label, 'United Kingdom');
    assert.equal(b.headline, ANSWER.headline);
    assert.deepEqual(b.market_dynamics, ANSWER.market_dynamics);
    assert.equal(b.regulatory[0].effective_date, '2024-12-31');
    assert.equal(b.from_the_desk, ANSWER.from_the_desk);
    assert.equal(b.notes_used, 2);
    assert.equal(b.visits_used, 1);
    assert.equal(b.verified, false, 'gathered content lands unverified');
    assert.equal(b.gathered_by, broker.user.id);
    assert.equal(b.gathered_by_name, broker.user.name);

    // On the screen, and on the map.
    const shown = (await view(api, 'country', 'GB')).body.brief;
    assert.equal(shown.id, b.id);
    const map = (await api('GET', BASE, { token: broker.token })).body;
    const row = map.regions.find((x) => x.region === 'Europe').countries.find((c) => c.code === 'GB');
    assert.equal(row.brief.verified, false);
    assert.equal(map.totals.briefs, 1);

    // Checked against its sources and signed off; a fresh gather is unverified again.
    const verified = await api('POST', `${BASE}/brief/${b.id}/verify`, { token: uw.token });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.verified, true);
    assert.equal(verified.body.verified_by, uw.user.id);
    assert.equal(verified.body.verified_by_name, uw.user.name);
    const again = await gather({ type: 'country', key: 'GB' }, broker.user, clients);
    assert.equal(again.brief.id, b.id, 'one brief per scope, replaced in place');
    assert.equal(again.brief.verified, false);
    assert.equal((await api('POST', `${BASE}/brief/00000000-0000-0000-0000-000000000001/verify`, { token: uw.token })).status, 404);
  });
});
