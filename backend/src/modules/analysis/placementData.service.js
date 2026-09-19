/*
 * The Data screen of the placement workflow.
 *
 * The screen ingests nothing. It reads what the screens before it hold —
 * treaty detail, expiring structure, structures to quote, retentions and the
 * modelling screens — as one digest, and compares this year with:
 *
 *   - the prior year in the book, where the placement renews one
 *     (`renewal_of`): its screens are read the same way and the two digests
 *     are compared figure by figure; or
 *   - the expiring renewal pack uploaded for a placement that is new to the
 *     house, in whatever format the other broker wrote it — held as an
 *     uploaded pack (renewal_pack_analysis, role "expiring") linked to the
 *     placement, read by the model.
 *
 * The digest and the deterministic comparison are computed here and cost
 * nothing; the model's reading (placementData.llm.js) is asked for on top.
 */

import { query } from '../../db/pool.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { splitClass } from '../../domain/placementClass.js';
import { propCapacity, rolOf } from '../../domain/negotiation.js';
import { organiseSections, classesOf, blocksOf } from '../modelling/modellingPack.js';

const numOrNull = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const day = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null);

async function loadPlacement(placementId) {
  const { rows } = await query(
    `SELECT p.*, c.name AS cedant_name, c.domicile AS cedant_domicile
       FROM placement p LEFT JOIN cedant c ON c.id = p.cedant_id WHERE p.id = $1`,
    [placementId],
  );
  if (!rows[0]) throw new NotFoundError('Placement');
  const { rows: layers } = await query(
    'SELECT * FROM layer WHERE placement_id = $1 ORDER BY position, created_at', [placementId],
  );
  return { ...rows[0], layers };
}

/** A stored layer (structure JSON or layer row) in one shape, with its rate on line. */
function layerDigest(l, i) {
  const limit = numOrNull(l.limit ?? l.limit_amt);
  const premium = numOrNull(l.premium ?? l.premium100);
  return {
    name: l.name || `Layer ${i + 1}`,
    type: l.type || null,
    limit,
    attachment: numOrNull(l.attachment),
    premium,
    rate_pct: numOrNull(l.rate_pct),
    rol_pct: rolOf({ limit_amt: limit, premium }),
    reinstatements: l.reinstatements || null,
    reinstatement_pct: numOrNull(l.reinstatement_pct),
    egnpi: numOrNull(l.egnpi),
    aad: numOrNull(l.aad),
    order_pct: numOrNull(l.order ?? l.order_pct),
  };
}

/** Proportional terms in one shape, with the capacity they add up to. */
function propDigest(prop = {}) {
  const p = prop || {};
  return {
    treaty_type: p.treatyType || null,
    qs_limit: numOrNull(p.qsLimit),
    max_retention: numOrNull(p.surplusMaxRetention),
    lines: numOrNull(p.numLines),
    cession_pct: numOrNull(p.cessionPct ?? p.cession_pct),
    retention_pct: numOrNull(p.retentionPct ?? p.retention_pct),
    commission_pct: numOrNull(p.commissionPct ?? p.commission_pct),
    epi: numOrNull(p.epi),
    capacity: propCapacity(p) || null,
  };
}

function structureDigest(st, i) {
  const basis = st?.basis === 'PROP' ? 'PROP' : 'NP';
  return {
    label: `Structure ${i + 1}`,
    basis,
    treaty_type: basis === 'PROP' ? (st.prop?.treatyType || null) : (st.npTreatyType || null),
    layers: basis === 'PROP' ? [] : (st.layers || []).map(layerDigest),
    prop: basis === 'PROP' ? propDigest(st.prop) : null,
  };
}

/**
 * The expiring structure: the one recorded on the placement; else, on a
 * renewal, the prior year's — its layer rows where it has them, else its
 * structure 1 — read live as the placement page reads it.
 */
function expiringDigest(exp, priorLayers = [], priorStructure = null) {
  if (exp && exp.basis) {
    const basis = exp.basis === 'PROP' ? 'PROP' : 'NP';
    return {
      recorded: true,
      basis,
      treaty_type: basis === 'PROP' ? (exp.prop?.treatyType || null) : (exp.np?.treatyType || null),
      layers: basis === 'PROP' ? [] : (exp.layers || []).map(layerDigest),
      prop: basis === 'PROP' ? propDigest(exp.prop) : null,
    };
  }
  if (priorLayers.length) {
    return { recorded: false, basis: 'NP', treaty_type: null, layers: priorLayers.map(layerDigest), prop: null };
  }
  if (priorStructure) {
    const st = structureDigest(priorStructure, 0);
    return { recorded: false, basis: st.basis, treaty_type: st.treaty_type, layers: st.layers, prop: st.prop };
  }
  return null;
}

function retentionsDigest(stored) {
  if (!stored) return null;
  const rows = Array.isArray(stored) ? stored : (stored.rows || stored.categories || []);
  return {
    treaty_limit: numOrNull(stored.treaty_limit ?? stored.treatyLimit ?? stored.limit),
    rows: rows.map((r) => ({
      klass: r.klass ?? r.class ?? null,
      category: r.category ?? r.name ?? null,
      pct: numOrNull(r.pct ?? r.percent ?? r.pct_of_limit),
    })).filter((r) => r.category),
  };
}

/** A modelling screen's data, summarised as its tables' shapes and totals. */
function screenDigest(screen) {
  const blocks = blocksOf(screen.data, screen.title);
  return {
    key: screen.key,
    title: screen.title,
    updated_at: screen.updated_at,
    blocks: blocks.slice(0, 12).map((b) => (b.facts
      ? { title: b.title || null, facts: Object.fromEntries(b.facts.slice(0, 30)) }
      : {
        title: b.title || null,
        columns: b.headers,
        rows: b.rows.length,
        totals: Object.fromEntries(b.headers.map((h, i) => {
          const nums = b.rows.map((r) => r[i]).filter((v) => typeof v === 'number');
          return [h, nums.length ? Number(nums.reduce((a, c) => a + c, 0).toFixed(2)) : null];
        }).filter(([, v]) => v != null)),
        sample: b.rows.slice(0, 6),
      })),
  };
}

/**
 * Everything the screens hold for one placement, as one digest: the treaty
 * detail, the expiring structure, the structures to quote, the retentions
 * and the modelling screens per class of business.
 */
export async function placementDigest(placementOrId) {
  const placement = typeof placementOrId === 'string' ? await loadPlacement(placementOrId) : placementOrId;
  const { rows: sections } = await query(
    'SELECT section, data, updated_at FROM placement_modelling WHERE placement_id = $1', [placement.id],
  );
  const cls = splitClass(placement.class);
  const cobs = cls.cobs.length ? cls.cobs : classesOf(placement.class);
  const classes = organiseSections(
    Object.fromEntries(sections.map((r) => [r.section, { data: r.data, updated_at: r.updated_at }])),
    cobs,
  );
  const structures = (placement.quote_structures || []).map(structureDigest);
  // Nothing recorded as expiring on a renewal → the prior year's layers are
  // the expiring structure, read live as the placement page reads them.
  let priorLayers = [];
  let priorStructure = null;
  if (!placement.expiring_structure?.basis && placement.renewal_of) {
    ({ rows: priorLayers } = await query(
      'SELECT name, type, limit_amt, attachment, premium100, rate_pct, reinstatements, reinstatement_pct, egnpi, aad, order_pct FROM layer WHERE placement_id = $1 ORDER BY position, created_at',
      [placement.renewal_of],
    ));
    if (!priorLayers.length) {
      const { rows } = await query('SELECT quote_structures FROM placement WHERE id = $1', [placement.renewal_of]);
      priorStructure = (rows[0]?.quote_structures || [])[0] || null;
    }
  }
  const digest = {
    placement: {
      id: placement.id,
      reference: placement.reference,
      cedant: placement.cedant_name || null,
      domicile: placement.cedant_domicile || null,
      class: placement.class,
      treaty_type: placement.treaty_type || cls.treaty_type,
      classes_of_business: cobs,
      currency: placement.currency,
      inception: day(placement.inception),
      expiry: day(placement.expiry),
      status: placement.status,
      renewal_of: placement.renewal_of || null,
      notes: placement.notes || null,
    },
    expiring_structure: expiringDigest(placement.expiring_structure, priorLayers, priorStructure),
    structures,
    layers: (placement.layers || []).map(layerDigest),
    retentions: retentionsDigest(placement.retentions),
    modelling: classes.map((c) => ({ class: c.name, screens: c.screens.map(screenDigest) })),
  };
  digest.screens = {
    treaty_detail: true,
    expiring_structure: Boolean(digest.expiring_structure && (digest.expiring_structure.layers.length || digest.expiring_structure.prop)),
    quote_structure: structures.some((s) => s.layers.length || (s.prop && (s.prop.capacity || s.prop.treaty_type))),
    retentions: Boolean(digest.retentions?.rows?.length),
    modelling_screens: classes.reduce((n, c) => n + c.screens.length, 0),
  };
  return digest;
}

/** A movement between two figures, or nothing when they agree. */
function delta(area, item, field, from, to) {
  const a = numOrNull(from);
  const b = numOrNull(to);
  if (a === null && b === null) return null;
  if (a !== null && b !== null && Math.abs(a - b) < 0.00005) return null;
  if (a === null || b === null) {
    if ((from ?? null) === (to ?? null)) return null;
    return { area, item, field, from: from ?? null, to: to ?? null, change_pct: null };
  }
  return { area, item, field, from: a, to: b, change_pct: a !== 0 ? Number((((b - a) / Math.abs(a)) * 100).toFixed(2)) : null };
}

const LAYER_FIELDS = ['limit', 'attachment', 'premium', 'rate_pct', 'rol_pct', 'reinstatements', 'reinstatement_pct', 'egnpi', 'aad'];
const PROP_FIELDS = ['qs_limit', 'max_retention', 'lines', 'cession_pct', 'commission_pct', 'epi', 'capacity'];

function compareLayers(area, current = [], prior = []) {
  const out = [];
  const max = Math.max(current.length, prior.length);
  for (let i = 0; i < max; i += 1) {
    const now = current[i];
    const was = prior.find((l) => now && String(l.name).toLowerCase() === String(now.name).toLowerCase()) || prior[i];
    if (now && !was) { out.push({ area, item: now.name, field: 'layer', from: null, to: 'added', change_pct: null }); continue; }
    if (!now && was) { out.push({ area, item: was.name, field: 'layer', from: 'present', to: 'removed', change_pct: null }); continue; }
    for (const f of LAYER_FIELDS) {
      const d = delta(area, now.name, f, was[f], now[f]);
      if (d) out.push(d);
    }
  }
  return out;
}

/**
 * The deterministic comparison of this year's digest with the prior year's:
 * structure 1 against the expiring structure (this year's expiring where
 * recorded, else last year's structure 1), retentions row by row, and the
 * treaty detail. Computed, so it stands whether or not a model reads it.
 */
export function computeChanges(current, prior) {
  const changes = [];
  if (!prior) return { changes, basis_layers: 0 };
  const now1 = current.structures[0] || null;
  const was1 = prior.structures[0] || null;
  if (now1 && was1) {
    if (now1.basis !== was1.basis) changes.push({ area: 'Structure', item: 'Basis', field: 'basis', from: was1.basis, to: now1.basis, change_pct: null });
    if (now1.basis === 'NP' && was1.basis === 'NP') changes.push(...compareLayers('Structure', now1.layers, was1.layers));
    if (now1.basis === 'PROP' && was1.basis === 'PROP') {
      for (const f of PROP_FIELDS) {
        const d = delta('Structure', now1.prop?.treaty_type || 'Proportional terms', f, was1.prop?.[f], now1.prop?.[f]);
        if (d) changes.push(d);
      }
    }
  } else if (now1 && !was1) {
    changes.push({ area: 'Structure', item: now1.label, field: 'structure', from: null, to: 'added', change_pct: null });
  }
  if (current.structures.length !== prior.structures.length) {
    changes.push({ area: 'Structure', item: 'Structures to quote', field: 'count', from: prior.structures.length, to: current.structures.length, change_pct: null });
  }
  const nowRet = current.retentions?.rows || [];
  const wasRet = prior.retentions?.rows || [];
  for (const r of nowRet) {
    const was = wasRet.find((w) => String(w.category).toLowerCase() === String(r.category).toLowerCase());
    if (!was) { changes.push({ area: 'Retentions', item: r.category, field: 'category', from: null, to: 'added', change_pct: null }); continue; }
    const d = delta('Retentions', r.category, 'pct', was.pct, r.pct);
    if (d) changes.push(d);
  }
  for (const w of wasRet) {
    if (!nowRet.some((r) => String(r.category).toLowerCase() === String(w.category).toLowerCase())) {
      changes.push({ area: 'Retentions', item: w.category, field: 'category', from: 'present', to: 'removed', change_pct: null });
    }
  }
  const dl = delta('Retentions', 'Treaty limit', 'treaty_limit', prior.retentions?.treaty_limit, current.retentions?.treaty_limit);
  if (dl) changes.push(dl);
  for (const f of ['currency', 'treaty_type', 'class']) {
    if ((current.placement[f] ?? null) !== (prior.placement[f] ?? null)) {
      changes.push({ area: 'Treaty detail', item: f.replace('_', ' '), field: f, from: prior.placement[f] ?? null, to: current.placement[f] ?? null, change_pct: null });
    }
  }
  const nowScreens = new Set(current.modelling.flatMap((c) => c.screens.map((s) => `${c.class}:${s.key}`)));
  const wasScreens = new Set(prior.modelling.flatMap((c) => c.screens.map((s) => `${c.class}:${s.key}`)));
  for (const k of wasScreens) {
    if (!nowScreens.has(k)) changes.push({ area: 'Modelling', item: k.split(':')[1], field: 'screen', from: 'entered last year', to: 'not entered this year', change_pct: null });
  }
  return { changes, basis_layers: was1?.layers?.length || 0 };
}

/** The uploaded expiring pack linked to the placement, if there is one. */
async function linkedExpiringPack(placementId) {
  const { rows } = await query(
    `SELECT a.id, a.status, a.result, a.analysed_at, a.cedant_name, a.class_of_business, a.treaty_type
       FROM renewal_pack_analysis a WHERE a.placement_id = $1
      ORDER BY (a.status = 'complete') DESC, a.created_at DESC LIMIT 1`,
    [placementId],
  );
  const analysis = rows[0];
  if (!analysis) return null;
  const { rows: documents } = await query(
    `SELECT id, role, filename, mime_type, size_bytes, uploaded_by, created_at
       FROM renewal_pack_analysis_document WHERE analysis_id = $1 ORDER BY created_at`,
    [analysis.id],
  );
  if (!documents.length) return null;
  const extracted = analysis.result
    ? { programme: analysis.result.programme, layers: analysis.result.layers, experience: analysis.result.experience, changes: analysis.result.changes, standard_pack: analysis.result.standard_pack }
    : null;
  return { analysis: { id: analysis.id, status: analysis.status, analysed_at: analysis.analysed_at }, documents, extracted };
}

/**
 * What this year is compared with: the prior placement's digest, the
 * uploaded expiring pack, or nothing.
 */
export async function comparisonFor(placement) {
  if (placement.renewal_of) {
    const prior = await placementDigest(placement.renewal_of).catch((e) => { if (e.name === 'NotFoundError') return null; throw e; });
    if (prior) return { basis: 'prior_year', compared_to: placement.renewal_of, prior };
  }
  const pack = await linkedExpiringPack(placement.id);
  if (pack) return { basis: 'expiring_pack', compared_to: pack.analysis.id, ...pack, prior: null };
  return { basis: 'none', compared_to: null, prior: null };
}

/** The whole reading the screen opens on — digest, comparison and computed changes. */
export async function dataContext(placementId) {
  const placement = await loadPlacement(placementId);
  const digest = await placementDigest(placement);
  const comparison = await comparisonFor(placement);
  const computed = comparison.basis === 'prior_year' ? computeChanges(digest, comparison.prior) : { changes: [], basis_layers: 0 };
  return { placement, digest, comparison, computed };
}

/** The raw uploaded documents, for the model to read the pack itself. */
export async function rawDocuments(analysisId) {
  const { rows } = await query(
    'SELECT * FROM renewal_pack_analysis_document WHERE analysis_id = $1 ORDER BY created_at', [analysisId],
  );
  return rows;
}

const TEXT_TYPES = ['application/json', 'application/csv'];

/**
 * Upload the expiring renewal pack for a placement new to the house: the
 * pack is held as an uploaded pack (renewal_pack_analysis) linked to the
 * placement, with the document in the "expiring" role, so the desk and the
 * pack builder can read it too. A placement renewing a year in the book
 * compares with that year instead and takes no upload.
 */
export async function uploadExpiringPack(placementId, input, user) {
  const placement = await loadPlacement(placementId);
  if (placement.renewal_of) {
    throw new ValidationError('This placement renews a year in the book — the comparison runs against that year, not an upload');
  }
  const content = Buffer.from(String(input.content_base64 || ''), 'base64');
  if (!content.length) throw new ValidationError('Uploaded file is empty or not valid base64');
  if (content.length > 15 * 1024 * 1024) throw new ValidationError('Document exceeds the 15MB upload limit');

  const { rows: existing } = await query(
    'SELECT id FROM renewal_pack_analysis WHERE placement_id = $1 ORDER BY created_at DESC LIMIT 1', [placementId],
  );
  let analysisId = existing[0]?.id;
  if (!analysisId) {
    const cls = splitClass(placement.class);
    const { rows } = await query(
      `INSERT INTO renewal_pack_analysis (cedant_name, cedant_domicile, cedant_notes, class_of_business, treaty_type, created_by, placement_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [placement.cedant_name || placement.reference, placement.cedant_domicile || null,
        `Expiring pack uploaded on the Data screen of ${placement.reference}`,
        cls.cobs.join(' / ') || placement.class, cls.treaty_type || placement.class, user.id, placementId],
    );
    analysisId = rows[0].id;
  }
  const textLike = String(input.mime_type || '').startsWith('text/') || TEXT_TYPES.includes(input.mime_type);
  const { rows } = await query(
    `INSERT INTO renewal_pack_analysis_document (analysis_id, role, filename, mime_type, size_bytes, content, text_content, uploaded_by)
     VALUES ($1,'expiring',$2,$3,$4,$5,$6,$7) RETURNING id, analysis_id, role, filename, mime_type, size_bytes, created_at`,
    [analysisId, input.filename, input.mime_type || 'application/octet-stream', content.length, content,
      textLike ? content.toString('utf8') : null, user.id],
  );
  return { analysis_id: analysisId, document: rows[0] };
}

export async function latestAnalysis(placementId) {
  const { rows } = await query(
    `SELECT a.id, a.basis, a.compared_to, a.provider, a.model, a.narrative, a.computed, a.created_at, u.name AS created_by_name
       FROM placement_data_analysis a LEFT JOIN users u ON u.id = a.created_by
      WHERE a.placement_id = $1 ORDER BY a.created_at DESC LIMIT 1`,
    [placementId],
  );
  return rows[0] || null;
}
