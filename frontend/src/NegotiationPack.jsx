import React, { useEffect, useMemo, useState } from 'react';
import { api, download } from './api.js';
import { StructCard } from './StructureSections.jsx';

/*
 * The renewal pack, as the markets have it.
 *
 * What a market opens is the Excel workbook cut with the version — so this
 * is that file, not a re-rendering of the snapshot: the stored bytes are
 * read back sheet by sheet and laid out as Excel lays them out, column
 * letters across, row numbers down, the title bars merged. The approved
 * version is the one that goes to market, and opens by default; any other
 * version can be looked at, and every one downloaded as cut.
 */

const day = (d) => (d ? String(d).slice(0, 10) : '—');
const kb = (n) => (n == null ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Excel's heading for a zero-based column: A … Z, AA … */
export function colLetter(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Rows shown before "show all": enough for every section sheet, not a bordereau. */
const FIRST_ROWS = 300;

/** One sheet as a grid: column letters across, row numbers down, merges spanned. */
export function SheetGrid({ sheet }) {
  const [all, setAll] = useState(false);
  // Merged ranges: the top-left cell spans, the cells under it are not drawn.
  const { anchors, covered } = useMemo(() => {
    const anchorsAt = new Map();
    const under = new Set();
    for (const m of sheet.merges || []) {
      anchorsAt.set(`${m.r}:${m.c}`, m);
      for (let r = m.r; r < m.r + m.rows; r += 1) {
        for (let c = m.c; c < m.c + m.cols; c += 1) {
          if (r !== m.r || c !== m.c) under.add(`${r}:${c}`);
        }
      }
    }
    return { anchors: anchorsAt, covered: under };
  }, [sheet]);

  if (!sheet.rows.length) return <div className="xl-empty">This sheet is empty.</div>;
  const rows = all ? sheet.rows : sheet.rows.slice(0, FIRST_ROWS);
  const cols = sheet.col_count || Math.max(...sheet.rows.map((r) => r.length));

  return (
    <>
      <div className="xl-grid-wrap">
        <table className="xl-grid">
          <thead>
            <tr>
              <th className="xl-rn xl-corner" aria-label="Row" />
              {Array.from({ length: cols }, (_, c) => <th key={c}>{colLetter(c)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                <th className="xl-rn">{r + 1}</th>
                {Array.from({ length: cols }, (_, c) => {
                  const key = `${r}:${c}`;
                  if (covered.has(key)) return null;
                  const cell = row[c];
                  const merge = anchors.get(key);
                  const cls = ['xl-cell', cell ? `xl-${cell.t}` : '', merge ? 'xl-merged' : ''].filter(Boolean).join(' ');
                  return (
                    <td key={c} className={cls}
                      rowSpan={merge && merge.rows > 1 ? merge.rows : undefined}
                      colSpan={merge && merge.cols > 1 ? merge.cols : undefined}>
                      {cell ? cell.w : ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(sheet.rows.length > rows.length || sheet.truncated) && (
        <div className="xl-note">
          {sheet.rows.length > rows.length
            ? <>Showing the first {rows.length} of {sheet.row_count} rows. <button type="button" className="linkish" onClick={() => setAll(true)}>Show all</button></>
            : <>The first {sheet.rows.length} of {sheet.row_count} rows — the rest are in the file.</>}
        </div>
      )}
    </>
  );
}

/** The workbook: a strip of sheet tabs, and the sheet that is open. */
export function Workbook({ book }) {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [book]);
  if (!book) return null;
  const sheet = book.sheets[active] || book.sheets[0];
  return (
    <div className="xl-book" data-testid="neg-workbook">
      <div className="xl-sheets" role="tablist" aria-label="Sheets">
        {book.sheets.map((s, i) => (
          <button key={s.name} type="button" role="tab" aria-selected={i === active}
            className={`xl-sheet${i === active ? ' is-on' : ''}`} onClick={() => setActive(i)}>
            {s.name}
          </button>
        ))}
      </div>
      {sheet && <SheetGrid key={`${book.pack.id}:${sheet.name}`} sheet={sheet} />}
    </div>
  );
}

/**
 * The Renewal Pack tab of the negotiation.
 *
 * @param data     the negotiation board: which pack is out, and who holds it
 * @param onSend   opens the covering email to take the pack to market
 */
export default function NegotiationPack({ placementId, data, canEdit, busy, onSend }) {
  const [versions, setVersions] = useState(null);
  const [packId, setPackId] = useState(null);
  const [book, setBook] = useState(null);
  const [error, setError] = useState(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let stale = false;
    api('GET', `/placements/${placementId}/packs`)
      .then((rows) => { if (!stale) setVersions(rows); })
      .catch((e) => { if (!stale) setError(e); });
    return () => { stale = true; };
  }, [placementId]);

  // The version to open: the approved one — what goes to market — else the latest.
  const defaultId = data.pack.approved?.id || data.pack.latest?.id || null;
  const currentId = packId || defaultId;

  useEffect(() => {
    if (!currentId) { setBook(null); return undefined; }
    let stale = false;
    setBook(null);
    setError(null);
    api('GET', `/packs/${currentId}/workbook`)
      .then((b) => { if (!stale) setBook(b); })
      .catch((e) => { if (!stale) setError(e); });
    return () => { stale = true; };
  }, [currentId]);

  const version = versions?.find((v) => v.id === currentId) || null;
  const packReady = !!data.pack.approved;
  const holding = data.markets.filter((m) => m.pack_id === currentId);
  const outVersions = [...new Set(data.markets.map((m) => m.pack_version).filter(Boolean))].sort((a, b) => a - b);

  const get = async (format) => {
    setDownloading(true);
    setError(null);
    try { await download(`/packs/${currentId}/export?format=${format}`); } catch (e) { setError(e); } finally { setDownloading(false); }
  };

  const status = (v) => (v.status === 'submitted' ? 'awaiting approval' : v.status);
  const hint = !data.pack.latest
    ? 'No renewal pack has been created yet.'
    : version
      ? `v${version.version} · ${status(version)}${version.status === 'approved' ? ` by ${version.approved_by_name || 'a Senior Broker'} on ${day(version.approved_at)}` : ''} · created ${day(version.created_at)} by ${version.created_by_name || '—'}`
      : `v${data.pack.latest.version}`;

  return (
    <StructCard
      title="Renewal pack"
      hint={hint}
      notice={!data.pack.latest
        ? 'Create a renewal pack on the Renewal Pack tab before going to market.'
        : !packReady
          ? `Renewal pack v${data.pack.latest.version} is awaiting a Senior Broker's approval — it goes to market once approved.`
          : undefined}
      actions={(
        <div className="toolbar">
          {versions?.length > 0 && (
            <select className="np-mini-input" style={{ width: 200 }} value={currentId || ''} aria-label="Pack version"
              onChange={(e) => setPackId(e.target.value || null)}>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version} · {status(v)} · {day(v.created_at)}
                </option>
              ))}
            </select>
          )}
          <span className="rp-exports">
            <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={!currentId || downloading}
              title={book?.file ? `${book.file.filename} · ${kb(book.file.bytes)}` : 'The Excel workbook of this version'}
              onClick={() => get('xlsx')}>
              ⤓ Excel
            </button>
            <button type="button" className="np-struct-btn" disabled={!currentId || downloading}
              title="The PDF of this version — what the covering email attaches" onClick={() => get('pdf')}>
              PDF
            </button>
          </span>
          {canEdit && (
            <button type="button" className="np-green-pill" disabled={!packReady || busy} data-testid="send-pack"
              title={packReady ? 'Draft the covering email to the reinsurers' : 'Approved versions only'}
              onClick={onSend}>
              Send pack to market
            </button>
          )}
        </div>
      )}
      footnote={book ? `${book.file.filename} · ${kb(book.file.bytes)} · ${book.sheets.length} sheets — ${book.file.stored ? 'the file stored when this version was created, byte for byte what went to market' : 'rendered now: this version was created before files were stored with it'}. Figures read as Excel shows them.` : undefined}
    >
      <div className="toolbar neg-pack-facts">
        {version && <span className="np-layer-count">Version<b>v{version.version} ({status(version)})</b></span>}
        <span className="np-layer-count">Markets holding it<b>{holding.length || '—'}</b></span>
        {outVersions.length > 0 && (
          <span className="np-layer-count">Out with markets<b>{outVersions.map((v) => `v${v}`).join(', ')}</b></span>
        )}
        {book && <span className="np-layer-count">Sheets<b>{book.sheets.length}</b></span>}
      </div>
      {error && <div className="err banner">{error.message}</div>}
      {currentId && !book && !error && <div className="muted" style={{ padding: 8 }}>Opening the workbook…</div>}
      {book && <Workbook book={book} />}
    </StructCard>
  );
}
