// Table-cell inputs for the layer tables: money (comma grouped, whole currency),
// rate (Universe RateInput: 6 significant figures on blur), pct, derived, select.
import PctInput from '../../components/PctInput';
import { fmtComma, stripDigits, fmtPctMaybe } from '../lib/format';

export function MoneyCell({ value, onChange, disabled, readOnly, pasteField, label, placeholder = '—' }) {
  return (
    <input className={`ab-cell${readOnly ? ' is-derived' : ''}`} type="text" inputMode="numeric" value={fmtComma(value)} placeholder={placeholder}
      onChange={(e) => onChange?.(stripDigits(e.target.value))} readOnly={readOnly} tabIndex={readOnly ? -1 : undefined} disabled={disabled}
      data-paste-field={pasteField || undefined} aria-label={label} aria-readonly={readOnly || undefined} />
  );
}

export function RateCell({ value, onChange, pasteField, label, disabled }) {
  return (
    <PctInput className="ab-cell w-s" placeholder="—%" value={value} onChange={onChange} disabled={disabled}
      onBlur={() => { const n = parseFloat(String(value ?? '').replace(/%/g, '')); if (Number.isFinite(n)) onChange(String(parseFloat(n.toPrecision(6)))); }}
      data-paste-field={pasteField || undefined} aria-label={label} title="RATE = Earned Premium ÷ EGNPI (%). Enter e.g. 2.5 for 2.5%" />
  );
}

export function PctCell({ value, onChange, pasteField, label, max = 100, disabled }) {
  return <PctInput className="ab-cell w-s" placeholder="—%" value={value} onChange={onChange} min={0} max={max} disabled={disabled} data-paste-field={pasteField || undefined} aria-label={label} />;
}

/** Derived cell: read-only, dashed, never tabbable. `kind` money | pct (0–1 fraction) | text */
export function DerivedCell({ value, kind = 'money', label, small = false, strong = false }) {
  let text = '';
  if (kind === 'pct') text = typeof value === 'number' ? fmtPctMaybe(value) : (value || '');
  else if (kind === 'text') text = value ?? '';
  else text = value == null || value === '' || Number(value) === 0 ? '' : fmtComma(String(value));
  return <input className={`ab-cell is-derived${small ? ' w-s' : ''}${strong ? ' is-strong' : ''}`} readOnly tabIndex={-1} value={text} placeholder="—" aria-label={label} aria-readonly="true" />;
}

export function SelectCell({ value, onChange, options, label, disabled }) {
  return (
    <select className="ab-cell w-s" value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={label} disabled={disabled}>
      {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );
}

export function CheckCell({ checked, onChange, label, disabled }) {
  return <input type="checkbox" className="ab-check" checked={!!checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} disabled={disabled} />;
}
