# NumericInput

Money and percent inputs from Universe (`CommaInput`, `PctInput`), plus the derived read-only variant.

**Consumer provides:** `kind` (`money` | `pct`), `value`, `onChange`, `currency` (money suffix), `min`/`max` (pct defaults 0–100; Loss Cap % and % Reinstatements allow 1000), `derived`.

- Money: comma-grouped integers while typing, decimals truncated, right aligned, currency code suffix.
- Percent: whole-number percent (`2.5` = 2.5%), `%` suffix, clamped to min/max on blur.
- Derived: `surface-muted`, dashed border, `tabindex=-1`; recomputed live from its inputs.
