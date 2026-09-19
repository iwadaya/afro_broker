// NumericInput — money / pct / derived inputs (design system NumericInput README).
//   money:   comma-grouped integers while typing (Universe CommaInput: fmtComma + stripDigits),
//            decimals truncated, right aligned, currency code suffix.
//   pct:     the Universe PctInput (shows "30%" when idle, bare number while editing,
//            clamped to min/max on blur; defaults 0–100).
//   derived: read-only, dashed, tabIndex -1, recomputed by the caller.
import { useEffect, useState } from 'react';
import PctInput from '../../components/PctInput';
import { fmtComma, stripDigits, fmtPctMaybe } from '../lib/format';

function MoneyInput({ id, value, onChange = () => {}, placeholder, readOnly, disabled, title, className = '', inputRef, ...rest }) {
  const [display, setDisplay] = useState(fmtComma(value));
  useEffect(() => { setDisplay(fmtComma(value)); }, [value]);
  const handleChange = (e) => { const raw = stripDigits(e.target.value); setDisplay(fmtComma(raw)); onChange(raw); };
  return (
    <input id={id} ref={inputRef} className={`ab-in ab-num ${className}`.trim()} type="text" inputMode="numeric" placeholder={placeholder}
      value={display} onChange={handleChange} readOnly={readOnly} disabled={disabled} title={title} {...rest} />
  );
}

export default function NumericInput({
  kind = 'money', value, onChange, currency, min, max, placeholder, disabled, readOnly, title, id, derived = false, format, className = '', inputRef, ...rest
}) {
  const suffix = kind === 'pct' ? null : (currency || null);
  if (derived || kind === 'derived') {
    let text = '';
    if (format === 'pct' || kind === 'pct') text = typeof value === 'number' ? fmtPctMaybe(value) : (value ?? '');
    else text = value == null || value === '' ? '' : fmtComma(String(value));
    return (
      <div className="ab-affix">
        <input id={id} ref={inputRef} className={`ab-in ab-num is-derived ${className}`.trim()} readOnly tabIndex={-1} value={text} placeholder={placeholder ?? ''} title={title} aria-readonly="true" {...rest} />
        {suffix && <span>{suffix}</span>}
      </div>
    );
  }
  if (kind === 'pct') {
    return (
      <PctInput id={id} ref={inputRef} className={`ab-in ab-num ${className}`.trim()} value={value ?? ''} onChange={onChange} placeholder={placeholder ?? '—%'}
        min={min ?? 0} max={max ?? 100} disabled={disabled} readOnly={readOnly} title={title || undefined} {...rest} />
    );
  }
  if (kind === 'number') {
    return (
      <input id={id} ref={inputRef} className={`ab-in ab-num ${className}`.trim()} type="number" min={min ?? 0} max={max} value={value ?? ''} onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder} disabled={disabled} readOnly={readOnly} title={title} {...rest} />
    );
  }
  return (
    <div className="ab-affix">
      <MoneyInput id={id} inputRef={inputRef} value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} readOnly={readOnly} title={title} className={className} {...rest} />
      {suffix && <span>{suffix}</span>}
    </div>
  );
}
