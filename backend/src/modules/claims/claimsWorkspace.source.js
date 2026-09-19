import { createHash } from 'node:crypto';
import { loadPremiumSource } from '../premium/premium.source.js';
import { dateOnly } from '../../domain/premiumAccounting.js';

export async function loadClaimSource(db, placementId, input, event = null) {
  const src = await loadPremiumSource(db, placementId);
  const p = (await db.query('SELECT quote_structures FROM placement WHERE id=$1', [placementId])).rows[0];
  const rows = (await db.query('SELECT id,aad,risk_cover,cat_cover FROM layer WHERE placement_id=$1', [placementId])).rows;
  const layers = src.layers.map(l => {
    let extra = rows.find(r => r.id === l.id);
    if (!l.id) {
      const match = /^final:s(\d+):l(\d+)$/.exec(l.key);
      extra = match ? p.quote_structures?.[Number(match[1])-1]?.layers?.[Number(match[2])] : null;
    }
    return { ...l, aad: extra?.aad ?? null, risk_cover: extra?.risk_cover ?? extra?.risk ?? true, cat_cover: extra?.cat_cover ?? extra?.cat ?? true };
  });
  const events = (await db.query('SELECT id,loss_date,created_at,gross_loss,cat_event FROM loss_event WHERE placement_id=$1 ORDER BY loss_date,created_at,id', [placementId])).rows;
  const at = dateOnly(input.loss_date);
  const previous = events.filter(e => {
    if (e.id === event?.id) return false;
    const day = dateOnly(e.loss_date);
    if (day !== at) return day < at;
    if (!event) return true; // A new event follows already recorded events on the same day.
    const time = new Date(e.created_at).getTime() - new Date(event.created_at).getTime();
    return time < 0 || (time === 0 && e.id < event.id);
  }).map(e => ({ id: e.id, loss_date: dateOnly(e.loss_date), gross_loss: Number(e.gross_loss), cat_event: e.cat_event, currency: src.placement.currency }));
  const basis = { placement: src.placement, layers, previous };
  return { ...src, ...basis, source_hash: createHash('sha256').update(JSON.stringify(basis)).digest('hex') };
}
