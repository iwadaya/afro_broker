import { Router } from 'express';
import { z } from 'zod';
import pg from 'pg';
import { asyncHandler, validate } from '../../lib/http.js';
import { ValidationError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { parseUpload, parseCsvTable } from '../../lib/tabular.js';
import {
  TEMPLATES, suggestMappings, learnMappings, standardMatch,
  detectType, suggestCombined, standardMatchCombined, combinedTemplate,
} from './ingest.service.js';

const router = Router();
router.use(authenticate);

const PREVIEW_ROWS = 25;

const previewSchema = z.object({
  filename: z.string().optional(),
  content_base64: z.string().optional(),
  csv: z.string().optional(),
  database: z.object({
    connection_string: z.string().min(1),
    sql: z.string().min(1),
  }).optional(),
}).refine((d) => d.content_base64 || d.csv || d.database, { message: 'Provide a file, CSV text or a database link' });

/** Run a read-only query against a linked cedant database. */
async function queryDatabase({ connection_string, sql }) {
  const stmt = sql.trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(stmt) || stmt.includes(';')) {
    throw new ValidationError('Only a single SELECT statement can be linked');
  }
  const client = new pg.Client({ connectionString: connection_string, statement_timeout: 15000 });
  try {
    await client.connect();
    const res = await client.query({ text: stmt, rowMode: 'array' });
    const headers = res.fields.map((f) => f.name);
    const rows = res.rows.slice(0, 5000).map((r) => Object.fromEntries(
      headers.map((h, i) => [h, r[i] == null ? '' : (r[i] instanceof Date ? r[i].toISOString().slice(0, 10) : String(r[i]))]),
    ));
    return [{ name: 'Database query', headers, rows, row_count: rows.length }];
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError(`Database link failed: ${e.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

/* Parse an uploaded bordereau (xlsx/csv/pdf), pasted CSV, or a linked
   database query into tables. Full rows are returned so the client can
   transform + import without re-uploading; `preview_rows` is what the UI
   should render. */
router.post(
  '/preview',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(previewSchema, req.body);
    let tables;
    let source;
    if (body.database) {
      tables = await queryDatabase(body.database);
      source = 'database';
    } else if (body.content_base64) {
      tables = await parseUpload(body.filename || 'upload.csv', body.content_base64);
      source = (body.filename || '').toLowerCase().split('.').pop() || 'file';
    } else {
      tables = parseCsvTable(body.csv, body.filename || 'Pasted CSV');
      source = 'csv';
    }
    if (tables.length === 0 || tables.every((t) => t.rows.length === 0)) {
      throw new ValidationError('No tabular data found in the source');
    }
    res.json({ source, preview_rows: PREVIEW_ROWS, tables });
  }),
);

const suggestSchema = z.object({
  type: z.enum(['premium', 'claims', 'both']),
  mode: z.enum(['ml', 'standard']).default('ml'),
  headers: z.array(z.string()).min(1),
  samples: z.record(z.string(), z.array(z.any())).default({}),
});

/** Column catalogue for a type — the combined one merges both templates. */
const fieldsFor = (type) => (type === 'both'
  ? combinedTemplate()
  : TEMPLATES[type].map(({ field, label, required }) => ({ field, label, required })));

/* Column-mapping suggestions. ML mode: supervised naive Bayes over learned
   header examples (+ template alias seeds), with unsupervised content
   profiling filling anything the classifier is unsure about. Standard mode:
   strict template header matching. */
router.post(
  '/suggest',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(suggestSchema, req.body);
    let suggestions;
    if (body.type === 'both') {
      suggestions = body.mode === 'standard'
        ? standardMatchCombined(body.headers)
        : await suggestCombined(body.headers, body.samples);
    } else {
      suggestions = body.mode === 'standard'
        ? standardMatch(body.type, body.headers)
        : await suggestMappings(body.type, body.headers, body.samples);
    }
    const fields = fieldsFor(body.type);
    const missing = fields
      .filter((f) => f.required && !suggestions.some((s) => s.field === f.field))
      .map((f) => f.field);
    res.json({ suggestions, fields, missing_required: missing });
  }),
);

const learnSchema = z.object({
  type: z.enum(['premium', 'claims', 'both']),
  mappings: z.array(z.object({ header: z.string(), field: z.string() })).min(1),
});

/* Record broker-confirmed mappings after an import — this is how the
   supervised classifier improves with every bordereau it sees. */
router.post(
  '/learn',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(learnSchema, req.body);
    const learned = await learnMappings(body.type, body.mappings, req.user.id);
    res.json({ learned });
  }),
);

/* The standard bordereau template — column catalogue per type. */
router.get(
  '/template',
  asyncHandler(async (req, res) => {
    const type = ['claims', 'both'].includes(req.query.type) ? req.query.type : 'premium';
    res.json({ type, columns: fieldsFor(type) });
  }),
);

const detectSchema = z.object({
  tables: z.array(z.object({
    name: z.string().optional(),
    headers: z.array(z.string()).min(1),
  })).min(1),
});

/* Is this a premium bordereau, a claims bordereau, or one sheet carrying
   both? Answered per table, so a workbook's tabs can differ. */
router.post(
  '/detect',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(detectSchema, req.body);
    res.json({
      tables: body.tables.map((t) => ({
        name: t.name || '',
        ...detectType(t.headers, { name: t.name || '' }),
      })),
    });
  }),
);

export default router;
