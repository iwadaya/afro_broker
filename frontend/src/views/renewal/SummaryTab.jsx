import React, { useState } from 'react';
import { api } from '../../api.js';
import { StatusPill, Pill, ErrorBanner, fmtStamp, providerLabel } from '../../components.jsx';
import {
  ROLE_LABEL, ROLE_TONE, PacksPanel, PipelinePanel, DetailsPanel, StageEmpty,
} from './panels.jsx';
import { useToast } from '../../toast.jsx';
import { stageOf } from './stages.js';

/* ── What the draft says, and what it does not ──────────────────────────
   Every figure on the summary is read from `result`. Where the model left a
   field empty — the packs did not say — the cell shows the flag, never a
   guess. Drafts made before the programme extraction existed carry none of
   programme / layers / experience / trace; they render the flags too, with
   a note that a re-run fills them in. */

const KIND = {
  missing: ['grey', 'Missing'],
  conflict: ['red', 'Conflict'],
  judgement: ['gold', 'Judgement'],
  unreadable: ['red', 'Unreadable'],
  check: ['gold', 'Check'],
};

/** The items for broker review: the draft's flags, else the older data_quality list. */
export function broker_flags(result) {
  if (result?.flags?.length) return result.flags;
  return (result?.data_quality || []).map((claim) => ({ kind: 'check', claim, source: '' }));
}

function Missing({ what = 'Not in the pack' }) {
  return <span className="rpa-missing" title="The packs do not state this — flagged, not filled">{what}</span>;
}

/** A figure, or the flag where the packs were silent. */
function Figure({ value }) {
  const v = value == null ? '' : String(value).trim();
  return v ? <>{v}</> : <Missing />;
}

function Paragraphs({ text }) {
  return String(text || '').split(/\n{2,}/).filter(Boolean).map((p, i) => <p key={i}>{p}</p>);
}

/**
 * Prose the broker may correct in place. Saving goes through the summary
 * edit route, which re-flags the draft — the banner says so before the
 * broker commits.
 */
function EditableProse({ value, field, label, canEdit, verified, onSaved, analysisId, placeholder }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('PATCH', `/renewal-analyses/${analysisId}/summary`, { [field]: draft });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="rpa-prose-edit">
        <textarea
          className="input"
          rows={6}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={label}
        />
        <div className="rpa-edit-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !draft.trim()} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
          {verified && <span className="muted small">Saving re-flags the summary as unverified.</span>}
        </div>
        <ErrorBanner error={error} />
      </div>
    );
  }
  return (
    <div className="rpa-prose-block">
      <div className="rpa-prose">
        {String(value || '').trim() ? <Paragraphs text={value} /> : <p><Missing what={placeholder} /></p>}
      </div>
      {canEdit && (
        <button
          type="button"
          className="btn btn-ghost btn-sm rpa-prose-editbtn"
          onClick={() => { setDraft(String(value || '')); setEditing(true); }}
        >
          Edit
        </button>
      )}
    </div>
  );
}

/** How far the upload covers the house skeleton, for the section's lede. */
function packCoverage(sections = []) {
  const count = (s) => sections.filter((x) => x.status === s).length;
  return { total: sections.length, supplied: count('supplied'), partial: count('partial'), missing: count('missing') };
}

/**
 * 02 AI summary — the two-page renewal summary the model drafted, behind the
 * broker's sign-off. The banner is the gate: nothing goes to market until a
 * broker has read the draft against the packs and signed it off on the
 * record, and any edit to the draft re-flags it.
 */
export default function SummaryTab({ shared }) {
  const { analysis: a, result, analysing, role, setTab, reload } = shared;
  const stage = stageOf('summary');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!result) {
    const uploaded = a.documents.length > 0;
    return (
      <>
        {analysing && <PipelinePanel shared={shared} />}
        <StageEmpty
          stage={stage}
          title={analysing ? 'The packs are being read'
            : uploaded ? 'No summary drafted yet' : 'Nothing to summarise yet'}
          note={analysing
            ? 'The draft lands here when the run finishes — usually a minute or two for a two-pack analysis — flagged unverified until a broker has read it.'
            : uploaded
              ? `${a.documents.length === 1 ? 'One pack is' : `${a.documents.length} packs are`} uploaded. Run the AI analysis on the Renewal pack tab and the draft lands here for review.`
              : 'Upload the cedant’s packs on the Renewal pack tab and run the AI analysis; the draft lands here for review.'}
        >
          {!analysing && (
            <button type="button" className="btn btn-secondary" onClick={() => setTab('pack')}>
              Open the renewal pack
            </button>
          )}
        </StageEmpty>
      </>
    );
  }

  const verified = Boolean(a.verified_at);
  const canSign = role.canBroke;
  const toast = useToast();
  const prog = result.programme || {};
  const layers = result.layers || [];
  const experience = result.experience || [];
  const changes = result.changes || [];
  const flags = broker_flags(result);
  const trace = result.trace || [];
  const extracted = Boolean(result.programme);
  const coverage = packCoverage(result.standard_pack);

  async function signOff(on) {
    setBusy(true);
    setError(null);
    try {
      await api(on ? 'POST' : 'DELETE', `/renewal-analyses/${a.id}/verify`);
      reload();
      toast(on ? 'Summary verified and signed off — the market email is open.' : 'Sign-off withdrawn — the summary is a draft again.');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const facts = [
    ['Cedant', a.cedant_name],
    ['Class', a.class_of_business],
    ['Inception', prog.inception],
    ['Currency', prog.currency],
    ['Programme', prog.structure],
    ['Layers', prog.layer_count],
    ['EPI', prog.epi],
    ['Deposit premium', prog.deposit_premium],
  ];

  return (
    <>
      {/* The gate. Dark and reversed while a check is owed; the tint once given. */}
      <div className={`rpa-verify${verified ? ' is-verified' : ''}`}>
        <span className="rpa-verify-chip">{verified ? 'Verified' : 'Unverified draft'}</span>
        <div className="rpa-verify-text">
          <div className="rpa-verify-title">
            {verified
              ? `Signed off by ${a.verified_by_name || 'a broker'} · ${fmtStamp(a.verified_at)}`
              : 'AI draft — not yet checked against the packs'}
          </div>
          <div className="rpa-verify-sub">
            {verified
              ? 'Locked for distribution. Any edit re-flags the summary as unverified.'
              : `Nothing can be sent to the market until a broker has verified this summary.${
                flags.length ? ` ${flags.length} item${flags.length === 1 ? ' is' : 's are'} flagged for review.` : ''
              }`}
          </div>
        </div>
        <div className="rpa-verify-actions">
          {verified ? (
            <>
              <button type="button" className="btn btn-primary" onClick={() => setTab('email')}>
                Continue to market email
              </button>
              {canSign && (
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => signOff(false)}>
                  Withdraw sign-off
                </button>
              )}
            </>
          ) : canSign ? (
            <button type="button" className="btn btn-primary" disabled={busy || analysing} onClick={() => signOff(true)}>
              {busy ? 'Signing off…' : 'Verify & sign off'}
            </button>
          ) : (
            <span className="rpa-verify-note">A broker signs this off.</span>
          )}
        </div>
      </div>
      <ErrorBanner error={error} />

      <div className="rpa-doc-grid">
        <div className="rpa-main">
          {/* A re-run keeps the standing summary on screen underneath the
              pipeline — the old draft is still the one in force until the new
              one lands. */}
          {analysing && <PipelinePanel shared={shared} />}

          <article className="blueprint rpa-doc">
            <header className="rpa-doc-head">
              <div>
                <div className="kicker accent">
                  Renewal summary · 2 pages · {a.documents.length} {a.documents.length === 1 ? 'pack' : 'packs'} read
                </div>
                <h2 className="rpa-doc-title">
                  {a.cedant_name}
                  <span>{String(prog.treaty_name || '').trim() || `${a.treaty_type} — ${a.class_of_business}`}</span>
                </h2>
              </div>
              <div className="rpa-doc-meta">
                <div>Broker: {a.created_by_name || '—'}</div>
                {a.analysed_at && <div>Drafted {fmtStamp(a.analysed_at)}</div>}
                {a.provider && <div>{providerLabel(a.provider)} · {a.model}</div>}
              </div>
            </header>

            {!extracted && (
              <p className="rpa-doc-note">
                This draft predates the programme extraction: the fact grid, layer schedule,
                experience and trace are not on it. Re-run the analysis to fill them from the packs.
              </p>
            )}

            <div className="rpa-facts">
              {facts.map(([k, v]) => (
                <div key={k} className="rpa-fact">
                  <div className="rpa-fact-k">{k}</div>
                  <div className="rpa-fact-v"><Figure value={v} /></div>
                </div>
              ))}
            </div>

            <section className="rpa-doc-section">
              <h3 className="rpa-doc-h">Programme</h3>
              <EditableProse
                value={prog.prose}
                field="programme_prose"
                label="Programme"
                placeholder="No programme paragraph on this draft"
                canEdit={canSign && !analysing}
                verified={verified}
                analysisId={a.id}
                onSaved={reload}
              />
            </section>

            <section className="rpa-doc-section">
              <h3 className="rpa-doc-h">Layer schedule</h3>
              {layers.length > 0 ? (
                <div className="table-wrap">
                  <table className="table rpa-layers">
                    <thead>
                      <tr>
                        <th>Layer</th><th>Cover</th><th className="r">Deposit premium</th><th className="r">ROL</th>
                        <th>Reinstatements</th><th className="r">Expiring line</th>
                      </tr>
                    </thead>
                    <tbody>
                      {layers.map((l, i) => (
                        <tr key={i}>
                          <td className="rpa-layer-name"><Figure value={l.name} /></td>
                          <td className="num"><Figure value={l.cover} /></td>
                          <td className="r num"><Figure value={l.deposit_premium} /></td>
                          <td className="r num"><Figure value={l.rol} /></td>
                          <td className="rpa-book-class"><Figure value={l.reinstatements} /></td>
                          <td className="r num rpa-book-sub"><Figure value={l.expiring_line} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="rpa-doc-empty"><Missing what="No layer schedule in the packs" /></p>
              )}
            </section>

            <div className="rpa-doc-pair">
              <section className="rpa-doc-section">
                <h3 className="rpa-doc-h">Changes on expiring</h3>
                {changes.length > 0 ? (
                  <ol className="rpa-changes">
                    {changes.map((c, i) => (
                      <li key={i} className="rpa-change">
                        <span className="rpa-change-n num">{String(i + 1).padStart(2, '0')}</span>
                        <div className="rpa-change-body">
                          <div className="rpa-change-line">{c.change}</div>
                          <div className="rpa-change-head">
                            {c.area && <span className="rpa-change-area">{c.area}</span>}
                            {c.direction && <StatusPill value={c.direction} />}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="rpa-doc-empty"><Missing what="No changes identified — one pack only, or the packs match" /></p>
                )}
              </section>

              <section className="rpa-doc-section">
                <h3 className="rpa-doc-h">Loss experience</h3>
                {experience.length > 0 ? (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr><th>Year</th><th className="r">Premium</th><th className="r">Incurred</th><th className="r">LR</th></tr>
                      </thead>
                      <tbody>
                        {experience.map((e, i) => (
                          <tr key={i}>
                            <td className="num"><Figure value={e.year} /></td>
                            <td className="r num"><Figure value={e.premium} /></td>
                            <td className="r num"><Figure value={e.incurred} /></td>
                            <td className="r num rpa-lr"><Figure value={e.loss_ratio} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="rpa-doc-empty"><Missing what="No loss experience in the packs" /></p>
                )}
                {String(result.experience_note || '').trim() && (
                  <p className="rpa-experience-note">{result.experience_note}</p>
                )}
              </section>
            </div>

            {/* ── The fuller review, after the two pages ─────────────────── */}
            <div className="rpa-doc-appendix">
              <span className="kicker accent">Working notes · the full review</span>
            </div>

            {result.standard_pack?.length > 0 && (
              <section className="rpa-doc-section">
                <h3 className="rpa-doc-h">Standardised renewal pack</h3>
                <p className="rpa-standard-lede">
                  The upload mapped onto the house pack skeleton — the same sections the pack builder
                  carries and refreshes. {coverage.supplied} of {coverage.total} supplied
                  {coverage.partial > 0 && `, ${coverage.partial} partial`}
                  {coverage.missing > 0 && `, ${coverage.missing} not in the packs`}.
                </p>
                <div className="blueprint secrows rpa-standard">
                  {result.standard_pack.map((s, i) => (
                    <div key={s.section} className={`secrow rpa-standard-row${s.status === 'missing' ? ' omit' : ''}`}>
                      <span className="secidx">{String(i + 1).padStart(2, '0')}</span>
                      <div className="secmain">
                        <div className="rpa-standard-head">
                          <span className="secname">{s.section}</span>
                          <StatusPill value={s.status} />
                        </div>
                        {s.summary && <div className="secnote rpa-standard-summary">{s.summary}</div>}
                        {s.key_figures?.length > 0 && (
                          <dl className="rpa-standard-figures">
                            {s.key_figures.map((f, j) => (
                              <div key={j}><dt>{f.label}</dt><dd>{f.value}</dd></div>
                            ))}
                          </dl>
                        )}
                        {s.gap && (
                          <div className="rpa-standard-gap">
                            <span className="rpa-standard-gap-k">To obtain</span> {s.gap}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="rpa-doc-section">
              <h3 className="rpa-doc-h">Executive summary</h3>
              <EditableProse
                value={result.executive_summary}
                field="executive_summary"
                label="Executive summary"
                placeholder="No executive summary on this draft"
                canEdit={canSign && !analysing}
                verified={verified}
                analysisId={a.id}
                onSaved={reload}
              />
            </section>

            {result.pack_reviews?.length > 0 && (
              <section className="rpa-doc-section">
                <h3 className="rpa-doc-h">Pack commentary</h3>
                <div className="rpa-reviews">
                  {result.pack_reviews.map((r, i) => (
                    <section key={i} className="rpa-review">
                      <header className="rpa-review-head">
                        <span className="rpa-review-doc">{r.document}</span>
                        <Pill tone={ROLE_TONE[r.role] || 'neutral'}>{ROLE_LABEL[r.role] || r.role}</Pill>
                      </header>
                      <div className="rpa-review-prose"><Paragraphs text={r.commentary} /></div>
                      {r.key_figures?.length > 0 && (
                        <dl className="rpa-figures">
                          {r.key_figures.map((f, j) => (
                            <div key={j} className="rpa-figure"><dt>{f.label}</dt><dd>{f.value}</dd></div>
                          ))}
                        </dl>
                      )}
                    </section>
                  ))}
                </div>
              </section>
            )}

            {String(result.detailed_analysis || '').trim() && (
              <section className="rpa-doc-section">
                <h3 className="rpa-doc-h">Detailed analysis</h3>
                <div className="rpa-prose"><Paragraphs text={result.detailed_analysis} /></div>
              </section>
            )}

            {result.recommendations?.length > 0 && (
              <section className="rpa-doc-section">
                <h3 className="rpa-doc-h">Recommendations</h3>
                <ol className="rpa-recs">
                  {result.recommendations.map((r, i) => <li key={i}>{r}</li>)}
                </ol>
              </section>
            )}
          </article>
        </div>

        <aside className="rpa-aside">
          <section className="blueprint rpa-side">
            <div className="sechead">
              <h3 className="seclabel">Flagged for broker review</h3>
              <span className="kicker spacer">{flags.length}</span>
            </div>
            {flags.length === 0 ? (
              <p className="muted small">Nothing flagged — the packs answered every figure on the summary.</p>
            ) : (
              <ul className="rpa-flags">
                {flags.map((f, i) => {
                  const [tone, label] = KIND[f.kind] || KIND.check;
                  return (
                    <li key={i} className="rpa-flag">
                      <Pill tone={tone}>{label}</Pill>
                      <span className="rpa-flag-body">
                        <span>{f.claim}</span>
                        {f.source && <span className="rpa-flag-src">{f.source}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="muted small">
              The model reports what the packs do not say rather than filling the gap. Each of
              these is a question for the cedant or a check for the broker, not a finding.
            </p>
          </section>

          <section className="blueprint rpa-side">
            <div className="sechead">
              <h3 className="seclabel">Extraction trace</h3>
              <span className="kicker spacer">{trace.length}</span>
            </div>
            {trace.length > 0 ? (
              <dl className="rpa-trace">
                {trace.map((t, i) => (
                  <div key={i} title={t.value ? `${t.field}: ${t.value}` : t.field}>
                    <dt>{t.field}</dt>
                    <dd>{t.source || <Missing what="No source" />}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="muted small">
                No trace on this draft — re-run the analysis to map each figure to its sheet, cell or page.
              </p>
            )}
            <p className="muted small">
              Every figure on the summary links back to a cell or page in the pack. Nothing is
              inferred where the pack is silent — gaps are flagged, not filled.
            </p>
          </section>

          <PacksPanel shared={shared} compact />
          <DetailsPanel shared={shared} />
        </aside>
      </div>
    </>
  );
}
