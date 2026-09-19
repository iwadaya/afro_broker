import { completeJson, llmProviders } from '../lib/llm.js';

/**
 * Market intelligence: the brief on a market — a country, or a region of the
 * reference list — that Portfolio intelligence's Market intelligence screen
 * shows, in six sections:
 *
 *   sector      the insurance and reinsurance sector — gross premium by
 *               segment, the top insurance companies, the local brokers,
 *               mergers and acquisitions in the industry
 *   economy     the economic indicators, and the government and private-
 *               sector projects above USD 50m, approved and in the pipeline
 *   regulation  the regulatory environment and its updates, the capital
 *               regime, fines and findings on industry players, other news
 *   statistics  gross written premium by class and in aggregate, loss ratios
 *               by class for the market and by insurer or reinsurer, the 50
 *               biggest insured risks and projects, the largest reported
 *               losses insured and uninsured
 *   events      catastrophes — flooding, hail, wildfire, earthquake — and
 *               big individual fires, a factory burning down and the like
 *   players     competition among the brokers, the insurers and the
 *               reinsurers, new products, government insurance pools
 *
 * Each section is researched on its own: ChatGPT searches the internet
 * through the Responses API's server-side web search and is constrained to
 * the section's shape below (as the counterparty profile is, marketIntel.js).
 * The six run together and the brief is stored whole, or not at all. The
 * desk's own material rides in every prompt — the accounts on our book in
 * the market, the cedants on our register, the brokers' market visits and
 * the notes they keep on a cedant, a country or a region. That material is
 * first-hand, so the model is told it takes precedence over the press and
 * to say, under each section's `from_the_desk`, what it added there.
 *
 * Nothing the gather returns is authoritative. A brief lands unverified and
 * the UI says so until a person has checked it against the sources. With no
 * key configured the gather fails with `llm_unavailable` (503) rather than
 * inventing a market — there is no fallback.
 */

/* ---- Coercions: what an answer's value becomes in the brief ---- */

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const isoDate = (v) => {
  const m = String(v ?? '').match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
};
const httpUrl = (v) => {
  const s = String(v ?? '').trim();
  return /^https?:\/\//i.test(s) ? s.slice(0, 2000) : null;
};
const arr = (v) => (Array.isArray(v) ? v : []);
const present = (v) => v != null && v !== '';

/*
 * A field: its slot in the strict schema, and how what comes back is coerced
 * into exactly what the brief stores. The schema goes to the API as it is,
 * so the coercion lives beside it rather than in it.
 */
const text = (description, max = 4000) => ({ schema: { type: 'string', description }, coerce: (v) => clip(v, max) || null });
const line = (description) => text(description, 500);
const oneOf = (values, description) => ({
  schema: { type: 'string', enum: values, description },
  coerce: (v) => (values.includes(v) ? v : values.includes('other') ? 'other' : null),
});
const integer = (description) => ({
  schema: { type: ['integer', 'null'], description },
  coerce: (v) => { const n = num(v); return n != null && Number.isInteger(n) ? n : null; },
});
const number = (description) => ({ schema: { type: ['number', 'null'], description }, coerce: num });
const date = (description) => ({
  schema: { type: 'string', description: `${description} ISO date (YYYY-MM-DD), or an empty string.` },
  coerce: isoDate,
});
const url = () => ({ schema: { type: 'string', description: 'The source, or an empty string.' }, coerce: httpUrl });
const currency = () => ({
  schema: { type: 'string', description: 'ISO 4217 code of the figures, or an empty string.' },
  coerce: (v) => clip(v, 8).toUpperCase() || null,
});

/** A list in a section: what to gather, the field a row must have to count, its cap, and its fields. */
const list = (description, { keep, max }, fields) => ({ description, keep, max, fields });

/* ---- The six sections: what each asks for and the shape it comes back in ---- */

const SECTION_SPECS = {
  sector: {
    title: 'Insurance and reinsurance sector',
    ask: 'Report: the sector in a paragraph; its gross written premium by segment and year; the top insurance companies by premium; the local brokers; and the mergers and acquisitions in the insurance and reinsurance industry.',
    summary: 'The insurance and reinsurance sector in 4-6 sentences: the size of the market (gross written premium in the latest published year), its growth, life against non-life, the main lines written, how reinsurance is bought (treaty types, the renewal date, the brokers and lead reinsurers active) and where it is heading.',
    lists: {
      gross_premium: list('Gross written premium of the market by segment and year, latest year first, up to 10 rows: the total, non-life, life, and the reinsurance premium ceded or written locally where published. Absolute units in the currency named, never millions.', { keep: 'amount', max: 10 }, {
        segment: oneOf(['total', 'non_life', 'life', 'reinsurance'], 'Which premium the row is.'),
        year: integer('The year the premium is for.'),
        currency: currency(),
        amount: number('Gross written premium in absolute units, or null when not published.'),
        growth_pct: number('Growth on the year before, in percentage points, or null.'),
        url: url(),
      }),
      top_insurers: list('The top insurance companies in the market by gross written premium, largest first, up to 15. Only companies you can source.', { keep: 'name', max: 15 }, {
        rank: integer('Its rank by premium, or null.'),
        name: line('The company\'s name.'),
        type: oneOf(['non_life', 'life', 'composite', 'reinsurer', 'takaful', 'other'], 'What it writes.'),
        overview: text('Ownership, size, lines written. 1-2 sentences.'),
        gwp: number('Its gross written premium in absolute units, or null.'),
        currency: currency(),
        year: integer('The year the premium is for, or null.'),
        market_share_pct: number('Its share of the market\'s premium, in percentage points, or null.'),
        url: url(),
      }),
      local_brokers: list('The insurance and reinsurance brokers based in the market, largest first, up to 15: the local independents and the local offices of the global networks.', { keep: 'name', max: 15 }, {
        name: line('The broker\'s name.'),
        ownership: line('Local independent, or the network it belongs to (Aon, Marsh, WTW, Gallagher, Howden…), or an empty string.'),
        overview: text('Size, specialisms, notable clients. 1-2 sentences.'),
        url: url(),
      }),
      mergers_acquisitions: list('Mergers and acquisitions in the insurance and reinsurance industry of the market in the last three years, most recent first, up to 12: announced, pending, completed or abandoned.', { keep: 'headline', max: 12 }, {
        headline: line('The deal in a line.'),
        acquirer: line('Who is buying.'),
        target: line('What is being bought.'),
        value: number('The deal value in absolute units, or null when undisclosed.'),
        currency: currency(),
        status: oneOf(['announced', 'pending_approval', 'completed', 'abandoned'], 'Where the deal stands.'),
        date: date('When it was announced or completed.'),
        summary: text('1-3 sentences.'),
        url: url(),
      }),
    },
  },

  economy: {
    title: 'Economic indicators and major projects',
    ask: 'Report: the economy in a paragraph; the headline economic indicators, latest available; and the major government and private-sector projects worth more than USD 50 million, approved and in the pipeline.',
    summary: 'The economy in 3-5 sentences: size and growth, inflation and interest rates, the currency, the sovereign rating, the sectors drawing investment, and what it means for insurance demand.',
    lists: {
      indicators: list('Up to 14 headline economic indicators, latest available, one row each: nominal GDP, real GDP growth, GDP per capita, inflation, the policy interest rate, the exchange rate against the US dollar, unemployment, population, the current account, the fiscal balance, government debt to GDP, foreign direct investment, the sovereign credit rating. Never estimate a figure.', { keep: 'indicator', max: 14 }, {
        indicator: line('The indicator\'s name.'),
        value: number('The figure as a number, or null when it is not numeric (a rating).'),
        unit: line('USD bn, %, per USD, million, or an empty string.'),
        period: line('The period the figure is for: 2025, Q2 2026, Aug 2026.'),
        as_published: line('The figure as the source states it: "USD 74.2bn", "3.1%", "B+ (stable)".'),
        url: url(),
      }),
      projects: list('Major government and private-sector projects in the market worth more than USD 50 million, approved or in the pipeline, largest first, up to 25: infrastructure, energy, mining, industry, real estate, transport, water, telecoms, health, agriculture.', { keep: 'name', max: 25 }, {
        name: line('The project\'s name.'),
        sector: line('energy, transport, mining, real estate, water, telecoms, industry, health, agriculture, other.'),
        sponsor: oneOf(['government', 'private', 'public_private'], 'Who is behind it.'),
        value: number('The project\'s value in absolute units, or null.'),
        currency: currency(),
        status: oneOf(['approved', 'pipeline', 'under_construction'], 'Approved and funded; in the pipeline (planned, tendered, awaiting approval); or under construction.'),
        location: line('Where it is.'),
        summary: text('What it is, who is building it, when. 1-2 sentences.'),
        url: url(),
      }),
    },
  },

  regulation: {
    title: 'Insurance and reinsurance regulation',
    ask: 'Report: the regulatory environment in a paragraph; who regulates; updates to the regulatory environment, recent and pending; the capital regime; fines and findings against industry players; and any other relevant news.',
    summary: 'The regulatory environment in 3-5 sentences: who supervises insurance and reinsurance, the capital regime in force, the rules on cessions, local retention and the use of foreign reinsurers, and what is changing.',
    lists: {
      regulators: list('The bodies that regulate insurance and reinsurance in the market, up to 5.', { keep: 'name', max: 5 }, {
        name: line('The regulator\'s name.'),
        role: line('What it supervises: insurers, reinsurers, brokers, pensions, market conduct.'),
        url: url(),
      }),
      updates: list('Up to 10 updates to the regulatory environment, recent or pending, most consequential for reinsurance first: new laws and regulations, licensing, reinsurance and retention requirements, compulsory covers, tax, sanctions, market conduct.', { keep: 'headline', max: 10 }, {
        headline: line('The change in a line.'),
        summary: text('What it requires and whom it affects. 2-4 sentences.'),
        regulator: line('The regulator or law-maker, or an empty string.'),
        status: oneOf(['in_force', 'pending', 'proposed'], 'In force; enacted but not yet effective; or proposed.'),
        effective_date: date('When it takes effect.'),
        url: url(),
      }),
      capital_regime: list('The capital regime in up to 6 items: the solvency framework in force (risk-based capital, a Solvency II equivalent, a solvency margin), the minimum paid-up capital for insurers, reinsurers and brokers, the solvency ratio required, and any change under way.', { keep: 'headline', max: 6 }, {
        headline: line('The rule in a line.'),
        summary: text('What it requires, with the figures where published. 1-3 sentences.'),
        regulator: line('The regulator, or an empty string.'),
        effective_date: date('When it took or takes effect.'),
        url: url(),
      }),
      enforcement: list('Fines, sanctions and published findings against industry players — insurers, reinsurers, brokers — in the last three years, most recent first, up to 12.', { keep: 'subject', max: 12 }, {
        subject: line('The company the action was against.'),
        action: line('Fine, licence suspension or revocation, public censure, remediation order, finding.'),
        amount: number('The fine in absolute units, or null.'),
        currency: currency(),
        date: date('When it was announced.'),
        regulator: line('Who acted.'),
        summary: text('What was found. 1-3 sentences.'),
        url: url(),
      }),
      other_news: list('Up to 8 other relevant news items on the regulatory environment, dated: consultations, guidance, industry-association positions, court rulings.', { keep: 'headline', max: 8 }, {
        headline: line('The item in a line.'),
        summary: text('1-3 sentences.'),
        published_at: date('When it was published.'),
        url: url(),
      }),
    },
  },

  statistics: {
    title: 'Market statistics',
    ask: 'Report: the statistics in a paragraph; gross written premium by class of business and in aggregate; loss ratios by class, for the market and split by insurer and by reinsurer where published; the 50 biggest insured risks and projects; and the largest reported losses, insured and uninsured.',
    summary: 'The market\'s statistics in 3-5 sentences: total gross written premium and its growth, the largest classes and their share, the loss ratios by class and overall, and where the largest risks and losses sit.',
    lists: {
      gwp_total: list('The market\'s aggregate gross written premium by year, latest first, up to 6 years. Absolute units, never millions.', { keep: 'amount', max: 6 }, {
        year: integer('The year.'),
        currency: currency(),
        amount: number('Gross written premium in absolute units.'),
        growth_pct: number('Growth on the year before, in percentage points, or null.'),
        url: url(),
      }),
      gwp_by_class: list('Gross written premium by class of business for the latest published year and, where available, the year before, up to 30 rows: motor, property, engineering, marine, aviation, liability, accident and health, life, agriculture, credit and bonds, other. Absolute units, never millions.', { keep: 'amount', max: 30 }, {
        class: line('The class of business.'),
        year: integer('The year.'),
        currency: currency(),
        amount: number('Gross written premium in absolute units.'),
        share_pct: number('Its share of the market\'s total, in percentage points, or null.'),
        growth_pct: number('Growth on the year before, in percentage points, or null.'),
        url: url(),
      }),
      loss_ratios: list('Loss ratios by class of business, up to 40 rows: the market as a whole, and split by insurer and by reinsurer where the regulator, the association or the companies publish them. One row per class, year and entity; "All classes" for the aggregate.', { keep: 'loss_ratio_pct', max: 40 }, {
        class: line('The class of business, or "All classes".'),
        year: integer('The year.'),
        entity: line('"Market" for the whole market, or the insurer\'s or reinsurer\'s name.'),
        entity_type: oneOf(['market', 'insurer', 'reinsurer'], 'Whose ratio it is.'),
        loss_ratio_pct: number('Claims incurred over premium earned, in percentage points.'),
        url: url(),
      }),
      top_insured_risks: list('The 50 biggest insured risks and projects in the market, largest sum insured first: power plants, refineries, mines, ports, airports, pipelines, dams, towers, fleets, major construction projects. Only risks you can source — fewer than 50 rather than invented ones.', { keep: 'name', max: 50 }, {
        rank: integer('Its rank by sum insured, or null.'),
        name: line('The risk or project.'),
        type: line('power plant, refinery, mine, port, airport, pipeline, dam, tower, fleet, construction project, other.'),
        owner: line('Who owns or operates it.'),
        sum_insured: number('The sum insured or project value in absolute units, or null.'),
        currency: currency(),
        insurer: line('The lead or fronting insurer, or an empty string.'),
        broker: line('The placing broker, or an empty string.'),
        summary: text('1-2 sentences.'),
        url: url(),
      }),
      largest_losses: list('The largest reported losses in the market in the last five years, largest first, up to 20, with the insured and the uninsured parts where reported.', { keep: 'event', max: 20 }, {
        event: line('The loss in a line.'),
        date: date('When it happened.'),
        type: line('fire, explosion, flood, storm, earthquake, riot, collapse, liability, cyber, other.'),
        insured_loss: number('The insured loss in absolute units, or null.'),
        uninsured_loss: number('The uninsured loss — the economic loss beyond what was insured — in absolute units, or null.'),
        currency: currency(),
        summary: text('1-3 sentences.'),
        url: url(),
      }),
    },
  },

  events: {
    title: 'Events in the market',
    ask: 'Report: the events in a paragraph; the catastrophe events — flooding, hail, wildfire, earthquake, windstorm — of the last five years; and the big individual fires and explosions, a factory burning down and the like.',
    summary: 'The events that have hit the market in 3-5 sentences: the catastrophes of the last five years, the big individual losses, the seasons and perils to watch, and what they did to rates and capacity.',
    lists: {
      catastrophes: list('Catastrophe events in the market in the last five years, most recent first, up to 20: flooding, hail, wildfire, earthquake, windstorm and cyclone, drought, landslide.', { keep: 'event', max: 20 }, {
        event: line('The event in a line.'),
        peril: oneOf(['flood', 'hail', 'wildfire', 'earthquake', 'windstorm', 'cyclone', 'drought', 'landslide', 'other'], 'The peril.'),
        date: date('When it began.'),
        area: line('Where it struck.'),
        insured_loss: number('The insured loss in absolute units, or null.'),
        economic_loss: number('The economic loss in absolute units, or null.'),
        currency: currency(),
        summary: text('What happened and what it cost the insurers. 1-3 sentences.'),
        url: url(),
      }),
      large_fires: list('Big individual fires and explosions in the market in the last five years — a factory burning down, a warehouse, a refinery, a mall, a market — most recent first, up to 20.', { keep: 'event', max: 20 }, {
        event: line('The fire in a line.'),
        date: date('When it happened.'),
        location: line('Where.'),
        occupancy: line('factory, warehouse, refinery, mall, market, hospital, hotel, power plant, other.'),
        insured_loss: number('The insured loss in absolute units, or null.'),
        currency: currency(),
        insurer: line('The insurer or insurers on risk where reported, or an empty string.'),
        summary: text('1-3 sentences.'),
        url: url(),
      }),
    },
  },

  players: {
    title: 'Market players',
    ask: 'Report: the market players in a paragraph; competition among the brokers, the insurers and the reinsurers; new products; and the government insurance pools.',
    summary: 'The competitive landscape in 3-5 sentences: how concentrated the market is, who is gaining and who is losing, the brokers competing for the reinsurance placements, the products coming to market and the pools the state runs.',
    lists: {
      competition: list('Up to 10 points on competition in the market — among the brokers, among the insurers, among the reinsurers writing there: market share and its shifts, new entrants and exits, price competition, consolidation, who leads which segment. Dated where possible.', { keep: 'headline', max: 10 }, {
        among: oneOf(['brokers', 'insurers', 'reinsurers'], 'Whose competition the point is about.'),
        headline: line('The point in a line.'),
        detail: text('2-4 sentences.'),
        url: url(),
      }),
      new_products: list('New insurance and reinsurance products launched in the market in the last two years, most recent first, up to 12: parametric and index covers, takaful, cyber, embedded, microinsurance, new compulsory lines.', { keep: 'product', max: 12 }, {
        product: line('The product.'),
        launched_by: line('Who launched it.'),
        launched_on: date('When.'),
        line_of_business: line('The class of business.'),
        summary: text('What it covers and whom it is for. 1-3 sentences.'),
        url: url(),
      }),
      government_pools: list('Government-run or state-backed insurance pools and schemes in the market, up to 8: catastrophe pools, terrorism pools, agricultural schemes, motor guarantee funds, national reinsurers with compulsory cessions, health schemes.', { keep: 'name', max: 8 }, {
        name: line('The pool or scheme.'),
        purpose: line('The peril or line it covers.'),
        operator: line('Who runs it.'),
        status: oneOf(['operating', 'proposed', 'wound_up'], 'Where it stands.'),
        summary: text('How it works: membership, cessions, capacity. 1-3 sentences.'),
        url: url(),
      }),
    },
  },
};

const SOURCES_SCHEMA = {
  type: 'array',
  description: 'The sources actually used for this section, most authoritative first.',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'url'],
    properties: { title: { type: 'string', description: 'The source\'s title.' }, url: { type: 'string', description: 'Its URL.' } },
  },
};

/** Strict structured outputs: every property required, every object closed. */
function schemaOf(spec) {
  const properties = { summary: { type: 'string', description: spec.summary } };
  for (const [name, l] of Object.entries(spec.lists)) {
    properties[name] = {
      type: 'array',
      description: l.description,
      items: {
        type: 'object',
        additionalProperties: false,
        required: Object.keys(l.fields),
        properties: Object.fromEntries(Object.entries(l.fields).map(([f, kind]) => [f, kind.schema])),
      },
    };
  }
  properties.from_the_desk = {
    type: 'string',
    description: 'What the desk\'s own notes and visits add to or contradict in this section, in a short paragraph. An empty string when none were given or none bear on it.',
  };
  properties.sources = SOURCES_SCHEMA;
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

/** The sections in the order the brief shows them: `{ key, title, lists, schema }`. */
export const SECTIONS = Object.entries(SECTION_SPECS).map(([key, spec]) => ({
  key, title: spec.title, lists: Object.keys(spec.lists), schema: schemaOf(spec),
}));
export const SECTION_KEYS = SECTIONS.map((s) => s.key);

const SYSTEM = [
  "You research (re)insurance markets for a reinsurance broker's market intelligence desk,",
  'one section of a market brief at a time. Search the internet and report only what you',
  'can source. Prefer the regulator\'s own publications, the insurance association\'s',
  'statistics and the insurers\' reports and filings, then rating-agency and broker market',
  'reports, then trade press. Date what you report. Never estimate or invent a figure, a',
  'company, a risk or a rule: leave the field empty rather than fill it. Money is reported',
  'in absolute units in the currency named, never in millions. The desk\'s own material,',
  'where given, is first-hand and takes precedence over the press where the two conflict;',
  'weave it into the section and say under from_the_desk what it added.',
].join(' ');

/** Whether the deployment can serve a gather (ChatGPT configured). */
export function isConfigured() {
  return llmProviders().some((p) => p.configured);
}

/* ---- The prompt: the section, the scope, then the desk's own material ---- */

const MAX_ACCOUNTS = 40;
const MAX_CEDANTS = 60;
const MAX_VISITS = 20;
const MAX_NOTES = 40;
const MAX_NOTE_CHARS = 1500;

const money = (ccy, n) => (n == null ? null : `${ccy || ''} ${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`.trim());

function requireSpec(key) {
  const spec = SECTION_SPECS[key];
  if (!spec) throw new Error(`Not a section of the brief: ${key}`);
  return spec;
}

/**
 * The prompt for one section of one scope. `context` is
 * `{ scope, book: { accounts }, cedants, visits, notes }` — everything the
 * desk holds on the market, already cut to the scope by the service.
 */
export function buildSectionPrompt(key, { scope, book = {}, cedants = [], visits = [], notes = [] }) {
  const spec = requireSpec(key);
  const where = scope.type === 'region'
    ? `the ${scope.label} region — ${scope.countries.map((c) => c.name).join(', ')}`
    : `${scope.label}${scope.region ? ` (${scope.region})` : ''}`;
  const lines = [
    `Research the insurance and reinsurance market of ${where} for the "${spec.title}" section of a market intelligence brief.`,
    spec.ask,
    'Date and source what you report; leave a field empty rather than estimate it.',
  ];

  const accounts = (book.accounts || []).slice(0, MAX_ACCOUNTS);
  lines.push('', `--- OUR BOOK IN THIS MARKET (${(book.accounts || []).length} accounts${(book.accounts || []).length > MAX_ACCOUNTS ? `, ${MAX_ACCOUNTS} shown` : ''}) ---`);
  if (!accounts.length) lines.push('(none)');
  for (const a of accounts) {
    lines.push(`- ${a.reference}: ${a.cedant_name} — ${a.class}${a.treaty_types ? ` (${a.treaty_types})` : ''}, incepting ${String(a.inception).slice(0, 10)}`
      + `${a.total_premium100 ? `, premium ${money(a.currency, a.total_premium100)}` : ''}`
      + `${a.broker_role ? `, we ${a.broker_role.toLowerCase()}` : ''}${a.lead_reinsurer ? `, led by ${a.lead_reinsurer}` : ''}, ${a.status}`);
  }

  const reg = cedants.slice(0, MAX_CEDANTS);
  lines.push('', `--- CEDANTS ON OUR REGISTER IN THIS MARKET (${cedants.length}) ---`);
  lines.push(reg.length ? reg.map((c) => c.name).join('; ') : '(none)');

  const trips = visits.slice(0, MAX_VISITS);
  lines.push('', `--- OUR MARKET VISITS (${visits.length}${visits.length > MAX_VISITS ? `, ${MAX_VISITS} shown` : ''}) ---`);
  if (!trips.length) lines.push('(none)');
  trips.forEach((v, i) => {
    const met = (v.cedants || []).map((c) => c.name).join(', ');
    lines.push(`${i + 1}. ${v.broker_name} — ${v.country_name}${v.city ? `, ${v.city}` : ''}, ${v.start_date} to ${v.end_date}`
      + `${v.purpose ? ` — ${clip(v.purpose, 200)}` : ''}${met ? ` — met: ${met}` : ''}${v.notes ? ` — ${clip(v.notes, MAX_NOTE_CHARS)}` : ''}`);
  });

  const kept = notes.slice(0, MAX_NOTES);
  lines.push('', `--- OUR NOTES (${notes.length}${notes.length > MAX_NOTES ? `, ${MAX_NOTES} most recent shown` : ''}) ---`);
  if (!kept.length) lines.push('(none)');
  kept.forEach((n, i) => {
    const subject = n.level === 'cedant' ? `cedant: ${n.cedant_name}` : n.level === 'country' ? `country: ${n.country_name}` : `region: ${n.region}`;
    lines.push(`${i + 1}. [${subject}] ${n.noted_on}, ${n.author_name}${n.title ? ` — ${clip(n.title, 200)}` : ''}: ${clip(n.body, MAX_NOTE_CHARS)}`);
  });

  return lines.join('\n');
}

/* ---- The answer, coerced into exactly what the section stores ---- */

/**
 * One section as the brief stores it: `{ summary, ...lists, from_the_desk,
 * sources }`, every list holding only rows with the field that makes them a
 * row, capped, every value coerced. An empty or garbled answer gives an
 * empty section rather than a throw.
 */
export function normaliseSection(key, raw = {}) {
  const spec = requireSpec(key);
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { summary: clip(r.summary, 4000) || null };
  for (const [name, l] of Object.entries(spec.lists)) {
    out[name] = arr(r[name])
      .filter((row) => row && typeof row === 'object')
      .map((row) => Object.fromEntries(Object.entries(l.fields).map(([f, kind]) => [f, kind.coerce(row[f])])))
      .filter((row) => present(row[l.keep]))
      .slice(0, l.max);
  }
  out.from_the_desk = clip(r.from_the_desk, 4000) || null;
  out.sources = arr(r.sources)
    .filter((c) => c && httpUrl(c.url))
    .map((c) => ({ title: clip(c.title, 300) || httpUrl(c.url), url: httpUrl(c.url) }))
    .slice(0, 30);
  return out;
}

/** A section with nothing in it: the shape a reader can rely on. */
export const emptySection = (key) => normaliseSection(key, {});

/** The sections' sources as one list, each URL once, in section order. */
export function citationsOf(sections) {
  const seen = new Set();
  return SECTION_KEYS
    .flatMap((k) => sections[k]?.sources || [])
    .filter((c) => c?.url && !seen.has(c.url) && seen.add(c.url))
    .slice(0, 60);
}

/**
 * Research a market: the six sections together, each its own request.
 * Returns `{ sections: { sector, economy, regulation, statistics, events,
 * players }, citations, provider, model, gathered_at }`; throws
 * `LlmUnavailableError` (503) when any section cannot run — the brief is
 * stored whole or not at all. `clients` is the test injection point —
 * production passes nothing.
 */
export async function gatherBrief(context, clients) {
  const gathered = await Promise.all(SECTIONS.map(async (s) => {
    try {
      const { data, provider, model } = await completeJson({
        system: SYSTEM,
        prompt: buildSectionPrompt(s.key, context),
        schema: s.schema,
        schemaName: `market_brief_${s.key}`,
        maxTokens: 24000,
        effort: 'high',
        webSearch: true,
      }, clients);
      return { key: s.key, section: normaliseSection(s.key, data), provider, model };
    } catch (e) {
      // Say which section fell over — unless nothing could run at all.
      if (e.code === 'llm_unavailable' && (e.attempts || []).some((a) => a.status === 'failed')) e.message = `${s.title}: ${e.message}`;
      throw e;
    }
  }));
  const sections = Object.fromEntries(gathered.map((g) => [g.key, g.section]));
  const models = [...new Set(gathered.map((g) => g.model).filter(Boolean))];
  return {
    sections,
    citations: citationsOf(sections),
    provider: gathered[0].provider,
    model: models.join(', ') || null,
    gathered_at: new Date().toISOString(),
  };
}
