# Button

Labelled actions. `primary` (accent fill, `on-accent` text) for the one forward action per screen — Create contract, Save, Next. `ghost` for secondary actions — Back, Cancel, + Add Layer, Delete Layer. `warn` (amber outline pill, Universe's orange-gloss button) only for "Enter slide manually", "Enter slides manually" and "EPI split" — actions that open a manual-entry modal.

**Consumer provides:** `variant`, `size` (`sm` in table bars), label, `onClick`, `disabled`.

- One primary per screen.
- Never icon-only.
