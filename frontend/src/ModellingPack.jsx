// The standardised renewal pack of the modelling data on the Renewal Pack
// tab: an AI analysis of everything entered on the modelling screens (summary,
// highlights, gaps, a read per class of business) and the Excel export — a
// cover, then one sheet per screen per class of business.
import React, { useEffect, useRef, useState } from 'react';
import { api, download } from './api.js';

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

/** Whether an analysis-style call failed because no AI provider is configured. */
const notConfigured = (e) => e.data?.code === 'llm_unavailable' || e.status === 503;
const NOT_CONFIGURED = 'AI analysis is not configured on this server (no OPENAI_API_KEY).';

/**
 * The raw data behind the screens — the cedant's loss runs, premium
 * listings, bordereaux, profiles — and the AI cross-check of every screen
 * against it.
 */
function RawData({ placementId, canEdit, documents, crosscheck, sheets, onChange, onCrosscheck, setNotice, busy, setBusy }) {
  const fileRef = useRef(null);
  const [note, setNote] = useState('');

  const upload = async (file) => {
    if (!file) return;
    setBusy(true); setNotice(null);
    try {
      const content_base64 = await fileToBase64(file);
      await api('POST', `/placements/${placementId}/modelling/documents`, {
        filename: file.name, mime_type: file.type || 'application/octet-stream', content_base64, note: note.trim() || undefined,
      });
      setNote('');
      await onChange();
    } catch (e) { setNotice({ kind: 'error', text: e.message || 'Upload failed' }); }
    finally { setBusy(false); }
  };

  const remove = async (doc) => {
    setBusy(true); setNotice(null);
    try { await api('DELETE', `/placements/${placementId}/modelling/documents/${doc.id}`); await onChange(); }
    catch (e) { setNotice({ kind: 'error', text: e.message || 'Delete failed' }); }
    finally { setBusy(false); }
  };

  const run = async () => {
    setBusy(true); setNotice(null);
    try {
      const r = await api('POST', `/placements/${placementId}/modelling/crosscheck`, {});
      onCrosscheck(r.crosscheck);
      setNotice({ kind: 'ok', text: `Cross-checked with ${r.crosscheck.provider} · ${r.crosscheck.model}` });
    } catch (e) {
      setNotice({ kind: notConfigured(e) ? 'warn' : 'error', text: notConfigured(e) ? `${NOT_CONFIGURED} The raw data stays attached to the placement.` : (e.message || 'Cross-check failed') });
    } finally { setBusy(false); }
  };

  return (
    <section className="mp-raw" data-testid="modelling-raw-data">
      <div className="rp-sub-title">Raw data &amp; AI cross-check</div>
      <p className="rp-input-hint">
        Upload the cedant's source files the screens were built from — loss runs, premium listings, bordereaux, profiles
        (Excel, CSV, PDF). The AI recomputes what it can from them and reports where the screens differ.
      </p>

      {canEdit && (
        <div className="mp-upload">
          <input ref={fileRef} type="file" hidden data-testid="raw-data-file"
            accept=".xlsx,.xls,.xlsm,.csv,.txt,.json,.pdf,.png,.jpg,.jpeg"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; upload(f); }} />
          <input className="np-mini-input mp-upload-note" placeholder="What is it? e.g. 2025 loss run" value={note}
            onChange={(e) => setNote(e.target.value)} maxLength={500} />
          <button type="button" className="np-struct-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            ⤒ Upload raw data
          </button>
          <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={busy || !documents.length || !sheets} onClick={run}
            title={!documents.length ? 'Upload the raw data first' : !sheets ? 'Enter data on the modelling screens first' : 'Cross-check every screen against the raw data'}>
            {crosscheck ? '↻ Re-run cross-check' : '✦ Cross-check with AI'}
          </button>
        </div>
      )}

      {documents.length > 0 ? (
        <table className="rp-table mp-sheets mp-docs">
          <thead><tr><th>File</th><th>Note</th><th>Size</th><th>Uploaded</th>{canEdit && <th />}</tr></thead>
          <tbody>
            {documents.map((d) => (
              <tr key={d.id}>
                <td>{d.filename}</td>
                <td>{d.note || ''}</td>
                <td>{kb(d.size_bytes)}</td>
                <td>{when(d.created_at)}</td>
                {canEdit && <td className="right"><button type="button" className="np-struct-btn mp-doc-remove" disabled={busy} onClick={() => remove(d)}>Remove</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="rp-empty-note">No raw data uploaded yet.</p>}

      {crosscheck && (
        <div className="mp-analysis mp-crosscheck">
          <div className="rp-sub-title">AI cross-check · {crosscheck.provider} {crosscheck.model} · {when(crosscheck.generated_at)}</div>
          <p className="mp-summary">{crosscheck.summary}</p>
          {crosscheck.discrepancies?.length > 0 ? (
            <>
              <div className="rp-sub-title">Discrepancies</div>
              <table className="rp-table mp-sheets mp-disc">
                <thead><tr><th>Severity</th><th>Class</th><th>Screen</th><th>Item</th><th>On screen</th><th>In raw data</th><th>Note</th></tr></thead>
                <tbody>
                  {crosscheck.discrepancies.map((d, i) => (
                    <tr key={i} className={`mp-disc--${d.severity}`}>
                      <td><span className={`pill-mini mp-sev mp-sev--${d.severity}`}>{d.severity}</span></td>
                      <td>{d.class}</td><td>{d.screen}</td><td>{d.item}</td><td>{d.screen_value}</td><td>{d.raw_value}</td><td>{d.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : <p className="rp-empty-note">No discrepancies found between the screens and the raw data.</p>}
          {crosscheck.consistent?.length > 0 && (
            <>
              <div className="rp-sub-title">Consistent with the raw data</div>
              <ul className="mp-list">{crosscheck.consistent.map((h, i) => <li key={i}>{h}</li>)}</ul>
            </>
          )}
          {crosscheck.unverified?.length > 0 && (
            <>
              <div className="rp-sub-title">Not verifiable from the uploads</div>
              <ul className="mp-list">{crosscheck.unverified.map((h, i) => <li key={i}>{h}</li>)}</ul>
            </>
          )}
          {crosscheck.data_quality?.length > 0 && (
            <>
              <div className="rp-sub-title">Data quality</div>
              <ul className="mp-list mp-list--gaps">{crosscheck.data_quality.map((h, i) => <li key={i}>{h}</li>)}</ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

export default function ModellingPack({ placementId, canEdit }) {
  const [pack, setPack] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null); // { kind: 'error' | 'warn' | 'ok', text }

  const load = () => api('GET', `/placements/${placementId}/modelling/pack`)
    .then(setPack)
    .catch((e) => setNotice({ kind: 'error', text: e.message || 'Failed to load the modelling pack' }));

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [placementId]);

  const sheets = (pack?.classes || []).reduce((n, c) => n + c.screens.length, 0);
  const analysis = pack?.analysis;
  const configured = !!(pack?.providers || []).some((p) => p.configured);

  const analyse = async () => {
    setBusy(true); setNotice(null);
    try {
      const r = await api('POST', `/placements/${placementId}/modelling/analysis`, {});
      setPack((p) => ({ ...(p || {}), analysis: r.analysis }));
      setNotice({ kind: 'ok', text: `Analysed with ${r.analysis.provider} · ${r.analysis.model}` });
    } catch (e) {
      setNotice({
        kind: notConfigured(e) ? 'warn' : 'error',
        text: notConfigured(e) ? `${NOT_CONFIGURED} The Excel pack still exports every screen.` : (e.message || 'Analysis failed'),
      });
    } finally { setBusy(false); }
  };

  const exportXlsx = async () => {
    setBusy(true); setNotice(null);
    try { await download(`/placements/${placementId}/modelling/pack.xlsx`); }
    catch (e) { setNotice({ kind: 'error', text: e.message || 'Export failed' }); }
    finally { setBusy(false); }
  };

  return (
    <div className="mp" data-testid="modelling-pack">
      <p className="rp-input-lede">
        The standardised renewal pack of the modelling data: a cover with the placement, the AI summary and the
        cross-check against the raw data, then one sheet per screen per class of business, in the wizards' running order.
      </p>

      <div className="mp-actions">
        {canEdit && (
          <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={busy || !sheets} onClick={analyse}
            title={sheets ? 'Have the AI read every screen and write the summary' : 'Enter data on the modelling screens first'}>
            {busy ? 'Working…' : analysis ? '↻ Re-analyse with AI' : '✦ Analyse with AI'}
          </button>
        )}
        <button type="button" className="np-struct-btn" disabled={busy || !pack} onClick={exportXlsx}
          title="Excel workbook — a cover, then a sheet per screen per class of business">
          ⤓ Excel pack{sheets ? ` (${sheets + 1} sheets)` : ''}
        </button>
        {pack && !configured && !analysis && (
          <span className="rp-input-note rp-input-note--warn">AI provider not configured — the summary needs an OPENAI_API_KEY on the server.</span>
        )}
      </div>

      {notice && <div className={`mp-notice mp-notice--${notice.kind}`}>{notice.text}</div>}

      {analysis ? (
        <section className="mp-analysis">
          <div className="rp-sub-title">AI analysis · {analysis.provider} {analysis.model} · {when(analysis.generated_at)}</div>
          <p className="mp-summary">{analysis.summary}</p>
          {analysis.highlights?.length > 0 && (
            <>
              <div className="rp-sub-title">Highlights</div>
              <ul className="mp-list">{analysis.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul>
            </>
          )}
          {analysis.per_class?.length > 0 && (
            <>
              <div className="rp-sub-title">By class of business</div>
              <dl className="mp-perclass">
                {analysis.per_class.map((p) => (
                  <div key={p.class}><dt>{p.class}</dt><dd>{p.summary}</dd></div>
                ))}
              </dl>
            </>
          )}
          {analysis.data_gaps?.length > 0 && (
            <>
              <div className="rp-sub-title">Data gaps</div>
              <ul className="mp-list mp-list--gaps">{analysis.data_gaps.map((h, i) => <li key={i}>{h}</li>)}</ul>
            </>
          )}
        </section>
      ) : pack && (
        <p className="rp-empty-note">
          {sheets
            ? 'No AI summary yet — run the analysis to have every screen read and summarised on the cover sheet.'
            : 'Nothing entered on the modelling screens yet. The pack fills as the screens are saved.'}
        </p>
      )}

      {pack && (
        <RawData
          placementId={placementId} canEdit={canEdit} documents={pack.documents || []} crosscheck={pack.crosscheck}
          sheets={sheets} busy={busy} setBusy={setBusy} setNotice={setNotice}
          onChange={load}
          onCrosscheck={(crosscheck) => setPack((p) => ({ ...(p || {}), crosscheck }))}
        />
      )}

      {pack && (
        <>
          <div className="rp-sub-title">Sheets in the pack</div>
          <table className="rp-table mp-sheets">
            <thead><tr><th>Class of business</th><th>Screen</th><th>Last saved</th></tr></thead>
            <tbody>
              <tr><td>—</td><td>Cover</td><td>on export</td></tr>
              {pack.classes.flatMap((c) => (c.screens.length ? c.screens : [null]).map((s, i) => (
                <tr key={`${c.name}:${s ? s.key : i}`} className={s ? '' : 'mp-sheets--empty'}>
                  <td>{c.name}</td>
                  <td>{s ? s.title : <em>no screen data yet</em>}</td>
                  <td>{s ? when(s.updated_at) : ''}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
