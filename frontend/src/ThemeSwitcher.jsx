// ThemeSwitcher — ported from the Universe modelling tool. Small dropdown for
// choosing a theme; listens for external changes so multiple mount points
// stay in sync. Lives in the top bar's account menu, styled on the theme's
// own control tokens so it reads on every palette.
import React, { memo, useEffect, useMemo, useState } from 'react';
import { THEMES, getTheme, setTheme } from './theme.js';

function ThemeSwitcher() {
  const [current, setCurrent] = useState(getTheme());

  useEffect(() => {
    const handler = (e) => setCurrent(e.detail || getTheme());
    window.addEventListener('universe:theme-change', handler);
    return () => window.removeEventListener('universe:theme-change', handler);
  }, []);

  const currentTheme = useMemo(
    () => THEMES.find((t) => t.key === current) || THEMES[0],
    [current],
  );

  return (
    <label className="theme-switcher">
      <span className="theme-switcher__swatch" data-theme-key={currentTheme.key} aria-hidden="true" />
      <select
        className="theme-switcher__select"
        value={current}
        onChange={(e) => { setTheme(e.target.value); setCurrent(e.target.value); }}
        aria-label="Theme"
      >
        {THEMES.map((t) => (
          <option key={t.key} value={t.key}>{t.label}</option>
        ))}
      </select>
    </label>
  );
}

export default memo(ThemeSwitcher);
