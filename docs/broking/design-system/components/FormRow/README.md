# FormRow

The Universe `FR` row: a fixed 160px label column (`label-col`) and the control, at least `row-min` tall. Every field on every capture pane is one FormRow.

**Consumer provides:** `label`, `required`, `missing` (after a save attempt), `disabledReason` and the control as children.

- Required: a `required` asterisk after the label.
- Missing after a save attempt: the control takes the `required` border and the error summary lists "Required: Cedant Name".
- Not applicable for the treaty type: the control is disabled at 50% with the tooltip "Not applicable for this treaty type".
- Derived values use a derived `NumericInput`, never plain text.
