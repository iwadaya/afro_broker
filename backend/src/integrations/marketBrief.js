import { completeJson, llmProviders } from '../lib/llm.js';

/**
 * Market intelligence: the brief on a market — a country, or a region of the
 * reference list — that Portfolio intelligence's Market intelligence screen
 * shows: the market in a paragraph, its dynamics, the cedants buying
 * reinsurance in it, regulatory change, dated developments, and what a
 * broker should do next.
 *
 * As with the counterparty profile (marketIntel.js), ChatGPT researches the
 * market on the internet through the Responses API's server-side web search
 * and is constrained to the shape below. What is different here is that the
 * desk's own material rides in the prompt: the accounts on our book in the
 * market, the cedants on our register, the brokers' market visits and the
 * notes they keep on a cedant, a country or a region. That material is
 * first-hand, so the model is told it takes precedence over the press and to
 * say, under `from_the_desk`, what it added.
 *
 * Nothing the gather returns is authoritative. A brief lands unverified and
 * the UI says so until a person has checked it against the sources. With no
 * key configured the gather fails with `llm_unavailable` (503) rather than
 * inventing a market — there is no fallback.
 */

export const TOPICS = ['pricing', 'capacity', 'demand', 'catastrophe', 'losses', 'distribution', 'competition', 'economy', 'other'];

const str = (description) => ({ type: 'string', description });
const item = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties });
const list = (description, items) => ({ type: 'array', description, items });

/** Strict structured outputs: every property required, every object closed. */
export const BRIEF_SCHEMA = item(
  ['headline', 'market_dynamics', 'cedants', 'regulatory', 'developments', 'opportunities', 'from_the_desk', 'citations'],
  {
    headline: str('The market in 3-5 sentences: the size and growth of its insurance market, the main lines written, how reinsurance is bought there (treaty types, the renewal date, the brokers and lead reinsurers active) and where it is heading.'),
    market_dynamics: list(
      'Up to 8 dynamics, each on one topic: rate movement at the last renewals, capacity, demand, catastrophe and loss experience, distribution, competition, the economy. Dated where possible.',
      item(['topic', 'detail'], { topic: { type: 'string', enum: TOPICS }, detail: str('2-4 sentences.') }),
    ),
    cedants: list(
      'Up to 12 of the main cedants — the insurers buying reinsurance in this market — largest first. Only companies you can source.',
      item(['name', 'overview', 'reinsurance', 'url'], {
        name: str('The insurer\'s name.'),
        overview: str('What it is: ownership, size, lines written. 1-3 sentences.'),
        reinsurance: str('What is known of its reinsurance buying: treaty types, renewal date, brokers, lead reinsurers, recent changes. An empty string when nothing is published.'),
        url: str('A source for the company, or an empty string.'),
      }),
    ),
    regulatory: list(
      'Up to 8 regulatory changes, recent or pending, most consequential for reinsurance first: solvency and capital rules, reinsurance and retention requirements, licensing, tax, sanctions.',
      item(['headline', 'summary', 'regulator', 'effective_date', 'url'], {
        headline: str('The change in a line.'),
        summary: str('What it requires and whom it affects. 2-4 sentences.'),
        regulator: str('The regulator or law-maker, or an empty string.'),
        effective_date: str('ISO date (YYYY-MM-DD), or an empty string when not fixed.'),
        url: str('The source, or an empty string.'),
      }),
    ),
    developments: list(
      'Up to 8 recent, dated developments — M&A, entries and exits, large losses, results, programme changes. Omit anything you cannot date and source.',
      item(['headline', 'summary', 'url', 'published_at'], {
        headline: str('The development in a line.'),
        summary: str('1-3 sentences.'),
        url: str('The source, or an empty string.'),
        published_at: str('ISO date (YYYY-MM-DD).'),
      }),
    ),
    opportunities: list(
      'Up to 6 things this broker should do next in the market, most valuable first: cedants to approach, programmes coming up for renewal or restructuring, capacity to bring, a regulatory change to act on.',
      item(['title', 'rationale'], { title: str('The action in a line.'), rationale: str('Why, in 1-3 sentences, citing the dynamic or change behind it.') }),
    ),
    from_the_desk: str('What the desk\'s own notes and visits add to or contradict in the picture above, in a short paragraph. An empty string when none were given.'),
    citations: list('The sources actually used, most authoritative first.', item(['title', 'url'], { title: str('The source\'s title.'), url: str('Its URL.') })),
  },
);

const SYSTEM = [
  "You research (re)insurance markets for a reinsurance broker's market intelligence desk.",
  'Search the internet and report only what you can source. Prefer the regulator\'s own',
  'publications and the insurers\' reports and filings, then rating-agency and broker market',
  'reports, then trade press. Date what you report. Never estimate or invent a figure, a',
  'company or a rule: leave the field empty rather than fill it. The desk\'s own material,',
  'where given, is first-hand and takes precedence over the press where the two conflict;',
  'weave it into the relevant sections and say under from_the_desk what it added.',
].join(' ');

/** Whether the deployment can serve a gather (ChatGPT configured). */
export function isConfigured() {
  return llmProviders().some((p) => p.configured);
}

/* ---- The prompt: the scope, then the desk's own material ---- */

const MAX_ACCOUNTS = 40;
const MAX_CEDANTS = 60;
const MAX_VISITS = 20;
const MAX_NOTES = 40;
const MAX_NOTE_CHARS = 1500;

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const money = (ccy, n) => (n == null ? null : `${ccy || ''} ${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`.trim());

/**
 * The prompt for one scope. `context` is
 * `{ scope, book: { accounts }, cedants, visits, notes }` — everything the
 * desk holds on the market, already cut to the scope by the service.
 */
export function buildBriefPrompt({ scope, book = {}, cedants = [], visits = [], notes = [] }) {
  const where = scope.type === 'region'
    ? `the ${scope.label} region — ${scope.countries.map((c) => c.name).join(', ')}`
    : `${scope.label}${scope.region ? ` (${scope.region})` : ''}`;
  const lines = [
    `Research the reinsurance market of ${where}.`,
    'Report: the market in a paragraph; its dynamics; the main cedants (the insurers buying',
    'reinsurance there) and what is known of each programme; regulatory changes, recent and',
    'pending; dated developments; and what a reinsurance broker should do next there.',
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

/* ---- The answer, coerced into exactly what the brief stores ---- */

const text = (v, n = 4000) => clip(v, n);
const url = (v) => {
  const s = String(v ?? '').trim();
  return /^https?:\/\//i.test(s) ? s.slice(0, 2000) : null;
};
const isoDate = (v) => {
  const m = String(v ?? '').match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
};
const arr = (v) => (Array.isArray(v) ? v : []);

export function normaliseBrief(raw = {}) {
  return {
    headline: text(raw.headline) || '',
    market_dynamics: arr(raw.market_dynamics)
      .filter((d) => d && text(d.detail))
      .map((d) => ({ topic: TOPICS.includes(d.topic) ? d.topic : 'other', detail: text(d.detail) }))
      .slice(0, 12),
    cedants: arr(raw.cedants)
      .filter((c) => c && text(c.name, 300))
      .map((c) => ({ name: text(c.name, 300), overview: text(c.overview) || null, reinsurance: text(c.reinsurance) || null, url: url(c.url) }))
      .slice(0, 20),
    regulatory: arr(raw.regulatory)
      .filter((r) => r && text(r.headline, 500))
      .map((r) => ({
        headline: text(r.headline, 500), summary: text(r.summary) || null, regulator: text(r.regulator, 300) || null,
        effective_date: isoDate(r.effective_date), url: url(r.url),
      }))
      .slice(0, 12),
    developments: arr(raw.developments)
      .filter((d) => d && text(d.headline, 500))
      .map((d) => ({ headline: text(d.headline, 500), summary: text(d.summary) || null, url: url(d.url), published_at: isoDate(d.published_at) }))
      .slice(0, 12),
    opportunities: arr(raw.opportunities)
      .filter((o) => o && text(o.title, 300))
      .map((o) => ({ title: text(o.title, 300), rationale: text(o.rationale) || null }))
      .slice(0, 8),
    from_the_desk: text(raw.from_the_desk) || null,
    citations: arr(raw.citations)
      .filter((c) => c && url(c.url))
      .map((c) => ({ title: text(c.title, 300) || url(c.url), url: url(c.url) }))
      .slice(0, 30),
  };
}

/**
 * Research a market. Returns the normalised brief with `{ provider, model,
 * gathered_at }`; throws `LlmUnavailableError` (503) when it cannot run.
 * `clients` is the test injection point — production passes nothing.
 */
export async function gatherBrief(context, clients) {
  const { data, provider, model } = await completeJson({
    system: SYSTEM,
    prompt: buildBriefPrompt(context),
    schema: BRIEF_SCHEMA,
    schemaName: 'market_brief',
    effort: 'high',
    webSearch: true,
  }, clients);
  return { ...normaliseBrief(data), provider, model, gathered_at: new Date().toISOString() };
}
