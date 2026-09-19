import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { Card, useFetch, ErrorBanner, StatusPill, fmtDate, Pct } from '../../components.jsx';
import { summariseTerms, versionTag, useAllVersions, parseJson } from './spine.js';

const OUTCOMES = ['QUOTED', 'DECLINED', 'ALTERNATIVE_QUOTED', 'NO_RESPONSE', 'ABSTAINED'];

/**
 * M6 — what each market said to a submitted version, the outcome first-class.
 *
 * A decline carries its reason (D4); an alternative quote becomes a version of
 * the structure in its own right; and closing the round records NO_RESPONSE
 * against everyone approached but not heard from — an absent row is
 * indistinguishable from never having asked.
 */
export default function ResponsesTab({ shared }) {
  const { versions, loading } = useAllVersions(shared.structures);
  const [versionId, setVersionId] = useState('');

  // Default to the newest submitted version — the one out at market.
  useEffect(() => {
    if (versionId || !versions.length) return;
    const submitted = [...versions].reverse().find((v) => v.status === 'SUBMITTED');
    setVersionId((submitted || versions[versions.length - 1]).id);
  }, [versions, versionId]);

  const version = versions.find((v) => v.id === versionId) || null;

  return (
    <>
      <Card title="Quote responses">
        <label className="field" style={{ maxWidth: 420 }}>
          <span>Submitted version</span>
          <select className="input" value={versionId} onChange={(e) => setVersionId(e.target.value)}>
            {!versionId && <option value="">{loading ? 'Loading…' : '—'}</option>}
            {versions.map((v) => (
              <option key={v.id} value={v.id}>{versionTag(v)}</option>
            ))}
          </select>
        </label>
        {version && (
          <p className="muted small">{summariseTerms(version.basis, version)}</p>
        )}
      </Card>

      {version && (
        <ResponsesFor
          version={version}
          shared={shared}
          onStructureChange={shared.reloadStructures}
        />
      )}
    </>
  );
}

function ResponsesFor({ version, shared, onStructureChange }) {
  const responses = useFetch('GET', `/structure-versions/${version.id}/responses`, [version.id]);
  const [recording, setRecording] = useState(false);

  return (
    <>
      <Card
        title={`Responses to ${versionTag(version)}`}
        actions={shared.canEdit && (
          <button className="small ghost" onClick={() => setRecording(!recording)}>
            {recording ? 'Cancel' : 'Record response'}
          </button>
        )}
      >
        <ErrorBanner error={responses.error} />
        {recording && (
          <RecordResponse
            version={version}
            reinsurers={shared.reinsurers}
            onDone={() => { setRecording(false); responses.reload(); onStructureChange(); }}
          />
        )}
        <table>
          <thead>
            <tr>
              <th>Reinsurer</th><th>Outcome</th><th className="r">Rate</th><th className="r">Line</th>
              <th className="r">Premium</th><th>Validity</th><th>Why declined</th><th>Responded</th>
            </tr>
          </thead>
          <tbody>
            {responses.data?.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.reinsurer_name}</strong>
                  {r.reinsurer_rating && <span className="muted"> {r.reinsurer_rating}</span>}
                </td>
                <td><StatusPill value={r.outcome} /></td>
                <td className="r"><Pct value={r.quoted_rate_pct} /></td>
                <td className="r"><Pct value={r.quoted_line_pct} /></td>
                <td className="r">
                  {r.quoted_premium != null ? `${r.quoted_currency} ${r.quoted_premium}` : '—'}
                </td>
                <td className="muted">{r.validity || '—'}</td>
                <td className="muted">
                  {r.decline_reason_name || '—'}
                  {r.decline_note && <span className="small"> — {r.decline_note}</span>}
                </td>
                <td className="mono" style={{ fontSize: 12.5 }}>
                  {r.responded_at ? fmtDate(r.responded_at, { shortYear: true }) : '—'}
                </td>
              </tr>
            ))}
            {responses.data?.length === 0 && (
              <tr><td colSpan="8" className="muted">No responses recorded against this version.</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {shared.canEdit && (
        <CloseQuoting version={version} shared={shared} onDone={responses.reload} />
      )}
    </>
  );
}

/** One market's answer. What the form asks follows the outcome chosen. */
function RecordResponse({ version, reinsurers, onDone }) {
  const reasons = useFetch('GET', '/decline-reasons');
  const [v, setV] = useState({
    reinsurer_id: '', outcome: 'QUOTED', quoted_rate_pct: '', quoted_line_pct: '',
    quoted_premium: '', quoted_currency: version.terms?.currency || 'USD',
    validity: '', decline_reason_code: '', decline_note: '',
    alternative_terms: JSON.stringify(version.terms_display ?? version.terms ?? {}, null, 2),
    responded_at: '',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = { reinsurer_id: v.reinsurer_id, outcome: v.outcome };
      if (v.responded_at) body.responded_at = v.responded_at;
      if (v.outcome === 'QUOTED' || v.outcome === 'ALTERNATIVE_QUOTED') {
        if (v.quoted_rate_pct !== '') body.quoted_rate_pct = Number(v.quoted_rate_pct);
        if (v.quoted_line_pct !== '') body.quoted_line_pct = Number(v.quoted_line_pct);
        if (v.quoted_premium !== '') {
          body.quoted_premium = v.quoted_premium;
          body.quoted_currency = v.quoted_currency;
        }
        if (v.validity) body.validity = v.validity;
      }
      if (v.outcome === 'DECLINED') {
        body.decline_reason_code = v.decline_reason_code;
        if (v.decline_note) body.decline_note = v.decline_note;
      }
      if (v.outcome === 'ALTERNATIVE_QUOTED') {
        body.alternative_terms = parseJson(v.alternative_terms);
      }
      await api('PUT', `/structure-versions/${version.id}/responses`, body);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="spine-compose">
      <ErrorBanner error={error} />
      <div className="inline-form">
        <label className="field">
          <span>Reinsurer *</span>
          <select className="input" value={v.reinsurer_id} onChange={set('reinsurer_id')} required>
            <option value="" disabled>—</option>
            {reinsurers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Outcome *</span>
          <select className="input" value={v.outcome} onChange={set('outcome')}>
            {OUTCOMES.map((o) => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Responded on</span>
          <input className="input" type="date" value={v.responded_at} onChange={set('responded_at')} />
        </label>
      </div>

      {(v.outcome === 'QUOTED' || v.outcome === 'ALTERNATIVE_QUOTED') && (
        <div className="inline-form">
          <label className="field">
            <span>Rate %</span>
            <input className="input" type="number" step="any" value={v.quoted_rate_pct} onChange={set('quoted_rate_pct')} />
          </label>
          <label className="field">
            <span>Line %</span>
            <input className="input" type="number" step="any" value={v.quoted_line_pct} onChange={set('quoted_line_pct')} />
          </label>
          <label className="field">
            <span>Premium</span>
            <input className="input" value={v.quoted_premium} onChange={set('quoted_premium')} placeholder="1250000.00" />
          </label>
          <label className="field">
            <span>Ccy</span>
            <input className="input" value={v.quoted_currency} onChange={set('quoted_currency')} maxLength={3} style={{ width: 70 }} />
          </label>
          <label className="field">
            <span>Valid until</span>
            <input className="input" value={v.validity} onChange={set('validity')} placeholder="30 days" />
          </label>
        </div>
      )}

      {v.outcome === 'DECLINED' && (
        <div className="inline-form">
          <label className="field">
            <span>Reason (D4) *</span>
            <select className="input" value={v.decline_reason_code} onChange={set('decline_reason_code')} required>
              <option value="" disabled>—</option>
              {reasons.data?.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Note</span>
            <input className="input" value={v.decline_note} onChange={set('decline_note')} />
          </label>
        </div>
      )}

      {v.outcome === 'ALTERNATIVE_QUOTED' && (
        <label className="field">
          <span>The terms they proposed instead * (becomes a version of this structure)</span>
          <textarea className="input" rows={8} value={v.alternative_terms} onChange={set('alternative_terms')} />
        </label>
      )}

      <button type="submit" disabled={busy || !v.reinsurer_id}>{busy ? '…' : 'Record'}</button>
    </form>
  );
}

/**
 * Close the round: everyone this version went to who has not answered is
 * recorded as NO_RESPONSE. The approached list comes from the quoting
 * approaches that actually carried this version — not from memory.
 */
function CloseQuoting({ version, shared, onDone }) {
  const distributions = useFetch('GET', `/contract-years/${shared.yearId}/distributions`, [shared.yearId]);
  const [approached, setApproached] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const sentQuoting = useMemo(
    () => (distributions.data || []).filter((d) => d.stage === 'QUOTING' && d.status !== 'DRAFT'),
    [distributions.data],
  );

  useEffect(() => {
    let alive = true;
    setApproached(null);
    Promise.all(sentQuoting.map((d) => api('GET', `/distributions/${d.id}`)))
      .then((details) => {
        if (!alive) return;
        const ids = new Set();
        for (const d of details) {
          if (!d.versions.some((sv) => sv.id === version.id)) continue;
          for (const r of d.recipients) ids.add(r.reinsurer_id);
        }
        setApproached([...ids]);
      })
      .catch((err) => alive && setError(err));
    return () => { alive = false; };
  }, [sentQuoting, version.id]);

  async function close() {
    setError(null);
    setBusy(true);
    setResult(null);
    try {
      const r = await api('POST', `/structure-versions/${version.id}/close-quoting`, {
        approached_reinsurer_ids: approached,
      });
      setResult(r);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Close the quoting round">
      <ErrorBanner error={error || distributions.error} />
      <p className="muted small">
        Records NO_RESPONSE against every market this version was sent to that has not answered.
        Idempotent, and never overwrites an answer given — the silences are data (M6).
      </p>
      {approached === null && <p className="muted">Working out who was approached…</p>}
      {approached !== null && approached.length === 0 && (
        <p className="muted">This version has not been sent to any market yet.</p>
      )}
      {approached !== null && approached.length > 0 && (
        <button className="small" disabled={busy} onClick={close}>
          {busy ? '…' : `Close — ${approached.length} market${approached.length === 1 ? '' : 's'} approached`}
        </button>
      )}
      {result && (
        <p className="muted small">
          {result.no_response_recorded === 0
            ? 'Everyone approached had already answered — nothing recorded.'
            : `NO_RESPONSE recorded for ${result.no_response_recorded} market${result.no_response_recorded === 1 ? '' : 's'}.`}
        </p>
      )}
    </Card>
  );
}
