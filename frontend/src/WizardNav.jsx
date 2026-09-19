// WizardNav — floating Back/Next dock, ported from the Universe modelling
// tool (client/src/components/WizardNav.jsx). Fixed to the lower right of
// the viewport, it fades out after a short idle gap and returns on any
// activity; CSS keeps it reachable via :hover / :focus-within while faded.
import React, { useEffect, useRef, useState } from 'react';

// How long of an inactivity gap (ms) before the dock fades out. Picked
// to feel responsive: short enough that it gets out of the user's way
// when reading a table, long enough that casual pauses don't flicker.
const IDLE_MS = 2500;

export default function WizardNav({
  onBack, onNext, hasPrev = true, hasNext = true,
  backLabel = null, nextLabel = null,
  nextDisabled = false, nextTitle = '',
  children = null,
}) {
  const [hidden, setHidden] = useState(false);
  const idleTimerRef = useRef(null);

  // Fade the dock out after IDLE_MS of no user activity; any scroll,
  // pointer move, keypress, or touch brings it back.
  useEffect(() => {
    function poke() {
      setHidden(false);
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => setHidden(true), IDLE_MS);
    }
    const events = ['mousemove', 'keydown', 'touchstart', 'wheel', 'scroll'];
    for (const ev of events) window.addEventListener(ev, poke, { passive: true });
    poke(); // start the timer on mount
    return () => {
      clearTimeout(idleTimerRef.current);
      for (const ev of events) window.removeEventListener(ev, poke);
    };
  }, []);

  return (
    <nav
      className={`wizard-dock wizard-dock--autohide${hidden ? ' is-hidden' : ''}`}
      aria-label="Wizard navigation"
    >
      {hasPrev && (
        <button
          type="button"
          className="wizard-dock-btn wizard-dock-btn--back"
          onClick={onBack}
          aria-label={backLabel ? `Go to previous step: ${backLabel}` : 'Go to previous step'}
        >
          <span aria-hidden="true">← </span>{backLabel ? `Back: ${backLabel}` : 'Back'}
        </button>
      )}
      {hasNext && (
        <button
          type="button"
          className="wizard-dock-btn wizard-dock-btn--next"
          onClick={onNext}
          disabled={nextDisabled}
          title={nextTitle}
          aria-label={nextLabel ? `Go to next step: ${nextLabel}` : 'Go to next step'}
        >
          {nextLabel ? `Next: ${nextLabel}` : 'Next'}<span aria-hidden="true"> →</span>
        </button>
      )}
      {children}
    </nav>
  );
}
