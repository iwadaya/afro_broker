import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, download } from '../../api.js';
import { useFetch, ErrorBanner, Pill, fmtDate } from '../../components.jsx';
import { useScreenHead } from '../../shell.jsx';
import { useHasRole } from '../../auth.jsx';
import { useToast } from '../../toast.jsx';
import WizardNav from '../../WizardNav.jsx';
import { Fr } from '../treatyDetail.jsx';
import { useContractHeader, ContractSummary } from './ContractDetailsPane.jsx';
import { BASIS_LABEL, detailPath } from './contractModel.js';

/**
 * Contracts → Documents: the second step of both workflows, the contract's
 * documents — the slip, the wording, the cedant's submission, bordereaux,
 * statements and correspondence — uploaded against the contract, listed
 * with who put them there and when, opened, and removed. The same summary
 * strip and card as the detail page, and the same floating dock: Back to
 * the detail, Done to the register.
 */
const KINDS = [
  ['slip', 'Slip'], ['wording', 'Wording'], ['submission', 'Submission / renewal pack'], ['bordereau', 'Bordereau'],
  ['statement', 'Statement'], ['correspondence', 'Correspondence'], ['other', 'Other'],
];
const KIND_LABEL = Object.fromEntries(KINDS);
const KIND_TONE = { slip: 'green', wording: 'blue', submission: 'amber', bordereau: 'blue' };
const MAX_BYTES = 15 * 1024 * 1024;

/** '12.4 KB', '3.1 MB'. */
function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

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
  useScreenHead(`Contracts · ${BASIS_LABEL[basis]} · 2 of 2`, 'Documents', pd?.reference || '');
  const h = useContractHeader({ pd, isNew: false, basis });

  const [kind, setKind] = useState('slip');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function onFiles(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    setError(null);
    const big = files.find((f) => f.size > MAX_BYTES);
    if (big) { setError(new Error(`${big.name} is over the 15 MB limit`)); return; }
    setBusy(true);
    try {
      for (const f of files) {
        await api('POST', `/placements/${id}/contract-documents`, {
          kind,
          filename: f.name,
          mime_type: f.type || 'application/octet-stream',
          content_base64: await toBase64(f),
          note: note.trim() || null,
        });
      }
      toast(files.length === 1 ? `${files[0].name} uploaded.` : `${files.length} documents uploaded.`);
      setNote('');
      docs.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove(d) {
    if (!window.confirm(`Remove ${d.filename} from the contract?`)) return;
    setError(null);
    try {
      await api('DELETE', `/contract-documents/${d.id}`);
      toast(`${d.filename} removed.`);
      docs.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function open(d) {
    setError(null);
    try { await download(`/contract-documents/${d.id}/download`); } catch (err) { setError(err); }
  }

  if (placement.error) return <ErrorBanner error={placement.error} />;
  if (!pd || !h.ed) return null;
  const list = docs.data || [];
  const detailLabel = basis === 'PROP' ? 'Treaty Detail' : 'Contract Details';

  return (
    <div className="screen contract-screen">
      <ContractSummary h={h} />
      {h.contractDescription && (
        <div className="td-contract"><span className="td-contract-label">Contract:</span>{h.contractDescription}</div>
      )}
      <ErrorBanner error={error || docs.error} />

      <div className="td-grid td-grid--single">
        <div className="td-card td-card--pane" data-testid="contract-documents">
          <div className="td-card-head">
            <span className="td-card-label">DOCUMENTS</span>
            <span className="td-card-tag" data-testid="documents-count">
              {docs.data ? `${list.length} ${list.length === 1 ? 'FILE' : 'FILES'}` : '…'}
            </span>
          </div>
          <div className="td-card-body">
            <div className="td-hint">
              The contract's documents: the slip, the wording, the cedant's submission, bordereaux,
              statements and correspondence. Upload what came in; open or remove what is here.
            </div>
            {canEdit && (
              <div className="doc-upload" data-testid="document-upload">
                <div className="td-mini">Upload</div>
                <Fr label="Document kind">
                  <select className="fi" value={kind} disabled={busy} aria-label="Document kind" onChange={(e) => setKind(e.target.value)}>
                    {KINDS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                </Fr>
                <Fr label="Note">
                  <input className="fi" value={note} disabled={busy} aria-label="Document note"
                    placeholder="Optional — what it is, who sent it…" onChange={(e) => setNote(e.target.value)} />
                </Fr>
                <Fr label="Files" hint="Up to 15 MB a file">
                  <input type="file" multiple className="fi doc-file" disabled={busy} aria-label="Files" onChange={onFiles} />
                </Fr>
                <div className="td-hint">{busy ? 'Uploading…' : 'Pick one or more files; each is kept on the contract with the kind and note above.'}</div>
              </div>
            )}
            <div className="table-wrap">
              <table className="table doc-table">
                <thead>
                  <tr><th>Document</th><th>Kind</th><th className="r">Size</th><th>Uploaded</th><th /></tr>
                </thead>
                <tbody>
                  {list.map((d) => (
                    <tr key={d.id} data-testid="document-row">
                      <td>
                        <span className="doc-name">{d.filename}</span>
                        {d.note && <span className="doc-meta">{d.note}</span>}
                      </td>
                      <td><Pill tone={KIND_TONE[d.kind] || 'neutral'}>{KIND_LABEL[d.kind] || d.kind}</Pill></td>
                      <td className="r mono">{fmtSize(d.size_bytes)}</td>
                      <td>
                        <span className="mono" style={{ fontSize: 12.5 }}>{fmtDate(d.created_at, { shortYear: true })}</span>
                        {d.uploaded_by_name && <span className="doc-meta">{d.uploaded_by_name}</span>}
                      </td>
                      <td className="r">
                        <span className="doc-actions">
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => open(d)}>Open</button>
                          {canEdit && (
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => remove(d)} aria-label={`Remove ${d.filename}`}>
                              Remove
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {docs.data && list.length === 0 && (
                    <tr><td colSpan="5" className="muted">No documents on this contract yet.</td></tr>
                  )}
                  {!docs.data && !docs.error && <tr><td colSpan="5" className="muted">Loading…</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <WizardNav
        hasPrev onBack={() => navigate(detailPath(basis, id))} backLabel={detailLabel}
        hasNext onNext={() => navigate('/contracts')} nextText="Done: Contracts" nextLabel="Contracts"
      />
    </div>
  );
}
