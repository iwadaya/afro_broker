// Placement modelling store — per-screen state for the modelling workflow on
// the placement page (triangles, straight stats, losses, dev factors,
// profiles, CRESTA, event loss tables, pricing), persisted the way the
// Universe modelling tool saves each wizard screen: one upsert per section.
//
// The section key is the screen's identity ("triangle_premium",
// "loss_selection_large", …); the payload is the screen's JSON state and is
// deliberately schemaless — the screens own their shapes, and a new screen
// must not need a migration or an API change. Writes are audited with
// before/after like every other mutation.
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { llmProviders } from '../../lib/llm.js';
import {
  organiseSections, classesOf, buildModellingWorkbook, analyseModelling, crosscheckModelling,
  AI_SUMMARY_SECTION, CROSSCHECK_SECTION,
} from './modellingPack.js';

const router = Router();
router.use(authenticate);

// Mirrors the CHECK constraint on placement_modelling.section.
const SECTION_RE = /^[a-z0-9][a-z0-9_:.-]{0,79}$/;

const sectionParam = z.object({
  placementId: z.string().uuid(),
  section: z.string().regex(SECTION_RE, 'Invalid section key'),
});

const putSchema = z.object({
  data: z.union([z.record(z.any()), z.array(z.any())]),
});

// A screen's state is bounded — a paste of a whole bordereau belongs on the
// Data tab, not in a modelling section.
const MAX_SECTION_BYTES = 4 * 1024 * 1024;

async function assertPlacement(placementId) {
  const { rowCount } = await query('SELECT 1 FROM placement WHERE id = $1', [placementId]);
  if (!rowCount) throw new NotFoundError('Placement');
}

/** Every saved section for the placement, keyed by section. */
router.get(
  '/placements/:placementId/modelling',
  asyncHandler(async (req, res) => {
    const params = validate(z.object({ placementId: z.string().uuid() }), req.params);
    await assertPlacement(params.placementId);
    const { rows } = await query(
      `SELECT section, data, updated_at, updated_by
         FROM placement_modelling WHERE placement_id = $1 ORDER BY section`,
      [params.placementId],
    );
    const sections = {};
    for (const r of rows) {
      sections[r.section] = { data: r.data, updated_at: r.updated_at, updated_by: r.updated_by };
    }
    res.json({ placement_id: params.placementId, sections });
  }),
);

/* ── The standardised renewal pack of the modelling data, and its AI analysis ──
   Registered before the per-section routes: "pack" would otherwise read as a section key. */

const DOC_COLUMNS = 'id, placement_id, filename, mime_type, size_bytes, note, uploaded_by, created_at';
const MAX_DOC_BYTES = 15 * 1024 * 1024; // fits the JSON body limit after base64 overhead
const TEXT_TYPES = ['application/json', 'application/csv'];

/** Upsert one of the AI sections (summary, cross-check) beside the screens. */
async function storeAiSection(placementId, section, data, userId) {
  await query(
    `INSERT INTO placement_modelling (placement_id, section, data, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (placement_id, section) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [placementId, section, JSON.stringify(data), userId],
  );
}

/** The placement with its cedant, and every stored section grouped by class and screen. */
async function packContext(placementId) {
  const { rows: [placement] } = await query(
    `SELECT p.*, c.name AS cedant_name FROM placement p LEFT JOIN cedant c ON c.id = p.cedant_id WHERE p.id = $1`,
    [placementId],
  );
  if (!placement) throw new NotFoundError('Placement');
  const { rows } = await query(
    'SELECT section, data, updated_at FROM placement_modelling WHERE placement_id = $1',
    [placementId],
  );
  const sections = Object.fromEntries(rows.map((r) => [r.section, { data: r.data, updated_at: r.updated_at }]));
  const { rows: types } = await query('SELECT treaty_type FROM public.treaty_type').catch(() => ({ rows: [] }));
  const cobs = classesOf(placement.class, types.map((t) => t.treaty_type));
  const classes = organiseSections(sections, cobs);
  const aiSummary = sections[AI_SUMMARY_SECTION]?.data || null;
  const crosscheck = sections[CROSSCHECK_SECTION]?.data || null;
  return { placement, sections, classes, aiSummary, crosscheck };
}

/** What the pack would carry: the classes and screens with data, and the stored AI summary. */
router.get(
  '/placements/:placementId/modelling/pack',
  asyncHandler(async (req, res) => {
    const params = validate(z.object({ placementId: z.string().uuid() }), req.params);
    const { classes, aiSummary, crosscheck } = await packContext(params.placementId);
    const { rows: documents } = await query(
      `SELECT ${DOC_COLUMNS} FROM placement_modelling_document WHERE placement_id = $1 ORDER BY created_at`,
      [params.placementId],
    );
    res.json({
      classes: classes.map((c) => ({ name: c.name, screens: c.screens.map((s) => ({ key: s.key, title: s.title, updated_at: s.updated_at })) })),
      analysis: aiSummary,
      crosscheck,
      documents,
      providers: llmProviders(),
    });
  }),
);

/** The Excel pack: a cover, then a sheet per screen per class of business. */
router.get(
  '/placements/:placementId/modelling/pack.xlsx',
  asyncHandler(async (req, res) => {
    const params = validate(z.object({ placementId: z.string().uuid() }), req.params);
    const { placement, classes, aiSummary, crosscheck } = await packContext(params.placementId);
    const buffer = await buildModellingWorkbook({ placement, classes, aiSummary, crosscheck });
    await audit({ entityType: 'placement_modelling', entityId: placement.id, action: 'export_pack', userId: req.user.id, detail: { sheets: classes.reduce((n, c) => n + c.screens.length, 0) } });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${placement.reference}-modelling-pack.xlsx"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  }),
);

/** Run the AI analysis over every screen's data and store it with the sections. */
router.post(
  '/placements/:placementId/modelling/analysis',
  requireRole('broker', 'admin', 'underwriter'),
  asyncHandler(async (req, res) => {
    const params = validate(z.object({ placementId: z.string().uuid() }), req.params);
    const { placement, classes } = await packContext(params.placementId);
    if (!classes.some((c) => c.screens.length)) throw new ValidationError('Nothing to analyse yet — enter data on the modelling screens first');
    let result;
    try {
      result = await analyseModelling({ placement, classes }, req.app.locals.llmClients || {});
    } catch (e) {
      if (e.code === 'llm_unavailable') {
        res.status(503).json({ error: e.message, code: e.code, attempts: e.attempts, providers: llmProviders() });
        return;
      }
      throw e;
    }
    const data = {
      ...result.data,
      provider: result.provider, model: result.model, generated_at: new Date().toISOString(),
      classes: classes.map((c) => c.name), screens: classes.reduce((n, c) => n + c.screens.length, 0),
    };
    await storeAiSection(placement.id, AI_SUMMARY_SECTION, data, req.user.id);
    await audit({ entityType: 'placement_modelling', entityId: placement.id, action: 'analyse', userId: req.user.id, detail: { provider: result.provider, model: result.model } });
    res.json({ analysis: data });
  }),
);

/* ── The raw data behind the screens, and the AI cross-check against it ── */

const uploadSchema = z.object({
  filename: z.string().min(1).max(255),
  mime_type: z.string().min(1).max(255),
  content_base64: z.string().min(1),
  note: z.string().max(500).optional(),
});

/** Upload a raw data file (base64 JSON body, like the renewal pack analysis). */
router.post(
  '/placements/:placementId/modelling/documents',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const params = validate(z.object({ placementId: z.string().uuid() }), req.params);
    await assertPlacement(params.placementId);
    const body = validate(uploadSchema, req.body);
    const content = Buffer.from(body.content_base64, 'base64');
    if (!content.length) throw new ValidationError('Uploaded file is empty or not valid base64');
    if (content.length > MAX_DOC_BYTES) throw new ValidationError('File exceeds the 15MB upload limit');
    const textLike = body.mime_type.startsWith('text/') || TEXT_TYPES.includes(body.mime_type);
    const { rows } = await query(
      `INSERT INTO placement_modelling_document (placement_id, filename, mime_type, size_bytes, content, text_content, note, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${DOC_COLUMNS}`,
      [params.placementId, body.filename, body.mime_type, content.length, content, textLike ? content.toString('utf8') : null, body.note || null, req.user.id],
    );
    await audit({ entityType: 'placement_modelling', entityId: params.placementId, action: 'upload_raw_data', userId: req.user.id, detail: { filename: body.filename, size_bytes: content.length } });
    res.status(201).json(rows[0]);
  }),
);

router.delete(
  '/placements/:placementId/modelling/documents/:docId',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const params = validate(z.object({ placementId: z.string().uuid(), docId: z.string().uuid() }), req.params);
    const { rows } = await query(
      'DELETE FROM placement_modelling_document WHERE id = $1 AND placement_id = $2 RETURNING id, filename',
      [params.docId, params.placementId],
    );
    if (!rows[0]) throw new NotFoundError('Document');
    await audit({ entityType: 'placement_modelling', entityId: params.placementId, action: 'delete_raw_data', userId: req.user.id, detail: { filename: rows[0].filename } });
    res.status(204).end();
  }),
);

/** Have the AI cross-check every screen against the raw data and store the result. */
router.post(
  '/placements/:placementId/modelling/crosscheck',
  requireRole('broker', 'admin', 'underwriter'),
  asyncHandler(async (req, res) => {
    const params = validate(z.object({ placementId: z.string().uuid() }), req.params);
    const { placement, classes } = await packContext(params.placementId);
    if (!classes.some((c) => c.screens.length)) throw new ValidationError('Nothing to cross-check yet — enter data on the modelling screens first');
    const { rows: documents } = await query(
      `SELECT ${DOC_COLUMNS}, content, text_content FROM placement_modelling_document WHERE placement_id = $1 ORDER BY created_at`,
      [params.placementId],
    );
    if (!documents.length) throw new ValidationError('Upload the raw data files first');
    let result;
    try {
      result = await crosscheckModelling({ placement, classes, documents }, req.app.locals.llmClients || {});
    } catch (e) {
      if (e.code === 'llm_unavailable') {
        res.status(503).json({ error: e.message, code: e.code, attempts: e.attempts, providers: llmProviders() });
        return;
      }
      if (e.code === 'no_readable_documents') throw new ValidationError(e.message);
      throw e;
    }
    const data = {
      ...result.data,
      provider: result.provider, model: result.model, generated_at: new Date().toISOString(),
      documents: documents.map((d) => d.filename), classes: classes.map((c) => c.name),
    };
    await storeAiSection(placement.id, CROSSCHECK_SECTION, data, req.user.id);
    await audit({ entityType: 'placement_modelling', entityId: placement.id, action: 'crosscheck', userId: req.user.id, detail: { provider: result.provider, model: result.model, documents: documents.length } });
    res.json({ crosscheck: data });
  }),
);

router.get(
  '/placements/:placementId/modelling/:section',
  asyncHandler(async (req, res) => {
    const params = validate(sectionParam, req.params);
    await assertPlacement(params.placementId);
    const { rows } = await query(
      `SELECT section, data, updated_at, updated_by
         FROM placement_modelling WHERE placement_id = $1 AND section = $2`,
      [params.placementId, params.section],
    );
    if (!rows.length) return res.json({ section: params.section, data: null, updated_at: null });
    res.json(rows[0]);
  }),
);

/** Upsert one section. The write replaces the section wholesale — a screen
    always saves its complete state, never a patch, so a reload renders
    exactly what was saved. */
router.put(
  '/placements/:placementId/modelling/:section',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const params = validate(sectionParam, req.params);
    const body = validate(putSchema, req.body);
    if (JSON.stringify(body.data).length > MAX_SECTION_BYTES) {
      throw new ValidationError(`Section payload exceeds ${MAX_SECTION_BYTES / (1024 * 1024)}MB`);
    }
    await assertPlacement(params.placementId);

    const before = await query(
      'SELECT data FROM placement_modelling WHERE placement_id = $1 AND section = $2',
      [params.placementId, params.section],
    );
    const { rows } = await query(
      `INSERT INTO placement_modelling (placement_id, section, data, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (placement_id, section)
       DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING section, data, updated_at, updated_by`,
      [params.placementId, params.section, JSON.stringify(body.data), req.user.id],
    );
    await audit({
      entityType: 'placement_modelling',
      entityId: `${params.placementId}:${params.section}`,
      action: before.rowCount ? 'modelling_section_updated' : 'modelling_section_created',
      userId: req.user.id,
      detail: { placement_id: params.placementId, section: params.section },
    });
    res.json(rows[0]);
  }),
);

router.delete(
  '/placements/:placementId/modelling/:section',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const params = validate(sectionParam, req.params);
    await assertPlacement(params.placementId);
    const { rowCount } = await query(
      'DELETE FROM placement_modelling WHERE placement_id = $1 AND section = $2',
      [params.placementId, params.section],
    );
    if (rowCount) {
      await audit({
        entityType: 'placement_modelling',
        entityId: `${params.placementId}:${params.section}`,
        action: 'modelling_section_deleted',
        userId: req.user.id,
        detail: { placement_id: params.placementId, section: params.section },
      });
    }
    res.json({ ok: true, deleted: rowCount > 0 });
  }),
);

export default router;
