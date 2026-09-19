# TogglePill

The Universe `toggle-group`: two or more mutually exclusive options in a pill. Used for FIXED COMMISSION / SLIDING SCALE, Loss Participation YES / NO, Triangulations available YES / NO and the business type on Identify.

**Consumer provides:** `options`, `value`, `onChange`. Placed in a pane head when it switches that pane's mode.

- The inactive section of the pane dims to 35% and stops taking input; it is not hidden.
- Arrow keys move between options; the active option is `accent-tint` with an `accent-line` border and `accent-strong` text.
