# LayerTable

The Universe NP Structure layer table: one row per XoL layer, 16 columns, sticky LAYER column, live derived columns and a totals row.

**Consumer provides:** `layers`, the programme `deductible` (layer-1 attachment), `mode` (`RISK` | `CAT` | `BOTH` from the treaty type), `currency`, `onChange(layers)`.

- Editable: Limit, Aggregate Limit, EGNPI, Rate %, MDP, No. Reinstatements (—, 1–10, Unlimited), % Reinstatements (0–1000), AAD, AAD Amount (only when AAD is ticked), Risk/Cat (only in BOTH mode).
- Derived (dashed, not tabbable): Deductible / Attachment cascade, Earned Premium = EGNPI × rate / 100, MDP% = MDP / EP, ROL = EP / Limit.
- Totals: sums of limit, aggregate, EP, MDP; max EGNPI; max reinstatements; ROL = Σ(rate × EGNPI) / Σ limit — in `info`.
- `+ Add Layer` appends (max 20); `Delete Layer` removes the last, disabled at 1. No per-row delete.
- A multi-cell Excel paste fills Limit, Aggregate Limit, EGNPI, Rate, MDP, % Reinstatements, AAD Amount in that order.
