import React, { useEffect, useState } from 'react';
import { api, download } from '../../api.js';
import {
  Card, useFetch, ErrorBanner, StatusPill, Pct, fmtStamp, ProgressBar,
} from '../../components.jsx';
import FourEyes from './FourEyes.jsx';

/**
 * M9 — lines against the firm order terms, signing down, the bordereau, and
 * the written-line advices that keep the cedant told as lines arrive.
 *
 * Lines only exist against a FOT version: a share of anything else is a share
 * of terms nobody has agreed. Signing down previews before it applies, an
 * undersubscribed order will not sign without the shortfall being accepted,
 * and every premium figure on this screen is the API's — computed once, in
 * integer minor units, and rendered server-side (§2.6).
 */
export default function LinesTab({ shared }) {
  const withFot = shared.completion.filter((c) => c.fot_version_id);
  const [structureId, setStructureId] = useState('');
  const [linesRev, setLinesRev] = useState(0);

  useEffect(() => {
    if (structureId || !withFot.length) return;
    setStructureId(withFot[0].structure_id);
  }, [withFot, structureId]);

  const current = withFot.find((c) => c.structure_id === structureId) || null;

  return (
    <>
      <Completion completion={shared.completion} />

      {withFot.length === 0 && (
        <p className="muted">
          No structure on this year has firm order terms yet — lines are written against FOT,
          so promote a version first (Structures tab).
        </p>
      )}

      {withFot.length > 0 && (
        <Card title="Lines">
          <label className="field" style={{ maxWidth: 420 }}>
            <span>Structure</span>
            <select className="input" value={structureId} onChange={(e) => setStructureId(e.target.value)}>
              {withFot.map((c) => (
                <option key={c.structure_id} value={c.structure_id}>
                  {c.label} — order {c.order_pct}%
                </option>
              ))}
            </select>
          </label>
          {current && <LinesFor completion={current} shared={shared} onLinesChanged={() => setLinesRev((r) => r + 1)} />}
        </Card>
      )}

      <Bordereau shared={shared} linesRev={linesRev} />
      <Advices shared={shared} />
    </>
  );
}

/** §1.4 / M10 — signed against order, per structure, always derived. */
function Completion({ completion }) {
  if (!completion.length) return null;
  return (
    <Card title="Placement completion">
      <table>
        <thead>
          <tr>
            <th>Structure</th><th className="r">Order</th><th className="r">Written</th>
            <th className="r">Signed</th><th>Of order written</th><th>State</th>
          </tr>
        </thead>
        <tbody>
          {completion.map((c) => (
            <tr key={c.structure_id}>
              <td><strong>{c.label}</strong></td>
              <td className="r"><Pct value={c.order_pct} /></td>
              <td className="r"><Pct value={c.written_total} /></td>
              <td className="r"><Pct value={c.signed_total} /></td>
              <td style={{ minWidth: 160 }}>
                {c.pct_of_order_written != null
                  ? <ProgressBar value={c.pct_of_order_written} label={`${c.label} written against order`} />
                  : <span className="muted">no order</span>}
              </td>
              <td>
                {!c.fot_version_id && <span className="status tone-grey">No FOT</span>}
                {c.fot_version_id && c.oversubscribed && <span className="status tone-amber">Oversubscribed</span>}
                {c.fot_version_id && !c.oversubscribed && c.shortfall > 0 && (
                  <span className="status tone-amber">Short {c.shortfall}%</span>
                )}
                {c.fot_version_id && !c.oversubscribed && c.shortfall === 0 && c.written_total > 0 && (
                  <span className="status tone-green">Placed</span>
                )}
                {c.fot_version_id && c.written_total === 0 && <span className="status tone-grey">No lines</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function LinesFor({ completion, shared, onLinesChanged }) {
  const versionId = completion.fot_version_id;
  const lines = useFetch('GET', `/structure-versions/${versionId}/lines`, [versionId]);
  const preview = useFetch('GET', `/structure-versions/${versionId}/signing/preview`, [versionId]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ reinsurer_id: '', written_pct: '', to_stand: false });
  const [acceptShortfall, setAcceptShortfall] = useState(false);

  const reloadAll = () => { lines.reload(); preview.reload(); shared.reloadCompletion(); onLinesChanged(); };

  async function run(fn) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      reloadAll();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const writeLine = (e) => {
    e.preventDefault();
    run(async () => {
      await api('PUT', `/structure-versions/${versionId}/lines`, {
        reinsurer_id: form.reinsurer_id,
        written_pct: Number(form.written_pct),
        to_stand: form.to_stand,
      });
      setForm({ reinsurer_id: '', written_pct: '', to_stand: false });
    });
  };

  const decline = (reinsurerId) => run(() =>
    api('POST', `/structure-versions/${versionId}/lines/${reinsurerId}/decline`));

  const apply = () => run(() =>
    api('POST', `/structure-versions/${versionId}/signing/apply`,
      acceptShortfall ? { accept_shortfall: true } : {}));

  const p = preview.data;

  return (
    <>
      <ErrorBanner error={error || lines.error || preview.error} />

      {shared.canEdit && (
        <form onSubmit={writeLine} className="inline-form">
          <label className="field">
            <span>Reinsurer *</span>
            <select
              className="input"
              value={form.reinsurer_id}
              onChange={(e) => setForm({ ...form, reinsurer_id: e.target.value })}
              required
            >
              <option value="" disabled>—</option>
              {shared.reinsurers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Written % *</span>
            <input
              className="input"
              type="number"
              step="any"
              min="0"
              max="100"
              value={form.written_pct}
              onChange={(e) => setForm({ ...form, written_pct: e.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>Line to stand (§1.4)</span>
            <input
              type="checkbox"
              checked={form.to_stand}
              onChange={(e) => setForm({ ...form, to_stand: e.target.checked })}
            />
          </label>
          <button type="submit" disabled={busy}>{busy ? '…' : 'Write line'}</button>
        </form>
      )}

      <table>
        <thead>
          <tr>
            <th>Reinsurer</th><th className="r">Written</th><th className="r">Signed</th>
            <th className="r">Signed premium</th><th>Stands</th><th>Status</th>
            {shared.canEdit && <th />}
          </tr>
        </thead>
        <tbody>
          {lines.data?.map((l) => (
            <tr key={l.id}>
              <td>
                <strong>{l.reinsurer_name}</strong>
                {l.rating && <span className="muted"> {l.rating} {l.rating_agency}</span>}
              </td>
              <td className="r"><Pct value={l.written_pct} /></td>
              <td className="r"><Pct value={l.signed_pct} /></td>
              <td className="r">
                {l.premium_signed != null ? `${l.premium_currency} ${l.premium_signed}` : '—'}
              </td>
              <td>{l.to_stand ? 'stands' : '—'}</td>
              <td><StatusPill value={l.status} /></td>
              {shared.canEdit && (
                <td>
                  {l.status !== 'DECLINED' && (
                    <button className="small ghost" disabled={busy} onClick={() => decline(l.reinsurer_id)}>
                      Decline
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
          {lines.data?.length === 0 && (
            <tr><td colSpan={shared.canEdit ? 7 : 6} className="muted">No lines written against this FOT.</td></tr>
          )}
        </tbody>
      </table>

      {p && p.state !== 'EMPTY' && (
        <div className="spine-signing">
          <h4>Signing down</h4>
          <p className="muted small">
            Order {p.order}% · written {p.writtenTotal}% ·{' '}
            {p.state === 'OVERSUBSCRIBED' && `signs down by factor ${p.signingFactor} to ${p.signedTotal}%`}
            {p.state === 'EXACT' && 'exactly placed — everyone signs written'}
            {p.state === 'UNDERSUBSCRIBED' && `undersubscribed — shortfall ${p.shortfall}%`}
            {p.premium && ` · premium at 100%: ${p.premium.currency} ${p.premium.at_hundred}`}
          </p>
          {shared.canEdit && (
            <div className="inline-form">
              {p.state === 'UNDERSUBSCRIBED' && (
                <label className="field">
                  <span>Accept shortfall — firm at written</span>
                  <input
                    type="checkbox"
                    checked={acceptShortfall}
                    onChange={(e) => setAcceptShortfall(e.target.checked)}
                  />
                </label>
              )}
              <button
                className="small"
                disabled={busy || (p.state === 'UNDERSUBSCRIBED' && !acceptShortfall)}
                onClick={apply}
              >
                {busy ? '…' : 'Apply signing'}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** M9 — the written lines bordereau, with the expiring panel from the chain. */
function Bordereau({ shared, linesRev }) {
  // linesRev bumps when a line is written, declined or signed, so the
  // bordereau reflects the panel as it stands rather than as the tab found it.
  const bordereau = useFetch('GET', `/contract-years/${shared.yearId}/bordereau`, [shared.yearId, linesRev]);
  const [error, setError] = useState(null);
  const b = bordereau.data;

  async function exportAs(format) {
    setError(null);
    try {
      await download(`/contract-years/${shared.yearId}/bordereau/export?format=${format}`);
    } catch (err) {
      setError(err);
    }
  }

  if (!b || b.lines.length === 0) return null;

  return (
    <Card
      title="Lines bordereau"
      actions={(
        <>
          <button className="small ghost" onClick={() => exportAs('xlsx')}>Excel</button>
          <button className="small ghost" onClick={() => exportAs('pdf')}>PDF</button>
        </>
      )}
    >
      <ErrorBanner error={error || bordereau.error} />
      {!b.expiring_panel_known && (
        <p className="muted small">
          No linked prior year, so whether a market was on the expiring panel is unknown — shown
          as “—”, not as “no”.
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Structure</th><th>Reinsurer</th><th>Rating</th>
            <th className="r">Written</th><th className="r">Signed</th>
            <th className="r">Signed premium</th><th>Expiring panel</th>
          </tr>
        </thead>
        <tbody>
          {b.lines.map((l) => (
            <tr key={`${l.structure_id}-${l.reinsurer_id}`}>
              <td>{l.structure_label}</td>
              <td><strong>{l.reinsurer_name}</strong></td>
              <td className="muted">{l.rating ? `${l.rating} ${l.rating_agency || ''}` : '—'}</td>
              <td className="r"><Pct value={l.written_pct} /></td>
              <td className="r"><Pct value={l.signed_pct} /></td>
              <td className="r">
                {l.premium_signed != null ? `${l.premium_currency} ${l.premium_signed}` : '—'}
              </td>
              <td>{b.expiring_panel_known ? (l.on_expiring_panel ? 'yes' : 'no') : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/**
 * Written lines advised to the cedant incrementally — each advice a snapshot
 * as at its date, D7-gated on the way out.
 */
function Advices({ shared }) {
  const advices = useFetch('GET', `/contract-years/${shared.yearId}/written-line-advices`, [shared.yearId]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setError(null);
    setBusy(true);
    try {
      await api('POST', `/contract-years/${shared.yearId}/written-line-advices`);
      advices.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Written-line advices to the cedant"
      actions={shared.canEdit && (
        <button className="small ghost" disabled={busy} onClick={create}>
          {busy ? '…' : 'Raise advice (snapshot now)'}
        </button>
      )}
    >
      <ErrorBanner error={error || advices.error} />
      <p className="muted small">
        Each advice snapshots the written percentages as at its date — a line that moves later
        does not rewrite what the cedant was told (M9).
      </p>
      <table>
        <thead>
          <tr><th>Raised</th><th>By</th><th className="r">Lines</th><th>Status</th><th>Four-eyes</th></tr>
        </thead>
        <tbody>
          {advices.data?.map((a) => (
            <tr key={a.id}>
              <td className="mono" style={{ fontSize: 12.5 }}>{fmtStamp(a.created_at)}</td>
              <td>{a.created_by_name || '—'}</td>
              <td className="r">{a.line_count}</td>
              <td><StatusPill value={a.status} /></td>
              <td>
                <FourEyes
                  actionType="written_line_advice"
                  entityType="written_line_advice"
                  entityId={a.id}
                  sendLabel="Send advice"
                  sent={a.status !== 'DRAFT'}
                  sentAt={a.sent_at}
                  onSend={async () => { await api('POST', `/written-line-advices/${a.id}/send`); advices.reload(); }}
                />
              </td>
            </tr>
          ))}
          {advices.data?.length === 0 && (
            <tr><td colSpan="5" className="muted">No advices raised on this year.</td></tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}
