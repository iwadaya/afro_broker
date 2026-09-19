import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTIONS, SECTION_KEYS, buildSectionPrompt, normaliseSection, emptySection, citationsOf, gatherBrief,
} from '../../src/integrations/marketBrief.js';

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

/** Every object in a strict schema: closed, and requiring every property it names. */
function assertStrict(schema, path) {
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, `${path} is closed`);
    assert.deepEqual(schema.required, Object.keys(schema.properties), `${path} requires every property`);
    for (const [k, v] of Object.entries(schema.properties)) assertStrict(v, `${path}.${k}`);
  } else if (schema.type === 'array') {
    assertStrict(schema.items, `${path}[]`);
  }
}

test('the brief has six sections, in order, each a strict schema of summary, lists, from_the_desk and sources', () => {
  assert.deepEqual(SECTION_KEYS, ['sector', 'economy', 'regulation', 'statistics', 'events', 'players']);
  for (const s of SECTIONS) {
    assertStrict(s.schema, s.key);
    assert.deepEqual(s.schema.required, ['summary', ...s.lists, 'from_the_desk', 'sources'], `${s.key} is summary, lists, desk, sources`);
    for (const l of s.lists) assert.equal(s.schema.properties[l].type, 'array', `${s.key}.${l} is a list`);
  }
  const lists = Object.fromEntries(SECTIONS.map((s) => [s.key, s.lists]));
  assert.deepEqual(lists, {
    sector: ['gross_premium', 'top_insurers', 'local_brokers', 'mergers_acquisitions'],
    economy: ['indicators', 'projects'],
    regulation: ['regulators', 'updates', 'capital_regime', 'enforcement', 'other_news'],
    statistics: ['gwp_total', 'gwp_by_class', 'loss_ratios', 'top_insured_risks', 'largest_losses'],
    events: ['catastrophes', 'large_fires'],
    players: ['competition', 'new_products', 'government_pools'],
  });
  // Figures are nullable numbers — the model may say "not published", never estimate.
  const risk = SECTIONS.find((s) => s.key === 'statistics').schema.properties.top_insured_risks.items.properties;
  assert.deepEqual(risk.sum_insured.type, ['number', 'null']);
  assert.deepEqual(risk.rank.type, ['integer', 'null']);
  assert.match(SECTIONS.find((s) => s.key === 'statistics').schema.properties.top_insured_risks.description, /50 biggest insured risks/);
  assert.match(SECTIONS.find((s) => s.key === 'economy').schema.properties.projects.description, /USD 50 million/);
});

test('a section prompt names the scope and the section, and carries the book, the register, the visits and the notes', () => {
  const context = {
    scope, book: { accounts: [account] }, cedants: [{ name: 'Grievous Mutual' }, { name: 'Albion Assurance' }],
    visits: [visit], notes: [note(), note({ level: 'country', title: null, body: 'Lloyd\'s syndicates pulling back from UK motor.' })],
  };
  const prompt = buildSectionPrompt('statistics', context);
  assert.match(prompt, /^Research the insurance and reinsurance market of United Kingdom \(Europe\) for the "Market statistics" section of a market intelligence brief\./);
  assert.match(prompt, /gross written premium by class of business and in aggregate; loss ratios by class/);
  assert.match(prompt, /OUR BOOK IN THIS MARKET \(1 accounts\)/);
  assert.match(prompt, /GRV-27-PROP-CAT: Grievous Mutual — Property CAT XL \(XoL\), incepting 2027-01-01, premium USD 4,200,000, we lead, led by Swiss Re, QUOTED/);
  assert.match(prompt, /CEDANTS ON OUR REGISTER IN THIS MARKET \(2\)/);
  assert.match(prompt, /Grievous Mutual; Albion Assurance/);
  assert.match(prompt, /1\. Demo Broker — United Kingdom, London, 2026-10-05 to 2026-10-08 — Renewal roadshow — met: Grievous Mutual — CFO keen to restructure layer 2\./);
  assert.match(prompt, /1\. \[cedant: Grievous Mutual\] 2026-10-06, Demo Broker — Programme: Retention going up to 15m\./);
  assert.match(prompt, /2\. \[country: United Kingdom\] 2026-10-06, Demo Broker: Lloyd's syndicates pulling back from UK motor\./);
  // Each section asks for its own things.
  assert.match(buildSectionPrompt('events', context), /"Events in the market" section.*\n.*flooding, hail, wildfire, earthquake, windstorm/);
  assert.match(buildSectionPrompt('players', context), /government insurance pools/);
  assert.throws(() => buildSectionPrompt('weather', context), /Not a section of the brief/);
});

test('a region prompt lists its countries, and empty material says so', () => {
  const prompt = buildSectionPrompt('sector', { scope: region, book: { accounts: [] }, cedants: [], visits: [], notes: [] });
  assert.match(prompt, /^Research the insurance and reinsurance market of the Europe region — United Kingdom, France for the "Insurance and reinsurance sector" section/);
  assert.equal((prompt.match(/\(none\)/g) || []).length, 4, 'book, register, visits and notes each read (none)');
});

test('the prompt is capped: the most recent notes ride, the rest are counted', () => {
  const notes = Array.from({ length: 45 }, (_, i) => note({ body: `Observation ${i + 1}` }));
  const prompt = buildSectionPrompt('regulation', { scope, book: { accounts: [] }, cedants: [], visits: [], notes });
  assert.match(prompt, /OUR NOTES \(45, 40 most recent shown\)/);
  assert.match(prompt, /Observation 40/);
  assert.doesNotMatch(prompt, /Observation 41/);
});

test('normaliseSection keeps exactly what a section stores and drops what it cannot use', () => {
  const s = normaliseSection('statistics', {
    summary: '  Motor is half the market.  ',
    gwp_total: [
      { year: 2025, currency: 'usd', amount: 1_200_000_000, growth_pct: '4.5', url: 'https://ira.go.ke/stats' },
      { year: 2024, currency: 'USD', amount: null, growth_pct: null, url: '' },   // no figure: not a row
    ],
    gwp_by_class: [{ class: 'Motor', year: '2025', currency: 'USD', amount: 600e6, share_pct: 50, growth_pct: null, url: 'not a url' }],
    loss_ratios: [
      { class: 'Motor', year: 2025, entity: 'Market', entity_type: 'market', loss_ratio_pct: 71.2, url: '' },
      { class: 'Motor', year: 2025, entity: 'Jubilee', entity_type: 'bank', loss_ratio_pct: 68, url: '' },   // not a type the brief knows
      { class: 'Fire', year: 2025, entity: 'Market', entity_type: 'market', loss_ratio_pct: '', url: '' },  // nothing said
    ],
    top_insured_risks: Array.from({ length: 60 }, (_, i) => ({
      rank: i + 1, name: `Risk ${i + 1}`, type: 'power plant', owner: 'KenGen', sum_insured: 1e9 - i, currency: 'USD', insurer: '', broker: '', summary: '', url: '',
    })),
    largest_losses: [{ event: 'Nairobi warehouse fire', date: '2025-03-02T10:00:00Z', type: 'fire', insured_loss: 12e6, uninsured_loss: 3e6, currency: 'USD', summary: 'Total loss.', url: 'https://example.com/fire' }],
    from_the_desk: '',
    sources: [{ title: 'IRA annual report', url: 'https://ira.go.ke/report' }, { title: 'no link', url: '' }],
  });
  assert.equal(s.summary, 'Motor is half the market.');
  assert.deepEqual(s.gwp_total, [{ year: 2025, currency: 'USD', amount: 1_200_000_000, growth_pct: 4.5, url: 'https://ira.go.ke/stats' }]);
  assert.deepEqual(s.gwp_by_class, [{ class: 'Motor', year: 2025, currency: 'USD', amount: 600e6, share_pct: 50, growth_pct: null, url: null }]);
  assert.deepEqual(s.loss_ratios, [
    { class: 'Motor', year: 2025, entity: 'Market', entity_type: 'market', loss_ratio_pct: 71.2, url: null },
    { class: 'Motor', year: 2025, entity: 'Jubilee', entity_type: null, loss_ratio_pct: 68, url: null },
  ]);
  assert.equal(s.top_insured_risks.length, 50, 'the 50 biggest, and no more');
  assert.deepEqual(s.top_insured_risks[0], { rank: 1, name: 'Risk 1', type: 'power plant', owner: 'KenGen', sum_insured: 1e9, currency: 'USD', insurer: null, broker: null, summary: null, url: null });
  assert.deepEqual(s.largest_losses, [{ event: 'Nairobi warehouse fire', date: '2025-03-02', type: 'fire', insured_loss: 12e6, uninsured_loss: 3e6, currency: 'USD', summary: 'Total loss.', url: 'https://example.com/fire' }]);
  assert.equal(s.from_the_desk, null);
  assert.deepEqual(s.sources, [{ title: 'IRA annual report', url: 'https://ira.go.ke/report' }]);

  // An enum with an "other" files the unknown there; a sponsor without one is left unsaid.
  const e = normaliseSection('events', { catastrophes: [{ event: 'Tana floods', peril: 'monsoon', date: '2024-04-20', area: 'Tana River', insured_loss: null, economic_loss: 2e8, currency: 'USD', summary: '', url: '' }] });
  assert.equal(e.catastrophes[0].peril, 'other');
  const ec = normaliseSection('economy', { projects: [{ name: 'LAPSSET', sector: 'transport', sponsor: 'donor', value: 24e9, currency: 'USD', status: 'pipeline', location: 'Lamu', summary: '', url: '' }] });
  assert.equal(ec.projects[0].sponsor, null);
  assert.throws(() => normaliseSection('weather', {}), /Not a section of the brief/);
});

test('an empty or garbled answer gives an empty section, in the shape a reader can rely on', () => {
  for (const s of SECTIONS) {
    for (const raw of [{}, null, 'nonsense', { [s.lists[0]]: 'not a list', summary: 42 }]) {
      const out = normaliseSection(s.key, raw);
      assert.deepEqual(Object.keys(out), ['summary', ...s.lists, 'from_the_desk', 'sources'], `${s.key} keeps its shape`);
      for (const l of s.lists) assert.deepEqual(out[l], [], `${s.key}.${l} is empty`);
      assert.equal(out.from_the_desk, null);
      assert.deepEqual(out.sources, []);
    }
    assert.deepEqual(emptySection(s.key), normaliseSection(s.key, {}));
  }
  assert.equal(normaliseSection('sector', { summary: 42 }).summary, '42', 'a summary is text');
});

test('citationsOf reads the sections\' sources as one list, each URL once, in section order', () => {
  const sections = {
    sector: { sources: [{ title: 'IRA', url: 'https://ira.go.ke' }, { title: 'AKI', url: 'https://akinsure.com' }] },
    regulation: { sources: [{ title: 'IRA again', url: 'https://ira.go.ke' }, { title: 'Gazette', url: 'https://gazette.go.ke' }] },
    players: null,
  };
  assert.deepEqual(citationsOf(sections), [
    { title: 'IRA', url: 'https://ira.go.ke' }, { title: 'AKI', url: 'https://akinsure.com' }, { title: 'Gazette', url: 'https://gazette.go.ke' },
  ]);
});

test('gatherBrief researches each section as its own request and stores the brief whole', async () => {
  const requests = [];
  const clients = {
    openai: async (req) => {
      requests.push(req);
      const key = req.schemaName.replace('market_brief_', '');
      return {
        model: 'gpt-test',
        data: {
          summary: `The ${key} summary.`,
          sources: [{ title: `${key} source`, url: `https://example.com/${key}` }, { title: 'shared', url: 'https://example.com/shared' }],
          ...(key === 'sector' ? { top_insurers: [{ rank: 1, name: 'Jubilee', type: 'composite', overview: '', gwp: 3e8, currency: 'USD', year: 2025, market_share_pct: 12, url: '' }] } : {}),
        },
      };
    },
  };
  const brief = await gatherBrief({ scope, book: { accounts: [] }, cedants: [], visits: [], notes: [] }, clients);
  assert.deepEqual(requests.map((r) => r.schemaName), SECTION_KEYS.map((k) => `market_brief_${k}`));
  for (const r of requests) {
    assert.equal(r.webSearch, true, 'every section is researched on the internet');
    assert.match(r.prompt, /Research the insurance and reinsurance market of United Kingdom \(Europe\)/);
    assert.equal(r.schema.additionalProperties, false);
  }
  assert.deepEqual(Object.keys(brief.sections), SECTION_KEYS);
  assert.equal(brief.sections.sector.summary, 'The sector summary.');
  assert.equal(brief.sections.sector.top_insurers[0].name, 'Jubilee');
  assert.deepEqual(brief.sections.events.catastrophes, []);
  assert.equal(brief.citations.length, 7, 'six section sources and the shared one, once');
  assert.equal(brief.citations[1].url, 'https://example.com/shared');
  assert.equal(brief.provider, 'openai');
  assert.equal(brief.model, 'gpt-test');
  assert.match(brief.gathered_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('a section that cannot be researched fails the whole gather, saying which section', async () => {
  const clients = {
    openai: async (req) => {
      if (req.schemaName === 'market_brief_statistics') throw new Error('rate limited');
      return { model: 'gpt-test', data: {} };
    },
  };
  await assert.rejects(
    gatherBrief({ scope, book: { accounts: [] }, cedants: [], visits: [], notes: [] }, clients),
    (e) => e.code === 'llm_unavailable' && /^Market statistics: ChatGPT could not complete the request: rate limited/.test(e.message),
  );
});
