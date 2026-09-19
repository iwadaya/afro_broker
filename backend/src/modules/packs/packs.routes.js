import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler, validate, pageParams } from '../../lib/http.js';
import { NotFoundError, ConflictError, ValidationError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { pullTechnical } from '../../integrations/universe.js';
import { aggregateBordereaux } from '../analysis/analysis.service.js';
import { buildPack, diffSections, packBasis } from './packs.build.js';
import { PACK_TEMPLATE, TEMPLATE_VERSION, templateGroups } from './packs.template.js';
import { presentPack, packFilename } from './packs.present.js';
import { packToXlsx } from './packs.xlsx.js';
import { packToCsv } from './packs.csv.js';
import { packToPdf } from './packs.pdf.js';
import { readWorkbook } from './packs.workbook.js';

const router = Router();
router.use(authenticate);

/** Everything a pack is built from, read in one place. */
async function loadContext(placementId, client) {
  const runner = client || { query };
  const { rows: pRows } = await runner.query('SELECT * FROM placement WHERE id = $1', [placementId]);
  if (!pRows[0]) throw new NotFoundError('Placement');
  const placement = pRows[0];

  const [{ rows: cedantRows }, { rows: layers }, { rows: bordereaux }, { rows: documents }, { rows: quotes }, { rows: wordings }] =
    await Promise.all([
      runner.query('SELECT * FROM cedant WHERE id = $1', [placement.cedant_id]),
      runner.query('SELECT * FROM layer WHERE placement_id = $1 ORDER BY position, created_at', [placementId]),
      runner.query(
        `SELECT id, type, source_file, period_start, period_end, row_count, summary, parsed_rows, created_at
         FROM bordereau WHERE placement_id = $1 ORDER BY created_at`,
        [placementId],
      ),
      runner.query('SELECT id, type, version, layer_id, created_at FROM document WHERE placement_id = $1 ORDER BY created_at', [placementId]),
      runner.query(
        `SELECT q.id, q.type, q.status, q.rol AS rate_on_line, q.premium AS premium100, q.validity,
                a.layer_id, m.name AS market_name
         FROM quote q
         JOIN approach a ON a.id = q.approach_id
         JOIN layer l ON l.id = a.layer_id
         JOIN market m ON m.id = a.market_id
         WHERE l.placement_id = $1
         ORDER BY q.created_at`,
        [placementId],
      ),
      runner.query(
        `SELECT w.id, w.title, w.status, m.name AS reinsurer_name,
                (SELECT COUNT(*) FROM wording_draft_clause c WHERE c.draft_id = w.id)::int AS clause_count
         FROM wording_draft w
         LEFT JOIN market m ON m.id = w.base_market_id
         WHERE w.placement_id = $1
         ORDER BY w.created_at DESC LIMIT 1`,
        [placementId],
      ),
    ]);

  const technical = [];
  for (const layer of layers) {
    technical.push({ layer_id: layer.id, name: layer.name, ...(await pullTechnical(layer)) });
  }

  // The modelling screens that carry vendor output rather than bordereau
  // data (the event loss tables); keyed by section, per class where stored so.
  const { rows: modellingRows } = await runner.query(
    'SELECT section, data FROM placement_modelling WHERE placement_id = $1',
    [placementId],
  );
  const modelling = Object.fromEntries(modellingRows.map((r) => [r.section, r.data]));

  // Special acceptances raised on the placement — the pack's closing tab.
  const { rows: specialAcceptances } = await runner.query(
    `SELECT type, title, detail, effective_date, status
     FROM amendment WHERE placement_id = $1 ORDER BY created_at`,
    [placementId],
  );

  // The expiring leader for the info page: the lead market on the expiring
  // placement (renewal_of), read from its lead lines, falling back to an
  // accepted lead quote.
  let expiringLeader = null;
  if (placement.renewal_of) {
    const { rows: leadRows } = await runner.query(
      `SELECT m.name
       FROM line ln
       JOIN approach a ON a.id = ln.approach_id AND a.role = 'lead'
       JOIN market m ON m.id = ln.market_id
       JOIN layer l ON l.id = ln.layer_id
       WHERE l.placement_id = $1
       ORDER BY ln.status = 'SIGNED' DESC, ln.written_pct DESC NULLS LAST
       LIMIT 1`,
      [placement.renewal_of],
    );
    expiringLeader = leadRows[0]?.name || null;
    if (!expiringLeader) {
      const { rows: quoteRows } = await runner.query(
        `SELECT m.name
         FROM quote q
         JOIN approach a ON a.id = q.approach_id AND a.role = 'lead'
         JOIN layer l ON l.id = a.layer_id
         JOIN market m ON m.id = a.market_id
         WHERE l.placement_id = $1 AND q.status = 'accepted'
         ORDER BY q.created_at DESC LIMIT 1`,
        [placement.renewal_of],
      );
      expiringLeader = quoteRows[0]?.name || null;
    }
  }

  // A renewal draft usually has no bordereaux of its own yet — inherit the
  // expiring placement's (walking the renewal_of chain) so the standard pack
  // auto-populates from the prior renewal pack's data until this year's
  // bordereaux are ingested. Own data always wins once it exists.
  let packBordereaux = bordereaux;
  let bordereauxSource = null;
  if (!packBordereaux.length && placement.renewal_of) {
    let ancestorId = placement.renewal_of;
    for (let hop = 0; ancestorId && hop < 5; hop += 1) {
      const { rows: ancRows } = await runner.query(
        'SELECT id, reference, renewal_of FROM placement WHERE id = $1', [ancestorId],
      );
      const ancestor = ancRows[0];
      if (!ancestor) break;
      const { rows: ancBdx } = await runner.query(
        `SELECT id, type, source_file, period_start, period_end, row_count, summary, parsed_rows, created_at
         FROM bordereau WHERE placement_id = $1 ORDER BY created_at`,
        [ancestor.id],
      );
      if (ancBdx.length) {
        packBordereaux = ancBdx.map((b) => ({ ...b, inherited_from: ancestor.reference }));
        bordereauxSource = { placement_id: ancestor.id, reference: ancestor.reference };
        break;
      }
      ancestorId = ancestor.renewal_of;
    }
  }

  const rowsOf = (type) => packBordereaux.filter((b) => b.type === type).flatMap((b) => b.parsed_rows || []);
  return {
    placement,
    bordereaux: packBordereaux,
    bordereaux_source: bordereauxSource,
    cedant: cedantRows[0] || null,
    layers,
    documents,
    quotes,
    wording: wordings[0] || null,
    technical,
    specialAcceptances,
    expiringLeader,
    modelling,
    premiumRows: rowsOf('premium'),
    claimsRows: rowsOf('claims'),
    aggregates: aggregateBordereaux(packBordereaux, { currency: placement.currency }),
    generated_at: new Date().toISOString(),
  };
}

/* What a stored version holds, without shipping the whole snapshot: enough to
   list versions and see at a glance what is in each one. */
function packSummary(row) {
  const snapshot = row.snapshot || {};
  const bordereaux = snapshot.bordereaux || [];
  return {
    id: row.id,
    placement_id: row.placement_id,
    version: row.version,
    basis: row.basis,
    template_version: row.template_version,
    status: row.status,
    title: row.title,
    notes: row.notes,
    attachments: row.attachments || [],
    extra: row.extra || {},
    summary: row.summary || {},
    changes: row.changes || [],
    created_by: row.created_by,
    created_at: row.created_at,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    created_by_name: row.created_by_name || null,
    approved_by_name: row.approved_by_name || null,
    submitted_by: row.submitted_by || null,
    submitted_at: row.submitted_at || null,
    submitted_by_name: row.submitted_by_name || null,
    rejected_by: row.rejected_by || null,
    rejected_at: row.rejected_at || null,
    rejected_by_name: row.rejected_by_name || null,
    rejection_note: row.rejection_note || null,
    // The required screens that had no data when the version was cut — what
    // holds a submission until a new version is created from filled screens.
    required_missing: snapshot.screens?.required_missing || [],
    files: row.files || {},
    contents: {
      sections_filled: snapshot.summary?.sections_filled ?? null,
      sections_total: snapshot.summary?.sections_total ?? null,
      bordereaux: bordereaux.length || snapshot.summary?.bordereaux || 0,
      bordereau_rows: bordereaux.reduce((a, b) => a + (b.row_count || 0), 0),
      layers: snapshot.summary?.layers ?? 0,
      attachments: (row.attachments || []).length,
      loss_ratio_pct: snapshot.summary?.loss_ratio_pct ?? null,
    },
  };
}

/* The files cut with a version, without their bytes: {xlsx: {filename, bytes}, pdf: {…}}. */
const PACK_FILES_SQL = `
  (SELECT COALESCE(jsonb_object_agg(f.format, jsonb_build_object(
            'filename', f.filename, 'bytes', f.bytes, 'created_at', f.created_at)), '{}'::jsonb)
   FROM renewal_pack_file f WHERE f.pack_id = rp.id)`;

const PACK_SELECT = `
  SELECT rp.*, p.reference, p.class, p.inception, p.expiry, p.currency, p.est_gwp,
         p.status AS placement_status,
         c.id AS cedant_id, c.name AS cedant_name, c.domicile AS cedant_domicile,
         cu.name AS created_by_name, au.name AS approved_by_name,
         su.name AS submitted_by_name, ru.name AS rejected_by_name,
         ${PACK_FILES_SQL} AS files
  FROM renewal_pack rp
  JOIN placement p ON p.id = rp.placement_id
  JOIN cedant c    ON c.id = p.cedant_id
  LEFT JOIN users cu ON cu.id = rp.created_by
  LEFT JOIN users au ON au.id = rp.approved_by
  LEFT JOIN users su ON su.id = rp.submitted_by
  LEFT JOIN users ru ON ru.id = rp.rejected_by`;

/** Build the WHERE clause shared by the two pack listings. */
function packFilters(reqQuery) {
  const params = [];
  const filters = [];
  if (reqQuery.cedant_id) {
    params.push(reqQuery.cedant_id);
    filters.push(`c.id = $${params.length}`);
  }
  if (reqQuery.status) {
    params.push(reqQuery.status);
    filters.push(`rp.status = $${params.length}`);
  }
  return { params, where: filters.length ? `WHERE ${filters.join(' AND ')}` : '' };
}

/* The template itself — the standard running order for each basis, so the UI
   can lay out the tabs before any pack exists. */
router.get(
  '/pack-template',
  asyncHandler(async (req, res) => {
    const basis = req.query.basis === 'PROP' ? 'PROP' : req.query.basis === 'NP' ? 'NP' : null;
    res.json({
      template_version: TEMPLATE_VERSION,
      bases: Object.fromEntries(Object.entries(PACK_TEMPLATE).map(([key, t]) => [
        key, { label: t.label, groups: templateGroups(key) },
      ])),
      ...(basis ? { basis, groups: templateGroups(basis) } : {}),
    });
  }),
);

/* Version history. The snapshot is left out — it is large, and the list only
   needs to show what each version is. */
router.get(
  '/placements/:placementId/packs',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `${PACK_SELECT} WHERE rp.placement_id = $1 ORDER BY rp.version DESC`,
      [req.params.placementId],
    );
    res.json(rows.map(packSummary));
  }),
);

/* A preview of what a pack would contain right now, without cutting a version.
   Same shape as a stored pack's snapshot. */
router.get(
  '/placements/:placementId/pack-preview',
  asyncHandler(async (req, res) => {
    const ctx = await loadContext(req.params.placementId);
    res.json({ snapshot: buildPack(ctx) });
  }),
);

/* What the renewal-pack wizard decided: the pack it inherited from, the
   per-section carry/refresh/omit choices and the bordereaux bound to the
   refreshed sections. Recorded on the snapshot so a built pack carries the
   reasoning behind it; every field is optional, so a plain POST still works. */
const composeSchema = z.object({
  source_pack_id: z.string().uuid().nullable().optional(),
  // The uploaded renewal pack this build was composed from, when one drove
  // it. Held on the row as well as in the snapshot, so a built pack can be
  // traced back to the cedant submission it came out of.
  source_analysis_id: z.string().uuid().nullable().optional(),
  source_label: z.string().optional(),
  sections: z.array(z.object({
    name: z.string(),
    mode: z.enum(['carry', 'refresh', 'omit']),
    note: z.string().optional(),
  })).optional(),
  bordereau_ids: z.array(z.string().uuid()).optional(),
});

/* The checklist of screens as the placement page saw it when the pack was
   created: every screen of the wizard, and whether it held data — per class
   of business for the modelling screens, once for the placement-level ones.
   Recorded on the snapshot and printed on the Excel cover and the PDF, so a
   version says what had been entered when it was cut. `required` is carried
   per screen for when the required set is derived from the quoting
   structure. */
const screensSchema = z.object({
  cobs: z.array(z.string().max(120)).max(20),
  rows: z.array(z.object({
    key: z.string().max(60),
    label: z.string().max(120),
    group: z.string().max(60),
    scope: z.enum(['placement', 'class']).optional(),
    done: z.array(z.boolean()).max(20),
    required: z.boolean().optional(),
  })).max(200),
}).optional();

/* Metadata held with a version beside the templated snapshot: what to call it,
   the broker's note to the cedant, the files that travel with it, and a
   free-form bag for anything else worth keeping. Editable while the pack is a
   draft; approval freezes it. */
const attachmentSchema = z.object({
  name: z.string().min(1),
  kind: z.string().optional(),     // 'bordereau' | 'exposure' | 'slip' | 'email' | ...
  file: z.string().optional(),     // path / URL / storage key
  note: z.string().optional(),
});

const packMetaSchema = z.object({
  title: z.string().optional(),
  notes: z.string().optional(),
  attachments: z.array(attachmentSchema).optional(),
  extra: z.record(z.any()).optional(),
});

/** The screen checklist with its own count, as the snapshot carries it. */
function screensRecord(screens) {
  if (!screens) return null;
  const cells = screens.rows.map((r) => (r.scope === 'placement' ? r.done.slice(0, 1) : r.done));
  return {
    cobs: screens.cobs,
    rows: screens.rows.map((r) => ({ ...r, scope: r.scope || 'class', required: !!r.required })),
    filled: cells.reduce((n, d) => n + d.filter(Boolean).length, 0),
    total: cells.reduce((n, d) => n + d.length, 0),
    missing: screens.rows.filter((r) => !r.done.every(Boolean)).map((r) => r.label),
    required_missing: screens.rows.filter((r) => r.required && !r.done.every(Boolean)).map((r) => r.label),
  };
}

/* Create a renewal pack: one call cuts the version in SQL and renders its
   Excel and PDF from that snapshot, stored beside it. Versions are immutable
   once written: the snapshot holds every section as it stood, and the files
   are the bytes that were cut, so a market can be sent v2 while v3 is being
   worked on. */
router.post(
  '/placements/:placementId/packs',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const placementId = req.params.placementId;
    const body = req.body || {};
    const meta = validate(packMetaSchema, {
      title: body.title, notes: body.notes, attachments: body.attachments, extra: body.extra,
    });
    const composition = validate(composeSchema, {
      source_pack_id: body.source_pack_id, source_analysis_id: body.source_analysis_id,
      source_label: body.source_label,
      sections: body.sections, bordereau_ids: body.bordereau_ids,
    });
    const screens = validate(screensSchema, body.screens);
    const pack = await withTransaction(async (client) => {
      const ctx = await loadContext(placementId, client);
      const snapshot = buildPack(ctx);
      const composed = Object.fromEntries(Object.entries(composition).filter(([, v]) => v !== undefined));
      if (Object.keys(composed).length > 0) snapshot.composition = composed;
      const screenRecord = screensRecord(screens);
      if (screenRecord) snapshot.screens = screenRecord;

      const { rows: prevRows } = await client.query(
        'SELECT version, snapshot FROM renewal_pack WHERE placement_id = $1 ORDER BY version DESC LIMIT 1',
        [placementId],
      );
      const previous = prevRows[0];
      const version = (previous?.version || 0) + 1;
      const changes = previous ? diffSections(previous.snapshot, snapshot) : [];

      const { rows } = await client.query(
        `INSERT INTO renewal_pack (placement_id, version, basis, template_version, snapshot, summary, changes,
                                   title, notes, attachments, extra, source_analysis_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [placementId, version, snapshot.basis, snapshot.template_version,
          JSON.stringify(snapshot), JSON.stringify(snapshot.summary), JSON.stringify(changes),
          meta.title || null, meta.notes || null,
          JSON.stringify(meta.attachments || []), JSON.stringify(meta.extra || {}),
          composition.source_analysis_id || null,
          req.user.id],
      );
      const row = rows[0];

      // The Excel and the PDF, rendered from the snapshot just written and
      // held with the version. A render that fails rolls the version back:
      // a pack without its files is not a pack that was created.
      const presented = presentPack(row);
      const files = {};
      for (const format of ['xlsx', 'pdf']) {
        const exporter = EXPORTS[format];
        const content = await exporter.render(presented);
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        const filename = packFilename(row, exporter.extension);
        const { rows: fileRows } = await client.query(
          `INSERT INTO renewal_pack_file (pack_id, format, filename, bytes, content)
           VALUES ($1, $2, $3, $4, $5) RETURNING created_at`,
          [row.id, format, filename, buffer.length, buffer],
        );
        files[format] = { filename, bytes: buffer.length, created_at: fileRows[0].created_at };
      }

      await audit({
        entityType: 'renewal_pack',
        entityId: row.id,
        action: 'build',
        userId: req.user.id,
        detail: {
          version, basis: snapshot.basis,
          sections_filled: snapshot.summary.sections_filled,
          screens_filled: screenRecord?.filled ?? null,
          screens_total: screenRecord?.total ?? null,
          bordereaux: snapshot.bordereaux.length,
          files: Object.fromEntries(Object.entries(files).map(([f, v]) => [f, v.bytes])),
        },
      }, client);
      return { ...row, files };
    });
    res.status(201).json(pack);
  }),
);

/* The pack store: every version held for every cedant, grouped
   cedant -> placement -> versions (newest first). Nothing is ever replaced —
   a restatement is a new version, and every prior one stays readable. */
router.get(
  '/packs/by-cedant',
  asyncHandler(async (req, res) => {
    const { params, where } = packFilters(req.query);
    const { rows } = await query(
      `${PACK_SELECT} ${where}
       ORDER BY c.name, p.inception DESC, p.reference, rp.version DESC`,
      params,
    );

    const cedants = new Map();
    for (const row of rows) {
      if (!cedants.has(row.cedant_id)) {
        cedants.set(row.cedant_id, {
          cedant_id: row.cedant_id,
          cedant_name: row.cedant_name,
          domicile: row.cedant_domicile,
          pack_count: 0,
          latest_pack_at: null,
          placements: new Map(),
        });
      }
      const cedant = cedants.get(row.cedant_id);
      cedant.pack_count += 1;
      if (!cedant.latest_pack_at || row.created_at > cedant.latest_pack_at) {
        cedant.latest_pack_at = row.created_at;
      }
      if (!cedant.placements.has(row.placement_id)) {
        cedant.placements.set(row.placement_id, {
          placement_id: row.placement_id,
          reference: row.reference,
          class: row.class,
          inception: row.inception,
          expiry: row.expiry,
          currency: row.currency,
          est_gwp: row.est_gwp,
          status: row.placement_status,
          packs: [],
        });
      }
      cedant.placements.get(row.placement_id).packs.push(packSummary(row));
    }

    res.json({
      cedants: [...cedants.values()].map((c) => ({ ...c, placements: [...c.placements.values()] })),
      pack_count: rows.length,
    });
  }),
);

/* The same store, flat and newest-first. */
router.get(
  '/packs',
  asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const { params, where } = packFilters(req.query);
    params.push(limit, offset);
    const { rows } = await query(
      `${PACK_SELECT} ${where}
       ORDER BY rp.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(rows.map((r) => ({
      ...packSummary(r),
      cedant_id: r.cedant_id,
      cedant_name: r.cedant_name,
      reference: r.reference,
      class: r.class,
      currency: r.currency,
    })));
  }),
);

router.get(
  '/packs/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query(`${PACK_SELECT} WHERE rp.id = $1`, [req.params.id]);
    if (!rows[0]) throw new NotFoundError('Renewal pack');
    // The full row, plus the cedant/placement context and the contents index.
    res.json({
      ...rows[0],
      cedant: { id: rows[0].cedant_id, name: rows[0].cedant_name, domicile: rows[0].cedant_domicile },
      contents: packSummary(rows[0]).contents,
    });
  }),
);

/* Amend a draft's metadata. The snapshot is evidence and never changes —
   restate it by building a new version — and an approved pack is frozen. */
router.patch(
  '/packs/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const meta = validate(packMetaSchema, req.body);
    const { rows: cur } = await query('SELECT status FROM renewal_pack WHERE id = $1', [req.params.id]);
    if (!cur[0]) throw new NotFoundError('Renewal pack');
    if (cur[0].status === 'approved') {
      throw new ConflictError('Pack is approved; build a new version to change it');
    }
    const { rows } = await query(
      `UPDATE renewal_pack
          SET title = COALESCE($1, title),
              notes = COALESCE($2, notes),
              attachments = COALESCE($3, attachments),
              extra = COALESCE($4, extra)
        WHERE id = $5 RETURNING *`,
      [meta.title ?? null, meta.notes ?? null,
        meta.attachments ? JSON.stringify(meta.attachments) : null,
        meta.extra ? JSON.stringify(meta.extra) : null,
        req.params.id],
    );
    await audit({
      entityType: 'renewal_pack', entityId: req.params.id, action: 'amend',
      userId: req.user.id, detail: { fields: Object.keys(meta) },
    });
    res.json(packSummary(rows[0]));
  }),
);

/* A built version as a file. Excel is what a market expects, so it is the
   default; CSV opens anywhere, and the PDF is the one to attach to an email.
   All three render the same sections in the same order, empty ones included. */
const EXPORTS = {
  xlsx: {
    extension: 'xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    render: packToXlsx,
  },
  csv: { extension: 'csv', contentType: 'text/csv; charset=utf-8', render: (p) => packToCsv(p) },
  pdf: { extension: 'pdf', contentType: 'application/pdf', render: packToPdf },
};

router.get(
  '/packs/:id/export',
  asyncHandler(async (req, res) => {
    const format = String(req.query.format || 'xlsx').toLowerCase();
    const exporter = EXPORTS[format];
    if (!exporter) throw new ValidationError(`Unsupported format "${format}" — use xlsx, csv or pdf`);

    const { rows } = await query('SELECT * FROM renewal_pack WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw new NotFoundError('Renewal pack');
    const pack = rows[0];

    // The file cut with the version, when there is one — the same bytes every
    // time. Versions from before files were stored, and CSV, render now.
    const { rows: stored } = await query(
      'SELECT filename, content FROM renewal_pack_file WHERE pack_id = $1 AND format = $2',
      [pack.id, format],
    );
    let buffer;
    let filename;
    if (stored[0]) {
      buffer = stored[0].content;
      filename = stored[0].filename;
    } else {
      const body = await exporter.render(presentPack(pack));
      buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      filename = packFilename(pack, exporter.extension);
    }
    await audit({
      entityType: 'renewal_pack',
      entityId: pack.id,
      action: 'export',
      userId: req.user.id,
      detail: { format, version: pack.version, stored: !!stored[0] },
    });
    res.setHeader('Content-Type', exporter.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  }),
);

/* The workbook of a version, opened sheet by sheet — what the Negotiation
   tab shows as the pack the markets are quoting on. The stored file where
   there is one, so it is exactly the bytes that went to market; a version
   from before files were stored renders now, as the export does. */
router.get(
  '/packs/:id/workbook',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM renewal_pack WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw new NotFoundError('Renewal pack');
    const pack = rows[0];

    const { rows: stored } = await query(
      "SELECT filename, bytes, content, created_at FROM renewal_pack_file WHERE pack_id = $1 AND format = 'xlsx'",
      [pack.id],
    );
    let buffer;
    let filename;
    if (stored[0]) {
      buffer = stored[0].content;
      filename = stored[0].filename;
    } else {
      buffer = await packToXlsx(presentPack(pack));
      filename = packFilename(pack, 'xlsx');
    }
    res.json({
      pack: {
        id: pack.id,
        version: pack.version,
        status: pack.status,
        created_at: pack.created_at,
        approved_at: pack.approved_at || null,
      },
      file: {
        filename,
        bytes: buffer.length,
        stored: !!stored[0],
        created_at: stored[0]?.created_at || null,
      },
      sheets: readWorkbook(buffer),
    });
  }),
);

/* Export the live preview — the pack as it would be cut right now — without
   storing a version. Same renderers, same running order; the file is marked
   "preview" instead of a version number. */
router.get(
  '/placements/:placementId/pack-preview/export',
  asyncHandler(async (req, res) => {
    const format = String(req.query.format || 'xlsx').toLowerCase();
    const exporter = EXPORTS[format];
    if (!exporter) throw new ValidationError(`Unsupported format "${format}" — use xlsx, csv or pdf`);

    const ctx = await loadContext(req.params.placementId);
    const preview = { snapshot: buildPack(ctx), version: 'preview', status: 'preview', created_at: new Date() };

    const body = await exporter.render(presentPack(preview));
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const ref = (preview.snapshot.placement?.reference || 'renewal-pack').replace(/[^A-Za-z0-9._-]+/g, '-');
    const filename = `${ref}_RenewalPack_preview_${new Date().toISOString().slice(0, 10)}.${exporter.extension}`;
    await audit({
      entityType: 'placement',
      entityId: req.params.placementId,
      action: 'pack_preview_export',
      userId: req.user.id,
      detail: { format },
    });
    res.setHeader('Content-Type', exporter.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  }),
);

/* ── Approval ──────────────────────────────────────────────────────────
   Once a renewal pack is created it goes for approval: the broker submits
   the version, a Senior Broker checks it and approves it or returns it with
   a note. Four-eyes: the person who created or submitted the version cannot
   be the one to approve it. Only an approved version unlocks the Negotiation
   tab and can go to market. */

/** The version as the approval routes hand it back: the summary row, with names. */
async function packRow(id) {
  const { rows } = await query(`${PACK_SELECT} WHERE rp.id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError('Renewal pack');
  return rows[0];
}

/* Submit a draft for the Senior Broker's approval. */
router.post(
  '/packs/:id/submit',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const cur = await packRow(req.params.id);
    if (cur.status === 'approved') throw new ConflictError('Pack already approved');
    if (cur.status === 'submitted') throw new ConflictError('Pack already submitted for approval');
    // A version created while a required screen had no data cannot go for
    // approval: the version is immutable, so the data goes on the screen and
    // a new version is created from it.
    const requiredMissing = cur.snapshot?.screens?.required_missing || [];
    if (requiredMissing.length) {
      throw new ConflictError(`Every required screen needs data before the pack goes for approval — v${cur.version} was created without: ${requiredMissing.join(', ')}. Fill them and create a new version.`);
    }
    await query(
      `UPDATE renewal_pack
          SET status = 'submitted', submitted_by = $1, submitted_at = now(),
              rejected_by = NULL, rejected_at = NULL, rejection_note = NULL
        WHERE id = $2`,
      [req.user.id, req.params.id],
    );
    await audit({
      entityType: 'renewal_pack', entityId: req.params.id, action: 'submit',
      userId: req.user.id, detail: { version: cur.version },
    });
    res.json(packSummary(await packRow(req.params.id)));
  }),
);

/* Approve a submitted version for market — a Senior Broker (or admin) who is
   not the one who created or submitted it. */
router.post(
  '/packs/:id/approve',
  requireRole('senior_broker', 'admin'),
  asyncHandler(async (req, res) => {
    const cur = await packRow(req.params.id);
    if (cur.status === 'approved') throw new ConflictError('Pack already approved');
    if (cur.status !== 'submitted') throw new ConflictError('Submit the pack for approval first');
    if ([cur.created_by, cur.submitted_by].includes(req.user.id)) {
      throw new ConflictError('Four-eyes: the broker who created or submitted the pack cannot approve it');
    }
    await query(
      `UPDATE renewal_pack SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2`,
      [req.user.id, req.params.id],
    );
    await audit({
      entityType: 'renewal_pack', entityId: req.params.id, action: 'approve',
      userId: req.user.id, detail: { version: cur.version, submitted_by: cur.submitted_by },
    });
    res.json(packSummary(await packRow(req.params.id)));
  }),
);

/* Return a submitted version to the broker with a note; it goes back to draft. */
router.post(
  '/packs/:id/reject',
  requireRole('senior_broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ note: z.string().trim().min(1).max(2000) }), req.body || {});
    const cur = await packRow(req.params.id);
    if (cur.status !== 'submitted') throw new ConflictError('Only a submitted pack can be returned');
    await query(
      `UPDATE renewal_pack
          SET status = 'draft', rejected_by = $1, rejected_at = now(), rejection_note = $2,
              submitted_by = NULL, submitted_at = NULL
        WHERE id = $3`,
      [req.user.id, body.note, req.params.id],
    );
    await audit({
      entityType: 'renewal_pack', entityId: req.params.id, action: 'reject',
      userId: req.user.id, detail: { version: cur.version, note: body.note },
    });
    res.json(packSummary(await packRow(req.params.id)));
  }),
);

/* ── The Pack Approval screen ─────────────────────────────────────────
   Where every version stands and how it got there: the audit trail of
   builds, submissions, approvals and returns, and the thread of comments on
   each version. Comments are versioned — an edit is a new comment naming
   the one it replaces, so nothing a reviewer wrote is ever overwritten. */

const COMMENT_ROLES = ['broker', 'senior_broker', 'underwriter', 'admin'];

/** The audit events of a set of pack versions, with who did each. */
async function packTrail(packIds) {
  if (!packIds.length) return [];
  const { rows } = await query(
    `SELECT a.id, a.entity_id AS pack_id, a.action, a.detail, a.created_at,
            u.name AS user_name, u.role AS user_role
       FROM audit_event a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity_type = 'renewal_pack' AND a.entity_id = ANY($1::text[])
      ORDER BY a.created_at, a.id`,
    [packIds.map(String)],
  );
  return rows;
}

/**
 * The comments of a set of versions, threaded by replacement: each thread
 * is the latest wording with every earlier wording underneath it.
 */
async function packComments(packIds) {
  if (!packIds.length) return [];
  const { rows } = await query(
    `SELECT c.id, c.pack_id, c.body, c.replaces_id, c.created_by, c.created_at,
            u.name AS created_by_name, u.role AS created_by_role
       FROM renewal_pack_comment c LEFT JOIN users u ON u.id = c.created_by
      WHERE c.pack_id = ANY($1::uuid[])
      ORDER BY c.created_at, c.id`,
    [packIds],
  );
  const replaced = new Set(rows.map((r) => r.replaces_id).filter(Boolean));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows
    .filter((r) => !replaced.has(r.id))
    .map((latest) => {
      const history = [];
      let cur = latest;
      while (cur.replaces_id && byId.has(cur.replaces_id)) {
        cur = byId.get(cur.replaces_id);
        history.unshift(cur);
      }
      const root = history[0] || latest;
      return { ...latest, root_id: root.id, first_at: root.created_at, edits: history.length, history };
    })
    .sort((a, b) => new Date(a.first_at).getTime() - new Date(b.first_at).getTime());
}

router.get(
  '/placements/:placementId/pack-approval',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `${PACK_SELECT} WHERE rp.placement_id = $1 ORDER BY rp.version DESC`,
      [req.params.placementId],
    );
    const ids = rows.map((r) => r.id);
    const [trail, comments] = await Promise.all([packTrail(ids), packComments(ids)]);
    res.json({
      versions: rows.map((r) => ({
        ...packSummary(r),
        trail: trail.filter((e) => e.pack_id === r.id),
        comments: comments.filter((c) => c.pack_id === r.id),
      })),
      approved: rows.find((r) => r.status === 'approved')?.id || null,
    });
  }),
);

const commentSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  // The comment this one replaces — an edit, kept as a new wording.
  replaces_id: z.string().uuid().optional(),
});

router.post(
  '/packs/:id/comments',
  requireRole(...COMMENT_ROLES),
  asyncHandler(async (req, res) => {
    const body = validate(commentSchema, req.body || {});
    const pack = await packRow(req.params.id);
    if (body.replaces_id) {
      const { rows } = await query(
        'SELECT id, created_by FROM renewal_pack_comment WHERE id = $1 AND pack_id = $2',
        [body.replaces_id, pack.id],
      );
      if (!rows[0]) throw new NotFoundError('Comment');
      if (rows[0].created_by !== req.user.id && req.user.role !== 'admin') {
        throw new ConflictError('Only the person who wrote a comment (or an admin) can revise it');
      }
      const { rowCount } = await query('SELECT 1 FROM renewal_pack_comment WHERE replaces_id = $1', [body.replaces_id]);
      if (rowCount) throw new ConflictError('This comment has already been revised — revise its latest wording');
    }
    const { rows } = await query(
      `INSERT INTO renewal_pack_comment (pack_id, body, replaces_id, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id, pack_id, body, replaces_id, created_by, created_at`,
      [pack.id, body.body, body.replaces_id || null, req.user.id],
    );
    await audit({
      entityType: 'renewal_pack', entityId: pack.id, action: body.replaces_id ? 'comment.revise' : 'comment',
      userId: req.user.id, detail: { version: pack.version, comment_id: rows[0].id, replaces_id: body.replaces_id || null, body: body.body },
    });
    const [thread] = await packComments([pack.id]).then((all) => all.filter((c) => c.id === rows[0].id));
    res.status(201).json(thread || rows[0]);
  }),
);

router.get(
  '/layers/:layerId/technical',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM layer WHERE id = $1', [req.params.layerId]);
    if (!rows[0]) throw new NotFoundError('Layer');
    res.json(await pullTechnical(rows[0]));
  }),
);

export { loadContext, packBasis };
export default router;
