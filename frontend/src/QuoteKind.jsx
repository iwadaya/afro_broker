import React from 'react';

/*
 * Lead quote or indication.
 *
 * Every reinsurer the pack goes to at the Quoting Stage is approached for a
 * lead quote, so the markets carry no role. What differs is what a reinsurer
 * gives back on a structure: a lead quote — terms the placement can be built
 * on — or an indication, a steer that must not be mistaken for one. The
 * switch sits on each structure a reinsurer has answered, and the mark
 * follows an indication wherever the quote is read.
 */

export const isIndicative = (quote) => quote?.kind === 'indicative';

const OPTIONS = [['lead', 'Lead quote'], ['indicative', 'Indicative']];

/**
 * The two-way switch on one reinsurer's answer to one structure.
 *
 * @param kind      'lead' | 'indicative' — what it reads as now
 * @param onChange  (kind) => void, called only when it changes
 */
export function QuoteKindToggle({ kind, onChange, disabled, label, size }) {
  const current = kind === 'indicative' ? 'indicative' : 'lead';
  return (
    <span className={`neg-kind-toggle${size === 'mini' ? ' neg-kind-toggle--mini' : ''}`}
      role="group" aria-label={label || 'Lead quote or indication'} data-testid="quote-kind">
      {OPTIONS.map(([value, text]) => (
        <button key={value} type="button" disabled={disabled}
          className={`${current === value ? 'on' : ''}${value === 'indicative' ? ' is-ind' : ''}`}
          aria-pressed={current === value}
          onClick={() => { if (current !== value) onChange?.(value); }}>
          {text}
        </button>
      ))}
    </span>
  );
}

/** The mark on a quote that is an indication only; nothing on a lead quote. */
export function IndicativeTag({ quote, kind, className }) {
  if (!(kind === 'indicative' || isIndicative(quote))) return null;
  return (
    <span className={`neg-kind-tag${className ? ` ${className}` : ''}`} data-testid="indicative-tag"
      title="An indication only — not a lead quote the placement can be built on">
      indicative
    </span>
  );
}
