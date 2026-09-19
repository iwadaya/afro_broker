/*
 * The renewal desk's responses: one row per reinsurer per layer, read off
 * the line ledger, the approaches and their quotes, and the markets the
 * desk's submission went to — so a market that was written to and has said
 * nothing is a row that reads Awaiting, and a declinature is a row at nil,
 * not a missing one.
 *
 * Nothing is computed here that the line and signing-down domain owns: the
 * written and signed figures are the ledger's, the layer totals are sums of
 * them, and the release gate is the one check the desk adds — every layer
 * signed to exactly its order.
 */

import { query } from '../../db/pool.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { roundPct } from '../../domain/signingDown.js';

async function loadAnalysis(id) {
  const { rows } = await query('SELECT * FROM renewal_pack_analysis WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Renewal pack analysis');
  return rows[0];
}

const num = (v) => (v == null ? null : Number(v));

/** The status a row reads, from what the ledger holds for that market on that layer. */
function rowStatus({ line, approach, quote }) {
  if (line?.status === 'DECLINED' || (!line && approach?.status === 'DECLINED')) return 'declined';
  if (line && Number(line.written_pct) > 0) return 'written';
  if (quote || approach?.status === 'QUOTED') return 'quoted';
  return 'awaiting';
}

/**
 * Everything the responses tab shows for the placement an uploaded pack is
 * linked to: the layers with their firm order terms, the rows, the totals.
 */
export async function responsesContext(analysisId) {
  const analysis = await loadAnalysis(analysisId);
  const blockers = [];
  if (!analysis.placement_id) {
    blockers.push('Link this pack to its placement on the Renewal pack tab — responses are recorded against its layers');
    return { analysis: { id: analysis.id }, placement: null, layers: [], blockers, ready: false };
  }

  const [{ rows: placements }, { rows: layers }] = await Promise.all([
    query(
      `SELECT p.id, p.reference, p.status, p.currency, p.inception, p.expiry, c.name AS cedant_name
         FROM placement p LEFT JOIN cedant c ON c.id = p.cedant_id WHERE p.id = $1`,
      [analysis.placement_id],
    ),
    query('SELECT * FROM layer WHERE placement_id = $1 ORDER BY position, created_at', [analysis.placement_id]),
  ]);
  const placement = placements[0];
  if (!placement) throw new NotFoundError('Placement');
  if (!layers.length) blockers.push(`No layers on ${placement.reference} yet — build the structure on the placement page`);

  const layerIds = layers.map((l) => l.id);
  const [lines, approaches, quotes, fots, recipients, contacts] = await Promise.all([
    query(
      `SELECT l.*, m.name AS market_name, m.rating AS market_rating
         FROM line l JOIN market m ON m.id = l.market_id WHERE l.layer_id = ANY($1)`,
      [layerIds],
    ),
    query(
      `SELECT a.*, m.name AS market_name, m.rating AS market_rating
         FROM approach a JOIN market m ON m.id = a.market_id WHERE a.layer_id = ANY($1)`,
      [layerIds],
    ),
    query(
      `SELECT q.approach_id, q.line_offered, q.premium, q.rate, q.rol, q.created_at
         FROM quote q JOIN approach a ON a.id = q.approach_id
        WHERE a.layer_id = ANY($1) AND q.status = 'active'`,
      [layerIds],
    ),
    query(
      `SELECT DISTINCT ON (layer_id) layer_id, id, version, status, proposed_by, authorised_by, authorised_at
         FROM fot WHERE layer_id = ANY($1) AND status IN ('authorised', 'proposed')
        ORDER BY layer_id, (status = 'authorised') DESC, version DESC`,
      [layerIds],
    ),
    // The markets the desk wrote to: every recipient of a sent desk
    // submission on this placement, with the reinsurer's register entry.
    query(
      `SELECT DISTINCT ON (r.market_id) r.market_id, r.name AS contact_name, r.email, r.sent_at,
              m.name AS market_name, m.rating AS market_rating
         FROM negotiation_submission_recipient r
         JOIN negotiation_submission s ON s.id = r.submission_id
         JOIN market m ON m.id = r.market_id
        WHERE s.placement_id = $1 AND s.status = 'sent' AND r.status = 'sent'
        ORDER BY r.market_id, r.sent_at DESC`,
      [analysis.placement_id],
    ),
    query(
      `SELECT DISTINCT ON (market_id) market_id, name, email
         FROM market_contact WHERE active ORDER BY market_id, is_primary DESC, name`,
    ),
  ]);

  const quoteOf = new Map(quotes.rows.map((q) => [q.approach_id, q]));
  const fotOf = new Map(fots.rows.map((f) => [f.layer_id, f]));
  const contactOf = new Map(contacts.rows.map((c) => [c.market_id, c]));
  const recipientOf = new Map(recipients.rows.map((r) => [r.market_id, r]));

  const out = layers.map((layer) => {
    const layerLines = lines.rows.filter((l) => l.layer_id === layer.id);
    const layerApproaches = approaches.rows.filter((a) => a.layer_id === layer.id);
    const marketIds = new Set([
      ...layerLines.map((l) => l.market_id),
      ...layerApproaches.map((a) => a.market_id),
      ...recipients.rows.map((r) => r.market_id),
    ]);
    const rows = [...marketIds].map((marketId) => {
      const line = layerLines.find((l) => l.market_id === marketId) || null;
      const approach = layerApproaches.find((a) => a.market_id === marketId) || null;
      const quote = approach ? quoteOf.get(approach.id) || null : null;
      const recipient = recipientOf.get(marketId) || null;
      const contact = contactOf.get(marketId) || null;
      const name = line?.market_name || approach?.market_name || recipient?.market_name;
      const status = rowStatus({ line, approach, quote });
      return {
        market_id: marketId,
        market_name: name,
        rating: line?.market_rating || approach?.market_rating || recipient?.market_rating || null,
        underwriter: recipient?.contact_name || contact?.name || null,
        email: recipient?.email || contact?.email || null,
        status,
        role: approach?.role || null,
        offered_pct: num(quote?.line_offered),
        written_pct: line ? num(line.written_pct) : null,
        signed_pct: line ? num(line.signed_pct) : null,
        premium_signed: line ? num(line.premium_signed) : null,
        to_stand: Boolean(line?.to_stand),
        notes: line?.notes ?? approach?.notes ?? null,
        line_id: line?.id || null,
        approach_id: approach?.id || null,
        emailed_at: recipient?.sent_at || null,
        received_at: line?.updated_at || quote?.created_at || approach?.updated_at || null,
      };
    }).sort((a, b) => (b.written_pct || 0) - (a.written_pct || 0) || String(a.market_name).localeCompare(String(b.market_name)));

    const active = layerLines.filter((l) => l.status === 'WRITTEN' || l.status === 'SIGNED');
    const writtenTotal = roundPct(active.reduce((t, l) => t + Number(l.written_pct), 0));
    const signedTotal = roundPct(active.reduce((t, l) => t + Number(l.signed_pct || 0), 0));
    const order = Number(layer.order_pct);
    const fot = fotOf.get(layer.id) || null;
    return {
      id: layer.id,
      name: layer.name,
      type: layer.type,
      position: layer.position,
      status: layer.status,
      currency: layer.currency,
      attachment: num(layer.attachment),
      limit_amt: num(layer.limit_amt),
      order_pct: order,
      premium100: num(layer.premium100),
      reinstatements: layer.reinstatements,
      fot: fot ? { id: fot.id, version: fot.version, status: fot.status, proposed_by: fot.proposed_by } : null,
      written_total: writtenTotal,
      signed_total: signedTotal,
      declined: rows.filter((r) => r.status === 'declined').length,
      awaiting: rows.filter((r) => r.status === 'awaiting').length,
      signed_to_order: active.length > 0 && roundPct(signedTotal) === roundPct(order),
      rows,
    };
  });

  return {
    analysis: { id: analysis.id, cedant_name: analysis.cedant_name },
    placement,
    layers: out,
    emailed: recipients.rows.length,
    blockers,
    ready: blockers.length === 0,
  };
}

/**
 * The release: every layer signed to exactly its order, on the ledger. The
 * check is the desk's; the figures are the signing-down engine's. Releasing
 * is recorded on the placement, and the signing advices follow from it.
 */
export async function releaseSignedLines(analysisId, user) {
  const ctx = await responsesContext(analysisId);
  if (!ctx.ready) throw new ConflictError(ctx.blockers.join('; '));
  const short = ctx.layers.filter((l) => !l.signed_to_order);
  if (short.length) {
    throw new ConflictError(
      `Every layer must sign to exactly its order before release. Short: ${
        short.map((l) => `${l.name} (${l.signed_total.toFixed(2)}% of ${l.order_pct.toFixed(2)}%)`).join(', ')}`,
    );
  }
  await audit({
    entityType: 'placement', entityId: ctx.placement.id, action: 'release_signed_lines', userId: user.id,
    detail: {
      analysis_id: analysisId,
      layers: ctx.layers.map((l) => ({ layer_id: l.id, name: l.name, order_pct: l.order_pct, signed_total: l.signed_total })),
    },
  });
  await audit({
    entityType: 'renewal_pack_analysis', entityId: analysisId, action: 'release_signed_lines', userId: user.id,
    detail: { placement_id: ctx.placement.id, layers: ctx.layers.length },
  });
  return { released: true, placement_id: ctx.placement.id, layers: ctx.layers.map((l) => ({ id: l.id, name: l.name, signed_total: l.signed_total })) };
}
