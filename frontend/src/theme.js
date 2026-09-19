// Lightweight theme system — ported from the Universe modelling tool
// (client/src/utils/theme.js). Writes data-theme on <html> so themes.css can
// swap the Daylight tokens in styles.css for another Universe palette.
// Persisted in localStorage so the user's choice survives reloads.

import { useEffect, useState } from 'react';
import { HOUSE_ALT } from './brand.js';

const KEY = 'AFRO_ASIAN_THEME_V1';

// A theme may carry a client logo: `logo` is a self-hosted path under
// frontend/public (never a CDN or the client's site), `logoAlt` its alt text.
// BrandLockup then leads with it in the top bar and on the login screen. Set
// `logoOnDark: true` when the artwork is drawn for a dark ground and should
// sit on a --nav chip. Themes without a logo render the wordmark alone.
export const THEMES = [
  { key: 'midnight', label: 'Midnight',  hint: 'Executive dark · mint' },
  { key: 'ocean',    label: 'Ocean',     hint: 'Deep teal · cyan'      },
  { key: 'graphite', label: 'Graphite',  hint: 'Charcoal · violet'     },
  { key: 'sunset',   label: 'Sunset',    hint: 'Aubergine · amber'     },
  { key: 'daylight', label: 'Daylight',  hint: 'Light · emerald'       },
  // Client theme for demonstrations to Maksure Risk Solutions (maksure.co.za).
  {
    key: 'maksure',
    label: 'Maksure',
    hint: 'Client · charcoal & orange',
    logo: '/brand/maksure/logo.png',
    logoAlt: 'Maksure Risk Solutions',
  },
];

// Daylight is the Universe modelling tool's default; the app follows it.
export const DEFAULT_THEME = 'daylight';

// The house brand — Afro-Asian Insurance Services Ltd, broker at Lloyd's —
// leads the lockup on every screen, whatever the theme (themes are palettes;
// the logo is the firm's). A client theme that carries a logo of its own
// (Maksure, for its demonstrations) shows that one instead. Self-hosted under
// frontend/public/brand/afro-asian; see the README there.
export const HOUSE_BRAND = { logo: '/brand/afro-asian/logo.png', logoAlt: HOUSE_ALT };

// The key applied to <html> this session — so the current theme is known even
// where storage is unavailable (private windows, blocked site data).
let applied = null;

export function isTheme(key) {
  return THEMES.some((t) => t.key === key);
}

export function getTheme() {
  if (applied) return applied;
  try {
    const v = window.localStorage.getItem(KEY);
    if (v && isTheme(v)) return v;
  } catch { /* storage unavailable */ }
  return DEFAULT_THEME;
}

export function setTheme(key) {
  if (!isTheme(key)) return;
  try { window.localStorage.setItem(KEY, key); } catch { /* storage unavailable */ }
  applied = key;
  document.documentElement.setAttribute('data-theme', key);
  window.dispatchEvent(new CustomEvent('universe:theme-change', { detail: key }));
}

export function initTheme() {
  // Demo link: /?theme=maksure opens a fresh browser in that theme. A valid
  // key is applied and persisted, then dropped from the URL so the router and
  // any bookmark never carry it. Unknown keys are ignored and left alone.
  let fromUrl = null;
  try {
    const url = new URL(window.location.href);
    const wanted = url.searchParams.get('theme');
    if (wanted && isTheme(wanted)) {
      fromUrl = wanted;
      url.searchParams.delete('theme');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
  } catch { /* no URL or history API — fall through to the persisted theme */ }
  if (fromUrl) {
    setTheme(fromUrl);
  } else {
    applied = getTheme();
    document.documentElement.setAttribute('data-theme', applied);
  }
}

/**
 * The active theme key, kept current across every mount point: subscribes to
 * the change event setTheme dispatches, exactly as ThemeSwitcher does.
 */
export function useTheme() {
  const [current, setCurrent] = useState(getTheme);
  useEffect(() => {
    const handler = (e) => setCurrent(e.detail || getTheme());
    window.addEventListener('universe:theme-change', handler);
    return () => window.removeEventListener('universe:theme-change', handler);
  }, []);
  return current;
}
