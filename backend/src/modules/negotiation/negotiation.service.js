import { query, withTransaction } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { buildUpdate, defined } from '../../lib/sql.js';
import { audit } from '../../lib/audit.js';
import {
  boardWithQuotes, negotiationBoard, marketStanding, quoteSheet, isQuotable, TERM_FIELDS,
  linesForStructure, quotesByUnderwriter, combinedQuotes, rolComparison, normaliseExpiringLayers,
} from '../../domain/negotiation.js';

const NEGOTIATION_COLUMNS = `n.id, n.placement_id, n.market_id, n.role, n.pack_id, n.pack_version,
  n.sent_at, n.status, n.notes, n.created_at, n.updated_at`;

const QUOTE_COLUMNS = `q.id, q.negotiation_id, q.structure_index, q.market_structure_id, q.layer_index,
  q.status, q.rate_pct, q.premium, q.line_pct, q.commission_pct, q.validity, q.notes, q.terms,
  q.contact_id, q.layer_name, q.layer_type, q.limit_amt, q.attachment, q.reinstatements,
  q.reinstatement_pct, q.egnpi, q.aad, q.order_pct, q.risk_cover, q.cat_cover, q.original,
  q.kind, q.created_at, q.updated_at`;

const STRUCTURE_COLUMNS = `s.id, s.negotiation_id, s.label, s.basis, s.structure, s.position,
  s.notes, s.created_at, s.updated_at`;

async function loadPlacement(placementId, runner = { query }) {
  const { rows } = await runner.query(
    'SELECT id, reference, currency, status, quote_structures, expiring_structure, renewal_of FROM placement WHERE id = $1',
    [placementId],
  );
  if (!rows[0]) throw new NotFoundError('Placement');
  return rows[0];
}

async function loadNegotiation(id, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT ${NEGOTIATION_COLUMNS}, m.name AS market_name FROM negotiation n
     JOIN market m ON m.id = n.market_id WHERE n.id = $1`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError('Negotiation');
  return rows[0];
}

/**
 * The markets holding the pack, each with the underwriters it was emailed to:
 * every recipient of a released covering email at that reinsurer, with the
 * delivery outcome and where the reply stands. A market put on the board
 * without a covering email (the bare send) has none.
 */
async function listMarkets(placementId, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT ${NEGOTIATION_COLUMNS}, m.name AS market_name, m.rating, m.security_status,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'recipient_id', r.id, 'submission_id', r.submission_id, 'contact_id', r.contact_id,
                       'name', r.name, 'email', r.email, 'role', r.role,
                       'delivery', r.status, 'sent_at', r.sent_at, 'error', r.error,
                       'pack_version', s.pack_version,
                       'reply_status', r.reply_status, 'reply_count', r.reply_count, 'replied_at', r.replied_at,
                       'last_kind', (SELECT x.kind FROM negotiation_reply x
                                      WHERE x.recipient_id = r.id ORDER BY x.received_at DESC LIMIT 1)
                     ) ORDER BY s.sent_at DESC, r.name)
              FROM negotiation_submission_recipient r
              JOIN negotiation_submission s ON s.id = r.submission_id
              WHERE s.placement_id = n.placement_id AND s.status = 'sent' AND r.market_id = n.market_id
            ), '[]'::json) AS underwriters
     FROM negotiation n JOIN market m ON m.id = n.market_id
     WHERE n.placement_id = $1
     ORDER BY m.name`,
    [placementId],
  );
  return rows;
}

/** Structures the markets themselves put up, across the placement. */
async function listMarketStructures(placementId, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT ${STRUCTURE_COLUMNS}, m.name AS market_name
     FROM negotiation_structure s
     JOIN negotiation n ON n.id = s.negotiation_id
     JOIN market m ON m.id = n.market_id
     WHERE n.placement_id = $1
     ORDER BY m.name, s.position, s.created_at`,
    [placementId],
  );
  return rows;
}

async function listQuotes(placementId, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT ${QUOTE_COLUMNS}, n.market_id, m.name AS market_name, c.name AS contact_name
     FROM negotiation_quote q
     JOIN negotiation n ON n.id = q.negotiation_id
     JOIN market m ON m.id = n.market_id
     LEFT JOIN market_contact c ON c.id = q.contact_id
     WHERE n.placement_id = $1
     ORDER BY q.structure_index, q.layer_index NULLS FIRST, m.name`,
    [placementId],
  );
  return rows;
}

/** The latest pack version, and the latest approved one — what goes to market. */
async function latestPacks(placementId, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT id, version, basis, status, created_at, approved_at
     FROM renewal_pack WHERE placement_id = $1 ORDER BY version DESC`,
    [placementId],
  );
  return { latest: rows[0] || null, approved: rows.find((p) => p.status === 'approved') || null, versions: rows };
}

/**
 * The expiring layers a quote's rate on line is read against: the expiring
 * structure recorded on the placement, else the prior year's layers where
 * the placement renews one — read live, never copied.
 */
async function expiringLayersOf(placement, runner = { query }) {
  const recorded = normaliseExpiringLayers(placement.expiring_structure, []);
  if (recorded.length || !placement.renewal_of) return recorded;
  const { rows } = await runner.query(
    'SELECT name, limit_amt, attachment, premium100 FROM layer WHERE placement_id = $1 ORDER BY position, created_at',
    [placement.renewal_of],
  );
  return normaliseExpiringLayers(null, rows);
}

/**
 * The whole negotiation for a placement: which pack is out, who has it, the
 * structures they were asked to price with their quotes against them — and
 * those quotes read three more ways: by reinsurer, as the combined
 * programme each one adds up to, and the rate on line compared layer by
 * layer against what was sent and what expired.
 */
export async function getNegotiation(placementId) {
  const placement = await loadPlacement(placementId);
  const [markets, quotes, marketStructures, packs, expiringLayers] = await Promise.all([
    listMarkets(placementId),
    listQuotes(placementId),
    listMarketStructures(placementId),
    latestPacks(placementId),
    expiringLayersOf(placement),
  ]);
  const board = boardWithQuotes(placement.quote_structures || [], quotes, marketStructures);
  return {
    placement: {
      id: placement.id, reference: placement.reference,
      currency: placement.currency, status: placement.status,
    },
    pack: { latest: packs.latest, approved: packs.approved },
    // Which pack versions are out there: markets carry their own, so a version
    // cut after a send does not change what a market is quoting on.
    markets,
    board,
    by_underwriter: quotesByUnderwriter(board, markets),
    combined: combinedQuotes(board, markets),
    rol_comparison: rolComparison(board, expiringLayers, markets),
    expiring_layers: expiringLayers,
  };
}

/**
 * One market's sheet: the structures it was sent, carrying whatever it has
 * already said, then any structure of its own. What the capture screen fills.
 */
export async function getQuoteSheet(negotiationId) {
  const negotiation = await loadNegotiation(negotiationId);
  const placement = await loadPlacement(negotiation.placement_id);
  const [{ rows: structures }, { rows: quotes }] = await Promise.all([
    query(`SELECT ${STRUCTURE_COLUMNS} FROM negotiation_structure s
           WHERE s.negotiation_id = $1 ORDER BY s.position, s.created_at`, [negotiationId]),
    query(`SELECT ${QUOTE_COLUMNS} FROM negotiation_quote q WHERE q.negotiation_id = $1`, [negotiationId]),
  ]);
  return {
    negotiation,
    currency: placement.currency,
    structures: quoteSheet(placement.quote_structures || [], structures, quotes),
  };
}

/**
 * Send the pack to markets: one negotiation each, skipping any already sent.
 * Every market approached at the Quoting Stage is approached for a lead
 * quote, so each goes on the board as a lead — there is no role to choose.
 */
export async function sendPack(placementId, { market_ids, pack_id }, userId) {
  const placement = await loadPlacement(placementId);
  if (!negotiationBoard(placement.quote_structures || []).length) {
    throw new ValidationError('There are no structures to quote — build the structure first');
  }

  return withTransaction(async (client) => {
    const packs = await latestPacks(placementId, client);
    const pack = pack_id
      ? packs.versions.find((p) => p.id === pack_id)
      : packs.approved || packs.latest;
    if (pack_id && !pack) throw new NotFoundError('Renewal pack');
    if (!pack) throw new ValidationError('Create a renewal pack before sending it to market');
    if (pack.status !== 'approved') {
      throw new ValidationError(`Renewal pack v${pack.version} must be approved by a Senior Broker before it goes to market`);
    }

    const { rows: known } = await client.query(
      'SELECT id FROM market WHERE id = ANY($1)', [market_ids],
    );
    if (known.length !== market_ids.length) throw new NotFoundError('Market');

    const sent = [];
    for (const marketId of market_ids) {
      const { rows } = await client.query(
        `INSERT INTO negotiation (placement_id, market_id, role, pack_id, pack_version, created_by)
         VALUES ($1,$2,'lead',$3,$4,$5)
         ON CONFLICT (placement_id, market_id) DO NOTHING
         RETURNING ${NEGOTIATION_COLUMNS.replaceAll('n.', '')}`,
        [placementId, marketId, pack.id, pack.version, userId],
      );
      if (rows[0]) sent.push(rows[0]);
    }

    await audit({
      entityType: 'placement', entityId: placementId, action: 'negotiation.send', userId,
      detail: { pack_version: pack.version, markets: sent.length, already_holding: market_ids.length - sent.length },
    }, client);
    return { pack, sent };
  });
}

export async function updateNegotiation(id, input, userId) {
  await loadNegotiation(id);
  const fields = defined({ status: input.status, notes: input.notes });
  if (!Object.keys(fields).length) throw new ValidationError('No fields to update');
  const { text, values, nextIndex } = buildUpdate(fields);
  const { rows } = await query(
    `UPDATE negotiation SET ${text}, updated_at = now() WHERE id = $${nextIndex} RETURNING id`,
    [...values, id],
  );
  await audit({ entityType: 'negotiation', entityId: rows[0].id, action: 'update', userId, detail: fields });
  return loadNegotiation(id);
}

/** Withdraw a market from the negotiation, taking its quotes with it. */
export async function removeNegotiation(id, userId) {
  const existing = await loadNegotiation(id);
  await query('DELETE FROM negotiation WHERE id = $1', [id]);
  await audit({
    entityType: 'negotiation', entityId: id, action: 'delete', userId,
    detail: { placement_id: existing.placement_id, market: existing.market_name },
  });
  return existing;
}

/**
 * Record what a market quoted on one line — of a structure it was sent, or of
 * one it put up itself. One answer per line, so quoting it again replaces it.
 */
export async function saveQuote(negotiationId, input, userId) {
  const negotiation = await loadNegotiation(negotiationId);
  const target = await resolveLine(negotiationId, negotiation, input);

  return withTransaction(async (client) => {
    const row = await writeLine(
      client, negotiationId, target.ref,
      { ...input, layer_index: target.layer_index }, userId, target.line,
    );
    if (!row) throw new ValidationError('Nothing to record on this line');
    await refreshStanding(negotiationId, client);
    await audit({
      entityType: 'negotiation', entityId: negotiationId, action: 'quote', userId,
      detail: { ...target.ref, layer_index: target.layer_index, status: row.status },
    }, client);
    return row;
  });
}

/** Check a quote names a line that exists, and say which structure it is on. */
async function resolveLine(negotiationId, negotiation, input) {
  const wanted = input.layer_index ?? null;

  if (input.market_structure_id) {
    const { rows } = await query(
      `SELECT ${STRUCTURE_COLUMNS} FROM negotiation_structure s WHERE s.id = $1 AND s.negotiation_id = $2`,
      [input.market_structure_id, negotiationId],
    );
    if (!rows[0]) throw new NotFoundError('Market structure');
    const lines = linesOfProposed(rows[0]);
    const line = lines.find((l) => l.layer_index === wanted);
    if (!line) throw new NotFoundError('Structure line');
    // The market's own structure is its own baseline.
    return { ref: { market_structure_id: rows[0].id }, layer_index: wanted, line: line.origin };
  }

  const placement = await loadPlacement(negotiation.placement_id);
  const structure = negotiationBoard(placement.quote_structures || [])
    .find((st) => st.index === input.structure_index);
  if (!structure) throw new NotFoundError(`Structure ${input.structure_index}`);
  // A proportional structure is quoted whole; a layer index would be meaningless.
  if (structure.basis === 'PROP' && wanted != null) {
    throw new NotFoundError('Structure line');
  }
  const line = structure.lines.find((l) => (l.layer_index ?? null) === wanted);
  if (!line) throw new NotFoundError('Structure line');
  return { ref: { structure_index: structure.index }, layer_index: wanted, line };
}

export async function deleteQuote(negotiationId, quoteId, userId) {
  const { rowCount } = await query(
    'DELETE FROM negotiation_quote WHERE id = $1 AND negotiation_id = $2',
    [quoteId, negotiationId],
  );
  if (!rowCount) throw new NotFoundError('Quote');
  await refreshStanding(negotiationId);
  await audit({ entityType: 'negotiation', entityId: negotiationId, action: 'quote.delete', userId, detail: { quote_id: quoteId } });
}

/**
 * Mark what a market gave on one structure as a lead quote or an indication.
 *
 * The kind belongs to the structure — a reinsurer indicates on a structure,
 * not on a layer of it — so every line it has priced there moves together. A
 * decline carries no kind, and a structure it has not priced has nothing to
 * mark yet.
 */
export async function setQuoteKind(negotiationId, input, userId) {
  await loadNegotiation(negotiationId);
  const ref = input.market_structure_id
    ? { column: 'market_structure_id', value: input.market_structure_id }
    : { column: 'structure_index', value: input.structure_index };
  const { rowCount } = await query(
    `UPDATE negotiation_quote SET kind = $1, updated_at = now()
     WHERE negotiation_id = $2 AND ${ref.column} = $3 AND status = 'quoted'`,
    [input.kind, negotiationId, ref.value],
  );
  if (!rowCount) throw new ConflictError('Nothing has been quoted on this structure yet — capture the quote first');
  await audit({
    entityType: 'negotiation', entityId: negotiationId, action: 'quote.kind', userId,
    detail: { [ref.column]: ref.value, kind: input.kind, lines: rowCount },
  });
  return { kind: input.kind, lines: rowCount };
}

/** The term columns a quote carries, as they are written and read back. */
const QUOTED_TERM_KEYS = TERM_FIELDS.map((f) => f.key);

/** Has this line actually been answered, or was it left blank? */
function isAnswered(line) {
  if (line.status === 'declined') return true;
  return ['premium', 'rate_pct', 'line_pct', 'commission_pct'].some((k) => line[k] != null)
    || QUOTED_TERM_KEYS.some((k) => line[k] != null)
    || Boolean(line.notes && line.notes.trim())
    || Boolean(line.validity)
    || Boolean(line.contact_id);
}

/**
 * Write one line's answer, or clear it when the line was left blank.
 *
 * `origin` is the line as it was sent. Its terms are snapshotted onto the quote
 * so the comparison survives a later rework of the structure — a quote has to
 * keep saying what the underwriter was answering, not what the structure says
 * today. An update keeps the snapshot it was captured against.
 *
 * A quote is a lead quote unless it says it is an indication; a re-quote that
 * says nothing about the kind keeps the kind it had.
 */
async function writeLine(client, negotiationId, target, line, userId, origin = {}) {
  const where = target.market_structure_id
    ? { column: 'market_structure_id', value: target.market_structure_id }
    : { column: 'structure_index', value: target.structure_index };

  if (!isAnswered(line)) {
    await client.query(
      `DELETE FROM negotiation_quote
       WHERE negotiation_id = $1 AND ${where.column} = $2 AND COALESCE(layer_index, -1) = $3`,
      [negotiationId, where.value, line.layer_index ?? -1],
    );
    return null;
  }

  const declined = line.status === 'declined';
  // A declined line records no terms — there are none to record.
  const term = (key) => (declined ? null : line[key] ?? null);
  const { rows } = await client.query(
    `INSERT INTO negotiation_quote (negotiation_id, structure_index, market_structure_id, layer_index,
                                    status, rate_pct, premium, line_pct, commission_pct, validity, notes, terms,
                                    contact_id, layer_name, layer_type, limit_amt, attachment, reinstatements,
                                    reinstatement_pct, egnpi, aad, order_pct, risk_cover, cat_cover,
                                    original, created_by, kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
             COALESCE($27::text, 'lead'))
     ON CONFLICT (${target.market_structure_id
       ? 'market_structure_id, COALESCE(layer_index, -1)) WHERE market_structure_id IS NOT NULL'
       : 'negotiation_id, structure_index, COALESCE(layer_index, -1)) WHERE structure_index IS NOT NULL'}
     DO UPDATE SET status = EXCLUDED.status, rate_pct = EXCLUDED.rate_pct, premium = EXCLUDED.premium,
       line_pct = EXCLUDED.line_pct, commission_pct = EXCLUDED.commission_pct,
       validity = EXCLUDED.validity, notes = EXCLUDED.notes, terms = EXCLUDED.terms,
       contact_id = EXCLUDED.contact_id, layer_name = EXCLUDED.layer_name, layer_type = EXCLUDED.layer_type,
       limit_amt = EXCLUDED.limit_amt, attachment = EXCLUDED.attachment,
       reinstatements = EXCLUDED.reinstatements, reinstatement_pct = EXCLUDED.reinstatement_pct,
       egnpi = EXCLUDED.egnpi, aad = EXCLUDED.aad, order_pct = EXCLUDED.order_pct,
       risk_cover = EXCLUDED.risk_cover, cat_cover = EXCLUDED.cat_cover,
       kind = COALESCE($27::text, negotiation_quote.kind),
       -- Keep the terms this quote was first captured against.
       original = CASE WHEN negotiation_quote.original = '{}'::jsonb
                       THEN EXCLUDED.original ELSE negotiation_quote.original END,
       updated_at = now()
     RETURNING ${QUOTE_COLUMNS.replaceAll('q.', '')}`,
    [negotiationId, target.structure_index ?? null, target.market_structure_id ?? null, line.layer_index ?? null,
      declined ? 'declined' : 'quoted',
      term('rate_pct'), term('premium'), term('line_pct'), term('commission_pct'),
      declined ? null : line.validity || null,
      line.notes || null, JSON.stringify(line.terms || {}),
      line.contact_id ?? null,
      term('layer_name'), term('layer_type'), term('limit_amt'), term('attachment'),
      term('reinstatements'), term('reinstatement_pct'), term('egnpi'), term('aad'), term('order_pct'),
      declined ? null : line.risk_cover ?? null,
      declined ? null : line.cat_cover ?? null,
      JSON.stringify(origin.terms || {}), userId,
      // A decline has no kind to keep; a quote is lead unless said otherwise,
      // and one that says nothing keeps what it had.
      declined ? 'lead' : (['lead', 'indicative'].includes(line.kind) ? line.kind : null)],
  );
  return rows[0];
}

/**
 * Save a market's whole sheet in one go: every structure it was sent, plus any
 * structure of its own.
 *
 * A structure marked `declined` is answered with a decline on every one of its
 * lines, so the board reads the same whether a market declined outright or line
 * by line. One marked `indicative` (or not) has every line it priced marked
 * the same way — the kind is the structure's. A line left blank clears any
 * answer that was there.
 */
export async function saveQuoteSheet(negotiationId, input, userId) {
  const negotiation = await loadNegotiation(negotiationId);
  const placement = await loadPlacement(negotiation.placement_id);
  const sent = negotiationBoard(placement.quote_structures || []);

  return withTransaction(async (client) => {
    let written = 0;
    let cleared = 0;

    for (const entry of input.structures || []) {
      let target;
      let lines;

      if (entry.market_structure) {
        const proposed = entry.market_structure;
        if (!isQuotable({ basis: proposed.basis, ...(proposed.structure || {}) })) {
          throw new ValidationError(`"${proposed.label}" has no layers or terms to quote`);
        }
        const structure = proposed.id
          ? await updateMarketStructure(client, negotiationId, proposed)
          : await insertMarketStructure(client, negotiationId, proposed, userId);
        target = { market_structure_id: structure.id };
        // A market's own structure is its own baseline: the terms it put up are
        // what its quote is read against, so nothing reads as a movement.
        lines = linesOfProposed(structure, entry.lines).map(({ origin, ...answer }) => ({
          answer, origin,
        }));
      } else {
        const structure = sent.find((s) => s.index === entry.structure_index);
        if (!structure) throw new NotFoundError(`Structure ${entry.structure_index}`);
        target = { structure_index: structure.index };
        lines = structure.lines.map((line) => {
          const given = (entry.lines || []).find((l) => (l.layer_index ?? null) === (line.layer_index ?? null));
          return { answer: { ...(given || {}), layer_index: line.layer_index ?? null }, origin: line };
        });
      }

      const kind = entry.indicative == null ? null : (entry.indicative ? 'indicative' : 'lead');
      for (const { answer, origin } of lines) {
        const line = {
          ...answer,
          ...(entry.declined ? { status: 'declined' } : {}),
          ...(kind ? { kind } : {}),
        };
        const row = await writeLine(client, negotiationId, target, line, userId, origin);
        if (row) written += 1; else cleared += 1;
      }
    }

    await refreshStanding(negotiationId, client);
    await audit({
      entityType: 'negotiation', entityId: negotiationId, action: 'quote.sheet', userId,
      detail: { structures: (input.structures || []).length, lines_written: written, lines_cleared: cleared },
    }, client);
    return { written, cleared };
  });
}

/** The lines a proposed structure resolves into, matched to what was given. */
function linesOfProposed(structure, given = []) {
  const shape = { basis: structure.basis, ...(structure.structure || {}) };
  return linesForStructure(shape, { market_structure_id: structure.id }).map((line) => {
    const match = given.find((l) => (l.layer_index ?? null) === line.layer_index);
    return { ...(match || {}), layer_index: line.layer_index, origin: line };
  });
}

async function insertMarketStructure(client, negotiationId, proposed, userId) {
  const { rows: last } = await client.query(
    'SELECT COALESCE(MAX(position), 0) AS max FROM negotiation_structure WHERE negotiation_id = $1',
    [negotiationId],
  );
  const { rows } = await client.query(
    `INSERT INTO negotiation_structure (negotiation_id, label, basis, structure, position, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${STRUCTURE_COLUMNS.replaceAll('s.', '')}`,
    [negotiationId, proposed.label.trim(), proposed.basis, JSON.stringify(proposed.structure || {}),
      Number(last[0].max) + 1, proposed.notes || null, userId],
  );
  return rows[0];
}

async function updateMarketStructure(client, negotiationId, proposed) {
  const { rows } = await client.query(
    `UPDATE negotiation_structure
     SET label = $1, basis = $2, structure = $3, notes = $4, updated_at = now()
     WHERE id = $5 AND negotiation_id = $6 RETURNING ${STRUCTURE_COLUMNS.replaceAll('s.', '')}`,
    [proposed.label.trim(), proposed.basis, JSON.stringify(proposed.structure || {}),
      proposed.notes || null, proposed.id, negotiationId],
  );
  if (!rows[0]) throw new NotFoundError('Market structure');
  return rows[0];
}

/** Drop a structure a market put up, and the quotes against it. */
export async function removeMarketStructure(negotiationId, structureId, userId) {
  const { rowCount } = await query(
    'DELETE FROM negotiation_structure WHERE id = $1 AND negotiation_id = $2',
    [structureId, negotiationId],
  );
  if (!rowCount) throw new NotFoundError('Market structure');
  await refreshStanding(negotiationId);
  await audit({
    entityType: 'negotiation', entityId: negotiationId, action: 'structure.delete', userId,
    detail: { structure_id: structureId },
  });
}

/** A market's status follows its quotes, unless it has been withdrawn. */
async function refreshStanding(negotiationId, runner = { query }) {
  const { rows } = await runner.query(
    'SELECT status FROM negotiation_quote WHERE negotiation_id = $1', [negotiationId],
  );
  await runner.query(
    `UPDATE negotiation SET status = $1, updated_at = now()
     WHERE id = $2 AND status <> 'WITHDRAWN'`,
    [marketStanding(rows), negotiationId],
  );
}
