import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { StructCard } from './StructureSections.jsx';
import { Underwriters } from './NegotiationSubmission.jsx';
import { useRefData } from './RefData.jsx';

/*
 * The two stages after the quoting stage, on one component.
 *
 * Final Quote (stage="quote"): the final terms — when we won the lead,
 * ticked from the quotes line by line; when another broker leads, entered
 * with the type of treaty — and who leads it (the lead broker and the lead
 * reinsurer, kept for market intelligence).
 *
 * Final Placement (stage="placement"): the firm order terms email, with the
 * approved renewal pack attached as its Excel and its PDF, or a renewal pack
 * uploaded by hand with a stated reason; and the written and signed lines —
 * what each market wrote on each line, read off the reinsurers' emails by
 * the AI and marked as such until the broker accepts or overrides them,
 * signed down to the order, and confirmed to each underwriter.
 */

const fmt = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 2 }));
const pct = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '—' : `${Number(v).toLocaleString('en-GB', { maximumFractionDigits: 4 })}%`);
const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const STATUS_LABEL = { draft: 'draft', fot_sent: 'FOT sent', confirmed: 'confirmed' };

/** One quote as the picker names it. */
function quoteLabel(q, ccy) {
  if (q.status === 'declined') return `${q.market_name} — declined`;
  const bits = [];
  if (q.premium != null) bits.push(`premium ${ccy} ${fmt(q.premium)}`);
  if (q.rate_pct != null) bits.push(`rate ${pct(q.rate_pct)}`);
  if (q.commission_pct != null) bits.push(`commission ${pct(q.commission_pct)}`);
  if (q.line_pct != null) bits.push(`line ${pct(q.line_pct)}`);
  return `${q.market_name}${q.kind === 'indicative' ? ' (indicative)' : ''} — ${bits.join(', ') || 'as sent'}`;
}

/* ── Details ── */

function Details({ data, canEdit, busy, onSave }) {
  const ref = useRefData();
  const { final, candidates, markets, placement } = data;
  const ccy = placement.currency;
  const frozen = final.status === 'confirmed';
  const [leadWon, setLeadWon] = useState(final.lead_won !== false);
  const [leadBroker, setLeadBroker] = useState(final.lead_broker || '');
  const [leadReinsurer, setLeadReinsurer] = useState(final.lead_reinsurer_id || '');
  const [leadReinsurerName, setLeadReinsurerName] = useState(final.lead_reinsurer_id ? '' : (final.lead_reinsurer_name || ''));
  const [treatyType, setTreatyType] = useState(final.treaty_type || '');
  const [notes, setNotes] = useState(final.notes || '');
  // Per line: { on, quote_id, premium, rate_pct, commission_pct, treaty_type }
  const [rows, setRows] = useState(() => Object.fromEntries(candidates.map((c) => {
    const t = (final.terms || []).find((x) => x.key === c.key);
    return [c.key, {
      on: !!t,
      // A lead quote first; an indication only when nothing firmer came back.
      quote_id: t?.quote_id || c.quotes.find((q) => q.kind !== 'indicative' && q.status !== 'declined')?.id || c.quotes.find((q) => q.status !== 'declined')?.id || '',
      premium: t?.premium ?? c.asked?.premium ?? '',
      rate_pct: t?.rate_pct ?? c.asked?.rate_pct ?? '',
      commission_pct: t?.commission_pct ?? c.asked?.commission_pct ?? '',
      treaty_type: t?.treaty_type || c.treaty_type || '',
    }];
  })));
  const setRow = (key, patch) => setRows((r) => ({ ...r, [key]: { ...r[key], ...patch } }));

  const treatyTypes = ref.treatyTypes || [];
  const chosen = candidates.filter((c) => rows[c.key]?.on);
  const leadFromQuotes = leadWon
    ? chosen.map((c) => c.quotes.find((q) => q.id === rows[c.key].quote_id)).find((q) => q)?.market_name
    : null;

  const save = () => onSave({
    lead_won: leadWon,
    lead_broker: leadBroker || undefined,
    lead_reinsurer_id: leadReinsurer || undefined,
    lead_reinsurer_name: leadReinsurer ? undefined : (leadReinsurerName || undefined),
    treaty_type: treatyType || undefined,
    notes: notes || undefined,
    terms: chosen.map((c) => {
      const r = rows[c.key];
      return leadWon && r.quote_id
        ? { key: c.key, quote_id: r.quote_id, treaty_type: r.treaty_type || undefined }
        : { key: c.key, premium: r.premium === '' ? null : Number(r.premium), rate_pct: r.rate_pct === '' ? null : Number(r.rate_pct),
          commission_pct: r.commission_pct === '' ? null : Number(r.commission_pct), treaty_type: r.treaty_type || undefined };
    }),
  });

  return (
    <>
      <StructCard title="Who leads the placement" hint="Captured on every placement — the lead broker and the lead reinsurer feed the market intelligence.">
        <div className="fp-lead">
          <label className={`neg-market${leadWon ? ' is-on' : ''}`} data-testid="lead-won">
            <input type="checkbox" checked={leadWon} disabled={!canEdit || frozen} onChange={(e) => { setLeadWon(e.target.checked); if (e.target.checked) setLeadBroker('Universe Broking'); else if (leadBroker === 'Universe Broking') setLeadBroker(''); }} />
            <span>We won the lead<span className="neg-sub-contact">{leadWon ? 'The final terms are picked from the quotes on the negotiation.' : 'Another broker leads: enter the final terms and the type of treaty.'}</span></span>
          </label>
          <div className="neg-editor-grid fp-lead-grid">
            <label className="fr">
              <div className="fr-label">Lead broker</div>
              <input className="fi" value={leadBroker} disabled={!canEdit || frozen} placeholder={leadWon ? 'Universe Broking' : 'The house that leads'} onChange={(e) => setLeadBroker(e.target.value)} data-testid="lead-broker" />
            </label>
            <label className="fr">
              <div className="fr-label">Lead reinsurer</div>
              <select className="fi" value={leadReinsurer} disabled={!canEdit || frozen} onChange={(e) => setLeadReinsurer(e.target.value)} data-testid="lead-reinsurer">
                <option value="">{leadFromQuotes ? `— from the terms: ${leadFromQuotes} —` : '— pick a reinsurer —'}</option>
                {markets.map((m) => <option key={m.market_id} value={m.market_id}>{m.market_name}{m.on_negotiation ? '' : ' (not approached)'}</option>)}
              </select>
            </label>
            {!leadReinsurer && !leadFromQuotes && (
              <label className="fr">
                <div className="fr-label">…or a reinsurer not on the register</div>
                <input className="fi" value={leadReinsurerName} disabled={!canEdit || frozen} onChange={(e) => setLeadReinsurerName(e.target.value)} />
              </label>
            )}
            {!leadWon && (
              <label className="fr">
                <div className="fr-label">Type of treaty</div>
                <select className="fi" value={treatyType} disabled={!canEdit || frozen} onChange={(e) => setTreatyType(e.target.value)} data-testid="treaty-type">
                  <option value="">— choose —</option>
                  {treatyTypes.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                  {treatyType && !treatyTypes.some((t) => t.name === treatyType) && <option value={treatyType}>{treatyType}</option>}
                </select>
              </label>
            )}
          </div>
        </div>
      </StructCard>

      <StructCard
        title="Final terms"
        hint={leadWon
          ? 'Tick the lines placed and pick, per line, the quote that became the final terms — the terms are read from that quote.'
          : 'Tick the lines placed and enter the final terms the lead broker set.'}
        actions={<span className="np-layer-count">Lines<b>{chosen.length}/{candidates.length}</b></span>}
        notice={!candidates.length ? 'There are no structures to quote on this placement — build the structure first.' : undefined}
      >
        <div className="np-table-wrap">
          <table className="np-struct-table fp-terms" data-testid="final-terms">
            <thead>
              <tr>
                <th>Final</th><th>Structure</th><th>Line</th><th>Limit / capacity</th><th>Attachment</th>
                {leadWon ? <th>Final terms from</th> : <><th>Premium</th><th>Rate %</th><th>Commission %</th></>}
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => {
                const r = rows[c.key];
                const usable = c.quotes.filter((q) => q.status !== 'declined');
                return (
                  <tr key={c.key} className={r.on ? 'is-on' : ''} data-testid={`term-${c.key}`}>
                    <td><input type="checkbox" checked={r.on} disabled={!canEdit || frozen || (leadWon && !usable.length)} onChange={(e) => setRow(c.key, { on: e.target.checked })} /></td>
                    <td className="neg-sub-market">{c.structure_label}<span className="neg-sub-contact">{c.basis === 'PROP' ? 'proportional' : 'non-proportional'}</span></td>
                    <td>{c.label}</td>
                    <td>{c.basis === 'PROP' ? `${ccy} ${fmt(c.capacity)}` : `${ccy} ${fmt(c.limit)}`}</td>
                    <td>{c.basis === 'PROP' ? '—' : `${ccy} ${fmt(c.attachment)}`}</td>
                    {leadWon ? (
                      <td>
                        {usable.length
                          ? (
                            <select className="fi" value={r.quote_id} disabled={!canEdit || frozen} onChange={(e) => setRow(c.key, { quote_id: e.target.value, on: true })}>
                              {usable.map((q) => <option key={q.id} value={q.id}>{quoteLabel(q, ccy)}</option>)}
                            </select>
                          )
                          : <span className="muted small">No quote captured on this line{c.quotes.length ? ' — every market declined' : ''}.</span>}
                      </td>
                    ) : (
                      <>
                        <td><input className="fi" style={{ width: 120 }} value={r.premium} disabled={!canEdit || frozen} onChange={(e) => setRow(c.key, { premium: e.target.value, on: true })} /></td>
                        <td><input className="fi" style={{ width: 90 }} value={r.rate_pct} disabled={!canEdit || frozen || c.basis === 'PROP'} onChange={(e) => setRow(c.key, { rate_pct: e.target.value, on: true })} /></td>
                        <td><input className="fi" style={{ width: 90 }} value={r.commission_pct} disabled={!canEdit || frozen || c.basis !== 'PROP'} onChange={(e) => setRow(c.key, { commission_pct: e.target.value, on: true })} /></td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <label className="fr" style={{ marginTop: 10 }}>
          <div className="fr-label">Notes on the final terms</div>
          <textarea className="fi" rows={3} value={notes} disabled={!canEdit || frozen} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {canEdit && !frozen && (
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button type="button" className="np-green-pill" disabled={busy || !chosen.length} data-testid="save-final-terms" onClick={save}>
              {busy ? 'Saving…' : 'Save final terms'}
            </button>
            {final.status !== 'draft' && <span className="muted small">Saving updates the terms; emails already sent keep what they said.</span>}
          </div>
        )}
        {frozen && <div className="np-struct-notice">The shares are confirmed — the final terms are frozen.</div>}
      </StructCard>
    </>
  );
}

/* ── Email ── */

const readFileBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(new Error('Could not read file'));
  r.readAsDataURL(file);
});
const kb = (n) => (n == null ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** A renewal pack uploaded by hand, in place of the approved version — with its reason. */
function PackUpload({ placementId, uploads, chosen, onChoose, busy, act, setNote }) {
  const [file, setFile] = useState(null);
  const [reason, setReason] = useState('');
  const upload = () => act(async () => {
    const content_base64 = await readFileBase64(file);
    const r = await api('POST', `/placements/${placementId}/final/pack-upload`, {
      filename: file.name, mime_type: file.type || 'application/octet-stream', content_base64, reason: reason.trim(),
    });
    onChoose(r.upload.id);
    setFile(null); setReason('');
    setNote(`Renewal pack "${r.upload.filename}" uploaded with its reason — it goes with the firm order terms instead of the approved version.`);
  });
  return (
    <div className="fp-upload" data-testid="fot-upload">
      {uploads.length > 0 && (
        <label className="fr">
          <div className="fr-label">Uploaded packs on this placement</div>
          <select className="fi" value={chosen || ''} onChange={(e) => onChoose(e.target.value || null)} data-testid="fot-upload-pick">
            <option value="">— pick an uploaded pack —</option>
            {uploads.map((u) => <option key={u.id} value={u.id}>{u.filename} · {kb(u.size_bytes)} · {when(u.created_at)} — {u.reason}</option>)}
          </select>
        </label>
      )}
      <label className="fr">
        <div className="fr-label">Upload a renewal pack</div>
        <input type="file" className="fi" accept=".pdf,.xlsx,.xls,.docx,.csv,.zip" disabled={busy} data-testid="fot-attach-upload"
          onChange={(e) => setFile(e.target.files?.[0] || null)} />
      </label>
      <label className="fr">
        <div className="fr-label">Why a pack is attached by hand instead of the approved version (required)</div>
        <textarea className="fi" rows={2} value={reason} disabled={busy} maxLength={2000} data-testid="fot-upload-reason"
          placeholder="e.g. the cedant restated its pack after the FOT call; the approved version has the old exposure table" onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="toolbar">
        <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={busy || !file || reason.trim().length < 5} data-testid="fot-upload-go" onClick={upload}>
          Upload with reason
        </button>
        <span className="muted small">The reason is kept with the file and on the audit trail.</span>
      </div>
    </div>
  );
}

function Email({ placementId, data, canEdit, busy, act, setNote }) {
  const { final, markets, pack } = data;
  const uploads = data.pack_uploads || [];
  const [selected, setSelected] = useState({});
  const [draft, setDraft] = useState(null);
  const [attachments, setAttachments] = useState([]);
  // 'approved' — the approved version's Excel and PDF; 'upload' — a pack
  // uploaded by hand with its reason; 'none' — nothing attached.
  const [attachMode, setAttachMode] = useState(pack ? 'approved' : 'none');
  const [uploadId, setUploadId] = useState(null);
  const saved = !!final.id && (final.terms || []).length > 0;

  useEffect(() => {
    if (!saved) return;
    api('GET', `/placements/${placementId}/final/email-draft?kind=fot`)
      .then((d) => { setDraft({ subject: d.subject, body: d.body }); setAttachments(d.attachments || []); })
      .catch(() => {});
  }, [placementId, saved, final.updated_at]);

  const chosen = Object.values(selected);
  const context = { blockers: saved ? [] : ['Save the final terms on the Final Quote tab first'], warnings: data.mail_transport === 'stub' ? ['No Outlook mailbox is connected — the email is recorded here but nothing is delivered.'] : [], mail_from: data.mail_from, mail_transport: data.mail_transport };
  const canSend = chosen.length > 0 && (attachMode !== 'upload' || !!uploadId);

  const send = () => act(async () => {
    const r = await api('POST', `/placements/${placementId}/final/emails`, {
      kind: 'fot', recipients: chosen, subject: draft.subject, body: draft.body,
      attach_pack: attachMode === 'approved',
      ...(attachMode === 'upload' && uploadId ? { pack_upload_id: uploadId } : {}),
    });
    const attached = attachMode === 'approved' ? ' with the renewal pack (Excel + PDF)' : attachMode === 'upload' ? ' with the uploaded renewal pack' : '';
    setNote(`Firm order terms sent to ${r.email.delivered} underwriter${r.email.delivered === 1 ? '' : 's'}${attached}.`);
    setSelected({});
  });

  return (
    <>
      <StructCard title="Who the firm order terms go to" hint="The reinsurers and underwriters who will write the placement — reinsurers first, then the underwriter(s) at each.">
        <Underwriters context={context} underwriters={markets} selected={selected} setSelected={setSelected} />
      </StructCard>
      <StructCard
        title="Firm order terms email"
        hint="Drafted from the final terms and the renewal pack summary; edit it before it goes. {{contact_name}} becomes each underwriter's name. The approved pack rides with it as its Excel and its PDF, exactly as approved — or a pack uploaded by hand, with the reason stated."
        actions={<span className="np-layer-count">Selected<b>{chosen.length || '—'}</b></span>}
      >
        {!saved && <div className="np-struct-notice">Save the final terms on the Final Quote tab first.</div>}
        {draft && (
          <>
            <label className="fr"><div className="fr-label">Subject</div><input className="fi" value={draft.subject} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} data-testid="fot-subject" /></label>
            <label className="fr"><div className="fr-label">Email</div><textarea className="fi neg-mail" value={draft.body} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, body: e.target.value })} data-testid="fot-body" /></label>
            <div className="fp-attach" data-testid="fot-attach">
              <label className="neg-confirm">
                <input type="radio" name="fp-attach" checked={attachMode === 'approved'} disabled={!pack || !canEdit} onChange={() => setAttachMode('approved')} />
                <span>
                  {pack ? <>Attach the approved renewal pack <b>v{pack.version}</b> — Excel and PDF, as stored when it was approved</> : 'No approved renewal pack to attach'}
                  {pack && attachments.length > 0 && (
                    <span className="neg-sub-contact">{attachments.map((a) => `${a.filename} (${kb(a.bytes)})`).join(' · ')}</span>
                  )}
                </span>
              </label>
              <label className="neg-confirm">
                <input type="radio" name="fp-attach" checked={attachMode === 'upload'} disabled={!canEdit} onChange={() => setAttachMode('upload')} data-testid="fot-attach-manual" />
                <span>Attach a renewal pack uploaded by hand instead — a reason is required<span className="neg-sub-contact">For a pack restated after approval, or one the cedant asked to go in its own form.</span></span>
              </label>
              {attachMode === 'upload' && canEdit && (
                <PackUpload placementId={placementId} uploads={uploads} chosen={uploadId} onChoose={setUploadId} busy={busy} act={act} setNote={setNote} />
              )}
              <label className="neg-confirm">
                <input type="radio" name="fp-attach" checked={attachMode === 'none'} disabled={!canEdit} onChange={() => setAttachMode('none')} />
                <span>No pack attached</span>
              </label>
            </div>
            {canEdit && (
              <div className="toolbar" style={{ marginTop: 10 }}>
                <button type="button" className="np-green-pill" disabled={busy || !canSend} data-testid="send-fot" onClick={send}
                  title={attachMode === 'upload' && !uploadId ? 'Upload a pack with its reason, or pick one already uploaded' : ''}>
                  {busy ? 'Sending…' : 'Send firm order terms'}
                </button>
              </div>
            )}
          </>
        )}
      </StructCard>
      <SentEmails emails={data.emails} />
    </>
  );
}

const attachedLabel = (e) => {
  const f = e.attached_formats || [];
  if (f.includes('upload')) return ' · uploaded pack attached';
  if (f.length) return ` · pack attached (${f.map((x) => (x === 'xlsx' ? 'Excel' : x.toUpperCase())).join(' + ')})`;
  return e.attach_pack ? ' · pack attached' : '';
};

function SentEmails({ emails }) {
  const [open, setOpen] = useState({});
  if (!emails?.length) return null;
  return (
    <StructCard title="Sent" hint="Every email that has gone from this stage.">
      <div className="np-table-wrap">
        <table className="np-struct-table" data-testid="final-emails">
          <thead><tr><th>Kind</th><th>Subject</th><th>To</th><th>Sent</th><th /></tr></thead>
          <tbody>
            {emails.map((e) => (
              <React.Fragment key={e.id}>
                <tr>
                  <td><span className={`neg-standing neg-standing--${e.kind === 'fot' ? 'quoted' : 'sent'}`}>{e.kind === 'fot' ? 'firm order terms' : e.kind === 'declinature' ? 'courtesy note' : 'confirmation'}</span></td>
                  <td className="neg-sub-subject" title={e.subject}>{e.subject}</td>
                  <td className="small">{(e.recipients || []).map((r) => `${r.market_name} · ${r.name || r.email}${r.status === 'failed' ? ' (failed)' : ''}`).join('; ')}</td>
                  <td className="small">{when(e.sent_at)}{e.sent_by_name ? ` · ${e.sent_by_name}` : ''}{attachedLabel(e)}</td>
                  <td><button type="button" className="np-struct-btn" onClick={() => setOpen((o) => ({ ...o, [e.id]: !o[e.id] }))}>{open[e.id] ? 'Hide' : 'Show'}</button></td>
                </tr>
                {open[e.id] && <tr><td colSpan={5}><pre className="neg-mail-preview">{e.body}</pre></td></tr>}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </StructCard>
  );
}

/* ── Lines ── */

const CHANGE_LABEL = {
  entered: 'entered', updated: 'changed', overridden: 'overrode the AI', cleared: 'cleared', accepted: 'accepted the AI\'s line',
  ai_entered: 'AI entered from email', ai_updated: 'AI updated from email',
};

/** Read the reinsurers' emails for lines: the ones on file, and one pasted in. */
function ReadFromEmails({ placementId, busy, act, setNote, canEdit }) {
  const [pasting, setPasting] = useState(false);
  const [from, setFrom] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [result, setResult] = useState(null);
  const summarise = (r) => {
    const o = r.outcome;
    setResult(r);
    setNote(`Read ${o.emails} email${o.emails === 1 ? '' : 's'}: ${o.entered} line${o.entered === 1 ? '' : 's'} entered, ${o.updated} updated${o.skipped.length ? `, ${o.skipped.length} skipped` : ''}. AI-entered lines are marked until you accept or override them.`);
  };
  const readOnFile = () => act(async () => summarise(await api('POST', `/placements/${placementId}/final/lines/read-emails`, {})));
  const readPasted = () => act(async () => {
    summarise(await api('POST', `/placements/${placementId}/final/lines/read-emails`, {
      emails: [{ from_email: from.trim(), subject: subject.trim() || undefined, body }],
    }));
    setBody(''); setSubject(''); setPasting(false);
  });
  if (!canEdit) return null;
  return (
    <div className="fp-paste">
      <div className="toolbar">
        <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={busy} data-testid="read-lines" onClick={readOnFile}
          title="Read every reply on file for this placement since the firm order terms went out, and enter the lines they state">
          Read lines from the emails on file
        </button>
        <button type="button" className="np-struct-btn" disabled={busy} data-testid="paste-email" onClick={() => setPasting((p) => !p)}>
          {pasting ? 'Cancel' : 'Paste an email'}
        </button>
      </div>
      {pasting && (
        <div className="neg-editor-grid" style={{ marginTop: 8 }}>
          <label className="fr"><div className="fr-label">From (the underwriter's address, as on the register)</div><input className="fi" type="email" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="paste-from" /></label>
          <label className="fr"><div className="fr-label">Subject</div><input className="fi" value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
          <label className="fr"><div className="fr-label">Email</div><textarea className="fi" value={body} onChange={(e) => setBody(e.target.value)} data-testid="paste-body" placeholder="Paste the reinsurer's email — the AI reads the written or signed line it states." /></label>
          <div className="toolbar">
            <button type="button" className="np-green-pill" disabled={busy || !from.trim() || !body.trim()} data-testid="paste-read" onClick={readPasted}>Read this email</button>
          </div>
        </div>
      )}
      {result?.outcome?.skipped?.length > 0 && (
        <ul className="pd-list muted small">
          {result.outcome.skipped.map((x, i) => <li key={i}>{x.from}: {x.reason}</li>)}
        </ul>
      )}
    </div>
  );
}

function LineHistory({ changes }) {
  const [open, setOpen] = useState(false);
  if (!changes?.length) return null;
  const fmtState = (st) => (st ? `${pct(st.written_pct)}${st.to_stand ? ' to stand' : ''}${st.source === 'ai' ? ' (AI)' : ''}` : '—');
  return (
    <StructCard
      title="Every change to the lines"
      hint="Who changed which line, when, and from what to what — a line the AI read, a broker's override, an acceptance, a line cleared. Kept for good."
      actions={<button type="button" className="np-struct-btn" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : `Show ${changes.length}`}</button>}
    >
      {open && (
        <div className="np-table-wrap">
          <table className="np-struct-table fp-changes" data-testid="line-changes">
            <thead><tr><th>When</th><th>Who</th><th>Market</th><th>Line</th><th>What</th><th>Before</th><th>After</th><th>Note</th></tr></thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.id}>
                  <td className="small">{when(c.changed_at)}</td>
                  <td>{c.changed_by_name || '—'}{c.source === 'ai' ? <span className="fp-ai">AI</span> : null}</td>
                  <td>{c.market_name}</td>
                  <td className="small">{c.term_key}</td>
                  <td>{CHANGE_LABEL[c.action] || c.action}</td>
                  <td>{fmtState(c.before_state)}</td>
                  <td><b>{fmtState(c.after_state)}</b></td>
                  <td className="small muted">{c.note || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </StructCard>
  );
}

function Lines({ placementId, data, canEdit, busy, act, setNote }) {
  const { final, markets, lines, signing } = data;
  const terms = final.terms || [];
  const frozen = final.status === 'confirmed';
  const saved = !!final.id && terms.length > 0;

  // The markets on the sheet: any with a line, any the FOT went to, any on the negotiation, plus one added by hand.
  const fotMarkets = new Set((data.emails || []).filter((e) => e.kind === 'fot').flatMap((e) => (e.recipients || []).map((r) => r.market_id)));
  const [added, setAdded] = useState([]);
  const sheetMarkets = useMemo(() => markets.filter((m) => lines.some((l) => l.market_id === m.market_id) || fotMarkets.has(m.market_id) || m.on_negotiation || added.includes(m.market_id)),
    [markets, lines, added]); // eslint-disable-line react-hooks/exhaustive-deps
  const [edits, setEdits] = useState({}); // `${market_id}|${key}` -> { written_pct, to_stand }
  const cell = (marketId, key) => {
    const e = edits[`${marketId}|${key}`];
    const l = lines.find((x) => x.market_id === marketId && x.term_key === key);
    return {
      written_pct: e?.written_pct ?? (l ? l.written_pct : ''), to_stand: e?.to_stand ?? !!l?.to_stand,
      signed_pct: l?.signed_pct ?? null, status: l?.status, source: l?.source || 'broker', ai_read: l?.ai_read || null, edited: !!e,
    };
  };
  const setCell = (marketId, key, patch) => setEdits((cur) => ({ ...cur, [`${marketId}|${key}`]: { ...cell(marketId, key), ...patch } }));

  const save = () => act(async () => {
    const payload = Object.entries(edits).map(([k, v]) => {
      const [market_id, term_key] = k.split('|');
      return { market_id, term_key, written_pct: v.written_pct === '' ? 0 : Number(v.written_pct), to_stand: !!v.to_stand };
    });
    await api('PUT', `/placements/${placementId}/final/lines`, { lines: payload });
    setEdits({});
    setNote('Lines saved and signed down to the order.');
  });
  const accept = (marketId, key) => act(async () => {
    await api('POST', `/placements/${placementId}/final/lines/accept`, { market_id: marketId, term_key: key });
    setNote('Line accepted as the AI read it — it is now the broker\'s.');
  });
  const confirm = () => act(async () => {
    const r = await api('POST', `/placements/${placementId}/final/confirm`, {});
    setNote(`Shares confirmed. ${r.email ? `Confirmations sent to ${r.email.delivered} underwriter${r.email.delivered === 1 ? '' : 's'}.` : 'No underwriter address to confirm to.'}`);
  });
  const aiLines = lines.filter((l) => l.source === 'ai').length;

  return (
    <>
      <StructCard
        title="Written and signed lines"
        hint="What each market wrote on each line of the final terms. The AI reads the reinsurers' emails and enters the lines they state, marked AI until you accept or override them; a figure you type is yours. Over 100% written signs down pro rata — a line marked to stand keeps its written share."
        actions={canEdit && !frozen && (
          <select className="fi" style={{ width: 220 }} value="" onChange={(e) => { if (e.target.value) setAdded((a) => [...a, e.target.value]); }} data-testid="add-line-market">
            <option value="">＋ Add a market…</option>
            {markets.filter((m) => !sheetMarkets.some((s) => s.market_id === m.market_id)).map((m) => <option key={m.market_id} value={m.market_id}>{m.market_name}</option>)}
          </select>
        )}
        notice={!saved ? 'Save the final terms on the Final Quote tab first.' : aiLines ? `${aiLines} line${aiLines === 1 ? '' : 's'} entered by the AI from email await your acceptance or override.` : undefined}
      >
        {saved && !frozen && <ReadFromEmails placementId={placementId} busy={busy} act={act} setNote={setNote} canEdit={canEdit} />}
        {saved && (
          <div className="np-table-wrap" style={{ marginTop: 10 }}>
            <table className="np-struct-table fp-lines" data-testid="final-lines">
              <thead>
                <tr>
                  <th>Market</th>
                  {terms.map((t) => <th key={t.key} colSpan={2}>{t.structure_label} · {t.label}</th>)}
                </tr>
                <tr>
                  <th />
                  {terms.map((t) => <React.Fragment key={t.key}><th className="small">Written %</th><th className="small">Signed %</th></React.Fragment>)}
                </tr>
              </thead>
              <tbody>
                {sheetMarkets.map((m) => (
                  <tr key={m.market_id} data-testid={`line-${m.market_id}`}>
                    <td className="neg-sub-market">{m.market_name}</td>
                    {terms.map((t) => {
                      const c = cell(m.market_id, t.key);
                      const ai = c.source === 'ai' && !c.edited;
                      return (
                        <React.Fragment key={t.key}>
                          <td className={ai ? 'fp-cell--ai' : ''} title={ai && c.ai_read ? `AI read from ${c.ai_read.from || 'email'}: ${c.ai_read.evidence || c.ai_read.summary || ''}` : undefined}>
                            <span className="fp-cell">
                              <input className="fi" style={{ width: 80 }} value={c.written_pct} disabled={!canEdit || frozen} placeholder="0"
                                onChange={(e) => setCell(m.market_id, t.key, { written_pct: e.target.value })} aria-label={`${m.market_name} written ${t.label}`} />
                              <label className="small" title="To stand: keeps its written share when signing down">
                                <input type="checkbox" checked={c.to_stand} disabled={!canEdit || frozen} onChange={(e) => setCell(m.market_id, t.key, { to_stand: e.target.checked })} /> stand
                              </label>
                              {ai && (
                                <>
                                  <span className="fp-ai" data-testid="line-ai">AI</span>
                                  {canEdit && !frozen && (
                                    <button type="button" className="np-struct-btn" disabled={busy} data-testid="accept-line" title="Accept the line as the AI read it" onClick={() => accept(m.market_id, t.key)}>Accept</button>
                                  )}
                                </>
                              )}
                            </span>
                          </td>
                          <td className={c.status === 'signed' ? 'fp-signed' : ''}>
                            {c.signed_pct != null ? pct(c.signed_pct) : '—'}
                            {c.status === 'signed' && <span className="neg-sub-contact">signed</span>}
                          </td>
                        </React.Fragment>
                      );
                    })}
                  </tr>
                ))}
                {!sheetMarkets.length && <tr><td colSpan={1 + terms.length * 2} className="muted">No markets yet — send the firm order terms, or add a market above.</td></tr>}
              </tbody>
              <tfoot>
                <tr>
                  <td><b>Total</b></td>
                  {terms.map((t) => {
                    const s = signing[t.key];
                    return (
                      <React.Fragment key={t.key}>
                        <td><b>{s ? pct(s.written_total) : '—'}</b></td>
                        <td>
                          <b>{s ? pct(s.signed_total) : '—'}</b>
                          {s && s.state === 'OVERSUBSCRIBED' && <span className="neg-sub-contact">signed down ×{fmt(s.signing_factor)}</span>}
                          {s && s.state === 'UNDERSUBSCRIBED' && <span className="neg-sub-contact">short {pct(s.shortfall)}</span>}
                          {s && s.state === 'EXACT' && <span className="neg-sub-contact">placed</span>}
                        </td>
                      </React.Fragment>
                    );
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {canEdit && saved && !frozen && (
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={busy || !Object.keys(edits).length} data-testid="save-lines" onClick={save}>{busy ? 'Saving…' : 'Save lines'}</button>
            <button type="button" className="np-green-pill" disabled={busy || !lines.length || Object.keys(edits).length > 0} data-testid="confirm-shares"
              title={Object.keys(edits).length ? 'Save the lines first' : 'Marks every line signed at its signed share and sends each underwriter their confirmation'}
              onClick={confirm}>
              Confirm shares &amp; send confirmations
            </button>
          </div>
        )}
        {frozen && <div className="np-struct-notice">Shares confirmed {when(final.confirmed_at)}{final.confirmed_by_name ? ` by ${final.confirmed_by_name}` : ''} — every line is signed.</div>}
      </StructCard>
      <LineHistory changes={data.line_changes} />
      <SentEmails emails={(data.emails || []).filter((e) => e.kind !== 'fot')} />
    </>
  );
}

/* ── The screens ── */

/**
 * @param stage 'quote' — the Final Quote: the final terms and who leads;
 *              'placement' — the Final Placement: the email and the lines.
 */
export default function FinalPlacement({ placementId, canEdit, stage = 'placement' }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('email');
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api('GET', `/placements/${placementId}/final`).then(setData).catch(setError), [placementId]);
  useEffect(() => { load(); }, [load]);

  async function act(fn) {
    setBusy(true); setError(null); setNote(null);
    try { await fn(); await load(); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  if (!data) return <div className="muted" style={{ padding: 12 }}>{error ? error.message : 'Loading…'}</div>;
  const { final } = data;
  const lead = final.lead_reinsurer_name ? ` · led by ${final.lead_reinsurer_name}` : '';
  const standing = <><b>{STATUS_LABEL[final.status] || final.status}</b>{final.lead_broker ? ` · lead broker ${final.lead_broker}` : ''}{lead}</>;

  if (stage === 'quote') {
    return (
      <section className="np-struct-card rp fp" data-testid="final-quote">
        <div className="np-struct-card-header">
          <div>
            <div className="np-struct-card-h2">Final Quote</div>
            <div className="np-struct-card-hint">
              The final terms the placement is done on — picked from the quotes line by line when we lead, entered when another broker does — and who leads it. {standing}
            </div>
          </div>
        </div>
        {error && <div className="ing-error">{error.message || 'Failed'}</div>}
        {note && <div className="np-struct-notice" data-testid="final-note">{note}</div>}
        <Details key={final.updated_at || 'new'} data={data} canEdit={canEdit} busy={busy}
          onSave={(body) => act(async () => { await api('PUT', `/placements/${placementId}/final`, body); setNote('Final terms saved.'); })} />
      </section>
    );
  }

  return (
    <section className="np-struct-card rp fp" data-testid="final-placement">
      <div className="np-struct-card-header">
        <div>
          <div className="np-struct-card-h2">Final Placement</div>
          <div className="np-struct-card-hint">
            The firm order terms to the underwriters who write it — with the approved renewal pack as Excel and PDF, or a pack uploaded with a reason — and the written and signed lines, read off the reinsurers' emails by the AI and confirmed by the broker. {standing}
          </div>
        </div>
        <div className="np-struct-card-actions">
          <span className="rp-viewswitch" role="tablist">
            <button type="button" className={tab === 'email' ? 'on' : ''} onClick={() => setTab('email')}>1 · Email</button>
            <button type="button" className={tab === 'lines' ? 'on' : ''} onClick={() => setTab('lines')}>2 · Lines</button>
          </span>
        </div>
      </div>
      {error && <div className="ing-error">{error.message || 'Failed'}</div>}
      {note && <div className="np-struct-notice" data-testid="final-note">{note}</div>}
      {!(final.terms || []).length && (
        <div className="np-struct-notice">No final terms yet — capture them on the Final Quote tab first.</div>
      )}

      {tab === 'email' && <Email placementId={placementId} data={data} canEdit={canEdit} busy={busy} act={act} setNote={setNote} />}
      {tab === 'lines' && <Lines placementId={placementId} data={data} canEdit={canEdit} busy={busy} act={act} setNote={setNote} />}
    </section>
  );
}
