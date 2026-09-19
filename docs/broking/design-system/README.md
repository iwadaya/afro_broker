A reinsurance broking system for capturing treaty contracts. Every contract carries two identifiers — a system **UUID** and the **Lloyd's Unique Market Reference (UMR)** — and is captured through screens modelled on the Universe Treaty Detail and Structure screens, so an underwriter who knows Universe already knows where every field lives.

## What gets built from this system

| Business | Capture path | Screens |
| --- | --- | --- |
| Proportional treaty (Quota Share, QS & Surplus, 1st/2nd/3rd Surplus, Fac Oblig) | Identify → Treaty Detail | `PropTreatyCapture`: the full Universe 2×2 Treaty Detail — Contract Details, Limit Details, Commissions, Loss Participation / EPI / Brokerage & Taxes |
| Non-proportional (Risk XL, CAT XL, Risk & CAT XL, Stop Loss, Aggregate XL) | Identify → Contract Details → Structure | `NpContractDetails` (the Universe Treaty Detail **left pane only**) then `NpStructure` (the Universe layer table) |

The database design is in **Data model**; the step-by-step flow, every field and every rule are in **Capture flow**.

## Content fundamentals

- Labels are Title Case nouns exactly as in Universe: "Treaty Inception Date", "Retention %", "Number of Lines", "Est. GNPI". Do not rename a Universe field.
- Pane titles, the header pill, table headers and badges are UPPERCASE: `CONTRACT DETAILS`, `PROPORTIONAL TREATY: TREATY DETAIL`, `AGGREGATE LIMIT`.
- Always write "UMR" (never "market ref", "MRN" or "slip no."). Always write "UUID" for the system id, and show it only in `uuid` style — nobody types it.
- Percentages are whole numbers with a `%` suffix (`2.5` means 2.5%). Money is comma-grouped integers with the currency code as suffix.
- Messages are one plain sentence that says what to do: "UMR B0621DAR26TR001 is already used by Kenya Re QS 2026 — open it or change the reference." No exclamation marks, no emoji.
- Disabled fields carry the tooltip "Not applicable for this treaty type".

## Visual foundations

- **Colour.** Two themes: Daylight (first, default) and Midnight. Grounds: `bg0` for the page, `surface-solid` for panes, `control-bg` for anything editable, `surface-muted` for anything derived. Green `accent` is the only brand hue: primary actions, the active step, focus. `info` blue is for totals and pipeline states, `warn` amber for "enter manually" actions and soft mismatches, `danger` for errors. `required` marks missing required fields — always pair it with the word "Required" in the error summary, because it is below 3:1 on white.
- **Editable vs derived is the core signal.** Editable: `control-bg`, solid `stroke-soft` border, `shadow-control`. Derived (Retention Amount, Cession Amount, Total Treaty Capacity, UW Year, Earned Premium, MDP%, ROL, deductible cascade): `surface-muted`, dashed border, no shadow, never focusable by Tab.
- **Type.** One sans family (`--font-sans`, Inter) plus `--font-mono` for identifiers. Use `pane-title` for pane heads, `label` for form labels, `input` for values, `table-head` / `table-cell` in the layer table, `umr` for every UMR. Numbers are always tabular and right-aligned.
- **Layout.** Shell = 252px step sidebar + content (`space-6` side padding). Proportional detail is a 2-column grid of panes with `space-5` gaps; NP Contract Details is a single pane at half width beside the Identity pane. Every form row is a 160px label column (`label-col`) plus the control, min height `row-min`.
- **Shape.** Panes `radius-lg` with `shadow-pane` and a `hairline` border; inputs and buttons `radius-md`; table-cell inputs `radius-sm`; toggles, pills and badges `radius-pill`.
- **Focus.** A solid `accent` border plus a 4px `focus` halo on inputs; a 2px solid `accent` outline offset 2px on buttons, toggles and tabs. Both hold 3:1 on `surface-solid` in both themes.
- **Motion.** None beyond 120ms colour/border transitions. Autosave is silent except a small "Draft saved 14:02" in `muted`.

## Interaction rules

- Keyboard first: Tab follows the visual order top-left → bottom-right pane; Enter in the last field of a pane moves to the next pane; Ctrl+S saves; in the layer table arrow keys move between cells and a multi-cell Excel paste fills across in Universe column order.
- Required fields show a `required` asterisk; a missing one gets the `required` border only after the first save attempt, and the sidebar step shows a `required` dot.
- The UMR is validated as the user types (format) and on blur (uniqueness). A contract cannot leave the Identify step without a valid, unused UMR; after that the UMR is read-only in the summary bar and can only be changed by an "Amend UMR" action that is audited.
- Toggles (FIXED COMMISSION / SLIDING SCALE, Loss Participation YES/NO) dim the inactive section to 35% rather than hiding it, so the pane never jumps.

## Iconography

No icon set: Universe uses text, badges and toggles. Keep it that way — status is a `Badge` with a word, actions are labelled buttons. No logo was supplied, so the name is set in plain type.
