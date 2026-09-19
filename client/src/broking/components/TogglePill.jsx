// TogglePill — the Universe `toggle-group` with arrow-key support (roving tabindex).
import { useRef } from 'react';

export default function TogglePill({ options, value, onChange, ariaLabel, disabled = false, size }) {
  const refs = useRef([]);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const move = (delta) => {
    const next = (idx + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  const onKeyDown = (e) => {
    if (disabled) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); onChange(options[0].value); refs.current[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); onChange(options[options.length - 1].value); refs.current[options.length - 1]?.focus(); }
  };
  return (
    <span className={`ab-toggle${size ? ` ${size}` : ''}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o, i) => (
        <button key={String(o.value)} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={i === idx}
          tabIndex={i === idx ? 0 : -1} className={i === idx ? 'is-on' : ''} disabled={disabled} onClick={() => onChange(o.value)}
          onKeyDown={onKeyDown}>
          {o.label}
        </button>
      ))}
    </span>
  );
}
