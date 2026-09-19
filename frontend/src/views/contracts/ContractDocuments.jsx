import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, download, fetchBlobUrl } from '../../api.js';
import { useFetch, ErrorBanner } from '../../components.jsx';
import { useScreenHead } from '../../shell.jsx';
import { useHasRole } from '../../auth.jsx';
import { useToast } from '../../toast.jsx';
import WizardNav from '../../WizardNav.jsx';
import { useContractHeader, ContractSummary } from './ContractDetailsPane.jsx';
import { BASIS_LABEL, detailPath, sharesPath } from './contractModel.js';

/**
 * Contracts → Documents: the second step of both workflows, laid out as the
 * Universe modelling tool's Documents screen — the "Files for Treaty" chip
 * and the contract id; the drag-and-drop zone with browse and + Select
 * Files; the upload form (document type off the tool's list, a title
 * suggested from the type, an optional description, the picked file and
 * ↑ Upload); and the Uploaded Documents card — file, type, title, size,
 * uploaded — with View (PDFs, images and text open in a preview over the
 * page), Download and Delete. The same summary strip as the detail page
 * heads it, and the floating dock takes it Back to the detail and on to
 * the Shares step.
 */
export const DOC_TYPES = [
  'Final Slip', 'Draft Slip', 'Expiring Slip', 'Renewal Pack',
  'Large Loss List', 'Risk Profiles', 'Claims Profile',
  'Presentation', 'CAT Modelling', 'Bordereaux', 'Accounts', 'Other',
];
const SLIPS = ['Final Slip', 'Draft Slip', 'Expiring Slip'];
const VIEWABLE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv']);
const isViewable = (m) => VIEWABLE.has(m) || (m || '').startsWith('image/');
const MAX_BYTES = 15 * 1024 * 1024;
const ACCEPT = '.pdf,.xlsx,.xls,.docx,.doc,.csv,.txt,.png,.jpg,.jpeg';

/** The title the form suggests for a document type. */
export function defaultTitle(docType) {
  const map = {
    'Final Slip': 'Final Signed Slip',
    'Draft Slip': 'Draft Slip',
    'Expiring Slip': 'Expiring Slip',
    'Renewal Pack': 'Renewal Pack',
    'Large Loss List': 'Large Loss Schedule',
    'Risk Profiles': 'Risk Profile',
    'Claims Profile': 'Claims Profile',
    'Presentation': 'Treaty Presentation',
    'CAT Modelling': 'CAT Model Output',
    'Bordereaux': 'Bordereaux',
    'Accounts': 'Accounts',
  };
  return map[docType] || '';
}
const stem = (name) => String(name || '').replace(/\.[^.]+$/, '');
const fmtSize = (b) => (!b ? '–' : b < 1024 ? `${b}B` : b < 1048576 ? `${Math.round(b / 1024)}KB` : `${(b / 1048576).toFixed(1)}MB`);

/** A File's bytes as base64, the way every upload in the API travels. */
const toBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(r.error || new Error(`Could not read ${file.name}`));
  r.readAsDataURL(file);
});

export default function ContractDocuments({ basis }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const canEdit = useHasRole('broker', 'admin');
  const placement = useFetch('GET', `/placements/${id}`, [id]);
  const docs = useFetch('GET', `/placements/${id}/contract-documents`, [id]);
  const pd = placement.data;
  useScreenHead(`Contracts · ${BASIS_LABEL[basis]} · 2 of 3`, 'Documents', pd?.reference || '');
  const h = useContractHeader({ pd, isNew: false, basis });

  const [docType, setDocType] = useState('Final Slip');
  const [title, setTitle] = useState(defaultTitle('Final Slip'));
  const [description, setDescription] = useState('');
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState(null); // { url, mime, name, doc }
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  // The preview's blob URL is released with the preview.
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview]);

  const handleDocTypeChange = (t) => { setDocType(t); setTitle(defaultTitle(t)); };

  const takeFile = (f, { fromDrop } = {}) => {
    if (!f) return;
    setFile(f);
    // The title follows the file unless one was typed.
    if (fromDrop ? !title : (!title || title === defaultTitle(docType))) setTitle(stem(f.name));
  };
  const handleDrop = (e) => { e.preventDefault(); setDragOver(false); takeFile(e.dataTransfer?.files?.[0], { fromDrop: true }); };
  const handleFileSelect = (e) => takeFile(e.target.files?.[0]);

  async function doUpload(f) {
    setError(null);
    if (f.size > MAX_BYTES) { setError(new Error(`${f.name} is over the 15 MB limit`)); return; }
    setUploading(true);
    try {
      await api('POST', `/placements/${id}/contract-documents`, {
        doc_type: docType,
        title: title.trim() || defaultTitle(docType) || stem(f.name),
        description: description.trim() || null,
        filename: f.name,
        mime_type: f.type || 'application/octet-stream',
        content_base64: await toBase64(f),
      });
      setTitle(defaultTitle(docType));
      setDescription('');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      toast(`${f.name} uploaded.`);
      docs.reload();
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
    }
  }
  const handleUploadClick = () => {
    const f = file || fileRef.current?.files?.[0];
    if (!f) { toast('Select or drop a file first.'); return; }
    doUpload(f);
  };

  async function del(d) {
    if (!window.confirm('Delete this document?')) return;
    setError(null);
    try {
      await api('DELETE', `/contract-documents/${d.id}`);
      toast(`${d.filename} deleted.`);
      docs.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function downloadDoc(d) {
    setError(null);
    try { await download(`/contract-documents/${d.id}/download`); } catch (err) { setError(err); }
  }

  async function openPreview(d) {
    if (!isViewable(d.mime_type)) { downloadDoc(d); return; }
    setError(null);
    try {
      const { url, mime } = await fetchBlobUrl(`/contract-documents/${d.id}/view`);
      setPreview({ url, mime: mime || d.mime_type, name: d.filename, doc: d });
    } catch (err) {
      setError(err);
    }
  }
  const closePreview = () => setPreview(null);

  if (placement.error) return <ErrorBanner error={placement.error} />;
  if (!pd || !h.ed) return null;
  const list = docs.data || [];
  const detailLabel = basis === 'PROP' ? 'Treaty Detail' : 'Contract Details';
  const onKeyActivate = (fn) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };

  return (
    <div className="screen contract-screen">
      <ContractSummary h={h} />
      {h.contractDescription && (
        <div className="td-contract"><span className="td-contract-label">Contract:</span>{h.contractDescription}</div>
      )}
      <ErrorBanner error={error || docs.error} />

      <div className="docs" data-testid="contract-documents">
        {/* Header */}
        <div className="docs-chip">
          <span className="docs-chip-dot" />
          <span className="docs-chip-text">Files for Treaty</span>
        </div>
        <div className="docs-id">
          <b>CONTRACT ID:</b>{' '}<span className="mono" data-testid="documents-contract-id">{pd.reference || '—'}</span>
        </div>

        {canEdit && (
          <>
            {/* Dropzone — drag-and-drop is a pointer convenience; keyboard users attach via browse / + Select Files. */}
            <div className={`docs-dropzone${dragOver ? ' is-over' : ''}`} role="presentation"
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={handleDrop}>
              <div className="docs-drop-left">
                <div className="docs-drop-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" />
                  </svg>
                </div>
                <div>
                  <div className="docs-drop-title">
                    Drag &amp; drop files here <span className="docs-drop-or">or</span>{' '}
                    <span role="button" tabIndex={0} className="docs-browse" onClick={() => fileRef.current?.click()}
                      onKeyDown={onKeyActivate(() => fileRef.current?.click())}>browse</span>
                  </div>
                  <div className="docs-drop-sub">Attach treaties, slips, wordings, accounts and bordereaux.</div>
                  <div className="docs-drop-sub">PDF, XLSX, DOCX, CSV up to 15MB each.</div>
                </div>
              </div>
              <button type="button" className="docs-green-btn" onClick={() => fileRef.current?.click()}>+ Select Files</button>
            </div>

            {/* Hidden file input */}
            <input type="file" ref={fileRef} onChange={handleFileSelect} className="docs-file-input" aria-label="Files" accept={ACCEPT} />

            {/* Upload form */}
            <div className="docs-form" data-testid="document-upload">
              <div>
                <div className="docs-lbl">Document Type</div>
                <div className="docs-sel-wrap">
                  <select className="docs-inp docs-sel" value={docType} aria-label="Document Type" disabled={uploading}
                    onChange={(e) => handleDocTypeChange(e.target.value)}>
                    {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <span className="docs-sel-caret" aria-hidden="true">▾</span>
                </div>
              </div>
              <div>
                <div className="docs-lbl">Document Title</div>
                <input className="docs-inp" placeholder="e.g. Final signed slip" value={title} aria-label="Document Title"
                  disabled={uploading} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div>
                <div className="docs-lbl">Description (Optional)</div>
                <input className="docs-inp" placeholder="Notes…" value={description} aria-label="Description"
                  disabled={uploading} onChange={(e) => setDescription(e.target.value)} />
              </div>
              <div className="docs-form-actions">
                {file && <div className="docs-file-chip" title={file.name} data-testid="document-file-chip">📎 {file.name}</div>}
                <button type="button" className="docs-green-btn docs-green-btn--sm" onClick={handleUploadClick} disabled={uploading}
                  data-testid="document-upload-button">
                  {uploading ? '⟳ Uploading…' : '↑ Upload'}
                </button>
              </div>
              <div className="docs-form-foot">Uploaded files are stored on the server and linked to this contract.</div>
            </div>
          </>
        )}

        {/* Uploaded Documents */}
        <div className="docs-card">
          <div className="docs-card-head">
            <div className="docs-card-title">
              Uploaded Documents
              <span className="docs-count" data-testid="documents-count">
                {docs.data ? `${list.length} ${list.length === 1 ? 'FILE' : 'FILES'}` : '…'}
              </span>
            </div>
            <button type="button" className="docs-sm-btn" onClick={docs.reload}>↻ Reload</button>
          </div>

          {docs.data && list.length === 0 ? (
            <div className="docs-empty">No documents uploaded yet.</div>
          ) : !docs.data && !docs.error ? (
            <div className="docs-empty">Loading…</div>
          ) : (
            <table className="docs-table">
              <thead>
                <tr><th>File</th><th>Type</th><th>Title</th><th>Size</th><th>Uploaded</th><th className="r">Actions</th></tr>
              </thead>
              <tbody>
                {list.map((d) => {
                  const isSlip = SLIPS.includes(d.doc_type);
                  return (
                    <tr key={d.id} data-testid="document-row" className={isSlip ? 'is-slip' : ''}>
                      <td>
                        <span role="button" tabIndex={0} className="docs-file-name" onClick={() => openPreview(d)}
                          onKeyDown={onKeyActivate(() => openPreview(d))}>
                          {d.filename || '–'}
                        </span>
                        {d.description && <div className="docs-desc">{d.description}</div>}
                      </td>
                      <td><span className={`docs-type-pill${isSlip ? ' is-slip' : ''}`}>{d.doc_type || '–'}</span></td>
                      <td className="docs-muted">{d.title || '–'}</td>
                      <td className="docs-muted">{fmtSize(d.size_bytes)}</td>
                      <td className="docs-muted">
                        {(d.uploaded_at || d.created_at || '').slice(0, 10)}
                        {d.uploaded_by_name && <div className="docs-desc">{d.uploaded_by_name}</div>}
                      </td>
                      <td>
                        <div className="docs-actions">
                          {isViewable(d.mime_type) && (
                            <button type="button" className="docs-sm-btn docs-sm-btn--accent" onClick={() => openPreview(d)}>View</button>
                          )}
                          <button type="button" className="docs-sm-btn docs-sm-btn--blue" onClick={() => downloadDoc(d)}>Download</button>
                          {canEdit && (
                            <button type="button" className="docs-sm-btn docs-sm-btn--rose" onClick={() => del(d)} aria-label={`Delete ${d.filename}`}>
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Preview — PDFs, images and text, over the page. */}
      {preview && (
        <div className="docs-preview" role="presentation" data-testid="document-preview"
          onClick={(e) => { if (e.target === e.currentTarget) closePreview(); }}>
          <div className="docs-preview-bar">
            <div className="docs-preview-name">{preview.name}</div>
            <div className="docs-preview-actions">
              <button type="button" className="docs-sm-btn docs-sm-btn--blue" onClick={() => downloadDoc(preview.doc)}>↓ Download</button>
              <button type="button" className="docs-sm-btn docs-sm-btn--rose" aria-label="Close" onClick={closePreview}>✕ Close</button>
            </div>
          </div>
          <div className="docs-preview-body">
            {preview.mime.startsWith('image/') ? (
              <img src={preview.url} alt={preview.name} className="docs-preview-img" />
            ) : (
              // allow-same-origin lets the browser render the file (its own
              // PDF viewer included); allow-scripts is withheld so nothing in
              // an uploaded file can run against the app.
              <iframe src={preview.url} sandbox="allow-same-origin" className="docs-preview-frame" title="File Preview" />
            )}
          </div>
        </div>
      )}

      <WizardNav
        hasPrev onBack={() => navigate(detailPath(basis, id))} backLabel={detailLabel}
        hasNext onNext={() => navigate(sharesPath(basis, id))} nextLabel="Shares"
      />
    </div>
  );
}
