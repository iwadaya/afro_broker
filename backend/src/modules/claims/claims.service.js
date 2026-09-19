import { withTransaction, query } from '../../db/pool.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { computeXolLoss, parseReinstatements } from '../../domain/xol.js';
import { allocatePremium } from '../../domain/signingDown.js';
import { settlementFor } from '../../domain/claimSettlement.js';

/**
 * Post-bind claims: loss events advised on a placement, the recovery each
 * bound XoL layer owes (loss to the layer), every reinsurer's share of it by
 * signed line, and the reinstatement premium due back the other way.
 */

async function loadEvent(runner, id, lock = false) {
  const { rows } = await runner.query(
    `SELECT * FROM loss_event WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id],
  );
  if (!rows[0]) throw new NotFoundError('Loss event');
  return rows[0];
}

async function recoveriesFor(runner, eventIds) {
  if (eventIds.length === 0) return [];
  const { rows } = await runner.query(
    `SELECT r.*, l.name AS layer_name FROM loss_recovery r JOIN layer l ON l.id = r.layer_id
     WHERE r.loss_event_id = ANY($1) ORDER BY l.position`,
    [eventIds],
  );
  return rows;
}

/** The event with its recoveries and the settlement ladder the workspace reads — never recomputed in the browser. */
function withSettlement(event, recoveries) {
  return { ...event, recoveries, settlement: event.workspace_claim ? event.settlement : recoveries.length ? settlementFor({ event, recoveries }) : null };
}

export async function listLosses(placementId) {
  const { rows: events } = await query(
    'SELECT * FROM loss_event WHERE placement_id = $1 ORDER BY loss_date, created_at',
    [placementId],
  );
  const recoveries = await recoveriesFor({ query }, events.map((e) => e.id));
  return events.map((e) => withSettlement(e, recoveries.filter((r) => r.loss_event_id === e.id)));
}

export async function getLoss(id) {
  const event = await loadEvent({ query }, id);
  const recoveries = await recoveriesFor({ query }, [id]);
  return withSettlement(event, recoveries);
}

const LOSS_FIELDS = ['reference', 'insured', 'cause', 'paid', 'outstanding', 'lae', 'salvage', 'cash_funded', 'waive_reinstatement'];

export async function createLoss(placementId, input, userId) {
  const { rows: pRows } = await query('SELECT 1 FROM placement WHERE id = $1', [placementId]);
  if (!pRows.length) throw new NotFoundError('Placement');
  const { rows: bound } = await query(
    "SELECT COUNT(*)::int AS n FROM layer WHERE placement_id = $1 AND status IN ('BOUND','CLOSED')",
    [placementId],
  );
  if (!bound[0].n) throw new ConflictError('No bound layers; losses are advised against a placed treaty');

  const { rows } = await query(
    `INSERT INTO loss_event (placement_id, name, loss_date, cat_event, description, gross_loss, created_by,
                             reference, insured, cause, paid, outstanding, lae, salvage, cash_funded, waive_reinstatement)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [placementId, input.name, input.loss_date, !!input.cat_event,
      input.description || null, input.gross_loss, userId,
      input.reference || null, input.insured || null, input.cause || null, input.paid ?? null, input.outstanding ?? null,
      input.lae ?? 0, input.salvage ?? 0, input.cash_funded ?? 0, !!input.waive_reinstatement],
  );
  await audit({ entityType: 'loss_event', entityId: rows[0].id, action: 'create', userId, detail: { gross_loss: input.gross_loss } });
  return rows[0];
}

export async function updateLoss(id, input, userId) {
  return withTransaction(async (client) => {
    const event = await loadEvent(client, id, true);
    if (event.workspace_claim) throw new ConflictError('Open this claim in the Non-Proportional Claims workspace');
    if (event.status === 'settled') throw new ConflictError('Loss event is settled');
    const { rows } = await client.query(
      `UPDATE loss_event SET
         name = COALESCE($1, name), loss_date = COALESCE($2, loss_date),
         cat_event = COALESCE($3, cat_event), description = COALESCE($4, description),
         gross_loss = COALESCE($5, gross_loss),
         reference = COALESCE($7, reference), insured = COALESCE($8, insured), cause = COALESCE($9, cause),
         paid = COALESCE($10, paid), outstanding = COALESCE($11, outstanding),
         lae = COALESCE($12, lae), salvage = COALESCE($13, salvage), cash_funded = COALESCE($14, cash_funded),
         waive_reinstatement = COALESCE($15, waive_reinstatement),
         status = 'open', settlement = NULL, updated_at = now()
       WHERE id = $6 RETURNING *`,
      [input.name ?? null, input.loss_date ?? null, input.cat_event ?? null,
        input.description ?? null, input.gross_loss ?? null, id,
        ...LOSS_FIELDS.map((f) => input[f] ?? null)],
    );
    // The advised figures are stale once the event changes.
    await client.query('DELETE FROM loss_recovery WHERE loss_event_id = $1', [id]);
    await audit({ entityType: 'loss_event', entityId: id, action: 'update', userId, detail: input }, client);
    return rows[0];
  });
}

/**
 * The placed XoL layers of a placement with the terms the calculation needs:
 * bound, or signed to the order — a signed layer's shares are fixed, and the
 * desk advises losses from the signing on.
 */
async function boundXolLayers(runner, placementId) {
  const { rows } = await runner.query(
    `SELECT * FROM layer WHERE placement_id = $1 AND type = 'XoL' AND status IN ('SIGNED','BOUND','CLOSED')
     ORDER BY position`,
    [placementId],
  );
  return rows;
}

/**
 * Limit consumed on each layer by loss events that precede `event` (by loss
 * date, then advice order). Recomputed from first principles each time so the
 * walk is deterministic regardless of which events have been advised.
 */
function consumedBefore(layers, events, event) {
  const consumed = Object.fromEntries(layers.map((l) => [l.id, 0]));
  for (const e of events) {
    if (e.id === event.id) break;
    for (const layer of layers) {
      const r = computeXolLoss({
        grossLoss: Number(e.gross_loss),
        attachment: Number(layer.attachment),
        limit: layer.limit_amt != null ? Number(layer.limit_amt) : null,
        premium100: Number(layer.premium100),
        reinstatements: parseReinstatements(layer.reinstatements),
        reinstatementPremiumPct: layer.reinstatement_pct != null ? Number(layer.reinstatement_pct) : 100,
        consumedBefore: consumed[layer.id],
      });
      consumed[layer.id] += r.recovery;
    }
  }
  return consumed;
}

/**
 * Calculate (or recalculate) a loss event against every bound XoL layer:
 * loss to layer, each market's share by signed line, and the reinstatement
 * premium — persisted per layer and issued as a loss advice document.
 */
export async function calculateLoss(id, userId) {
  return withTransaction(async (client) => {
    const event = await loadEvent(client, id, true);
    if (event.workspace_claim) throw new ConflictError('Open this claim in the Non-Proportional Claims workspace');
    if (event.status === 'settled') throw new ConflictError('Loss event is settled');

    const layers = await boundXolLayers(client, event.placement_id);
    if (layers.length === 0) throw new ConflictError('No bound XoL layers to calculate against');

    const { rows: allEvents } = await client.query(
      'SELECT * FROM loss_event WHERE placement_id = $1 ORDER BY loss_date, created_at',
      [event.placement_id],
    );
    const consumed = consumedBefore(layers, allEvents, event);

    await client.query('DELETE FROM loss_recovery WHERE loss_event_id = $1', [id]);

    const recoveries = [];
    for (const layer of layers) {
      const calc = computeXolLoss({
        grossLoss: Number(event.gross_loss),
        attachment: Number(layer.attachment),
        limit: layer.limit_amt != null ? Number(layer.limit_amt) : null,
        premium100: Number(layer.premium100),
        reinstatements: parseReinstatements(layer.reinstatements),
        reinstatementPremiumPct: layer.reinstatement_pct != null ? Number(layer.reinstatement_pct) : 100,
        consumedBefore: consumed[layer.id],
      });

      const { rows: lineRows } = await client.query(
        `SELECT l.market_id, m.name AS market_name, l.signed_pct
         FROM line l JOIN market m ON m.id = l.market_id
         WHERE l.layer_id = $1 AND l.status = 'SIGNED' ORDER BY m.name`,
        [layer.id],
      );
      const signed = lineRows.map((r) => ({ id: r.market_id, signed: Number(r.signed_pct || 0) }));
      const recoveryShares = allocatePremium(calc.recovery, signed);
      const ripShares = allocatePremium(calc.reinstatementPremium, signed);
      const ripByMarket = Object.fromEntries(ripShares.map((s) => [s.id, s.premiumSigned]));

      const detail = {
        attachment: Number(layer.attachment),
        limit: layer.limit_amt != null ? Number(layer.limit_amt) : null,
        premium100: Number(layer.premium100),
        reinstatements: layer.reinstatements ?? null,
        reinstatement_pct: layer.reinstatement_pct != null ? Number(layer.reinstatement_pct) : 100,
        consumed_before: consumed[layer.id],
        remaining_aggregate: calc.remainingAggregate,
        reinstated: calc.reinstated,
        markets: recoveryShares.map((s) => ({
          market_id: s.id,
          market_name: lineRows.find((r) => r.market_id === s.id)?.market_name,
          signed_pct: s.signed,
          recovery: s.premiumSigned,
          reinstatement_premium: ripByMarket[s.id] ?? 0,
        })),
      };

      const { rows: recRows } = await client.query(
        `INSERT INTO loss_recovery (loss_event_id, layer_id, loss_to_layer, reinstatement_premium, detail)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, layer.id, calc.recovery, calc.reinstatementPremium, JSON.stringify(detail)],
      );
      recoveries.push({ ...recRows[0], layer_name: layer.name });
    }

    // The settlement ladder and every market's share of it, kept with the
    // event and carried on the advice — the workspace never recomputes it.
    const settlement = settlementFor({ event, recoveries });
    const { rows: upd } = await client.query(
      "UPDATE loss_event SET status = 'advised', settlement = $2, updated_at = now() WHERE id = $1 RETURNING *",
      [id, JSON.stringify(settlement)],
    );

    // The loss advice lands in the document worklist (Wording).
    const { rows: verDoc } = await client.query(
      "SELECT COALESCE(MAX(version),0)+1 AS next FROM document WHERE placement_id = $1 AND type = 'loss_advice' AND layer_id IS NULL",
      [event.placement_id],
    );
    await client.query(
      `INSERT INTO document (placement_id, type, version, content, created_by)
       VALUES ($1,'loss_advice',$2,$3,$4)`,
      [event.placement_id, verDoc[0].next,
        JSON.stringify({
          loss_event: {
            id: event.id, name: event.name, loss_date: event.loss_date,
            cat_event: event.cat_event, gross_loss: Number(event.gross_loss),
          },
          recoveries: recoveries.map((r) => ({
            layer_id: r.layer_id, layer_name: r.layer_name,
            loss_to_layer: Number(r.loss_to_layer),
            reinstatement_premium: Number(r.reinstatement_premium),
            detail: r.detail,
          })),
          // The full breakdown: the ladder at 100% of layer, and each
          // market's share of every line at its signed percentage.
          settlement,
        }), userId],
    );

    await audit(
      { entityType: 'loss_event', entityId: id, action: 'calculate', userId,
        detail: { layers: recoveries.length } },
      client,
    );
    return { ...upd[0], recoveries, settlement };
  });
}

export async function settleLoss(id, userId) {
  return withTransaction(async (client) => {
    const event = await loadEvent(client, id, true);
    if (event.workspace_claim) throw new ConflictError('Open this claim in the Non-Proportional Claims workspace');
    if (event.status !== 'advised') throw new ConflictError('Calculate the loss before settling it');
    const { rows } = await client.query(
      "UPDATE loss_event SET status = 'settled', updated_at = now() WHERE id = $1 RETURNING *", [id],
    );
    await audit({ entityType: 'loss_event', entityId: id, action: 'settle', userId }, client);
    return rows[0];
  });
}

