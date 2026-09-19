import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useFetch, StatusPill, ErrorBanner, fmtDate } from '../components.jsx';
import { useScreenHead, useWorkspace, useRole } from '../shell.jsx';
import { useToast } from '../toast.jsx';
import { domicileMatches, countryOfDomicile, CATEGORY_LABELS } from '../refData.js';
import { useRefData, entryOf, RefOptions } from '../RefData.jsx';
// The wizard's line-of-business multi-select modal, reused so classes are
// picked the same way everywhere (a contract routinely covers several).
import { CobModal } from './treatyDetail.jsx';
import { ROLE_LABEL, fmtSize, fmtElapsed, fileToBase64 } from './renewal/panels.jsx';

const NEW_CEDANT = '__new__';

/** The upload limits until the API has said its own (it answers the same figures). */
const DEFAULT_LIMITS = { max_document_bytes: 15 * 1024 * 1024, max_total_bytes: 18 * 1024 * 1024, max_documents: 6 };

/**
 * What the desk does with a pack once it has one, stated on the intake panel
 * itself — including the boundary the AI does not cross. Reads / Drafts /
 * Never sends, from the placement-desk design.
 */
const CAPABILITIES = [
  {
    k: 'Reads',
    t: 'Layer schedules, EPI, retentions, terms and the loss experience — from PDFs, workbooks, images and CSV',
  },
  {
    k: 'Compares',
    t: 'The expiring pack against the current submission, change by change, quantified where the packs allow',
  },
  {
    k: 'Never invents',
    t: 'Gaps and inconsistencies are flagged for the broker, not filled in',
  },
];

/**
 * The two ways a renewal pack comes into being, asked on arrival at §02.
 *
 * Building by hand runs the placement workflow and ends on the pack builder;
 * uploading hands the cedant's own submission to the AI, which maps it onto
 * the same section skeleton the builder produces. Either way a broker ends
 * up with the same object.
 */
function PackChoice({ onUpload, onManual, onClose }) {
  return (
    <div className="cob-modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cob-panel rpa-choice-panel" role="dialog" aria-modal="true" aria-labelledby="rpa-choice-title" data-testid="rpa-pack-choice">
        <div className="renew-head">
          <div>
            <div className="renew-kicker">RENEWAL PACK</div>
            <div className="renew-title" id="rpa-choice-title">How is this pack being made?</div>
          </div>
          <button type="button" className="renew-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="rpa-choice-list">
          <button type="button" className="rpa-choice" onClick={onManual} data-testid="rpa-choice-manual">
            <span className="rpa-choice-k">Create manually</span>
            <span className="rpa-choice-t">
              Run the placement workflow — cedant, structure and layers — and finish on the pack
              builder, carrying and refreshing sections from the expiring pack.
            </span>
            <span className="rpa-choice-go">Start a placement →</span>
          </button>
          <button type="button" className="rpa-choice" onClick={onUpload} data-testid="rpa-choice-upload">
            <span className="rpa-choice-k">Upload a renewal pack</span>
            <span className="rpa-choice-t">
              Hand the cedant's submission to the AI. It is read, standardised onto the house
              section skeleton and reviewed — with whatever the cedant left out flagged.
            </span>
            <span className="rpa-choice-go">Quick or full →</span>
          </button>
        </div>
        <div className="rpa-choice-foot">
          Or close this and pick up an analysis already on the desk.
        </div>
      </div>
    </div>
  );
}

/**
 * Quick or full, asked once "Upload a renewal pack" is chosen.
 *
 * The two routes end on the same desk with the same record; the only
 * difference is who fills the intake form first. Quick hands the pack to
 * the AI, which reads the broker details off it — cedant, country, treaty
 * type, classes of business — for the broker to correct and add to. Full is
 * the manual route: the broker types them, and uploads the packs on the desk.
 */
function UploadModeChoice({ onQuick, onFull, onBack, onClose, aiConfigured }) {
  return (
    <div className="cob-modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cob-panel rpa-choice-panel" role="dialog" aria-modal="true" aria-labelledby="rpa-mode-title" data-testid="rpa-mode-choice">
        <div className="renew-head">
          <div>
            <div className="renew-kicker">UPLOAD A RENEWAL PACK</div>
            <div className="renew-title" id="rpa-mode-title">Quick or full renewal pack?</div>
          </div>
          <button type="button" className="renew-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="rpa-choice-list">
          <button type="button" className="rpa-choice" onClick={onQuick} data-testid="rpa-mode-quick">
            <span className="rpa-choice-k">Quick renewal pack</span>
            <span className="rpa-choice-t">
              Drop the cedant's pack first. The AI reads the broker details off it — cedant,
              country, treaty type and classes of business — and fills the form for you to correct
              and add to. The pack then goes onto the desk with the record.
            </span>
            <span className="rpa-choice-go">
              {aiConfigured === false
                ? 'No AI provider is configured here — the packs still upload with the record; the form is yours to fill →'
                : 'Read the pack with AI →'}
            </span>
          </button>
          <button type="button" className="rpa-choice" onClick={onFull} data-testid="rpa-mode-full">
            <span className="rpa-choice-k">Full renewal pack</span>
            <span className="rpa-choice-t">
              The manual route. Name the cedant, the class of business and the treaty type
              yourself, then upload the packs on the desk. Nothing is filled in for you.
            </span>
            <span className="rpa-choice-go">Enter the details →</span>
          </button>
        </div>
        <div className="rpa-choice-foot rpa-choice-foot--row">
          <span>Both routes end on the same desk — the only difference is who fills the form first.</span>
          <button type="button" className="rpa-linkbtn rpa-linkbtn--quiet" onClick={onBack}>← Back</button>
        </div>
      </div>
    </div>
  );
}

const ROLE_SHORT = { expiring: 'EXP', current: 'CUR', other: 'OTH' };

/**
 * Which years are on an analysis, short enough to sit under the pack count
 * without pushing the column into the status pill. The full words stay on the
 * cell's title, and the detail screen spells them out.
 */
function packRoles(roles = []) {
  const order = ['expiring', 'current', 'other'].filter((r) => roles.includes(r));
  const extra = roles.filter((r) => !ROLE_SHORT[r]);
  return {
    short: [...order.map((r) => ROLE_SHORT[r]), ...extra].join(' · '),
    title: [...order, ...extra].join(', '),
  };
}

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * Where a filled field came from, under the field itself (spec §2.1): the
 * model's confidence and the place it read, the pack's own words when
 * nothing on the list fitted, and "Corrected" once the broker has changed
 * it. `value` is what the model put in the field; `pick` its provenance.
 */
function AiMark({ pick, value, touched, note }) {
  if (touched) {
    return (
      <small className="rpa-ai-mark is-corrected">
        <b>Corrected</b>{value ? ` · the AI read “${value}”` : ' · the AI had nothing'}
      </small>
    );
  }
  if (!value) {
    return (
      <small className="rpa-ai-mark is-missing">
        <b>Not in the pack</b>
        {pick?.as_written ? ` · it says “${pick.as_written}”` : ''}
        {' — add it'}
      </small>
    );
  }
  return (
    <small className="rpa-ai-mark" title={pick?.source || undefined}>
      <b>AI · {pick?.confidence || 'low'}</b>
      {pick?.source ? ` · ${pick.source}` : ''}
      {note ? ` · ${note}` : ''}
    </small>
  );
}

/**
 * The quick route's intake object: the packs, dropped before anything is
 * typed, and the one call that reads the broker details off them. After the
 * read, each file carries the year the model took it for, as a select the
 * broker can move.
 */
function QuickIntake({
  files, onAdd, onRemove, onRole, limits, aiConfigured, aiKnown,
  reading, startedAt, now, onRead, read, error, onUseFull,
}) {
  const inputRef = useRef();
  const [over, setOver] = useState(false);
  const total = files.reduce((n, f) => n + f.file.size, 0);
  const tooBig = total > limits.max_total_bytes;
  const oversize = files.filter((f) => f.file.size > limits.max_document_bytes);
  const full = files.length >= limits.max_documents;
  const canRead = files.length > 0 && !tooBig && !oversize.length && !reading && aiConfigured !== false;

  return (
    <div className="rpa-quick" data-testid="rpa-quick">
      <div
        className={`rpa-dropzone rpa-dropzone--quick${over ? ' rpa-dropzone--active' : ''}`}
        role="presentation"
        data-testid="rpa-quick-dropzone"
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer?.files?.length) onAdd(e.dataTransfer.files);
        }}
      >
        <div className="rpa-dropzone-idle">
          {!files.length && <span className="rpa-dropzone-mark" aria-hidden="true" />}
          <div className="rpa-dropzone-title">
            {files.length ? 'Add another pack' : 'Drop the cedant\'s pack to begin'}
          </div>
          <div className="rpa-dropzone-hint">
            Usually the current submission, and the expiring one beside it · up to {limits.max_documents} files,{' '}
            {fmtSize(limits.max_document_bytes)} each and {fmtSize(limits.max_total_bytes)} together · PDFs preferred; images, Excel and text/CSV also read
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="rpa-file-input"
            data-testid="rpa-quick-input"
            onChange={(e) => { if (e.target.files?.length) onAdd(e.target.files); e.target.value = ''; }}
          />
          <button type="button" className="btn btn-secondary" disabled={full || reading} onClick={() => inputRef.current?.click()}>
            {files.length ? 'Choose another file' : 'Choose file'}
          </button>
        </div>
      </div>

      {files.length > 0 && (
        <ul className="rpa-quick-files">
          {files.map((f, i) => {
            const readDoc = read?.extraction?.documents?.find((d) => d.index === i + 1);
            return (
              <li key={f.key} className="rpa-quick-file" data-testid="rpa-quick-file">
                <span className="rpa-quick-file-name">{f.file.name}</span>
                <span className="rpa-quick-file-meta">
                  {fmtSize(f.file.size)} · {f.file.type || 'application/octet-stream'}
                  {f.file.size > limits.max_document_bytes && <> · <b className="rpa-quick-file-over">over the {fmtSize(limits.max_document_bytes)} limit</b></>}
                </span>
                {read ? (
                  <label className="rpa-quick-file-role" title={readDoc?.reason || undefined}>
                    <span className="sr-only">Pack role</span>
                    <select className="input" value={f.role} onChange={(e) => onRole(i, e.target.value)} disabled={reading}>
                      {Object.entries(ROLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <small className="rpa-ai-mark">
                      <b>AI</b>{readDoc?.year ? ` · ${readDoc.year}` : ''}{readDoc?.reason ? ` · ${readDoc.reason}` : ''}
                    </small>
                  </label>
                ) : (
                  <span className="rpa-quick-file-meta">{ROLE_LABEL[f.role]} — the AI confirms which year on reading</span>
                )}
                <button type="button" className="rpa-linkbtn" disabled={reading} onClick={() => onRemove(i)}>remove</button>
              </li>
            );
          })}
        </ul>
      )}

      {reading ? (
        <div className="rpa-read" data-testid="rpa-quick-reading">
          <div className="rpa-pipeline-bar" role="progressbar" aria-label="Reading the pack">
            <span className="rpa-pipeline-sweep" />
          </div>
          <div className="rpa-quick-file-meta">
            Reading the pack{startedAt ? ` · ${fmtElapsed(now - startedAt)}` : ''} — picking the cedant, its country,
            the treaty type and the classes of business, and telling which year each file is. Usually well under a minute.
          </div>
        </div>
      ) : (
        <div className="rpa-quick-actions">
          <button type="button" className="btn btn-primary" disabled={!canRead} onClick={onRead} data-testid="rpa-quick-read">
            {read ? 'Read the packs again' : 'Read the pack with AI'}
          </button>
          {aiKnown && aiConfigured === false && (
            <span className="rpa-packs-note" data-testid="rpa-quick-noai">
              No AI provider is configured on this deployment — set OPENAI_API_KEY to have the pack read.
              The packs still upload with the record; fill the form yourself, or{' '}
              <button type="button" className="rpa-linkbtn" onClick={onUseFull}>take the full route</button>.
            </span>
          )}
          {aiConfigured !== false && !files.length && (
            <span className="rpa-packs-note">Drop a pack, and the AI fills the form below from it.</span>
          )}
          {tooBig && (
            <span className="rpa-packs-note">
              Together the packs are over {fmtSize(limits.max_total_bytes)} — read the main pack first and add the rest on the desk.
            </span>
          )}
          {read && (
            <span className="rpa-packs-note" data-testid="rpa-quick-read-done">
              Read by {read.model || 'the AI'}. Every field below says where it came from — correct anything wrong, add what is missing.
            </span>
          )}
        </div>
      )}

      {read?.extraction?.flags?.length > 0 && (
        <ul className="rpa-read-flags">
          {read.extraction.flags.map((f, i) => (
            <li key={i}><b>{f.kind}</b> — {f.claim}{f.source ? <span className="rpa-quick-file-meta"> · {f.source}</span> : null}</li>
          ))}
        </ul>
      )}
      <ErrorBanner error={error} />
    </div>
  );
}

/**
 * Renewal packs (nav §02) — the desk, and the upload intake.
 *
 * Two columns, from the placement-desk design: the intake object on the left
 * (what the desk is about to be given, and what it will do with it), the
 * renewal book on the right (everything already on the desk this season).
 *
 * The client details still follow the Universe modelling tool's treaty-detail
 * flow: pick the country, then the cedant (from Broker IQ's own register,
 * filtered by country, with a new-cedant escape that also registers them),
 * then treaty type and class of business — dropdowns throughout. On the quick
 * route the AI fills those dropdowns from the pack first, and the broker
 * corrects them; on the full route the broker fills them.
 */
export default function RenewalAnalysis() {
  useScreenHead('RENEWAL PACK', 'Renewal packs', 'Build or upload');
  const analyses = useFetch('GET', '/renewal-analyses');
  const cedants = useFetch('GET', '/cedants?limit=200');
  const role = useRole();
  const ws = useWorkspace();
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();

  // Arriving on §02 asks the question; coming back from an analysis
  // (?book=1) goes straight to the book. Only a broker is offered the
  // choice — the other seats read.
  const [choosing, setChoosing] = useState(() => role.canBroke && params.get('book') !== '1');
  // Quick or full, asked once uploading is chosen. Full — the manual route —
  // is what the form is until the quick route is picked.
  const [pickingMode, setPickingMode] = useState(false);
  const [mode, setMode] = useState('full');

  // Whether an AI provider can read a pack in, and the upload limits — asked
  // once per visit, only for a seat that could upload.
  const intakeInfo = useFetch('GET', role.canBroke ? '/renewal-analyses/intake' : null, [role.canBroke]);
  const aiKnown = Boolean(intakeInfo.data);
  const aiConfigured = aiKnown ? (intakeInfo.data.providers || []).some((p) => p.configured) : null;
  const limits = intakeInfo.data?.limits || DEFAULT_LIMITS;

  const [countryId, setCountryId] = useState('');
  const [cedantId, setCedantId] = useState('');
  const [newCedantName, setNewCedantName] = useState('');
  const [treatyTypeId, setTreatyTypeId] = useState('');
  const [classIds, setClassIds] = useState([]);
  const [showCob, setShowCob] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null); // a record whose packs did not all upload

  // The quick route: the packs, the read, and which fields the broker has
  // moved since the model filled them.
  const [files, setFiles] = useState([]);
  const [reading, setReading] = useState(false);
  const [readStarted, setReadStarted] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [readError, setReadError] = useState(null);
  const [read, setRead] = useState(null);
  const [touched, setTouched] = useState({});

  useEffect(() => {
    if (!reading) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [reading]);

  // The same reference data the placement wizard reads, bound by row id.
  const ref = useRefData();
  const country = entryOf(ref.countries, countryId);
  const treatyType = entryOf(ref.treatyTypes, treatyTypeId)?.name || '';
  const cobs = classIds.map((id) => entryOf(ref.classes, id)?.name || id);
  const countryCedants = useMemo(
    () => (cedants.data || []).filter((c) => domicileMatches(c.domicile, country)),
    [cedants.data, country],
  );

  const cedantName = cedantId === NEW_CEDANT
    ? newCedantName.trim()
    : countryCedants.find((c) => c.id === cedantId)?.name || '';
  const ready = country && cedantName && treatyType && cobs.length > 0;

  /** A broker's change to a field the model filled is recorded as a correction. */
  const touch = (field) => { if (read) setTouched((t) => (t[field] ? t : { ...t, [field]: true })); };

  function addFiles(list) {
    const incoming = Array.from(list || []);
    setFiles((prev) => {
      const next = [...prev];
      for (const file of incoming) {
        if (next.length >= limits.max_documents) break;
        if (next.some((x) => x.file.name === file.name && x.file.size === file.size)) continue;
        // The first two are usually the two years; the model confirms on reading.
        const role = read || next.length > 1 ? 'other' : next.length === 0 ? 'expiring' : 'current';
        next.push({ key: `${file.name}-${file.size}-${Date.now()}-${next.length}`, file, role });
      }
      return next;
    });
  }
  const removeFile = (i) => setFiles((prev) => prev.filter((_, j) => j !== i));
  const setFileRole = (i, value) => setFiles((prev) => prev.map((f, j) => (j === i ? { ...f, role: value } : f)));

  /**
   * The model's picks onto the form. The country is the pack's, unless the
   * register already knows the cedant under a domicile — the register wins,
   * and the cedant is picked rather than re-registered. A cedant the register
   * does not know goes in as new, under its name as the pack writes it.
   */
  function applyExtraction(x, fileRoles) {
    const registered = (cedants.data || []).find((c) => sameName(c.name, x.cedant?.value));
    const known = registered ? countryOfDomicile(registered.domicile, ref.countries) : null;
    const picked = known || entryOf(ref.countries, x.domicile?.value) || null;
    setCountryId(picked?.id || '');
    if (registered && picked && domicileMatches(registered.domicile, picked)) {
      setCedantId(registered.id);
      setNewCedantName('');
    } else if (x.cedant?.value) {
      setCedantId(NEW_CEDANT);
      setNewCedantName(x.cedant.value);
    } else {
      setCedantId('');
      setNewCedantName('');
    }
    setTreatyTypeId(entryOf(ref.treatyTypes, x.treaty_type?.value)?.id || '');
    setClassIds((x.classes_of_business?.values || []).map((v) => entryOf(ref.classes, v)?.id).filter(Boolean));
    setNotes(x.notes || '');
    setFiles((prev) => prev.map((f, i) => ({ ...f, role: fileRoles[i] || f.role })));
    setTouched({});
  }

  async function readPacks() {
    if (!files.length || reading) return;
    setReading(true);
    setReadStarted(Date.now());
    setNow(Date.now());
    setReadError(null);
    try {
      const documents = await Promise.all(files.map(async ({ file }) => ({
        filename: file.name,
        mime_type: file.type || 'application/octet-stream',
        content_base64: await fileToBase64(file),
      })));
      const result = await api('POST', '/renewal-analyses/intake', { documents });
      setRead(result);
      applyExtraction(result.extraction, (result.extraction.documents || []).map((d) => d.role));
      toast('The pack is read — check each detail, correct what is wrong, add what is missing.');
    } catch (err) {
      setReadError(err);
    } finally {
      setReading(false);
      setReadStarted(null);
    }
  }

  async function create(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    setCreated(null);
    let a = null;
    try {
      // A cedant typed in fresh joins the register too, so next time they
      // are in the dropdown.
      if (cedantId === NEW_CEDANT) {
        await api('POST', '/cedants', { name: cedantName, domicile: country.code }).catch(() => {});
      }
      a = await api('POST', '/renewal-analyses', {
        cedant_name: cedantName,
        cedant_domicile: country.name,
        class_of_business: cobs.join(', '),
        treaty_type: treatyType,
        ...(notes.trim() ? { cedant_notes: notes.trim() } : {}),
        // How the details arrived: the model's picks ride with a quick
        // intake, so the record keeps them beside what was saved.
        intake: read
          ? { mode: 'quick', provider: read.provider, model: read.model, extraction: read.extraction }
          : { mode: 'full' },
      });
    } catch (err) {
      setError(err);
      setBusy(false);
      return;
    }

    // The quick route's packs go onto the record now, so the desk opens with
    // them in place rather than asking for them again.
    const failed = [];
    for (const { file, role: docRole } of files) {
      try {
        await api('POST', `/renewal-analyses/${a.id}/documents`, {
          role: docRole,
          filename: file.name,
          mime_type: file.type || 'application/octet-stream',
          content_base64: await fileToBase64(file),
        });
      } catch (err) {
        failed.push(`${file.name}: ${err.message}`);
      }
    }
    if (failed.length) {
      // The record exists; say which packs did not make it rather than move
      // on as if they had.
      setCreated({ id: a.id, failed });
      setBusy(false);
      return;
    }
    navigate(`/renewal-packs/${a.id}`);
  }

  const rows = analyses.data || [];
  const x = read?.extraction;
  const aiCedantNote = x && cedantId === NEW_CEDANT ? 'not in the register — it will be added' : undefined;

  return (
    <div className="screen rpa-screen">
      {choosing && (
        <PackChoice
          onClose={() => setChoosing(false)}
          onUpload={() => { setChoosing(false); setPickingMode(true); }}
          onManual={() => navigate('/placements/new')}
        />
      )}
      {pickingMode && (
        <UploadModeChoice
          aiConfigured={aiConfigured}
          onQuick={() => { setMode('quick'); setPickingMode(false); }}
          onFull={() => { setMode('full'); setPickingMode(false); }}
          onBack={() => { setPickingMode(false); setChoosing(true); }}
          onClose={() => setPickingMode(false)}
        />
      )}
      <div className="rpa-intake-grid">
        {role.canBroke ? (
          <section className="blueprint rpa-intake" data-testid="rpa-intake" data-mode={mode}>
            <div className="rpa-intake-body">
              <div className="sechead">
                <h3 className="seclabel">Upload a renewal pack</h3>
                <span className="kicker accent">Step 01 · {mode === 'quick' ? 'Quick' : 'Full'} renewal pack</span>
                <span className="rpa-mode">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-testid="rpa-switch-mode"
                    disabled={busy || reading}
                    onClick={() => setMode((m) => (m === 'quick' ? 'full' : 'quick'))}
                  >
                    {mode === 'quick' ? 'Use the full route' : 'Use the quick route'}
                  </button>
                </span>
              </div>
              {mode === 'quick' ? (
                <p className="rpa-intake-lede">
                  Drop the cedant's pack. The AI reads the details a broker would otherwise type —
                  the <b>cedant</b>, its <b>country</b>, the <b>treaty type</b> and the <b>classes of
                  business</b> — and fills the form below, each field saying where it was read.
                  Correct anything it got wrong, add what it could not find, then create: the pack
                  goes onto the desk with the record.
                </p>
              ) : (
                <p className="rpa-intake-lede">
                  Name the cedant, the class of business and the treaty type. The next screen
                  takes the packs themselves — usually the <b>expiring</b> submission and the{' '}
                  <b>current</b> one — and reviews them: commentary on each pack, a
                  change-by-change comparison and a detailed analysis.
                  {ws.placement?.id && (
                    <> Building the outgoing pack instead? Open the{' '}
                      <Link to={`/placements/${ws.placement.id}/pack`}>pack builder</Link> for {ws.placement.reference}.
                    </>
                  )}
                </p>
              )}

              {mode === 'quick' && (
                <QuickIntake
                  files={files}
                  onAdd={addFiles}
                  onRemove={removeFile}
                  onRole={setFileRole}
                  limits={limits}
                  aiConfigured={aiConfigured}
                  aiKnown={aiKnown}
                  reading={reading}
                  startedAt={readStarted}
                  now={now}
                  onRead={readPacks}
                  read={read}
                  error={readError}
                  onUseFull={() => setMode('full')}
                />
              )}

              <form className="inline-form" onSubmit={create}>
                <label className="field">
                  <span>Country *</span>
                  <select
                    className="input"
                    value={countryId}
                    onChange={(e) => {
                      setCountryId(e.target.value);
                      // A new cedant is not bound to a country yet, so it stays picked.
                      if (cedantId !== NEW_CEDANT) setCedantId('');
                      touch('country');
                    }}
                  >
                    <option value="">Select country…</option>
                    <RefOptions list={ref.countries} />
                  </select>
                  {x && <AiMark pick={x.domicile} value={x.domicile?.value} touched={touched.country} />}
                </label>

                <label className="field">
                  <span>Cedant *</span>
                  <select
                    className="input"
                    value={cedantId}
                    onChange={(e) => { setCedantId(e.target.value); touch('cedant'); }}
                    disabled={!country}
                  >
                    <option value="">{country ? 'Select cedant…' : 'Select country first…'}</option>
                    {countryCedants.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    <option value={NEW_CEDANT}>+ New cedant…</option>
                  </select>
                  {x && <AiMark pick={x.cedant} value={x.cedant?.value} touched={touched.cedant} note={aiCedantNote} />}
                </label>

                {cedantId === NEW_CEDANT && (
                  <label className="field">
                    <span>New cedant name *</span>
                    <input
                      className="input"
                      value={newCedantName}
                      onChange={(e) => { setNewCedantName(e.target.value); touch('cedant'); }}
                      placeholder="Cedant name"
                    />
                    {x && <small className="rpa-ai-mark">As the pack writes it — the register's spelling wins if it is already there.</small>}
                  </label>
                )}

                <label className="field">
                  <span>Treaty type *</span>
                  <select className="input" value={treatyTypeId} onChange={(e) => { setTreatyTypeId(e.target.value); touch('treaty'); }}>
                    <option value="">Select treaty type…</option>
                    <RefOptions list={ref.treatyTypes} groupBy={(t) => t.category} groupLabel={(g) => CATEGORY_LABELS[g] || g} />
                  </select>
                  {x && <AiMark pick={x.treaty_type} value={x.treaty_type?.value} touched={touched.treaty} />}
                </label>

                <label className="field">
                  <span>Classes of business *</span>
                  <button type="button" className="cob-trigger" style={{ minWidth: 190 }} onClick={() => setShowCob(true)}>
                    <span className={cobs.length ? '' : 'cob-placeholder'}>
                      {cobs.length
                        ? (cobs.length > 2 ? `${cobs.slice(0, 2).join(', ')} +${cobs.length - 2}` : cobs.join(', '))
                        : 'Select classes…'}
                    </span>
                    <span className="cob-caret">▾</span>
                  </button>
                  {x && (
                    <AiMark
                      pick={x.classes_of_business}
                      value={(x.classes_of_business?.values || []).join(', ')}
                      touched={touched.classes}
                    />
                  )}
                </label>

                <label className="field grow">
                  <span>Cedant notes</span>
                  <input
                    className="input"
                    value={notes}
                    onChange={(e) => { setNotes(e.target.value); touch('notes'); }}
                    placeholder="Optional context for the AI"
                  />
                  {x && (
                    touched.notes
                      ? <small className="rpa-ai-mark is-corrected"><b>Edited</b> · the AI's line is yours now</small>
                      : x.notes
                        ? <small className="rpa-ai-mark"><b>AI</b> · a line of context from the pack — edit freely</small>
                        : <small className="rpa-ai-mark is-missing"><b>Nothing to add</b> from the pack</small>
                  )}
                </label>

                <button type="submit" className="btn btn-primary rpa-intake-go" disabled={!ready || busy} data-testid="rpa-create">
                  {busy
                    ? (files.length ? 'Creating & uploading…' : 'Creating…')
                    : files.length
                      ? `Create & upload ${files.length} ${files.length === 1 ? 'pack' : 'packs'}`
                      : 'Create & upload packs'}
                </button>
              </form>
              <ErrorBanner error={error} />
              {created && (
                <div className="err banner">
                  The record was created, but {created.failed.length === 1 ? 'one pack' : `${created.failed.length} packs`} did not upload
                  ({created.failed.join('; ')}). <Link to={`/renewal-packs/${created.id}`}>Open the desk</Link> and add
                  {created.failed.length === 1 ? ' it' : ' them'} there.
                </div>
              )}
              {showCob && (
                <CobModal
                  selected={classIds}
                  onSave={(ids) => { setClassIds(ids); touch('classes'); }}
                  onClose={() => setShowCob(false)}
                />
              )}
            </div>

            <div className="rpa-capabilities">
              {CAPABILITIES.map((c) => (
                <div key={c.k} className="rpa-capability">
                  <div className="kicker accent">{c.k}</div>
                  <div className="rpa-capability-text">{c.t}</div>
                </div>
              ))}
            </div>
          </section>
        ) : (
          <section className="blueprint rpa-intake">
            <div className="rpa-intake-body">
              <div className="sechead">
                <h3 className="seclabel">Renewal packs</h3>
                <span className="kicker accent">Read only</span>
              </div>
              <p className="rpa-intake-lede">
                Brokers create analyses and upload the packs. Open any analysis in the
                renewal book to read the AI review.
              </p>
            </div>
            <div className="rpa-capabilities">
              {CAPABILITIES.map((c) => (
                <div key={c.k} className="rpa-capability">
                  <div className="kicker accent">{c.k}</div>
                  <div className="rpa-capability-text">{c.t}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="blueprint rpa-book">
          <div className="sechead rpa-book-head">
            <h3 className="seclabel">Renewal book</h3>
            <span className="kicker spacer">{rows.length} {rows.length === 1 ? 'analysis' : 'analyses'}</span>
          </div>
          <ErrorBanner error={analyses.error} />
          {rows.length === 0 && !analyses.loading && (
            <p className="muted rpa-book-empty">No analyses yet — the first pack you create lands here.</p>
          )}
          {rows.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Cedant / treaty</th>
                    <th>Class</th>
                    <th className="r">Packs</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Link className="rpa-book-cedant" to={`/renewal-packs/${a.id}`}>{a.cedant_name}</Link>
                        <div className="rpa-book-sub">
                          {a.treaty_type}{a.cedant_domicile ? ` · ${a.cedant_domicile}` : ''}
                          {a.intake_mode === 'quick' ? ' · quick intake' : ''}
                        </div>
                      </td>
                      <td className="rpa-book-class">{a.class_of_business}</td>
                      <td className="r num rpa-book-packs" title={packRoles(a.doc_roles).title}>
                        {a.doc_count}
                        {a.doc_roles?.length > 0 && (
                          <div className="rpa-book-sub">{packRoles(a.doc_roles).short}</div>
                        )}
                      </td>
                      <td><StatusPill value={a.status} /></td>
                      <td className="rpa-book-sub">{fmtDate(a.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
