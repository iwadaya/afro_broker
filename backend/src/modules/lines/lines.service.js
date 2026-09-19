import { withTransaction, query } from '../../db/pool.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { computeSigning, computeInstructedSigning, allocatePremium, roundPct } from '../../domain/signingDown.js';
import { createApproval, approve } from '../../lib/approvals.js';
import { getActiveFot } from '../fot/fot.service.js';
import { confirmInwardsContract } from '../../integrations/universe.js';

const ACTIVE_LINE_STATUSES = ['WRITTEN', 'SIGNED'];

export async function listLines(layerId) {
  const { rows } = await query(
    `SELECT l.*, m.name AS market_name FROM line l JOIN market m ON m.id = l.market_id
     WHERE l.layer_id = $1 ORDER BY m.name`,
    [layerId],
  );
  return rows;
}

async function loadLayer(client, layerId, lock = false) {
  const { rows } = await client.query(
    `SELECT * FROM layer WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [layerId],
  );
  if (!rows[0]) throw new NotFoundError('Layer');
  return rows[0];
}

/**
 * Write (upsert) a market's line on a layer. Requires an authorised FOT — lines
 * are collected against firm order terms. Re-writing a market's line replaces
 * its written value (and clears any prior signed values, which become stale).
 */
export async function writeLine(layerId, input, userId) {
  return withTransaction(async (client) => {
    const layer = await loadLayer(client, layerId, true);
    if (layer.status === 'BOUND' || layer.status === 'CLOSED') {
      throw new ConflictError('Layer is bound; lines are locked');
    }
    const fot = await getActiveFot(layerId);
    if (!fot) throw new ConflictError('No authorised FOT; cannot collect lines yet');

    const market = await client.query('SELECT type FROM market WHERE id = $1', [input.market_id]);
    if (!market.rowCount) throw new NotFoundError('Market');
    // Capacity comes from reinsurers; insurers and brokers are register-only.
    if (market.rows[0].type !== 'reinsurer') {
      throw new ConflictError('Only reinsurers can write a line');
    }

    const { rows } = await client.query(
      `INSERT INTO line (layer_id, market_id, approach_id, written_pct, to_stand, market_ref, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'WRITTEN',$7)
       ON CONFLICT (layer_id, market_id) DO UPDATE
         SET written_pct = EXCLUDED.written_pct,
             to_stand = EXCLUDED.to_stand,
             approach_id = COALESCE(EXCLUDED.approach_id, line.approach_id),
             market_ref = COALESCE(EXCLUDED.market_ref, line.market_ref),
             signed_pct = NULL, signing_factor = NULL, premium_signed = NULL,
             status = 'WRITTEN', updated_at = now()
       RETURNING *`,
      [layerId, input.market_id, input.approach_id || null, input.written_pct, !!input.to_stand, input.market_ref || null, userId],
    );

    if (input.approach_id) {
      await client.query(
        "UPDATE approach SET status = 'WRITTEN', updated_at = now() WHERE id = $1 AND status IN ('AGREED','QUOTED','APPROACHED')",
        [input.approach_id],
      );
    }

    // Advance placement: FOT_AGREED -> FOLLOW_MARKETING -> LINES_WRITTEN.
    await client.query(
      "UPDATE placement SET status = 'FOLLOW_MARKETING', updated_at = now() WHERE id = $1 AND status = 'FOT_AGREED'",
      [layer.placement_id],
    );
    await client.query(
      "UPDATE placement SET status = 'LINES_WRITTEN', updated_at = now() WHERE id = $1 AND status = 'FOLLOW_MARKETING'",
      [layer.placement_id],
    );

    await audit({ entityType: 'line', entityId: rows[0].id, action: 'write', userId, detail: { written_pct: input.written_pct, to_stand: !!input.to_stand } }, client);
    return rows[0];
  });
}

/**
 * The broker's own column: a signed line set by hand, or a note on the line.
 *
 * Signing down (below) apportions a whole layer; this is the override the
 * design keeps possible afterwards — one cell, never above the line written,
 * with the premium following. The release gate, not this call, is where the
 * signed column has to add up to the order.
 */
export async function overrideLine(layerId, marketId, input, userId) {
  return withTransaction(async (client) => {
    const layer = await loadLayer(client, layerId, true);
    if (layer.status === 'BOUND' || layer.status === 'CLOSED') {
      throw new ConflictError('Layer is bound; lines are locked');
    }
    const { rows: existing } = await client.query(
      'SELECT * FROM line WHERE layer_id = $1 AND market_id = $2 FOR UPDATE', [layerId, marketId],
    );
    const line = existing[0];
    if (!line) throw new NotFoundError('Line');

    const sets = [];
    const params = [];
    const add = (sql, value) => { params.push(value); sets.push(sql.replace('?', `$${params.length}`)); };
    const detail = {};

    if (input.signed_pct !== undefined) {
      if (line.status === 'DECLINED') throw new ConflictError('A declined line has no signed share — re-write the line first');
      const signed = input.signed_pct == null ? null : roundPct(Number(input.signed_pct));
      const written = roundPct(Number(line.written_pct));
      if (signed != null && signed > written) {
        throw new ConflictError(`Signed ${signed}% is above the ${written}% written — a line is never signed above the amount written`);
      }
      const premium = signed == null ? null : round2(Number(layer.premium100) * (signed / 100));
      const brokerage = premium == null ? null : round2(premium * (Number(layer.brokerage_pct || 0) / 100));
      add('signed_pct = ?', signed);
      add('premium_signed = ?', premium);
      add('brokerage_amount = ?', brokerage);
      add('signing_factor = ?', null);
      add('status = ?', signed == null ? 'WRITTEN' : 'SIGNED');
      detail.signed_pct = signed;
    }
    if (input.notes !== undefined) {
      add('notes = ?', input.notes == null || input.notes === '' ? null : String(input.notes));
      detail.notes = Boolean(input.notes);
    }
    if (!sets.length) return line;

    params.push(line.id);
    const { rows } = await client.query(
      `UPDATE line SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
      params,
    );
    await audit({ entityType: 'line', entityId: line.id, action: 'override', userId, detail }, client);
    return rows[0];
  });
}

export async function declineLine(layerId, marketId, userId) {
  const { rows } = await query(
    "UPDATE line SET status = 'DECLINED', written_pct = 0, signed_pct = NULL, premium_signed = NULL, updated_at = now() WHERE layer_id = $1 AND market_id = $2 RETURNING *",
    [layerId, marketId],
  );
  if (!rows[0]) throw new NotFoundError('Line');
  await audit({ entityType: 'line', entityId: rows[0].id, action: 'decline', userId });
  return rows[0];
}

/** Gather the active written lines and the layer order for a signing run. */
async function gatherForSigning(runner, layerId) {
  const layer = (await runner.query('SELECT * FROM layer WHERE id = $1', [layerId])).rows[0];
  if (!layer) throw new NotFoundError('Layer');
  const { rows } = await runner.query(
    `SELECT * FROM line WHERE layer_id = $1 AND status = ANY($2) ORDER BY created_at`,
    [layerId, ACTIVE_LINE_STATUSES],
  );
  const order = Number(layer.order_pct);
  const lines = rows.map((l) => ({ id: l.id, written: Number(l.written_pct), toStand: l.to_stand }));
  return { layer, lineRows: rows, order, lines };
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Per-line premium + brokerage from a signing result and the layer's terms. */
function moneyByLine(layer, result) {
  const brokeragePct = Number(layer.brokerage_pct || 0);
  const alloc = allocatePremium(Number(layer.premium100), result.lines);
  const money = new Map(alloc.map((a) => {
    const brokerage = round2(a.premiumSigned * (brokeragePct / 100));
    return [a.id, { premiumSigned: a.premiumSigned, brokerageAmount: brokerage }];
  }));
  return { brokeragePct, money };
}

function resultShape(layer, result, money, brokeragePct) {
  const lines = result.lines.map((l) => {
    const m = money.get(l.id) || { premiumSigned: 0, brokerageAmount: 0 };
    return { ...l, premiumSigned: m.premiumSigned, brokerageAmount: m.brokerageAmount };
  });
  return {
    ...result,
    premium100: Number(layer.premium100),
    brokerage_pct: brokeragePct,
    brokerage_total: round2(lines.reduce((a, l) => a + l.brokerageAmount, 0)),
    lines,
  };
}

/**
 * Non-mutating preview of the signing-down result (for the UI before applying).
 * `standsCsv` (comma-separated line ids), when provided — empty string included
 * — replaces the persisted to-stand flags for this preview only.
 */
export async function previewSigning(layerId, standsCsv) {
  const { layer, order, lines } = await gatherForSigning({ query }, layerId);
  let effective = lines;
  if (standsCsv != null) {
    const stands = new Set(String(standsCsv).split(',').filter(Boolean));
    effective = lines.map((l) => ({ ...l, toStand: stands.has(String(l.id)) }));
  }
  const result = computeSigning(order, effective);
  const { brokeragePct, money } = moneyByLine(layer, result);
  return resultShape(layer, result, money, brokeragePct);
}

/**
 * Apply signing-down and persist signed lines. Oversubscribed scales down to the
 * order; under/exact sign at written. Undersubscribed requires `acceptShortfall`
 * (firm-order-at-written) — otherwise the caller must keep marketing.
 */
export async function applySigning(layerId, { acceptShortfall = false } = {}, userId) {
  return withTransaction(async (client) => {
    const layer = await loadLayer(client, layerId, true);
    if (layer.status === 'BOUND' || layer.status === 'CLOSED') {
      throw new ConflictError('Layer is bound; signing is locked');
    }
    const { order, lineRows, lines } = await gatherForSigning(client, layerId);
    if (lines.length === 0) throw new ConflictError('No written lines to sign');

    const result = computeSigning(order, lines);
    if (result.state === 'UNDERSUBSCRIBED' && !acceptShortfall) {
      throw new ConflictError(
        `Undersubscribed: shortfall ${result.shortfall}%. Keep marketing or apply with accept_shortfall to firm at written.`,
      );
    }

    const { brokeragePct, money } = moneyByLine(layer, result);
    for (const sl of result.lines) {
      const factor = sl.toStand ? 1 : result.signingFactor;
      const m = money.get(sl.id) || { premiumSigned: 0, brokerageAmount: 0 };
      await client.query(
        `UPDATE line SET signed_pct = $1, signing_factor = $2, premium_signed = $3, brokerage_amount = $4,
                         status = 'SIGNED', updated_at = now()
         WHERE id = $5`,
        [sl.signed, factor, m.premiumSigned, m.brokerageAmount, sl.id],
      );
    }

    // Layer + placement status.
    await client.query(
      "UPDATE layer SET status = 'SIGNED', signing_method = 'pro_rata', updated_at = now() WHERE id = $1",
      [layerId],
    );
    const placementStatus = result.state === 'UNDERSUBSCRIBED' ? 'INCOMPLETE' : 'SIGNED';
    await client.query(
      `UPDATE placement SET status = $1, updated_at = now()
       WHERE id = $2 AND status IN ('LINES_WRITTEN','FOLLOW_MARKETING','INCOMPLETE')`,
      [placementStatus, layer.placement_id],
    );

    await audit(
      { entityType: 'layer', entityId: layerId, action: 'sign_down', userId,
        detail: { state: result.state, factor: result.signingFactor, signedTotal: result.signedTotal, lines: lineRows.length } },
      client,
    );

    return resultShape(layer, result, money, brokeragePct);
  });
}

/**
 * Apply the cedant's signing instruction: the client dictates each market's
 * signed line (per market, not pro-rata). The instruction must allocate the
 * whole order and may not sign any market above its written line.
 */
export async function applySigningInstruction(layerId, allocations, userId) {
  return withTransaction(async (client) => {
    const layer = await loadLayer(client, layerId, true);
    if (layer.status === 'BOUND' || layer.status === 'CLOSED') {
      throw new ConflictError('Layer is bound; signing is locked');
    }
    const { order, lineRows, lines } = await gatherForSigning(client, layerId);
    if (lines.length === 0) throw new ConflictError('No written lines to sign');

    // The instruction arrives keyed by market; translate to line ids.
    const lineByMarket = new Map(lineRows.map((l) => [l.market_id, l.id]));
    const byLineId = allocations.map((a) => {
      const lineId = lineByMarket.get(a.market_id);
      if (!lineId) throw new ConflictError(`Market ${a.market_id} has no written line on this layer`);
      return { id: lineId, signed: a.signed_pct };
    });

    let result;
    try {
      result = computeInstructedSigning(order, lines, byLineId);
    } catch (err) {
      throw new ConflictError(err.message);
    }

    const { brokeragePct, money } = moneyByLine(layer, result);
    for (const sl of result.lines) {
      const m = money.get(sl.id) || { premiumSigned: 0, brokerageAmount: 0 };
      await client.query(
        `UPDATE line SET signed_pct = $1, signing_factor = NULL, premium_signed = $2, brokerage_amount = $3,
                         status = 'SIGNED', updated_at = now()
         WHERE id = $4`,
        [sl.signed, m.premiumSigned, m.brokerageAmount, sl.id],
      );
    }

    await client.query(
      "UPDATE layer SET status = 'SIGNED', signing_method = 'client_instruction', updated_at = now() WHERE id = $1",
      [layerId],
    );
    await client.query(
      `UPDATE placement SET status = 'SIGNED', updated_at = now()
       WHERE id = $1 AND status IN ('LINES_WRITTEN','FOLLOW_MARKETING','INCOMPLETE')`,
      [layer.placement_id],
    );

    await audit(
      { entityType: 'layer', entityId: layerId, action: 'sign_instruction', userId,
        detail: { signedTotal: result.signedTotal, lines: lineRows.length } },
      client,
    );

    return resultShape(layer, result, money, brokeragePct);
  });
}

// ---- Four-eyes bind ----

export async function proposeBind(layerId, userId) {
  return withTransaction(async (client) => {
    const layer = await loadLayer(client, layerId, true);
    if (layer.status !== 'SIGNED') throw new ConflictError('Layer must be SIGNED before bind');

    // Verify Σ signed === order before allowing a bind proposal.
    const { rows } = await client.query(
      "SELECT COALESCE(SUM(signed_pct),0) AS total FROM line WHERE layer_id = $1 AND status = 'SIGNED'",
      [layerId],
    );
    const signedTotal = roundPct(Number(rows[0].total));
    if (signedTotal !== roundPct(Number(layer.order_pct))) {
      throw new ConflictError(`Signed total ${signedTotal}% ≠ order ${layer.order_pct}%; cannot bind`);
    }

    await client.query(
      "UPDATE approval SET status = 'rejected', resolved_at = now() WHERE action_type = 'bind' AND entity_type = 'layer' AND entity_id = $1 AND status = 'pending'",
      [String(layerId)],
    );
    const approval = await createApproval(client, {
      actionType: 'bind', entityType: 'layer', entityId: layerId, proposedBy: userId,
      detail: { signedTotal },
    });
    await audit({ entityType: 'layer', entityId: layerId, action: 'propose_bind', userId }, client);
    return approval;
  });
}

/** Authorise and execute the bind (four-eyes). Issues closing + optional push. */
export async function authoriseBind(layerId, approver) {
  return withTransaction(async (client) => {
    const layer = await loadLayer(client, layerId, true);
    if (layer.status !== 'SIGNED') throw new ConflictError('Layer must be SIGNED before bind');

    await approve(client, {
      actionType: 'bind', entityType: 'layer', entityId: layerId,
      approver, allowedRoles: ['underwriter', 'admin'],
    });

    await client.query(
      "UPDATE line SET bound_date = CURRENT_DATE, updated_at = now() WHERE layer_id = $1 AND status = 'SIGNED'",
      [layerId],
    );
    await client.query("UPDATE layer SET status = 'BOUND', updated_at = now() WHERE id = $1", [layerId]);

    // Placement BOUND only once every non-cancelled layer is bound.
    const { rows: open } = await client.query(
      "SELECT COUNT(*) AS n FROM layer WHERE placement_id = $1 AND status NOT IN ('BOUND','CLOSED')",
      [layer.placement_id],
    );
    if (Number(open[0].n) === 0) {
      await client.query(
        "UPDATE placement SET status = 'BOUND', updated_at = now() WHERE id = $1",
        [layer.placement_id],
      );
    }

    // Optional push to Universe (no-op unless configured).
    const { rows: lines } = await client.query(
      "SELECT market_id, signed_pct, premium_signed FROM line WHERE layer_id = $1 AND status = 'SIGNED'",
      [layerId],
    );
    let push = { pushed: false };
    try {
      push = await confirmInwardsContract(layer, lines);
    } catch (err) {
      push = { pushed: false, error: err.message };
    }

    await audit({ entityType: 'layer', entityId: layerId, action: 'bind', userId: approver.id, detail: { push } }, client);
    const { rows: updated } = await client.query('SELECT * FROM layer WHERE id = $1', [layerId]);
    return { layer: updated[0], universe_push: push };
  });
}
