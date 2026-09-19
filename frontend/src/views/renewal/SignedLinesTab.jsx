import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useFetch, ErrorBanner, Pill, fmtMoney, fmtStamp } from '../../components.jsx';
import { useHasRole } from '../../auth.jsx';
import { useToast } from '../../toast.jsx';
import { StageEmpty } from './panels.jsx';
import { stageOf } from './stages.js';

const pct = (v) => (v == null ? 'nil' : `${Number(v).toFixed(2)}%`);

/**
 * 05 Signed lines — the release, and the signing advice: one template for
 * the whole market, merged per reinsurer with its own layer / written /
 * signed / premium rows so no market sees another's line. Sent through the
 * final placement module and audited per recipient; declinatures get the
 * separate courtesy note.
 */
export default function SignedLinesTab({ shared }) {
  const { analysis: a, setTab } = shared;
  const stage = stageOf('signed');
  if (!a.placement) {
    return (
      <StageEmpty
        stage={stage}
        title="Not linked to a placement"
        note="Lines are signed on the layers of the placement this pack belongs to. Link it to its placement on the Renewal pack tab."
      >
        <button type="button" className="btn btn-secondary" onClick={() => setTab('pack')}>Link a placement</button>
      </StageEmpty>
    );
  }
  return <SignedLines shared={shared} />;
}

function SignedLines({ shared }) {
  const { analysis: a, setTab, reload: reloadRecord } = shared;
  const canSend = useHasRole('broker', 'admin');
  const ctx = useFetch('GET', `/renewal-analyses/${a.id}/signed-lines`, [a.id, a.placement_id]);
  const c = ctx.data;
  const stage = stageOf('signed');

  const [seededFor, setSeededFor] = useState(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const toast = useToast();

  useEffect(() => {
    if (!c?.template || seededFor === a.id) return;
    setSubject(c.template.subject);
    setBody(c.template.body);
    setSeededFor(a.id);
  }, [c, a.id, seededFor]);

  if (ctx.error) return <ErrorBanner error={ctx.error} />;
  if (!c) return <p className="muted">Reading the signed lines…</p>;
  if (!c.ready) {
    return (
      <StageEmpty
        stage={stage}
        title={!c.placement ? 'Not linked to a placement' : c.layers.length === 0 ? `No layers on ${c.placement.reference} yet` : 'The lines are not yet released'}
        note={c.blockers.join(' ')}
      >
        {c.placement && c.layers.length > 0 && (
          <button type="button" className="btn btn-secondary" onClick={() => setTab('responses')}>Open the responses</button>
        )}
      </StageEmpty>
    );
  }

  const chosen = c.recipients.find((r) => r.market_id === preview) || c.recipients[0] || null;
  const sentCount = c.recipients.filter((r) => r.sent?.status === 'sent').length;

  async function act(label, fn, { then } = {}) {
    setBusy(label);
    setError(null);
    try {
      const out = await fn();
      ctx.reload();
      reloadRecord();
      if (then) then(out);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const send = () => act('send', () => api('POST', `/renewal-analyses/${a.id}/signed-lines/send`, { subject, body }), {
    then: (out) => {
      toast(`Signing advice sent to ${out.email.delivered} of ${out.recipients.length} reinsurer${out.recipients.length === 1 ? '' : 's'}, each merged with its own lines.${
        out.skipped.length ? ` No underwriter on file for ${out.skipped.join(', ')}.` : ''}`);
      setTab('claims');
    },
  });
  const courtesy = () => act('courtesy', () => api('POST', `/renewal-analyses/${a.id}/signed-lines/courtesy`, {}), {
    then: (out) => toast(`Courtesy note sent to ${out.email.delivered} declinature${out.email.delivered === 1 ? '' : 's'}.`),
  });

  return (
    <div className="rpa-adv-grid">
      <section className="blueprint rpa-mail">
        <div className="sechead">
          <h3 className="seclabel">Signing advice</h3>
          <span className="kicker accent spacer">One template · merged per reinsurer</span>
        </div>
        {c.advice && (
          <div className="rpa-mail-state is-sent">
            <Pill tone="green">Confirmed</Pill>
            <div className="rpa-mail-state-text">
              <div className="rpa-mail-state-title">
                Signing advice issued {fmtStamp(c.advice.sent_at)} · {c.advice.delivered} of {c.advice.recipients} reached
              </div>
              <div className="rpa-mail-state-sub">Each reinsurer received its own lines. Send again below only to re-issue.</div>
            </div>
          </div>
        )}
        {c.warnings?.map((w) => <div key={w} className="warn banner">{w}</div>)}

        <div className="rpa-mail-row">
          <label className="rpa-mail-k" htmlFor="rpa-adv-subject">Subject</label>
          <input id="rpa-adv-subject" className="rpa-mail-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <textarea
          className="input rpa-mail-body rpa-adv-body"
          aria-label="Signing advice body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />

        <div className="rpa-merge">
          <div className="kicker accent">Merge block — preview for {chosen ? chosen.name : '—'}</div>
          {chosen ? (
            <div className="table-wrap">
              <table className="table rpa-merge-table">
                <thead>
                  <tr><th>Layer</th><th className="r">Written</th><th className="r">Signed</th><th className="r">Signed premium</th></tr>
                </thead>
                <tbody>
                  {c.layers.map((l) => {
                    const line = chosen.lines.find((x) => x.layer_id === l.id);
                    return (
                      <tr key={l.id}>
                        <td>{l.name}{l.cover && l.cover !== l.name ? <span className="muted"> — {l.cover}</span> : null}</td>
                        <td className="r num">{line ? pct(line.written_pct) : 'nil'}</td>
                        <td className="r num rpa-merge-signed">{line ? pct(line.signed_pct) : 'nil'}</td>
                        <td className="r num">{line?.premium_signed != null ? `${c.placement.currency} ${fmtMoney(line.premium_signed, 2)}` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <p className="muted small">No reinsurer has a signed line yet.</p>}
          <p className="muted small rpa-merge-note">
            Replaces <code>{'{{lines}}'}</code> in the body for each reinsurer at send; the treatment reads: {c.treatment}
          </p>
        </div>

        <div className="rpa-mail-actions">
          <button type="button" className="btn btn-primary rpa-mail-send" disabled={!canSend || busy || !c.recipients.length} onClick={send}>
            {busy === 'send' ? 'Sending…' : `${c.advice ? 'Re-send' : 'Send'} to ${c.recipients.length} reinsurer${c.recipients.length === 1 ? '' : 's'}`}
          </button>
          <span className="rpa-resp-hint">
            Each reinsurer receives its own lines only. {sentCount ? `${sentCount} of ${c.recipients.length} already sent.` : 'Nothing has gone out yet.'}
            {c.mail_transport === 'stub' ? ' Recorded only — no mailbox is connected.' : ''}
          </span>
        </div>
        <ErrorBanner error={error} />
      </section>

      <section className="blueprint rpa-panel">
        <div className="sechead">
          <h3 className="seclabel">Recipients</h3>
          <span className="kicker spacer">{c.recipients.length}</span>
        </div>
        <p className="muted small rpa-panel-lede">
          Every reinsurer with a signed line on any layer. Declinatures receive a separate courtesy note.
        </p>
        <div className="table-wrap">
          <table className="table rpa-recipients">
            <thead>
              <tr><th>Reinsurer</th><th className="r">Layers</th><th className="r">Signed premium</th><th>Sent</th></tr>
            </thead>
            <tbody>
              {c.recipients.length === 0 && <tr><td colSpan="4" className="muted">No signed lines yet.</td></tr>}
              {c.recipients.map((r) => (
                <tr
                  key={r.market_id}
                  className={`rpa-recipient${chosen?.market_id === r.market_id ? ' is-preview' : ''}`}
                  onClick={() => setPreview(r.market_id)}
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPreview(r.market_id); } }}
                  aria-selected={chosen?.market_id === r.market_id}
                >
                  <td>
                    <div className="rpa-resp-name">{r.name}</div>
                    <div className="rpa-book-sub">{r.email || <span className="rpa-missing">No underwriter on file</span>}</div>
                  </td>
                  <td className="r num">{r.layers} of {r.layers_total}</td>
                  <td className="r num">{c.placement.currency} {fmtMoney(r.signed_premium)}</td>
                  <td>
                    {r.sent?.status === 'sent'
                      ? <Pill tone="green">Sent {fmtStamp(r.sent.at)}</Pill>
                      : r.sent?.status === 'failed'
                        ? <Pill tone="red">Failed</Pill>
                        : <Pill tone="neutral">Queued</Pill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="sechead rpa-declinatures-head">
          <h3 className="seclabel">Declinatures</h3>
          <span className="kicker spacer">{c.declinatures.length}</span>
        </div>
        {c.declinatures.length === 0 ? (
          <p className="muted small">No reinsurer declined every layer it was asked.</p>
        ) : (
          <>
            <ul className="rpa-declinatures">
              {c.declinatures.map((d) => (
                <li key={d.market_id}>
                  <span className="rpa-resp-name">{d.name}</span>
                  <span className="rpa-book-sub"> · {d.layers.join(', ')}{d.notes ? ` · ${d.notes}` : ''}</span>
                  <span className="rpa-declinature-sent">
                    {d.sent?.status === 'sent' ? <Pill tone="green">Note sent {fmtStamp(d.sent.at)}</Pill> : <Pill tone="neutral">Courtesy note queued</Pill>}
                  </span>
                </li>
              ))}
            </ul>
            {canSend && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={courtesy}>
                {busy === 'courtesy' ? 'Sending…' : 'Send the courtesy note'}
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
