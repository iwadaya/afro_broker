export const number = (value) => Number(value) || 0;
export function currenciesOf(treaties) {
  return [...new Set(treaties.flatMap(t => [t.currency, ...t.premiums.map(p => p.currency)]))].filter(Boolean).sort();
}
export function selectTreaties(treaties, { search = '', currency = '', year = '' } = {}) {
  const q = search.trim().toLowerCase();
  return treaties.filter(t => (!q || [t.reference, t.cedant_name, t.class, t.country].join(' ').toLowerCase().includes(q))
    && (!year || String(t.inception).slice(0, 4) === year)
    && (!currency || t.currency === currency || t.premiums.some(p => p.currency === currency)));
}
export function summarize(treaties, currency = '') {
  const totals = { paid: {}, due: {}, upcoming: {}, reported_amount: {}, pla_amount: {}, adjustment_due: 0, accounts_due: 0, reported_count: 0, pla_count: 0, layers: 0, scheduled_layers: 0 };
  const add = (field, ccy, value) => { totals[field][ccy] = Math.round(((totals[field][ccy] || 0) + number(value)) * 100) / 100; };
  for (const t of treaties) {
    if(t.adjustment_due) totals.adjustment_due += 1;
    for (const p of t.premiums.filter(p => !currency || p.currency === currency)) {
      for (const key of ['paid', 'due', 'upcoming']) add(key, p.currency, p[key]);
      for (const key of ['accounts_due', 'layers', 'scheduled_layers']) totals[key] += number(p[key]);
    }
    if (!currency || currency === t.currency) {
      for (const key of ['reported_amount', 'pla_amount']) add(key, t.currency, t[key]);
      for (const key of ['reported_count', 'pla_count']) totals[key] += number(t[key]);
    }
  }
  return totals;
}
