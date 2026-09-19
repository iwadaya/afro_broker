# WizardShell

The capture frame: a 252px step sidebar and the content area. Steps are grouped exactly like the capture path — Setup (Identify, Treaty Detail or Contract Details), Structure (NP only), Placement (Documents, Markets — later) — with a status dot per step.

**Consumer provides:** `steps` (`{label, group, state: 'todo' | 'done' | 'missing'}`), `activeStep`, `onNavigate`, and the screen as children.

- Active step: `accent-tint` fill, `accent-strong` text, 3px `accent` inset bar.
- Dot: `stroke` to do, `accent` complete, `required` when a save found missing fields.
- Leaving a step autosaves a draft; navigation is never blocked.
