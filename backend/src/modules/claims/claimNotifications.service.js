/*
 * Claim-notification intake: an inbound loss advice is read, matched to the
 * contract it concerns, and held for the broker — loaded as a loss event
 * with the preliminary advice fanned out to the panel, or parked for
 * triage. A low-confidence match is never loaded on its own.
 */

import { query, withTransaction } from '../../db/pool.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { readClaimNotice } from './claimNotice.llm.js';
import { matchNotification } from './claimMatch.js';
import { calculateLoss, getLoss } from './claims.service.js';
import { issuePreliminaryAdvice } from './claimAdvices.service.js';

const NOTIFICATION_SELECT = `
  SELECT n.*, p.reference AS placement_reference, c.name AS placement_cedant, p.class AS placement_class,
         lu.name AS loaded_by_name, pu.name AS parked_by_name
    FROM claim_notification n
    LEFT JOIN placement p ON p.id = n.placement_id
    LEFT JOIN cedant c ON c.id = p.cedant_id
    LEFT JOIN users lu ON lu.id = n.loaded_by
    LEFT JOIN users pu ON pu.id = n.parked_by`;

/**
 * The contracts a notice can be matched to: every placement with layers,
 * with what the desk knows of its insureds — the losses already advised and
 * the claims bordereaux' insured, claimant or event columns.
 */
export async function candidatePlacements() {
  const { rows } = await query(
    `SELECT p.id AS placement_id, p.reference, p.class, p.inception, p.expiry, c.name AS cedant_name
       FROM placement p LEFT JOIN cedant c ON c.id = p.cedant_id
      WHERE EXISTS (SELECT 1 FROM layer ly WHERE ly.placement_id = p.id)`,
  );
  const { rows: known } = await query(
    `SELECT placement_id, name FROM loss_event
      UNION SELECT placement_id, insured FROM loss_event WHERE insured IS NOT NULL
      UNION SELECT b.placement_id, COALESCE(r->>'insured', r->>'claimant', r->>'event')
        FROM bordereau b, jsonb_array_elements(CASE WHEN jsonb_typeof(b.parsed_rows) = 'array' THEN b.parsed_rows ELSE '[]'::jsonb END) r
       WHERE b.type = 'claims' AND (r ? 'insured' OR r ? 'claimant' OR r ? 'event')`,
  );
  const insureds = new Map();
  for (const k of known) {
    if (!k.name) continue;
    if (!insureds.has(k.placement_id)) insureds.set(k.placement_id, new Set());
    insureds.get(k.placement_id).add(k.name);
  }
  return rows.map((r) => ({ ...r, insureds: [...(insureds.get(r.placement_id) || [])] }));
}

async function getRow(id, runner = { query }) {
  const { rows } = await runner.query(`${NOTIFICATION_SELECT} WHERE n.id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError('Claim notification');
  return rows[0];
}

/** Read, match and record an inbound notice. A message already recorded is returned, not duplicated. */
export async function ingestNotification(input, { clients, userId } = {}) {
  if (input.message_id) {
    const { rows } = await query('SELECT id FROM claim_notification WHERE message_id = $1', [input.message_id]);
    if (rows[0]) return { notification: await getRow(rows[0].id), duplicate: true };
  }
  const parsed = await readClaimNotice({
    source: input.source, sender: input.sender, subject: input.subject, body: input.body, received_at: input.received_at,
  }, clients);
  const candidates = await candidatePlacements();
  const match = matchNotification(parsed, candidates);
  const suggestion = match.candidate
    ? { placement_id: match.candidate.placement_id, reference: match.candidate.reference, basis: match.basis, confidence: match.confidence }
    : null;
  const { rows } = await query(
    `INSERT INTO claim_notification
       (source, message_id, received_at, subject, sender, raw_body, parsed, placement_id, match_basis, match_confidence, status)
     VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [input.source || 'inbox', input.message_id || null, input.received_at || null, input.subject || null, input.sender || null,
      input.body, JSON.stringify({ ...parsed, suggestion }),
      match.status === 'matched' ? match.candidate.placement_id : null,
      match.status === 'matched' ? match.basis : null,
      match.candidate ? match.confidence : null,
      match.status],
  );
  await audit({
    entityType: 'claim_notification', entityId: rows[0].id, action: 'ingest', userId: userId || null,
    detail: { source: input.source || 'inbox', status: match.status, basis: match.basis, confidence: match.confidence, read: parsed.source },
  });
  return { notification: await getRow(rows[0].id), duplicate: false };
}

export async function listNotifications({ placement_id, status } = {}) {
  const params = [];
  const where = [];
  if (placement_id) { params.push(placement_id); where.push(`n.placement_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`n.status = $${params.length}`); }
  const { rows } = await query(
    `${NOTIFICATION_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY n.received_at DESC`,
    params,
  );
  return rows;
}

export const getNotification = (id) => getRow(id);

/** The broker's own match, at triage. */
export async function matchToPlacement(id, placementId, user) {
  const n = await getRow(id);
  if (n.status === 'loaded') throw new ConflictError('Already loaded — the loss event carries it now');
  const { rows: p } = await query('SELECT reference FROM placement WHERE id = $1', [placementId]);
  if (!p[0]) throw new NotFoundError('Placement');
  await query(
    `UPDATE claim_notification SET placement_id = $1, match_basis = 'broker', match_confidence = 1, status = 'matched',
            parked_by = NULL, parked_at = NULL, updated_at = now() WHERE id = $2`,
    [placementId, id],
  );
  await audit({ entityType: 'claim_notification', entityId: id, action: 'match', userId: user.id, detail: { placement_id: placementId, reference: p[0].reference } });
  return getRow(id);
}

export async function parkNotification(id, { notes } = {}, user) {
  const n = await getRow(id);
  if (n.status === 'loaded') throw new ConflictError('Already loaded — the loss event carries it now');
  await query(
    `UPDATE claim_notification SET status = 'parked', notes = COALESCE($2, notes), parked_by = $3, parked_at = now(), updated_at = now() WHERE id = $1`,
    [id, notes || null, user.id],
  );
  await audit({ entityType: 'claim_notification', entityId: id, action: 'park', userId: user.id, detail: { notes: notes || null } });
  return getRow(id);
}

/**
 * Load the notice: the loss event on the matched placement from the parsed
 * fields, the calculation, and the preliminary advice to every market with
 * a signed line on any layer. Idempotent per notification — a second load
 * returns what the first made and sends nothing.
 */
export async function loadNotification(id, input, user) {
  const created = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM claim_notification WHERE id = $1 FOR UPDATE', [id]);
    const n = rows[0];
    if (!n) throw new NotFoundError('Claim notification');
    if (n.status === 'loaded') return { notification: n, event: null, already: true };

    const placementId = input?.placement_id || n.placement_id;
    if (!placementId) throw new ConflictError('Not matched to a contract — match it first, then load it');
    const { rows: layers } = await client.query(
      `SELECT COUNT(*)::int AS placed FROM layer WHERE placement_id = $1 AND status IN ('SIGNED', 'BOUND', 'CLOSED')`,
      [placementId],
    );
    const { rows: p } = await client.query('SELECT reference FROM placement WHERE id = $1', [placementId]);
    if (!p[0]) throw new NotFoundError('Placement');
    if (!layers[0].placed) throw new ConflictError(`No signed layers on ${p[0].reference} — a loss is advised against a placed treaty`);

    const parsed = n.parsed || {};
    const lossDate = parsed.date_of_loss || String(n.received_at instanceof Date ? n.received_at.toISOString() : n.received_at).slice(0, 10);
    const { rows: ev } = await client.query(
      `INSERT INTO loss_event (placement_id, name, loss_date, cat_event, description, gross_loss, reference, insured, cause, paid, outstanding, created_by)
       VALUES ($1,$2,$3,FALSE,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [placementId, parsed.insured || n.subject || 'Loss advice', lossDate, parsed.summary || parsed.cause || null,
        Number(parsed.advised_reserve) || 0, parsed.cedant_reference || null, parsed.insured || null, parsed.cause || null,
        Number(parsed.paid) || null, Number(parsed.outstanding) || null, user.id],
    );
    await audit({
      entityType: 'loss_event', entityId: ev[0].id, action: 'create', userId: user.id,
      detail: { gross_loss: Number(parsed.advised_reserve) || 0, source: 'claim_notification', notification_id: id },
    }, client);
    const { rows: upd } = await client.query(
      `UPDATE claim_notification
          SET status = 'loaded', placement_id = $2, loss_event_id = $3, loaded_by = $4, loaded_at = now(),
              match_basis = CASE WHEN placement_id IS DISTINCT FROM $2 THEN 'broker' ELSE match_basis END,
              match_confidence = CASE WHEN placement_id IS DISTINCT FROM $2 THEN 1 ELSE match_confidence END,
              updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, placementId, ev[0].id, user.id],
    );
    await audit({
      entityType: 'claim_notification', entityId: id, action: 'load', userId: user.id,
      detail: { placement_id: placementId, loss_event_id: ev[0].id },
    }, client);
    return { notification: upd[0], event: ev[0], already: false };
  });

  if (created.already) {
    const n = await getRow(id);
    const advice = (await query(`SELECT * FROM claim_advice WHERE loss_event_id = $1 AND kind = 'preliminary' ORDER BY sent_at DESC LIMIT 1`, [n.loss_event_id])).rows[0] || null;
    return { notification: n, loss_event: n.loss_event_id ? await getLoss(n.loss_event_id) : null, advice, already: true };
  }

  // The calculation and the panel-wide advice, outside the load itself: a
  // failure here leaves a loaded notice with a loss event the workspace can
  // re-calculate and re-advise.
  const calculated = await calculateLoss(created.event.id, user.id);
  const { advice } = await issuePreliminaryAdvice(created.event.id, { notification_id: id }, user);
  return { notification: await getRow(id), loss_event: { ...calculated, ...(await getLoss(created.event.id)) }, advice, already: false };
}
