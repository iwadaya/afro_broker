import { query, withTransaction } from '../../db/pool.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { assertPlacementTransition } from '../../domain/statusMachine.js';
import { audit } from '../../lib/audit.js';
import { buildUpdate, defined } from '../../lib/sql.js';
import { classColumns } from '../../domain/placementClass.js';

export async function getPlacement(id) {
  const { rows } = await query('SELECT * FROM placement WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Placement');
  return rows[0];
}

/**
 * The placement with its layers and its place in the renewal chain: the
 * year it renews (`renewal_of`, with that placement's reference) and the
 * year(s) that renew it — so the link reads from both ends.
 */
export async function getPlacementWithLayers(id) {
  const placement = await getPlacement(id);
  const [{ rows: layers }, { rows: prior }, { rows: next }] = await Promise.all([
    query('SELECT * FROM layer WHERE placement_id = $1 ORDER BY position, created_at', [id]),
    placement.renewal_of
      ? query('SELECT id, reference, inception, expiry, status FROM placement WHERE id = $1', [placement.renewal_of])
      : Promise.resolve({ rows: [] }),
    query('SELECT id, reference, inception, expiry, status FROM placement WHERE renewal_of = $1 ORDER BY inception', [id]),
  ]);
  return {
    ...placement,
    layers,
    renewal_of_placement: prior[0] || null,
    renewed_by: next,
  };
}

function generateReference(cedantCode, year) {
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `UB-${year}-${cedantCode}-${rand}`;
}

export async function createPlacement(input, userId) {
  const cedant = await query('SELECT * FROM cedant WHERE id = $1', [input.cedant_id]);
  if (!cedant.rowCount) throw new NotFoundError('Cedant');
  const year = new Date(input.inception).getUTCFullYear();
  const cedantCode = cedant.rows[0].name.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'CED';
  const reference = input.reference || generateReference(cedantCode, year);

  // A renewal names the year it renews; that year has to exist.
  if (input.renewal_of) {
    const prior = await query('SELECT id FROM placement WHERE id = $1', [input.renewal_of]);
    if (!prior.rowCount) throw new NotFoundError('Placement being renewed');
  }
  const cls = classColumns(input.class);
  const { rows } = await query(
    `INSERT INTO placement (reference, cedant_id, class, inception, expiry, currency, renewal_of, est_gwp, notes, created_by,
                            treaty_type, class_of_business)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [reference, input.cedant_id, input.class, input.inception, input.expiry,
      input.currency, input.renewal_of || null, input.est_gwp ?? null, input.notes || null, userId,
      cls.treaty_type, cls.class_of_business],
  );
  await audit({
    entityType: 'placement', entityId: rows[0].id, action: 'create', userId,
    detail: input.renewal_of ? { renewal_of: input.renewal_of } : {},
  });
  return rows[0];
}

export async function updatePlacement(id, input, userId) {
  // Moving the placement to another cedant must land on a real one.
  if (input.cedant_id !== undefined) {
    const cedant = await query('SELECT id FROM cedant WHERE id = $1', [input.cedant_id]);
    if (!cedant.rowCount) throw new NotFoundError('Cedant');
  }
  if (input.renewal_of !== undefined && input.renewal_of !== null) {
    if (input.renewal_of === id) throw new ConflictError('A placement cannot renew itself');
    const prior = await query('SELECT id FROM placement WHERE id = $1', [input.renewal_of]);
    if (!prior.rowCount) throw new NotFoundError('Placement being renewed');
  }
  const cls = input.class !== undefined ? classColumns(input.class) : {};
  const fields = defined({
    cedant_id: input.cedant_id,
    class: input.class,
    treaty_type: cls.treaty_type,
    class_of_business: cls.class_of_business,
    renewal_of: input.renewal_of,
    inception: input.inception,
    expiry: input.expiry,
    currency: input.currency,
    est_gwp: input.est_gwp,
    notes: input.notes,
    structure_cobs: input.structure_cobs !== undefined ? JSON.stringify(input.structure_cobs) : undefined,
    expiring_structure: input.expiring_structure !== undefined ? JSON.stringify(input.expiring_structure) : undefined,
    quote_structures: input.quote_structures !== undefined ? JSON.stringify(input.quote_structures) : undefined,
    retentions: input.retentions !== undefined ? JSON.stringify(input.retentions) : undefined,
  });
  if (Object.keys(fields).length === 0) return getPlacement(id);
  fields.updated_at = new Date();
  const upd = buildUpdate(fields);
  const { rows } = await query(
    `UPDATE placement SET ${upd.text} WHERE id = $${upd.nextIndex} RETURNING *`,
    [...upd.values, id],
  );
  if (!rows[0]) throw new NotFoundError('Placement');
  await audit({ entityType: 'placement', entityId: id, action: 'update', userId, detail: fields });
  return rows[0];
}

export async function transitionPlacement(id, toStatus, userId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM placement WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new NotFoundError('Placement');
    const from = rows[0].status;
    assertPlacementTransition(from, toStatus);
    const { rows: updated } = await client.query(
      'UPDATE placement SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
      [toStatus, id],
    );
    await audit(
      { entityType: 'placement', entityId: id, action: 'transition', userId, detail: { from, to: toStatus } },
      client,
    );
    return updated[0];
  });
}

/**
 * Clone a placement for renewal: copies structure (placement + layers) into a
 * new DRAFT placement linked back via `renewal_of`. Market data, quotes, lines
 * and FOT are intentionally NOT copied — renewal starts fresh to market.
 */
export async function cloneForRenewal(sourceId, overrides, userId) {
  return withTransaction(async (client) => {
    const { rows: srcRows } = await client.query('SELECT * FROM placement WHERE id = $1', [sourceId]);
    const src = srcRows[0];
    if (!src) throw new NotFoundError('Placement');

    const cedantId = overrides.cedant_id || src.cedant_id;
    const { rows: cedantRows } = await client.query('SELECT * FROM cedant WHERE id = $1', [cedantId]);
    if (!cedantRows[0]) throw new NotFoundError('Cedant');
    const cedantCode = (cedantRows[0].name || 'CED').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
    const inception = overrides.inception || src.inception;
    const expiry = overrides.expiry || src.expiry;
    const year = new Date(inception).getUTCFullYear();
    const reference = overrides.reference || generateReference(cedantCode, year);

    const cls = classColumns(src.class);
    const { rows: newRows } = await client.query(
      `INSERT INTO placement (reference, cedant_id, class, inception, expiry, currency, renewal_of, est_gwp, notes, created_by, status,
                              treaty_type, class_of_business)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DRAFT',$11,$12) RETURNING *`,
      [reference, cedantId, src.class, inception, expiry, src.currency, src.id, src.est_gwp, src.notes, userId,
        cls.treaty_type, cls.class_of_business],
    );
    const renewal = newRows[0];

    const { rows: layers } = await client.query(
      'SELECT * FROM layer WHERE placement_id = $1 ORDER BY position', [sourceId],
    );
    for (const l of layers) {
      await client.query(
        `INSERT INTO layer (placement_id, name, type, attachment, limit_amt, section_pct, order_pct, premium100, currency, technical_ref, position, risk_cover, cat_cover,
                            reinstatements, reinstatement_pct, egnpi, rate_pct, aad, brokerage_pct, region)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [renewal.id, l.name, l.type, l.attachment, l.limit_amt, l.section_pct,
          l.order_pct, 0, l.currency, l.technical_ref, l.position,
          l.risk_cover ?? true, l.cat_cover ?? true,
          l.reinstatements, l.reinstatement_pct, l.egnpi, l.rate_pct, l.aad,
          l.brokerage_pct ?? 0, l.region ?? null],
      );
    }

    await audit(
      { entityType: 'placement', entityId: renewal.id, action: 'renewal_clone', userId, detail: { renewal_of: sourceId, layers: layers.length } },
      client,
    );
    return renewal;
  });
}

// ---- Layers ----

export async function createLayer(placementId, input, userId) {
  await getPlacement(placementId); // existence
  const { rows } = await query(
    `INSERT INTO layer (placement_id, name, type, attachment, limit_amt, section_pct, order_pct, premium100, currency, technical_ref, position, risk_cover, cat_cover,
                        reinstatements, reinstatement_pct, egnpi, rate_pct, aad, brokerage_pct, region)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [placementId, input.name, input.type, input.attachment ?? 0, input.limit_amt ?? null,
      input.section_pct ?? 100, input.order_pct ?? 100, input.premium100 ?? 0,
      input.currency, input.technical_ref ?? null, input.position ?? 0,
      input.risk_cover ?? true, input.cat_cover ?? true,
      input.reinstatements ?? null, input.reinstatement_pct ?? null,
      input.egnpi ?? null, input.rate_pct ?? null, input.aad ?? null,
      input.brokerage_pct ?? 0, input.region ?? null],
  );
  await audit({ entityType: 'layer', entityId: rows[0].id, action: 'create', userId });
  return rows[0];
}

export async function updateLayer(layerId, input, userId) {
  // Guard: structural/financial terms are locked once the layer is bound.
  const { rows: cur } = await query('SELECT * FROM layer WHERE id = $1', [layerId]);
  if (!cur[0]) throw new NotFoundError('Layer');
  if (cur[0].status === 'BOUND' || cur[0].status === 'CLOSED') {
    throw new ConflictError('Layer is bound; terms are locked');
  }
  const fields = defined({
    name: input.name,
    type: input.type,
    attachment: input.attachment,
    limit_amt: input.limit_amt,
    section_pct: input.section_pct,
    order_pct: input.order_pct,
    premium100: input.premium100,
    currency: input.currency,
    technical_ref: input.technical_ref,
    position: input.position,
    risk_cover: input.risk_cover,
    cat_cover: input.cat_cover,
    reinstatements: input.reinstatements,
    reinstatement_pct: input.reinstatement_pct,
    egnpi: input.egnpi,
    rate_pct: input.rate_pct,
    aad: input.aad,
    brokerage_pct: input.brokerage_pct,
    region: input.region,
  });
  if (Object.keys(fields).length === 0) return cur[0];
  fields.updated_at = new Date();
  const upd = buildUpdate(fields);
  const { rows } = await query(
    `UPDATE layer SET ${upd.text} WHERE id = $${upd.nextIndex} RETURNING *`,
    [...upd.values, layerId],
  );
  await audit({ entityType: 'layer', entityId: layerId, action: 'update', userId, detail: fields });
  return rows[0];
}

export async function getLayer(layerId) {
  const { rows } = await query('SELECT * FROM layer WHERE id = $1', [layerId]);
  if (!rows[0]) throw new NotFoundError('Layer');
  return rows[0];
}

export async function deleteLayer(layerId, userId) {
  const layer = await getLayer(layerId);
  if (layer.status !== 'OPEN') throw new ConflictError('Only OPEN layers can be deleted');
  await query('DELETE FROM layer WHERE id = $1', [layerId]);
  await audit({ entityType: 'layer', entityId: layerId, action: 'delete', userId });
}
