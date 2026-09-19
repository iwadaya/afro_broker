import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { Pill, ErrorBanner, fmtDate, fmtStamp, providerLabel } from '../../components.jsx';
import { useToast } from '../../toast.jsx';

/*
 * The panels the renewal desk's tabs share: the packs themselves (the intake
 * object on the Renewal pack tab, the compact provenance list beside the
 * summary), the run while it is running, the record's details, and the
 * empty state a stage shows before the record supports it. Every one reads
 * the workspace's `shared` memo rather than fetching for itself.
 */

export const ROLE_LABEL = { expiring: 'Expiring pack', current: 'Current pack', other: 'Other exhibit' };
export const ROLE_TONE = { expiring: 'neutral', current: 'accent', other: 'outline' };

/**
 * What one run of the analysis covers. Shown while it is running so the wait
 * is legible — the model is called once, so these are the stages of that call
 * rather than a live position in a queue, and the panel says so.
 */
const RUN_STAGES = [
  'Reading each uploaded pack whole — PDFs and images natively, workbooks sheet by sheet',
  'Reviewing each pack on its own: structure, exposure, premium, loss experience, terms',
  'Comparing the expiring submission against the current one, change by change',
  'Judging each movement from the reinsurer’s perspective and drafting the analysis',
];

export function fmtSize(n) {
  if (n == null) return '—';
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** A File as the API takes it: the base64 body without the data-URL prefix. */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Drag-drop / file-picker upload card — the Universe modelling tool's
 * UploadDropzone pattern: the zone itself is pointer-only chrome, the real
 * controls are the file input and buttons inside it.
 */
function PackDropzone({ role, setRole, pending, setPending, uploading, onUpload, onUploadAnalyse }) {
  const inputRef = useRef();
  const [over, setOver] = useState(false);

  return (
    <div
      className={`rpa-dropzone${over ? ' rpa-dropzone--active' : ''}`}
      role="presentation"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const file = e.dataTransfer?.files?.[0];
        if (file) setPending(file);
      }}
    >
      {!pending ? (
        <div className="rpa-dropzone-idle">
          <span className="rpa-dropzone-mark" aria-hidden="true" />
          <div className="rpa-dropzone-title">Drop a renewal pack to begin</div>
          <div className="rpa-dropzone-hint">
            Up to 15 MB · PDFs preferred · images, Excel and text/CSV also read · tag it expiring or current below
          </div>
          <input
            ref={inputRef}
            type="file"
            className="rpa-file-input"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) setPending(f); e.target.value = ''; }}
          />
          <button type="button" className="btn btn-secondary" onClick={() => inputRef.current?.click()}>
            Choose file
          </button>
        </div>
      ) : (
        <div className="rpa-upload-form">
          <div className="rpa-upload-fileinfo">
            <div className="rpa-upload-name">{pending.name}</div>
            <div className="rpa-upload-meta">
              {fmtSize(pending.size)} · {pending.type || 'application/octet-stream'}
              {' · '}
              <button type="button" className="rpa-linkbtn" onClick={() => setPending(null)}>remove</button>
            </div>
          </div>
          <label className="field">
            <span>Pack role</span>
            <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
              {Object.entries(ROLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <div className="rpa-upload-actions">
            <button type="button" className="btn btn-secondary" disabled={uploading} onClick={onUpload}>
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
            <button type="button" className="btn btn-primary" disabled={uploading} onClick={onUploadAnalyse}>
              {uploading ? 'Uploading…' : 'Upload & analyse'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The packs panel: the intake object when there is nothing to read yet, a
 * compact provenance list beside the summary. Uploading and removing packs
 * happen here; the run itself is the workspace's, so the pipeline, the tab
 * strip and the move to the summary all follow one call.
 */
export function PacksPanel({ shared, compact = false }) {
  const { analysis: a, role, analysing, aiConfigured, canRun, run, runError, reload } = shared;
  // The next pack of a two-pack upload is usually the other year: with the
  // expiring pack already on the record, the current one is offered first.
  const [docRole, setDocRole] = useState(() => (
    a.documents.some((d) => d.role === 'expiring') && !a.documents.some((d) => d.role === 'current')
      ? 'current' : 'expiring'
  ));
  const [pending, setPending] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const toast = useToast();

  async function upload({ thenRun = false } = {}) {
    if (!pending) return;
    setUploading(true);
    setError(null);
    try {
      const content_base64 = await fileToBase64(pending);
      await api('POST', `/renewal-analyses/${a.id}/documents`, {
        role: docRole,
        filename: pending.name,
        mime_type: pending.type || 'application/octet-stream',
        content_base64,
      });
      const uploaded = pending.name;
      setPending(null);
      setDocRole((r) => (r === 'expiring' ? 'current' : r));
      reload();
      toast(`${uploaded} uploaded${thenRun ? ' — reading it now' : ''}.`);
      if (thenRun) await run();
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
    }
  }

  async function removeDoc(docId) {
    setError(null);
    try {
      await api('DELETE', `/renewal-analyses/${a.id}/documents/${docId}`);
      reload();
    } catch (err) {
      setError(err);
    }
  }

  const runButton = canRun && (
    <button
      className="btn btn-primary"
      onClick={run}
      disabled={analysing || !a.documents.length}
    >
      {analysing ? 'Analysing…' : a.result ? 'Re-run AI analysis' : 'Run AI analysis'}
    </button>
  );

  return (
    <section className={`blueprint rpa-packs${compact ? ' rpa-packs--compact' : ''}`}>
      <div className="sechead">
        <h3 className="seclabel">{compact ? 'Source packs' : 'Renewal packs'}</h3>
        {!compact && <span className="kicker accent">Step 01 · Intake</span>}
        {compact && <span className="kicker spacer">{a.documents.length} uploaded</span>}
      </div>
      {!compact && (
        <p className="rpa-intake-lede">
          Upload the packs to analyse — usually two: the <b>expiring</b> submission and the{' '}
          <b>current</b> (renewal) submission. PDFs, images, Excel workbooks and text/CSV
          files are read by the AI. Nothing is inferred where a pack is silent; gaps are
          flagged for you instead.
        </p>
      )}
      {role.canBroke && !analysing && (
        <PackDropzone
          role={docRole}
          setRole={setDocRole}
          pending={pending}
          setPending={setPending}
          uploading={uploading}
          onUpload={() => upload()}
          onUploadAnalyse={() => upload({ thenRun: true })}
        />
      )}
      {a.documents.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Pack</th><th>File</th>
                {!compact && <th>Type</th>}
                <th className="r">Size</th><th>Uploaded</th>
                {role.canBroke && <th />}
              </tr>
            </thead>
            <tbody>
              {a.documents.map((d) => (
                <tr key={d.id}>
                  <td><Pill tone={ROLE_TONE[d.role] || 'neutral'}>{ROLE_LABEL[d.role] || d.role}</Pill></td>
                  <td className="rpa-doc-file">{d.filename}</td>
                  {!compact && <td className="rpa-book-sub">{d.mime_type}</td>}
                  <td className="r num">{fmtSize(d.size_bytes)}</td>
                  <td className="rpa-book-sub">{fmtDate(d.created_at)}</td>
                  {role.canBroke && (
                    <td className="r">
                      <button className="btn btn-ghost btn-sm" onClick={() => removeDoc(d.id)} disabled={analysing}>
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {a.documents.length === 0 && compact && <p className="muted small">No packs on this analysis.</p>}
      <div className="rpa-packs-foot">
        {runButton}
        {!aiConfigured && (
          <span className="rpa-packs-note">
            No AI provider is configured on this deployment — set OPENAI_API_KEY to run the analysis.
          </span>
        )}
        {aiConfigured && !a.documents.length && (
          <span className="rpa-packs-note">Upload at least one pack before running the analysis.</span>
        )}
      </div>
      {a.status === 'failed' && a.error && <div className="err banner">Last run failed: {a.error}</div>}
      <ErrorBanner error={error} />
      <ErrorBanner error={runError} />
    </section>
  );
}

/** The run, while it is running: its own elapsed time and the stages of the one call. */
export function PipelinePanel({ shared }) {
  const { startedAt, now } = shared;
  return (
    <section className="blueprint rpa-pipeline">
      <div className="sechead">
        <h3 className="seclabel">Reading the packs</h3>
        <span className="kicker spacer num">
          {startedAt ? fmtElapsed(now - startedAt) : 'running'}
        </span>
      </div>
      <div className="rpa-pipeline-bar" role="progressbar" aria-label="Analysis running">
        <span className="rpa-pipeline-sweep" />
      </div>
      <ol className="rpa-pipeline-steps">
        {RUN_STAGES.map((s) => (
          <li key={s} className="rpa-pipeline-step">
            <span className="rpa-pipeline-dot" aria-hidden="true" />
            <span>{s}</span>
          </li>
        ))}
      </ol>
      <p className="muted small">
        One call to the model covers all four — the stages are what the run does, not a
        live position in it. A two-pack analysis usually takes a minute or two.
      </p>
    </section>
  );
}

/**
 * How a quick intake went, in a phrase: how many of the fields the model
 * filled were kept as read, corrected, or added by the broker.
 */
export function reviewSummary(review) {
  if (!review) return '';
  const counts = {};
  for (const state of Object.values(review)) counts[state] = (counts[state] || 0) + 1;
  return ['accepted', 'corrected', 'added']
    .filter((k) => counts[k])
    .map((k) => `${counts[k]} ${k}`)
    .join(' · ');
}

/** The record itself: who the cedant is, what is being placed, when it was last read. */
export function DetailsPanel({ shared }) {
  const { analysis: a, role } = shared;
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  async function remove() {
    if (!window.confirm('Delete this analysis and its uploaded packs?')) return;
    try {
      await api('DELETE', `/renewal-analyses/${a.id}`);
      navigate('/renewal-packs?book=1');
    } catch (err) {
      setError(err);
    }
  }

  return (
    <section className="blueprint rpa-side">
      <div className="sechead">
        <h3 className="seclabel">Details</h3>
        {role.canBroke && (
          <span className="sechead-actions">
            <button className="btn btn-ghost btn-sm" onClick={remove}>Delete</button>
          </span>
        )}
      </div>
      <dl className="rpa-deflist">
        <div><dt>Cedant</dt><dd>{a.cedant_name}{a.cedant_domicile ? ` (${a.cedant_domicile})` : ''}</dd></div>
        <div><dt>Classes of business</dt><dd>{a.class_of_business}</dd></div>
        <div><dt>Treaty type</dt><dd>{a.treaty_type}</dd></div>
        {a.cedant_notes && <div><dt>Broker notes</dt><dd>{a.cedant_notes}</dd></div>}
        {a.intake_mode === 'quick' && (
          <div>
            <dt>Intake</dt>
            <dd>
              Quick renewal pack — the details were read off the pack by the AI
              {a.intake?.provider ? ` (${providerLabel(a.intake.provider)}${a.intake.model ? `, ${a.intake.model}` : ''})` : ''}
              {' '}and checked by the broker{reviewSummary(a.intake?.review) ? `: ${reviewSummary(a.intake.review)}` : ''}.
            </dd>
          </div>
        )}
        {a.analysed_at && (
          <div>
            <dt>Last analysed</dt>
            <dd>{fmtStamp(a.analysed_at)} · {providerLabel(a.provider)} ({a.model})</dd>
          </div>
        )}
      </dl>
      <ErrorBanner error={error} />
    </section>
  );
}

// The empty-stage panel is shared with the other desks (components.jsx).
export { StageEmpty } from '../../components.jsx';
