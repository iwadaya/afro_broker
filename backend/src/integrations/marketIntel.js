import { completeJson, llmProviders } from '../lib/llm.js';

/**
 * Market intelligence: the group summary shown on a counterparty — market
 * position, latest news and five years of headline financials.
 *
 * Everything on the counterparty profile can be keyed in by hand. This module
 * is the other route: given a counterparty's name and domicile, ask ChatGPT to
 * research it on the internet (server-side web search) and return the same
 * shape the manual forms write, with the sources it used.
 *
 * Nothing it returns is authoritative. Results land with `source: 'ai'` and
 * `verified: false`, and the UI marks them unverified until a human signs them
 * off — a rating or a GWP figure that drives a placement decision has to be
 * confirmed against the primary source.
 *
 * With no key configured the gather fails with `llm_unavailable` (503)
 * rather than returning anything: a stub that invented plausible financials
 * would be indistinguishable from researched ones once stored. There is no
 * fallback — ChatGPT answers, or the gather fails.
 */

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'market_position', 'strategy', 'news', 'financials', 'citations'],
  properties: {
    overview: { type: 'string', description: 'What the group is: ownership, size, lines written, where it operates. 2-4 sentences.' },
    market_position: { type: 'string', description: 'Where it sits in its market: ranking, share, peer group, competitive strengths. 2-4 sentences.' },
    strategy: { type: 'string', description: 'Stated appetite and direction of travel: classes it is growing or exiting, recent M&A. 2-4 sentences.' },
    news: {
      type: 'array',
      description: 'Up to 6 recent, dated news items about this group. Omit anything you cannot date and source.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['headline', 'summary', 'url', 'published_at'],
        properties: {
          headline: { type: 'string' },
          summary: { type: 'string' },
          url: { type: 'string' },
          published_at: { type: 'string', description: 'ISO date (YYYY-MM-DD).' },
        },
      },
    },
    financials: {
      type: 'array',
      description: 'The five most recent full financial years, newest first. Use null for any figure not found — never estimate.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['year', 'currency', 'gwp', 'nwp', 'net_income', 'shareholders_equity',
          'total_assets', 'loss_ratio', 'expense_ratio', 'combined_ratio', 'roe'],
        properties: {
          year: { type: 'integer' },
          currency: { type: 'string', description: 'ISO 4217 code the figures are reported in.' },
          gwp: { type: ['number', 'null'], description: 'Gross written premium, absolute units (not millions).' },
          nwp: { type: ['number', 'null'], description: 'Net written premium, absolute units.' },
          net_income: { type: ['number', 'null'] },
          shareholders_equity: { type: ['number', 'null'] },
          total_assets: { type: ['number', 'null'] },
          loss_ratio: { type: ['number', 'null'], description: 'Percentage points, e.g. 61.4' },
          expense_ratio: { type: ['number', 'null'], description: 'Percentage points.' },
          combined_ratio: { type: ['number', 'null'], description: 'Percentage points.' },
          roe: { type: ['number', 'null'], description: 'Percentage points.' },
        },
      },
    },
    citations: {
      type: 'array',
      description: 'The sources actually used, most authoritative first.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'url'],
        properties: { title: { type: 'string' }, url: { type: 'string' } },
      },
    },
  },
};

const SYSTEM = [
  "You research (re)insurance counterparties for a reinsurance broker's market register.",
  'Search the internet and report only what you can source. Prefer the group\'s own annual',
  'report and regulatory filings, then rating-agency reports, then trade press.',
  'Never estimate, interpolate or carry a figure across years: if a number is not published,',
  'return null for it. If you cannot identify the company with confidence, return empty',
  'strings and empty arrays rather than a profile for a similarly-named entity.',
].join(' ');

/** Whether the deployment can serve a research request (ChatGPT configured). */
export function isConfigured() {
  return llmProviders().some((p) => p.configured);
}

/**
 * Research a counterparty. Returns `{ source, provider, model, gathered_at,
 * overview, market_position, strategy, news[], financials[], citations[] }`.
 * Throws `LlmUnavailableError` (503) when the research cannot run.
 */
export async function gatherProfile(market, { years = 5 } = {}) {
  const who = [market.name, market.group_name && `(part of ${market.group_name})`,
    market.domicile && `domiciled in ${market.domicile}`].filter(Boolean).join(' ');

  const { data, provider, model } = await completeJson({
    system: SYSTEM,
    prompt: [
      `Research the ${market.type || 'reinsurer'} ${who}.`,
      'Return its group overview, market position, strategy, recent news, and the last',
      `${years} full financial years of headline figures, with the sources you used.`,
    ].join(' '),
    schema: PROFILE_SCHEMA,
    schemaName: 'counterparty_profile',
    effort: 'high',
    webSearch: true,
  });

  return { ...normalise(data, years), source: 'ai', provider, model, gathered_at: new Date().toISOString() };
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isoDate(v) {
  if (!v) return null;
  const m = String(v).match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

/** Coerce whatever came back into exactly the columns the register stores. */
function normalise(raw, years) {
  const financials = (Array.isArray(raw.financials) ? raw.financials : [])
    .map((f) => ({
      year: num(f.year),
      currency: (f.currency || 'USD').toUpperCase().slice(0, 8),
      gwp: num(f.gwp),
      nwp: num(f.nwp),
      net_income: num(f.net_income),
      shareholders_equity: num(f.shareholders_equity),
      total_assets: num(f.total_assets),
      loss_ratio: num(f.loss_ratio),
      expense_ratio: num(f.expense_ratio),
      combined_ratio: num(f.combined_ratio),
      roe: num(f.roe),
    }))
    .filter((f) => f.year != null)
    .sort((a, b) => b.year - a.year)
    .slice(0, years);

  return {
    overview: raw.overview || '',
    market_position: raw.market_position || '',
    strategy: raw.strategy || '',
    news: (Array.isArray(raw.news) ? raw.news : [])
      .filter((n) => n && n.headline)
      .map((n) => ({
        headline: String(n.headline).slice(0, 500),
        summary: n.summary || null,
        url: n.url || null,
        published_at: isoDate(n.published_at),
      }))
      .slice(0, 10),
    financials,
    citations: (Array.isArray(raw.citations) ? raw.citations : [])
      .filter((c) => c && c.url)
      .map((c) => ({ title: c.title || c.url, url: c.url }))
      .slice(0, 20),
  };
}
