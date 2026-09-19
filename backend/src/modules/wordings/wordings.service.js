import { query, withTransaction } from '../../db/pool.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { buildUpdate, defined } from '../../lib/sql.js';
import { audit } from '../../lib/audit.js';
import { titleKey, alignClauseSets, normaliseBody, diffWords } from '../../domain/wordingDiff.js';

/** Reading order of a wording: what it covers, then what it excludes, then how it operates. */
export const CATEGORY_ORDER = ['coverage', 'extension', 'exclusion', 'condition', 'definition'];

const categoryRank = (c) => {
  const i = CATEGORY_ORDER.indexOf(c);
  return i === -1 ? CATEGORY_ORDER.length : i;
};

const CLAUSE_COLUMNS = `c.id, c.title, c.clause_ref, c.category, c.cob, c.treaty_type, c.source,
  c.market_id, c.body, c.summary, c.tags, c.status, c.version, c.created_at, c.updated_at,
  c.provenance, c.source_org, c.source_url, c.source_note`;

/* ------------------------------------------------------------------ library */

/**
 * List library clauses. `cob` matches the class *and* the general clauses that
 * apply to every class — a Property wording is its Property clauses plus the
 * treaty-wide conditions and market exclusions — unless `strict_cob` is set.
 */
export async function listClauses(filters = {}, page = { limit: 200, offset: 0 }) {
  const params = [];
  const where = ["c.status <> 'archived'"];
  if (filters.status) {
    params.push(filters.status);
    where[0] = `c.status = $${params.length}`;
  }
  if (filters.cob) {
    params.push(filters.cob);
    where.push(filters.strict_cob ? `c.cob = $${params.length}` : `(c.cob = $${params.length} OR c.cob IS NULL)`);
  }
  if (filters.category) {
    params.push(filters.category);
    where.push(`c.category = $${params.length}`);
  }
  if (filters.source) {
    params.push(filters.source);
    where.push(`c.source = $${params.length}`);
  }
  if (filters.market_id) {
    params.push(filters.market_id);
    where.push(`c.market_id = $${params.length}`);
  }
  if (filters.provenance) {
    params.push(filters.provenance);
    where.push(`c.provenance = $${params.length}`);
  }
  if (filters.treaty_type) {
    params.push(filters.treaty_type);
    where.push(`(c.treaty_type = $${params.length} OR c.treaty_type IS NULL)`);
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    where.push(`(c.title ILIKE $${params.length} OR c.body ILIKE $${params.length} OR c.clause_ref ILIKE $${params.length} OR c.summary ILIKE $${params.length})`);
  }
  params.push(page.limit, page.offset);
  const { rows } = await query(
    `SELECT ${CLAUSE_COLUMNS}, m.name AS market_name
     FROM wording_clause c LEFT JOIN market m ON m.id = c.market_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.category, c.cob NULLS LAST, c.title
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.sort((a, b) => categoryRank(a.category) - categoryRank(b.category));
}

export async function getClause(id) {
  const { rows } = await query(
    `SELECT ${CLAUSE_COLUMNS}, m.name AS market_name
     FROM wording_clause c LEFT JOIN market m ON m.id = c.market_id WHERE c.id = $1`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError('Clause');
  const { rows: revisions } = await query(
    `SELECT id, version, title, body, created_at FROM wording_clause_revision
     WHERE clause_id = $1 ORDER BY version DESC`,
    [id],
  );
  return { ...rows[0], revisions };
}

export async function createClause(input, userId) {
  if ((input.source === 'market') !== Boolean(input.market_id)) {
    throw new ValidationError('A market clause must name a reinsurer, and only a market clause may name one');
  }
  const { rows } = await query(
    `INSERT INTO wording_clause
       (title, clause_ref, category, cob, treaty_type, source, market_id, body, summary, tags, status,
        provenance, source_org, source_url, source_note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [input.title, input.clause_ref || null, input.category, input.cob || null,
      input.treaty_type || null, input.source || 'standard', input.market_id || null,
      input.body, input.summary || null, input.tags || [], input.status || 'active',
      input.provenance || 'illustrative', input.source_org || null,
      input.source_url || null, input.source_note || null, userId],
  );
  await audit({ entityType: 'wording_clause', entityId: rows[0].id, action: 'create', userId, detail: { title: input.title, category: input.category, cob: input.cob || null } });
  return rows[0];
}

/**
 * Edit a clause. A change of wording text is versioned: the outgoing body is
 * written to the revision history and `version` bumped, so the library keeps a
 * record of what the clause said when earlier drafts were built from it.
 */
export async function updateClause(id, input, userId) {
  return withTransaction(async (client) => {
    const { rows: current } = await client.query('SELECT * FROM wording_clause WHERE id = $1', [id]);
    if (!current[0]) throw new NotFoundError('Clause');
    const before = current[0];

    const source = input.source ?? before.source;
    const marketId = input.market_id !== undefined ? input.market_id : before.market_id;
    if ((source === 'market') !== Boolean(marketId)) {
      throw new ValidationError('A market clause must name a reinsurer, and only a market clause may name one');
    }

    const bodyChanged = input.body !== undefined && normaliseBody(input.body) !== normaliseBody(before.body);
    if (bodyChanged) {
      await client.query(
        `INSERT INTO wording_clause_revision (clause_id, version, title, body, changed_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, before.version, before.title, before.body, userId],
      );
    }

    const fields = defined({
      title: input.title,
      clause_ref: input.clause_ref,
      category: input.category,
      cob: input.cob,
      treaty_type: input.treaty_type,
      source: input.source,
      market_id: input.market_id,
      body: input.body,
      summary: input.summary,
      tags: input.tags,
      status: input.status,
      provenance: input.provenance,
      source_org: input.source_org,
      source_url: input.source_url,
      source_note: input.source_note,
    });
    fields.updated_at = new Date();
    if (bodyChanged) fields.version = before.version + 1;

    const upd = buildUpdate(fields);
    const { rows } = await client.query(
      `UPDATE wording_clause SET ${upd.text} WHERE id = $${upd.nextIndex} RETURNING *`,
      [...upd.values, id],
    );
    await audit({
      entityType: 'wording_clause',
      entityId: id,
      action: bodyChanged ? 'revise' : 'update',
      userId,
      detail: { fields: Object.keys(fields), version: rows[0].version },
    }, client);
    return rows[0];
  });
}

export async function deleteClause(id, userId) {
  const { rowCount } = await query('DELETE FROM wording_clause WHERE id = $1', [id]);
  if (!rowCount) throw new NotFoundError('Clause');
  await audit({ entityType: 'wording_clause', entityId: id, action: 'delete', userId });
}

/** Filter options for the library UI, with live counts. */
export async function libraryMeta() {
  const [cobs, treatyTypes, categories, markets, totals] = await Promise.all([
    query(`SELECT cob, COUNT(*)::int AS count FROM wording_clause
           WHERE status <> 'archived' GROUP BY cob ORDER BY cob NULLS FIRST`),
    query(`SELECT treaty_type, COUNT(*)::int AS count FROM wording_clause
           WHERE status <> 'archived' AND treaty_type IS NOT NULL
           GROUP BY treaty_type ORDER BY treaty_type`),
    query(`SELECT category, COUNT(*)::int AS count FROM wording_clause
           WHERE status <> 'archived' GROUP BY category`),
    query(`SELECT m.id, m.name, m.rating, m.security_status, COUNT(c.id)::int AS clause_count
           FROM market m LEFT JOIN wording_clause c ON c.market_id = m.id AND c.status <> 'archived'
           WHERE m.type = 'reinsurer'
           GROUP BY m.id ORDER BY COUNT(c.id) DESC, m.name`),
    query(`SELECT COUNT(*)::int AS clauses,
             COUNT(*) FILTER (WHERE source = 'market')::int AS market_clauses,
             COUNT(*) FILTER (WHERE provenance = 'market_standard')::int AS market_standard,
             (SELECT COUNT(*)::int FROM wording_draft WHERE status <> 'archived') AS drafts
           FROM wording_clause WHERE status <> 'archived'`),
  ]);
  return {
    cobs: cobs.rows,
    treaty_types: treatyTypes.rows,
    categories: CATEGORY_ORDER.map((c) => ({
      category: c,
      count: categories.rows.find((r) => r.category === c)?.count || 0,
    })),
    markets: markets.rows,
    totals: totals.rows[0],
  };
}

/* ------------------------------------------------------------------- drafts */

/**
 * The clauses that make up a wording for a class, with a reinsurer's house
 * version substituted for the standard one wherever they have written their
 * own. This is both how a new draft is seeded and what "Swiss Re's wording for
 * Property" means on the comparison screen.
 */
export async function resolveWordingSet({ cob, treaty_type, market_id, layered = true, categories }) {
  const clauses = await listClauses({ cob, treaty_type, status: 'active' }, { limit: 1000, offset: 0 });
  // Their own clauses alone, or the standard set with theirs written over it.
  const base = market_id && !layered ? [] : clauses.filter((c) => ['standard', 'house'].includes(c.source));
  const picked = new Map(base.map((c) => [`${c.category}|${titleKey(c.title)}`, c]));
  if (market_id) {
    for (const c of clauses.filter((x) => x.market_id === market_id)) {
      picked.set(`${c.category}|${titleKey(c.title)}`, c);
    }
  }

  let out = [...picked.values()];
  if (categories?.length) out = out.filter((c) => categories.includes(c.category));
  // Reading order of a real wording: category first, then the treaty-wide
  // clauses ahead of the class-specific ones, then alphabetically.
  return out.sort(
    (a, b) => categoryRank(a.category) - categoryRank(b.category)
      || (a.cob ? 1 : 0) - (b.cob ? 1 : 0)
      || a.title.localeCompare(b.title),
  );
}

export async function listDrafts(filters = {}, page = { limit: 100, offset: 0 }) {
  const params = [];
  const where = [];
  if (filters.status) {
    params.push(filters.status);
    where.push(`d.status = $${params.length}`);
  } else {
    where.push("d.status <> 'archived'");
  }
  if (filters.placement_id) {
    params.push(filters.placement_id);
    where.push(`d.placement_id = $${params.length}`);
  }
  if (filters.layer_id) {
    params.push(filters.layer_id);
    where.push(`d.layer_id = $${params.length}`);
  }
  if (filters.cob) {
    params.push(filters.cob);
    where.push(`d.cob = $${params.length}`);
  }
  params.push(page.limit, page.offset);
  const { rows } = await query(
    `SELECT d.*, m.name AS base_market_name, u.name AS created_by_name,
            (SELECT COUNT(*)::int FROM wording_draft_clause dc WHERE dc.draft_id = d.id) AS clause_count,
            (SELECT COUNT(*)::int FROM wording_draft_clause dc
              WHERE dc.draft_id = d.id AND dc.source_body IS NOT NULL AND dc.body <> dc.source_body) AS amended_count
     FROM wording_draft d
     LEFT JOIN market m ON m.id = d.base_market_id
     LEFT JOIN users u ON u.id = d.created_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY d.updated_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

export async function getDraft(id) {
  const { rows } = await query(
    `SELECT d.*, m.name AS base_market_name, u.name AS created_by_name, p.class AS placement_class
     FROM wording_draft d
     LEFT JOIN market m ON m.id = d.base_market_id
     LEFT JOIN users u ON u.id = d.created_by
     LEFT JOIN placement p ON p.id = d.placement_id
     WHERE d.id = $1`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError('Wording draft');
  return { ...rows[0], clauses: await draftClauses(id) };
}

/** A draft's clauses, each flagged where the draft text has moved off the library. */
export async function draftClauses(draftId, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT dc.*, m.name AS source_market_name,
            c.body AS library_body, c.version AS library_version
     FROM wording_draft_clause dc
     LEFT JOIN market m ON m.id = dc.source_market_id
     LEFT JOIN wording_clause c ON c.id = dc.clause_id
     WHERE dc.draft_id = $1 ORDER BY dc.position, dc.created_at`,
    [draftId],
  );
  return rows.map((r) => ({
    ...r,
    // Amended = the broker has changed the text since pulling it in.
    amended: r.source_body != null && normaliseBody(r.body) !== normaliseBody(r.source_body),
    // Stale = the library clause has moved on since; the draft still holds the
    // older text. Worth surfacing at renewal.
    library_updated: r.library_body != null && normaliseBody(r.library_body) !== normaliseBody(r.source_body ?? r.body),
  }));
}

/**
 * Create a draft. Unless `seed` is false the draft is populated from the
 * library for its class — the standard wording, with the base reinsurer's
 * house clauses substituted where they have them.
 */
export async function createDraft(input, userId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO wording_draft (title, cob, treaty_type, placement_id, layer_id, base_market_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [input.title, input.cob || null, input.treaty_type || null, input.placement_id || null,
        input.layer_id || null, input.base_market_id || null, input.notes || null, userId],
    );
    const draft = rows[0];

    if (input.seed !== false) {
      const clauses = await resolveWordingSet({
        cob: input.cob,
        treaty_type: input.treaty_type,
        market_id: input.base_market_id,
        layered: true,
        categories: input.categories,
      });
      let position = 0;
      for (const c of clauses) {
        position += 1;
        await client.query(
          `INSERT INTO wording_draft_clause
             (draft_id, clause_id, position, category, title, clause_ref, body, source_body, source_market_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [draft.id, c.id, position, c.category, c.title, c.clause_ref, c.body, c.body, c.market_id],
        );
      }
    }
    await audit({ entityType: 'wording_draft', entityId: draft.id, action: 'create', userId, detail: { cob: input.cob || null, base_market_id: input.base_market_id || null } }, client);
    return { ...draft, clauses: await draftClauses(draft.id, client) };
  });
}

export async function updateDraft(id, input, userId) {
  const fields = defined({
    title: input.title,
    cob: input.cob,
    treaty_type: input.treaty_type,
    placement_id: input.placement_id,
    layer_id: input.layer_id,
    base_market_id: input.base_market_id,
    status: input.status,
    notes: input.notes,
  });
  fields.updated_at = new Date();
  const upd = buildUpdate(fields);
  const { rows } = await query(
    `UPDATE wording_draft SET ${upd.text} WHERE id = $${upd.nextIndex} RETURNING *`,
    [...upd.values, id],
  );
  if (!rows[0]) throw new NotFoundError('Wording draft');
  await audit({ entityType: 'wording_draft', entityId: id, action: 'update', userId, detail: { fields: Object.keys(fields) } });
  return getDraft(id);
}

export async function deleteDraft(id, userId) {
  const { rowCount } = await query('DELETE FROM wording_draft WHERE id = $1', [id]);
  if (!rowCount) throw new NotFoundError('Wording draft');
  await audit({ entityType: 'wording_draft', entityId: id, action: 'delete', userId });
}

async function touchDraft(runner, draftId) {
  await runner.query('UPDATE wording_draft SET updated_at = now() WHERE id = $1', [draftId]);
}

/** Add a clause to a draft: either pulled from the library, or typed in fresh. */
export async function addDraftClause(draftId, input, userId) {
  return withTransaction(async (client) => {
    const { rows: draftRows } = await client.query('SELECT id FROM wording_draft WHERE id = $1', [draftId]);
    if (!draftRows[0]) throw new NotFoundError('Wording draft');

    let clause = null;
    if (input.clause_id) {
      const { rows } = await client.query('SELECT * FROM wording_clause WHERE id = $1', [input.clause_id]);
      if (!rows[0]) throw new NotFoundError('Clause');
      clause = rows[0];
    } else if (!input.title || !input.body || !input.category) {
      throw new ValidationError('A free-text clause needs a title, category and body');
    }

    const { rows: posRows } = await client.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM wording_draft_clause WHERE draft_id = $1',
      [draftId],
    );
    const position = input.position ?? posRows[0].next;
    const body = input.body ?? clause.body;
    const { rows } = await client.query(
      `INSERT INTO wording_draft_clause
         (draft_id, clause_id, position, category, title, clause_ref, body, source_body, source_market_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [draftId, clause?.id || null, position,
        input.category || clause.category, input.title || clause.title,
        input.clause_ref ?? clause?.clause_ref ?? null, body,
        clause ? clause.body : null, clause?.market_id || null],
    );
    await touchDraft(client, draftId);
    await audit({ entityType: 'wording_draft', entityId: draftId, action: 'clause_add', userId, detail: { title: rows[0].title } }, client);
    return rows[0];
  });
}

export async function updateDraftClause(draftId, clauseRowId, input, userId) {
  return withTransaction(async (client) => {
    const fields = defined({
      title: input.title,
      clause_ref: input.clause_ref,
      category: input.category,
      body: input.body,
      position: input.position,
    });
    if (Object.keys(fields).length === 0) throw new ValidationError('Nothing to update');
    fields.updated_at = new Date();
    const upd = buildUpdate(fields);
    const { rows } = await client.query(
      `UPDATE wording_draft_clause SET ${upd.text}
       WHERE id = $${upd.nextIndex} AND draft_id = $${upd.nextIndex + 1} RETURNING *`,
      [...upd.values, clauseRowId, draftId],
    );
    if (!rows[0]) throw new NotFoundError('Draft clause');
    await touchDraft(client, draftId);
    return rows[0];
  });
}

/** Put a draft clause back to the library text it came from. */
export async function revertDraftClause(draftId, clauseRowId, userId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT dc.*, c.body AS library_body, c.title AS library_title
       FROM wording_draft_clause dc LEFT JOIN wording_clause c ON c.id = dc.clause_id
       WHERE dc.id = $1 AND dc.draft_id = $2`,
      [clauseRowId, draftId],
    );
    if (!rows[0]) throw new NotFoundError('Draft clause');
    const row = rows[0];
    const target = row.library_body ?? row.source_body;
    if (target == null) throw new ValidationError('This clause was typed into the draft — there is no library text to revert to');
    const { rows: updated } = await client.query(
      `UPDATE wording_draft_clause SET body = $1, source_body = $1, title = COALESCE($2, title), updated_at = now()
       WHERE id = $3 RETURNING *`,
      [target, row.library_title, clauseRowId],
    );
    await touchDraft(client, draftId);
    await audit({ entityType: 'wording_draft', entityId: draftId, action: 'clause_revert', userId, detail: { title: row.title } }, client);
    return updated[0];
  });
}

export async function deleteDraftClause(draftId, clauseRowId, userId) {
  const { rowCount } = await query(
    'DELETE FROM wording_draft_clause WHERE id = $1 AND draft_id = $2',
    [clauseRowId, draftId],
  );
  if (!rowCount) throw new NotFoundError('Draft clause');
  await query('UPDATE wording_draft SET updated_at = now() WHERE id = $1', [draftId]);
  await audit({ entityType: 'wording_draft', entityId: draftId, action: 'clause_remove', userId });
}

/** Rewrite clause order from an explicit list of draft-clause ids. */
export async function reorderDraft(draftId, ids, userId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT id FROM wording_draft_clause WHERE draft_id = $1', [draftId]);
    const known = new Set(rows.map((r) => r.id));
    if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
      throw new ValidationError('Reorder must list every clause in the draft exactly once');
    }
    for (const [i, id] of ids.entries()) {
      await client.query('UPDATE wording_draft_clause SET position = $1 WHERE id = $2', [i + 1, id]);
    }
    await touchDraft(client, draftId);
    await audit({ entityType: 'wording_draft', entityId: draftId, action: 'reorder', userId }, client);
    return draftClauses(draftId, client);
  });
}

/* ---------------------------------------------------------------- comparison */

/**
 * Resolve one side of a comparison to `{ label, clauses }`.
 * `type` is one of:
 *   draft    — a draft wording, as it currently stands
 *   market   — a reinsurer's wording for the class (their house clauses over
 *              the standard set, or their own clauses alone when layered=false)
 *   standard — the standard library wording for the class
 *   clause   — a single library clause, for a one-clause comparison
 */
export async function resolveSide(side) {
  if (side.type === 'draft') {
    const draft = await getDraft(side.id);
    return {
      type: 'draft',
      id: draft.id,
      label: draft.title,
      sub: [draft.cob, draft.treaty_type, draft.base_market_name].filter(Boolean).join(' · ') || null,
      clauses: draft.clauses,
    };
  }
  if (side.type === 'clause') {
    const clause = await getClause(side.id);
    return {
      type: 'clause',
      id: clause.id,
      label: clause.title,
      sub: clause.market_name || 'Standard',
      clauses: [clause],
    };
  }
  if (side.type === 'market') {
    const { rows } = await query('SELECT id, name FROM market WHERE id = $1', [side.id]);
    if (!rows[0]) throw new NotFoundError('Market');
    const clauses = await resolveWordingSet({
      cob: side.cob,
      treaty_type: side.treaty_type,
      market_id: side.id,
      layered: side.layered !== false,
    });
    return {
      type: 'market',
      id: rows[0].id,
      label: rows[0].name,
      sub: [side.cob || 'All classes', side.layered === false ? 'house clauses only' : 'house clauses over standard'].join(' · '),
      clauses,
    };
  }
  if (side.type === 'standard') {
    const clauses = await resolveWordingSet({ cob: side.cob, treaty_type: side.treaty_type });
    return {
      type: 'standard',
      id: null,
      label: 'Standard library wording',
      sub: side.cob || 'All classes',
      clauses,
    };
  }
  throw new ValidationError(`Unknown comparison side type: ${side.type}`);
}

/** Compare two wordings clause by clause. */
export async function compare(leftSide, rightSide) {
  const [left, right] = await Promise.all([resolveSide(leftSide), resolveSide(rightSide)]);
  const shape = (c) => ({
    id: c.id,
    title: c.title,
    clause_ref: c.clause_ref || null,
    category: c.category,
    body: c.body,
    market_name: c.market_name || c.source_market_name || null,
    cob: c.cob ?? null,
    provenance: c.provenance ?? null,
    source_org: c.source_org ?? null,
    source_url: c.source_url ?? null,
  });
  const { rows, summary } = alignClauseSets(left.clauses.map(shape), right.clauses.map(shape));
  return {
    left: { ...left, clauses: undefined, clause_count: left.clauses.length },
    right: { ...right, clauses: undefined, clause_count: right.clauses.length },
    summary,
    rows,
  };
}

/* ------------------------------------------------- clause review (read-only)

   Three views a reviewer needs on a single clause: what changed against the
   version it is replacing, which reinsurers hold their own form of it, and
   where it is in force across the book. All derived from the library — no
   separate store. */

/**
 * The clause against the version it supersedes, as a word-level diff.
 * `ops` is `[{ op: 'same' | 'add' | 'del', text }]` — `del` is text that was in
 * the prior version, `add` is text new to this one.
 */
export async function clauseHistory(id) {
  const clause = await getClause(id);
  // revisions are newest-first; a revision records the body *before* an edit,
  // so the top one is what this version replaced.
  const prior = clause.revisions[0] || null;
  return {
    clause_id: clause.id,
    title: clause.title,
    version: clause.version,
    prior_version: prior?.version ?? null,
    prior_body: prior?.body ?? null,
    body: clause.body,
    changed: Boolean(prior) && normaliseBody(prior.body) !== normaliseBody(clause.body),
    ops: prior ? diffWords(prior.body, clause.body) : [],
  };
}

/**
 * Reinsurers holding their own form of this clause — the market clauses that
 * share its title — each diffed against the clause in hand.
 */
export async function clauseVariants(id) {
  const clause = await getClause(id);
  const key = titleKey(clause.title);
  const { rows } = await query(
    `SELECT ${CLAUSE_COLUMNS}, m.name AS market_name
     FROM wording_clause c JOIN market m ON m.id = c.market_id
     WHERE c.source = 'market' AND c.category = $1 AND c.id <> $2
       AND c.status <> 'archived'
     ORDER BY m.name`,
    [clause.category, clause.id],
  );
  return rows
    .filter((r) => titleKey(r.title) === key)
    .map((r) => ({
      ...r,
      identical: normaliseBody(r.body) === normaliseBody(clause.body),
      ops: diffWords(clause.body, r.body),
    }));
}

/** Where this clause is in force: the drafts that carry it, newest first. */
export async function clauseUsage(id) {
  const { rows } = await query(
    `SELECT dc.id AS draft_clause_id, dc.body, dc.source_body,
            d.id AS draft_id, d.title AS draft_title, d.status, d.version,
            d.cob, d.updated_at,
            p.reference AS placement_reference, p.inception, p.expiry,
            c.name AS cedant_name
     FROM wording_draft_clause dc
     JOIN wording_draft d ON d.id = dc.draft_id
     LEFT JOIN placement p ON p.id = d.placement_id
     LEFT JOIN cedant c ON c.id = p.cedant_id
     WHERE dc.clause_id = $1 AND d.status <> 'archived'
     ORDER BY d.updated_at DESC`,
    [id],
  );
  return rows.map((r) => ({
    ...r,
    // The draft has moved the text off the library version it pulled in.
    amended: r.source_body != null && normaliseBody(r.body) !== normaliseBody(r.source_body),
  }));
}
