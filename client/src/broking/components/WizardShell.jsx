// WizardShell — 252px step sidebar (groups → steps with todo / done / missing dots)
// + the content area. Leaving a step never blocks navigation: the caller's
// onNavigate autosaves a draft first.
export default function WizardShell({ steps = [], activeStep, onNavigate, children }) {
  const groups = [];
  for (const s of steps) {
    let g = groups.find((x) => x.label === s.group);
    if (!g) { g = { label: s.group, steps: [] }; groups.push(g); }
    g.steps.push(s);
  }
  return (
    <div className="ab-shell">
      <nav className="ab-side" aria-label="Capture steps">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="ab-side-group">{g.label}</div>
            {g.steps.map((s) => {
              const active = s.key === activeStep;
              return (
                <button key={s.key} type="button" disabled={s.disabled}
                  className={`ab-tab${active ? ' is-active' : ''}${s.state === 'done' ? ' is-done' : ''}${s.state === 'missing' ? ' is-missing' : ''}`}
                  aria-current={active ? 'step' : undefined} title={s.title}
                  onClick={() => { if (!active && !s.disabled) onNavigate?.(s); }}>
                  <span className="ab-dot" aria-hidden="true" />
                  <span>{s.label}</span>
                  {s.state === 'missing' && <span className="ab-help" style={{ margin: '0 0 0 auto' }}>required</span>}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <main className="ab-main" id="broking-main">{children}</main>
    </div>
  );
}
