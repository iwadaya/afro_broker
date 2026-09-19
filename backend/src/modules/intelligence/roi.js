import { moneyBag, round2 } from '../dashboards/portfolioBook.js';

/**
 * The return on a market visit, read from the book.
 *
 * A trip is an investment in a market: it costs what it costs, and what it
 * brings in is the business that follows it. The reading here is deliberately
 * simple and stated on screen: a visit's return is the brokerage expected on
 * the accounts of the cedants met on the trip — or, when none is named, of
 * every cedant in the country visited — incepting from the trip's first day
 * to ATTRIBUTION_MONTHS after its last. Brokerage expected is the book's own
 * figure (our order at the layers' rates, see portfolioBook.js), so an
 * account with no layer yet contributes nothing rather than an estimate.
 *
 * The book holds no FX rates, so the ratio is only ever read in the cost's
 * currency; return in any other currency is reported beside it, unconverted.
 */

/** How long after a trip an account incepting still counts as its return. */
export const ATTRIBUTION_MONTHS = 12;

const pad = (n) => String(n).padStart(2, '0');

/** A date as YYYY-MM-DD: pg hands DATE columns over as local-midnight Dates. */
export function isoDay(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  return String(v).slice(0, 10);
}

/** The day `months` after a day, held to the end of a shorter month. */
export function monthsAfter(day, months) {
  const [y, m, d] = isoDay(day).split('-').map(Number);
  const target = m - 1 + months;
  const dt = new Date(Date.UTC(y, target, d));
  if (dt.getUTCMonth() !== ((target % 12) + 12) % 12) dt.setUTCDate(0);
  return dt.toISOString().slice(0, 10);
}

/**
 * The accounts a visit's return is read from. `countryOf` resolves a
 * cedant's stored domicile to its country ({ code }).
 */
export function attributeAccounts(visit, accounts, countryOf) {
  const from = isoDay(visit.start_date);
  const to = monthsAfter(visit.end_date, ATTRIBUTION_MONTHS);
  const met = new Set((visit.cedants || []).map((c) => c.id));
  return accounts.filter((a) => {
    const inception = isoDay(a.inception);
    if (!inception || inception < from || inception > to) return false;
    if (met.size) return met.has(a.cedant_id);
    return countryOf(a.cedant_country)?.code === visit.country_code;
  });
}

/** The return on one visit, against its cost. */
export function readRoi(cost, accounts) {
  const bag = moneyBag();
  for (const a of accounts) bag.add(a.currency, a.brokerage_expected);
  const ret = bag.value();
  const amount = round2(cost.amount || 0);
  const currency = cost.currency || null;
  const inCurrency = round2(ret.by_currency[currency] || 0);
  const unconverted = Object.fromEntries(Object.entries(ret.by_currency).filter(([ccy]) => ccy !== currency));
  return {
    cost: { amount, currency },
    return: ret,
    return_in_cost_currency: inCurrency,
    unconverted,
    net: round2(inCurrency - amount),
    roi_pct: ratio(amount, inCurrency, Object.keys(unconverted).length > 0),
    accounts: accounts.length,
  };
}

/**
 * The ratio, or null when it cannot honestly be read: no cost to read it
 * against, or a return that exists only in another currency — which is not
 * a loss, just unconvertible. A return of nothing at all is a loss of 100%.
 */
function ratio(cost, back, elsewhere) {
  if (!(cost > 0)) return null;
  if (back === 0 && elsewhere) return null;
  return round2(((back - cost) / cost) * 100);
}

/**
 * Every visit in a scope together: the costs and returns by currency, with
 * an account counted once however many trips it is credited to, and the
 * ratio read in each currency that carries a cost.
 */
export function aggregateRoi(visits) {
  const cost = moneyBag();
  const ret = moneyBag();
  const seen = new Set();
  for (const v of visits) {
    cost.add(v.roi.cost.currency, v.roi.cost.amount);
    for (const a of v.attributed || []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      ret.add(a.currency, a.brokerage_expected);
    }
  }
  const costs = cost.value();
  const returns = ret.value();
  const by_currency = Object.entries(costs.by_currency).map(([currency, spent]) => {
    const back = round2(returns.by_currency[currency] || 0);
    const elsewhere = Object.entries(returns.by_currency).some(([ccy, amt]) => ccy !== currency && amt);
    return { currency, cost: round2(spent), return: back, net: round2(back - spent), roi_pct: ratio(spent, back, elsewhere) };
  });
  return { trips: visits.length, accounts: seen.size, cost: costs, return: returns, by_currency };
}
