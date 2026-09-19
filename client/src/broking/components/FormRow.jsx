// FormRow — the Universe `FR`: 160px label column + control, min 36px tall.
// required → asterisk; missing (after a save attempt) → `required` border on the
// control; disabledReason → the control is wrapped with the tooltip
// "Not applicable for this treaty type".
export const NA_TYPE = 'Not applicable for this treaty type';

export default function FormRow({ label, htmlFor, required = false, missing = false, disabledReason = null, hint = null, children }) {
  return (
    <div className={`ab-fr${missing ? ' is-missing' : ''}`}>
      <label htmlFor={htmlFor}>{label}{required && <span className="ab-req" aria-hidden="true">*</span>}</label>
      {disabledReason ? <span title={disabledReason}>{children}</span> : <div>{children}{hint}</div>}
    </div>
  );
}
