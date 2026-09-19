import React, { useState } from 'react';
import { THEMES, HOUSE_BRAND, useTheme } from './theme.js';
import { HOUSE } from './brand.js';

/**
 * The brand in the top bar and on the login screen: the house logo —
 * Afro-Asian Insurance Services Ltd, broker at Lloyd's (HOUSE_BRAND) — on
 * every screen and every theme. A client theme that carries a logo of its
 * own (THEMES[].logo) shows that instead; a logo that fails to load falls
 * back to the house's name in text rather than a broken-image glyph.
 *
 * `size` is "topbar" (in the 72px bar) or "login" (the card). Other props —
 * className, aria-hidden — land on the root, so the callers' own classes
 * (.topbar-brand, .brand-name) and the rules on them keep applying.
 */
export default function BrandLockup({ size = 'topbar', className = '', ...rest }) {
  const key = useTheme();
  const theme = THEMES.find((t) => t.key === key);
  const brand = theme?.logo ? theme : HOUSE_BRAND;
  const house = brand === HOUSE_BRAND;
  // Keyed by the path so switching to another theme's logo tries afresh.
  const [failed, setFailed] = useState(null);
  const logo = brand.logo && brand.logo !== failed ? brand.logo : null;

  return (
    <span
      className={`brand-lockup brand-lockup--${size}${logo && house ? ' brand-lockup--house' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {logo ? (
        <span className={`brand-lockup-logo${brand.logoOnDark ? ' brand-lockup-logo--chip' : ''}${house ? ' brand-lockup-logo--house' : ''}`}>
          <img src={logo} alt={brand.logoAlt || ''} decoding="async" onError={() => setFailed(logo)} data-testid="brand-logo" />
        </span>
      ) : (
        <span className="brand-lockup-text">{HOUSE}</span>
      )}
    </span>
  );
}
