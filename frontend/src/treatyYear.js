import { useCallback, useEffect, useState } from 'react';

/**
 * Treaty-year context.
 *
 * The backend has no treaty-year parameter, so this is application context
 * rather than a query filter: it scopes the placement set a screen works from,
 * and every module on that screen re-scopes together. A treaty year is named
 * for the year it incepts in — the book renews at 1 January — matching the
 * language the dashboard already uses. "All" is always offered so no data is
 * unreachable behind the selector.
 */
export const ALL_YEARS = 'all';
const STORAGE_KEY = 'biq_treaty_year';

/** The renewal year the book is currently working towards. */
export const RENEWAL_YEAR = new Date().getUTCFullYear() + 1;

export const TREATY_YEARS = [
  ALL_YEARS,
  ...[RENEWAL_YEAR + 1, RENEWAL_YEAR, RENEWAL_YEAR - 1, RENEWAL_YEAR - 2].map(String),
];

/** `1 Jan 2027` — how the book refers to a treaty year. */
export function yearLabel(value) {
  return value === ALL_YEARS ? 'All treaty years' : `1 Jan ${value}`;
}

const listeners = new Set();
let current = read();

function read() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && TREATY_YEARS.includes(stored)) return stored;
  } catch {
    // Storage unavailable — fall through to the default.
  }
  return String(RENEWAL_YEAR);
}

/**
 * Shared treaty-year state. A module-level store rather than a React context so
 * the top bar and every screen stay in step without threading another provider
 * through the shell.
 */
export function useTreatyYear() {
  const [value, setValue] = useState(current);

  useEffect(() => {
    listeners.add(setValue);
    setValue(current);
    return () => { listeners.delete(setValue); };
  }, []);

  const set = useCallback((next) => {
    current = next;
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* non-fatal */ }
    for (const l of listeners) l(next);
  }, []);

  return [value, set];
}

/** True when a record's inception falls inside the selected treaty year. */
export function inTreatyYear(inception, year) {
  if (year === ALL_YEARS || !inception) return true;
  return String(inception).slice(0, 4) === String(year);
}
