import { withTransaction, query } from '../../db/pool.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { createApproval, approve } from '../../lib/approvals.js';

/**
 * Firm Order Terms (design doc §3, §6 phase 7).
 *
 * Integrity rules enforced here:
 *  - FOT is immutable once authorised. A change is a NEW version, never an edit.
 *  - Authorisation is four-eyes: the proposer cannot authorise; the authoriser
 *    must be an underwriter or admin.
 *  - At most one authorised FOT per layer (also guarded by a partial unique
 *    index in the schema).
 */

export async function listFot(layerId) {
  const { rows } = await query('SELECT * FROM fot WHERE layer_id = $1 ORDER BY version DESC', [layerId]);
  return rows;
}

export async function getActiveFot(layerId) {
  const { rows } = await query(
    "SELECT * FROM fot WHERE layer_id = $1 AND status = 'authorised'", [layerId],
  );
  return rows[0] || null;
}

/** Propose firm order terms (status 'proposed') and open a four-eyes request. */
export async function proposeFot(layerId, input, userId) {
  return withTransaction(async (client) => {
    const { rows: layerRows } = await client.query('SELECT * FROM layer WHERE id = $1 FOR UPDATE', [layerId]);
    if (!layerRows[0]) throw new NotFoundError('Layer');
    if (layerRows[0].status === 'BOUND' || layerRows[0].status === 'CLOSED') {
      throw new ConflictError('Layer is bound; FOT cannot be changed');
    }

    // Supersede any outstanding proposal that has not been authorised.
    await client.query(
      "UPDATE fot SET status = 'superseded' WHERE layer_id = $1 AND status = 'proposed'",
      [layerId],
    );
    await client.query(
      "UPDATE approval SET status = 'rejected', resolved_at = now() WHERE action_type = 'fot_authorise' AND entity_type = 'layer' AND entity_id = $1 AND status = 'pending'",
      [String(layerId)],
    );

    const { rows: verRows } = await client.query(
      'SELECT COALESCE(MAX(version),0)+1 AS next FROM fot WHERE layer_id = $1', [layerId],
    );
    const version = verRows[0].next;
    const { rows } = await client.query(
      `INSERT INTO fot (layer_id, version, agreed_terms, agreed_date, proposed_by, status)
       VALUES ($1,$2,$3,$4,$5,'proposed') RETURNING *`,
      [layerId, version, JSON.stringify(input.agreed_terms || {}), input.agreed_date || null, userId],
    );
    await createApproval(client, {
      actionType: 'fot_authorise', entityType: 'layer', entityId: layerId,
      proposedBy: userId, detail: { fot_id: rows[0].id, version },
    });
    await audit({ entityType: 'fot', entityId: rows[0].id, action: 'propose', userId, detail: { version } }, client);
    return rows[0];
  });
}

/**
 * Authorise the outstanding FOT proposal (four-eyes). Moves the layer to
 * FOT_AGREED and, if the placement is still pre-FOT, advances it to FOT_AGREED.
 */
export async function authoriseFot(layerId, approver) {
  return withTransaction(async (client) => {
    const { rows: proposalRows } = await client.query(
      "SELECT * FROM fot WHERE layer_id = $1 AND status = 'proposed' ORDER BY version DESC LIMIT 1 FOR UPDATE",
      [layerId],
    );
    const proposal = proposalRows[0];
    if (!proposal) throw new NotFoundError('Proposed FOT');

    // Four-eyes gate (proposer ≠ approver, approver role check).
    await approve(client, {
      actionType: 'fot_authorise', entityType: 'layer', entityId: layerId,
      approver, allowedRoles: ['underwriter', 'admin'],
    });

    // Supersede a prior authorised FOT (new version replaces it).
    await client.query(
      "UPDATE fot SET status = 'superseded' WHERE layer_id = $1 AND status = 'authorised'",
      [layerId],
    );
    const { rows } = await client.query(
      `UPDATE fot SET status = 'authorised', authorised_by = $1, authorised_at = now()
       WHERE id = $2 RETURNING *`,
      [approver.id, proposal.id],
    );

    await client.query(
      "UPDATE layer SET status = 'FOT_AGREED', updated_at = now() WHERE id = $1 AND status = 'OPEN'",
      [layerId],
    );
    // Advance the placement to FOT_AGREED if it is at QUOTED (or earlier active state).
    const { rows: layerRows } = await client.query('SELECT placement_id FROM layer WHERE id = $1', [layerId]);
    await client.query(
      `UPDATE placement SET status = 'FOT_AGREED', updated_at = now()
       WHERE id = $1 AND status IN ('LEAD_MARKETING','QUOTED','PACK','DATA','DRAFT')`,
      [layerRows[0].placement_id],
    );

    await audit({ entityType: 'fot', entityId: proposal.id, action: 'authorise', userId: approver.id, detail: { version: proposal.version } }, client);
    return rows[0];
  });
}

/** Guard used by the routes to make explicit that authorised FOT is immutable. */
export async function assertFotNotAuthorised(fotId) {
  const { rows } = await query('SELECT status FROM fot WHERE id = $1', [fotId]);
  if (!rows[0]) throw new NotFoundError('FOT');
  if (rows[0].status === 'authorised') {
    throw new ConflictError('Authorised FOT is immutable; propose a new version instead');
  }
}
