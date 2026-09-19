import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRIEF_SCHEMA, TOPICS, buildBriefPrompt, normaliseBrief } from '../../src/integrations/marketBrief.js';

/* The scope the service resolves, and the desk's material it cuts to it. */
const scope = {
  type: 'country', key: 'GB', label: 'United Kingdom', region: 'Europe',
  countries: [{ code: 'GB', name: 'United Kingdom', region: 'Europe' }],
};
const region = {
  type: 'region', key: 'Europe', label: 'Europe', region: 'Europe',
  countries: [{ code: 'GB', name: 'United Kingdom', region: 'Europe' }, { code: 'FR', name: 'France', region: 'Europe' }],
};
const account = {
  reference: 'GRV-27-PROP-CAT', cedant_name: 'Grievous Mutual', class: 'Property CAT XL', treaty_types: 'XoL',
  inception: '2027-01-01', currency: 'USD', total_premium100: 4_200_000, broker_role: 'Lead', lead_reinsurer: 'Swiss Re', status: 'QUOTED',
};
const visit = {
  broker_name: 'Demo Broker', country_name: 'United Kingdom', city: 'London', start_date: '2026-10-05', end_date: '2026-10-08',
  purpose: 'Renewal roadshow', cedants: [{ id: 'c1', name: 'Grievous Mutual' }], notes: 'CFO keen to restructure layer 2.',
};
const note = (over = {}) => ({
  level: 'cedant', cedant_name: 'Grievous Mutual', country_name: 'United Kingdom', region: 'Europe',
  noted_on: '2026-10-06', author_name: 'Demo Broker', title: 'Programme', body: 'Retention going up to 15m.', ...over,
});

test('the brief schema is strict at every level and closes the topics', () => {
  assert.equal(BRIEF_SCHEMA.additionalProperties, false);
  assert.deepEqual(BRIEF_SCHEMA.required, ['headline', 'market_dynamics', 'cedants', 'regulatory', 'developments', 'opportunities', 'from_the_desk', 'citations']);
  for (const key of ['market_dynamics', 'cedants', 'regulatory', 'developments', 'opportunities', 'citations']) {
    const items = BRIEF_SCHEMA.properties[key].items;
    assert.equal(items.additionalProperties, false, `${key} items are closed`);
    assert.deepEqual(items.required, Object.keys(items.properties), `${key} items require every property`);
  }
  assert.deepEqual(BRIEF_SCHEMA.properties.market_dynamics.items.properties.topic.enum, TOPICS);
});

test('the prompt names the scope and carries the book, the register, the visits and the notes', () => {
  const prompt = buildBriefPrompt({
    scope, book: { accounts: [account] }, cedants: [{ name: 'Grievous Mutual' }, { name: 'Albion Assurance' }],
    visits: [visit], notes: [note(), note({ level: 'country', title: null, body: 'Lloyd\'s syndicates pulling back from UK motor.' })],
  });
  assert.match(prompt, /^Research the reinsurance market of United Kingdom \(Europe\)\./);
  assert.match(prompt, /OUR BOOK IN THIS MARKET \(1 accounts\)/);
  assert.match(prompt, /GRV-27-PROP-CAT: Grievous Mutual — Property CAT XL \(XoL\), incepting 2027-01-01, premium USD 4,200,000, we lead, led by Swiss Re, QUOTED/);
  assert.match(prompt, /CEDANTS ON OUR REGISTER IN THIS MARKET \(2\)/);
  assert.match(prompt, /Grievous Mutual; Albion Assurance/);
  assert.match(prompt, /1\. Demo Broker — United Kingdom, London, 2026-10-05 to 2026-10-08 — Renewal roadshow — met: Grievous Mutual — CFO keen to restructure layer 2\./);
  assert.match(prompt, /1\. \[cedant: Grievous Mutual\] 2026-10-06, Demo Broker — Programme: Retention going up to 15m\./);
  assert.match(prompt, /2\. \[country: United Kingdom\] 2026-10-06, Demo Broker: Lloyd's syndicates pulling back from UK motor\./);
});

test('a region prompt lists its countries, and empty material says so', () => {
  const prompt = buildBriefPrompt({ scope: region, book: { accounts: [] }, cedants: [], visits: [], notes: [] });
  assert.match(prompt, /^Research the reinsurance market of the Europe region — United Kingdom, France\./);
  assert.equal((prompt.match(/\(none\)/g) || []).length, 4, 'book, register, visits and notes each read (none)');
});

test('the prompt is capped: the most recent notes ride, the rest are counted', () => {
  const notes = Array.from({ length: 45 }, (_, i) => note({ body: `Observation ${i + 1}` }));
  const prompt = buildBriefPrompt({ scope, book: { accounts: [] }, cedants: [], visits: [], notes });
  assert.match(prompt, /OUR NOTES \(45, 40 most recent shown\)/);
  assert.match(prompt, /Observation 40/);
  assert.doesNotMatch(prompt, /Observation 41/);
});

test('normaliseBrief keeps exactly what the brief stores and drops what it cannot use', () => {
  const b = normaliseBrief({
    headline: '  The UK is the largest reinsurance market in Europe.  ',
    market_dynamics: [
      { topic: 'pricing', detail: 'Rates softened 5-10% at 1/1.' },
      { topic: 'weather', detail: 'Storms.' },   // not a topic the brief knows: filed under other
      { topic: 'capacity', detail: '' },          // nothing said
    ],
    cedants: [
      { name: 'Aviva', overview: 'Composite.', reinsurance: '', url: 'https://aviva.com' },
      { name: '', overview: 'nameless' },
    ],
    regulatory: [{ headline: 'Solvency UK reforms', summary: 'Risk margin cut.', regulator: 'PRA', effective_date: '2024-12-31T00:00:00Z', url: 'not a url' }],
    developments: [{ headline: 'Aviva buys Direct Line', summary: 'Completed.', url: 'https://example.com/x', published_at: 'July 2025' }],
    opportunities: [{ title: 'Approach Direct Line on its motor XL', rationale: 'Programme consolidating.' }],
    from_the_desk: '',
    citations: [{ title: 'PRA', url: 'https://bankofengland.co.uk' }, { title: 'no link', url: '' }],
  });
  assert.equal(b.headline, 'The UK is the largest reinsurance market in Europe.');
  assert.deepEqual(b.market_dynamics, [{ topic: 'pricing', detail: 'Rates softened 5-10% at 1/1.' }, { topic: 'other', detail: 'Storms.' }]);
  assert.deepEqual(b.cedants, [{ name: 'Aviva', overview: 'Composite.', reinsurance: null, url: 'https://aviva.com' }]);
  assert.deepEqual(b.regulatory, [{ headline: 'Solvency UK reforms', summary: 'Risk margin cut.', regulator: 'PRA', effective_date: '2024-12-31', url: null }]);
  assert.deepEqual(b.developments, [{ headline: 'Aviva buys Direct Line', summary: 'Completed.', url: 'https://example.com/x', published_at: null }]);
  assert.deepEqual(b.opportunities, [{ title: 'Approach Direct Line on its motor XL', rationale: 'Programme consolidating.' }]);
  assert.equal(b.from_the_desk, null);
  assert.deepEqual(b.citations, [{ title: 'PRA', url: 'https://bankofengland.co.uk' }]);
});

test('normaliseBrief survives an empty answer', () => {
  const b = normaliseBrief({});
  assert.equal(b.headline, '');
  for (const key of ['market_dynamics', 'cedants', 'regulatory', 'developments', 'opportunities', 'citations']) assert.deepEqual(b[key], []);
  assert.equal(b.from_the_desk, null);
});
