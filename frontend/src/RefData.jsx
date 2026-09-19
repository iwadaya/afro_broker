import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

/**
 * The reference data behind the Treaty Detail dropdowns, loaded the way the
 * Universe modelling tool's treaty detail loads its lookups — brokers,
 * treaty types, classes of business, and the currency and country ref lists,
 * fetched together, each list empty if its call fails — and held once per
 * sign-in so every dropdown in the app binds to the same rows.
 *
 * Every entry is the tool's lookup row: `{ id, name }` for a broker,
 * `{ id, name, category }` for a treaty type, `{ id, name, code }` for a
 * class of business, a country or a currency. Dropdowns bind by `id`.
 */
const RefDataContext = createContext(null);

const EMPTY = { brokers: [], treatyTypes: [], classes: [], currencies: [], countries: [] };

export function RefDataProvider({ children }) {
  const [state, setState] = useState({ ...EMPTY, ready: false });

  const reload = useCallback(() => {
    let alive = true;
    Promise.all([
      api('GET', '/brokers').catch(() => []),
      api('GET', '/treaty-types').catch(() => []),
      api('GET', '/class-of-business').catch(() => []),
      api('GET', '/ref/lists/currency/items').catch(() => []),
      api('GET', '/ref/lists/country/items').catch(() => []),
    ]).then(([b, t, cl, cur, cty]) => {
      if (!alive) return;
      setState({
        brokers: Array.isArray(b) ? b : [],
        treatyTypes: Array.isArray(t) ? t : [],
        classes: Array.isArray(cl) ? cl : [],
        currencies: Array.isArray(cur) ? cur : [],
        countries: Array.isArray(cty) ? cty : [],
        ready: true,
      });
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => reload(), [reload]);
  const value = useMemo(() => ({ ...state, reload }), [state, reload]);
  return <RefDataContext.Provider value={value}>{children}</RefDataContext.Provider>;
}

/** `{ brokers, treatyTypes, classes, currencies, countries, ready, reload }`. */
export function useRefData() {
  return useContext(RefDataContext) || { ...EMPTY, ready: false, reload: () => {} };
}

/**
 * The row a dropdown value refers to. A value is the row id once picked in a
 * dropdown; a record written before the reference data — or one carrying an
 * entry the list no longer offers — holds the stored code or name instead,
 * which resolves through the row's code and name.
 */
export function entryOf(list, value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  return (list || []).find((e) => String(e.id) === String(value))
    || (list || []).find((e) => (e.code && String(e.code).toLowerCase() === v) || String(e.name).toLowerCase() === v)
    || null;
}

/** What a dropdown value reads as: the row's name, or the stored text itself. */
export function labelOf(list, value, field = 'name') {
  const e = entryOf(list, value);
  return e ? (e[field] ?? e.name) : (value || '');
}

/** The value a <select> holds for a stored value: the row id, or the text as is. */
export function selectValueOf(list, value) {
  return entryOf(list, value)?.id ?? (value || '');
}

/** A stored value the list does not carry stays pickable as itself. */
export function OffListOption({ list, value }) {
  if (!value || entryOf(list, value)) return null;
  return <option value={value}>{value}</option>;
}

/** The rows of a lookup as options, bound by id; optionally grouped. */
export function RefOptions({ list, label = (e) => e.name, groupBy, groupLabel = (g) => g }) {
  if (!groupBy) return (list || []).map((e) => <option key={e.id} value={e.id}>{label(e)}</option>);
  const groups = new Map();
  for (const e of list || []) {
    const g = groupBy(e) || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  return [...groups.entries()].map(([g, entries]) => (
    <optgroup key={g} label={groupLabel(g)}>
      {entries.map((e) => <option key={e.id} value={e.id}>{label(e)}</option>)}
    </optgroup>
  ));
}
