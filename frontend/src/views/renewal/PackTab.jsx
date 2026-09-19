import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { StatusPill, ErrorBanner, fmtDate } from '../../components.jsx';
import { useToast } from '../../toast.jsx';
import { PacksPanel, PipelinePanel, DetailsPanel } from './panels.jsx';

/**
 * The placement an uploaded pack belongs to.
 *
 * Analyses are read before a placement necessarily exists, so the link is
 * made here rather than assumed: placements whose cedant matches the one on
 * the analysis are offered first, but the choice is the broker's — a cedant
 * can have several placements in the same season. Once linked, the pack
 * builder on that placement can carry this pack's section coverage.
 */
function PlacementLink({ analysis, placements, cedants, canEdit, onChange }) {
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const linked = analysis.placement;

  const cedantName = (p) => cedants.find((c) => c.id === p.cedant_id)?.name || '—';
  const label = (p) => `${p.reference} · ${cedantName(p)} · ${p.class}`;
  // Same cedant first — that is nearly always the one wanted.
  const target = String(analysis.cedant_name || '').toLowerCase();
  const options = [...placements].sort((x, y) => {
    const m = (p) => (cedantName(p).toLowerCase().includes(target)
      || target.includes(cedantName(p).toLowerCase()) ? 0 : 1);
    return m(x) - m(y) || label(x).localeCompare(label(y));
  });

  const toast = useToast();

  async function set(placementId) {
    setBusy(true);
    setError(null);
    try {
      await api('PUT', `/renewal-analyses/${analysis.id}/placement`, { placement_id: placementId });
      setChoice('');
      onChange();
      const picked = placements.find((p) => p.id === placementId);
      toast(picked ? `Linked to ${picked.reference} — the market stages open on it.` : 'Placement link cleared.');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="blueprint rpa-side">
      <div className="sechead">
        <h3 className="seclabel">Placement</h3>
        {linked && <span className="kicker spacer"><StatusPill value={linked.status} /></span>}
      </div>

      {linked ? (
        <>
          <dl className="rpa-deflist">
            <div>
              <dt>Reference</dt>
              <dd><Link to={`/placements/${linked.id}/pack`}>{linked.reference}</Link></dd>
            </div>
            <div><dt>Cedant</dt><dd>{linked.cedant_name || '—'}</dd></div>
            <div><dt>Class</dt><dd>{linked.class}</dd></div>
            <div>
              <dt>Period</dt>
              <dd>{fmtDate(linked.inception)} – {fmtDate(linked.expiry)} · {linked.currency}</dd>
            </div>
          </dl>
          <p className="muted small">
            The pack builder on this placement can carry the sections this upload supplies.
          </p>
          <div className="rpa-link-actions">
            <Link className="btn btn-secondary btn-sm" to={`/placements/${linked.id}/pack`}>Open pack builder</Link>
            {canEdit && (
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => set(null)}>Unlink</button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="muted small">
            Not linked to a placement. Link it and the pack builder can carry what this upload
            supplies into the pack it cuts.
          </p>
          {canEdit && (
            <div className="rpa-link-pick">
              <label className="field">
                <span>Placement</span>
                <select className="input" value={choice} onChange={(e) => setChoice(e.target.value)}>
                  <option value="">Select a placement…</option>
                  {options.map((p) => <option key={p.id} value={p.id}>{label(p)}</option>)}
                </select>
              </label>
              <button className="btn btn-primary btn-sm" disabled={!choice || busy} onClick={() => set(choice)}>
                {busy ? 'Linking…' : 'Link'}
              </button>
            </div>
          )}
        </>
      )}
      <ErrorBanner error={error} />
    </section>
  );
}

/**
 * 01 Renewal pack — intake and upload. The uploaded-pack screen as it was,
 * framed as the desk's first stage: the packs go in here, the run shows its
 * progress here, and the record is linked to its placement here. A run that
 * finishes moves the desk on to the summary itself.
 */
export default function PackTab({ shared }) {
  const { analysis, role, analysing, placements, cedants, reload } = shared;
  return (
    <div className="rpa-intake-grid">
      <div className="rpa-main">
        {analysing && <PipelinePanel shared={shared} />}
        <PacksPanel shared={shared} />
      </div>
      <aside className="rpa-aside">
        <PlacementLink
          analysis={analysis}
          placements={placements}
          cedants={cedants}
          canEdit={role.canBroke}
          onChange={reload}
        />
        <DetailsPanel shared={shared} />
      </aside>
    </div>
  );
}
