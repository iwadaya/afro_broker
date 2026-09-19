// "Draft saved 14:02" in muted, "Unsaved changes" in warn, errors in danger.
import { hhmm } from '../lib/format';

export default function SaveStatus({ savedAt, dirty, saving, error }) {
  if (saving) return <span className="ab-saved" data-testid="save-status">Saving…</span>;
  if (error) return <span className="ab-saved is-error" data-testid="save-status">Save failed: {error}</span>;
  if (dirty) return <span className="ab-saved is-dirty" data-testid="save-status">Unsaved changes</span>;
  if (savedAt) return <span className="ab-saved" data-testid="save-status">Draft saved {hhmm(savedAt)}</span>;
  return <span className="ab-saved" data-testid="save-status" />;
}
