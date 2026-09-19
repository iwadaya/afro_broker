import React, { useState } from 'react';
import { THEMES, useTheme } from './theme.js';

/**
 * The brand lockup — BROKER·IQ — in the top bar and on the login screen.
 * When the active theme carries a client logo (THEMES[].logo) the logo
 * leads, a thin divider follows and the wordmark closes; every other theme
 * renders the wordmark alone, exactly as it always has. Generic on purpose:
 * the next client theme only adds a logo to its THEMES entry.
 *
 * `size` is "topbar" (a 30px logo in the 72px bar) or "login" (44px). Other
 * props — className, aria-hidden — land on the root, so the callers' own
 * classes (.topbar-brand, .brand-name) and the rules on them keep applying.
 */
export default function BrandLockup({ size = 'topbar', className = '', ...rest }) {
  const key = useTheme();
  const theme = THEMES.find((t) => t.key === key);
  // A logo that fails to load (file not in place, wrong path) falls back to
  // the wordmark alone rather than a broken-image glyph. Keyed by the path so
  // switching to another theme's logo tries afresh.
  const [failed, setFailed] = useState(null);
  const logo = theme?.logo && theme.logo !== failed ? theme.logo : null;

  return (
    <span className={`brand-lockup brand-lockup--${size}${className ? ` ${className}` : ''}`} {...rest}>
      {logo && (
        <>
          <span className={`brand-lockup-logo${theme.logoOnDark ? ' brand-lockup-logo--chip' : ''}`}>
            <img src={logo} alt={theme.logoAlt || ''} decoding="async" onError={() => setFailed(logo)} />
          </span>
          <span className="brand-lockup-divider" aria-hidden="true" />
        </>
      )}
      <span className="brand-lockup-text">BROKER<b>·IQ</b></span>
    </span>
  );
}
