/*
 * The signing workflow's read model: the contracts a signing can be explored
 * on, and one contract's programme with its signings — the written line and
 * the signed line of every market on every layer.
 *
 * A contract here is a placement with a programme (at least one layer): the
 * treaty the cedant is placing, as the claims desk and the DFA desk read it.
 * Nothing is re-derived: a signed layer reads back exactly what applySigning
 * persisted, and an unsigned one carries the same preview the worksheet's
 * `GET /layers/:id/signing/preview` gives, marked as provisional, so the
 * screen can show where the panel would land without pretending it has.
 */

import { query } from '../../db/pool.js';
import { NotFoundError } from '../../lib/errors.js';
import { computeSigning, allocatePremium, roundPct } from '../../domain/signingDown.js';

const ACTIVE_LINE_STATUSES = ['WRITTEN', 'SIGNED'];
const SIGNED_LAYER_STATUSES = ['SIGNED', 'BOUND'];

const num = (v) => (v == null || v === '' ? null : Number(v));
const isoDay = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Where a contract stands in signing, from its line counts: every active
 * line signed, some of them, none of them, or no line written at all.
 */
export function signingStateOf({ lines_written = 0, lines_signed = 0 }) {
  if (lines_signed > 0 && lines_written === 0) return 'SIGNED';
  if (lines_signed > 0) return 'PARTLY_SIGNED';
  if (lines_written > 0) return 'LINES_WRITTEN';
  return 'NO_LINES';
}

/** The programme's name as the desk says it: the class the placement was written as. */
function contractName(p) {
  return p.class_of_business && p.treaty_type
    ? `${p.class_of_business} ${p.treaty_type}`
    : p.class;
}

function contractShape(p) {
  const uy = isoDay(p.inception)?.slice(0, 4) || null;
  return {
    id: p.id,
    reference: p.reference,
    name: contractName(p),
    cedant: p.cedant_name,
    cedant_id: p.cedant_id,
    cedant_domicile: p.cedant_domicile || null,
    class: p.class,
    treaty_type: p.treaty_type || null,
    class_of_business: p.class_of_business || null,
    status: p.status,
    currency: p.currency,
    inception: isoDay(p.inception),
    expiry: isoDay(p.expiry),
    uy,
    period: `${isoDay(p.inception)} – ${isoDay(p.expiry)}`,
  };
}

/**
 * The contracts the signing workflow can open: every placement with a
 * programme, matched on reference, cedant, class, treaty type and year,
 * newest inception first. Each carries the counts the chooser reads its
 * state from — layers, layers with lines, markets on the panel, lines
 * written and signed.
 */
export async function searchContracts(q, { limit = 200 } = {}) {
  const params = [ACTIVE_LINE_STATUSES];
  let where = 'WHERE EXISTS (SELECT 1 FROM layer ly WHERE ly.placement_id = p.id)';
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim()}%`);
    where += ` AND (p.reference ILIKE $2 OR c.name ILIKE $2 OR p.class ILIKE $2
                    OR COALESCE(p.treaty_type, '') ILIKE $2 OR COALESCE(p.class_of_business, '') ILIKE $2
                    OR to_char(p.inception, 'YYYY') ILIKE $2)`;
  }
  params.push(Math.min(Math.max(Number(limit) || 200, 1), 500));
  const { rows } = await query(
    `SELECT p.*, c.name AS cedant_name, c.domicile AS cedant_domicile,
            (SELECT COUNT(*)::int FROM layer ly WHERE ly.placement_id = p.id) AS layer_count,
            (SELECT COUNT(DISTINCT ly.id)::int FROM layer ly JOIN line ln ON ln.layer_id = ly.id
              WHERE ly.placement_id = p.id AND ln.status = ANY($1)) AS layers_with_lines,
            (SELECT COUNT(*)::int FROM layer ly
              WHERE ly.placement_id = p.id AND ly.status = ANY($${params.length + 1})) AS layers_signed,
            (SELECT COUNT(DISTINCT ln.market_id)::int FROM line ln JOIN layer ly ON ly.id = ln.layer_id
              WHERE ly.placement_id = p.id AND ln.status = ANY($1)) AS markets,
            (SELECT COUNT(*)::int FROM line ln JOIN layer ly ON ly.id = ln.layer_id
              WHERE ly.placement_id = p.id AND ln.status = 'WRITTEN') AS lines_written,
            (SELECT COUNT(*)::int FROM line ln JOIN layer ly ON ly.id = ln.layer_id
              WHERE ly.placement_id = p.id AND ln.status = 'SIGNED') AS lines_signed
       FROM placement p
       JOIN cedant c ON c.id = p.cedant_id
       ${where}
      ORDER BY p.inception DESC, c.name, p.reference
      LIMIT $${params.length}`,
    [...params, SIGNED_LAYER_STATUSES],
  );
  return rows.map((p) => ({
    ...contractShape(p),
    layer_count: p.layer_count,
    layers_with_lines: p.layers_with_lines,
    layers_signed: p.layers_signed,
    markets: p.markets,
    lines_written: p.lines_written,
    lines_signed: p.lines_signed,
    signing_state: signingStateOf(p),
  }));
}

/** The firm order terms a layer's lines were collected against, if any. */
async function fotByLayer(layerIds) {
  if (!layerIds.length) return new Map();
  const { rows } = await query(
    `SELECT DISTINCT ON (layer_id) layer_id, id, version, status, agreed_terms, agreed_date, authorised_at
       FROM fot
      WHERE layer_id = ANY($1) AND status IN ('authorised', 'proposed')
      ORDER BY layer_id, CASE status WHEN 'authorised' THEN 0 ELSE 1 END, version DESC`,
    [layerIds],
  );
  return new Map(rows.map((f) => [f.layer_id, {
    id: f.id,
    version: f.version,
    status: f.status,
    rol: num(f.agreed_terms?.rol),
    agreed_date: isoDay(f.agreed_date),
    authorised_at: f.authorised_at,
  }]));
}

/**
 * One layer of the programme with its signings. The written line is the
 * market's; the signed line is the engine's — persisted once signing was
 * applied, otherwise the preview at the current stand set, flagged so.
 */
function layerShape(layer, position, lines, fot) {
  const active = lines
    .filter((l) => ACTIVE_LINE_STATUSES.includes(l.status))
    .sort((a, b) => Number(b.written_pct) - Number(a.written_pct) || a.market_name.localeCompare(b.market_name));
  const declined = lines.filter((l) => l.status === 'DECLINED');
  const order = Number(layer.order_pct);
  const premium100 = Number(layer.premium100);
  const applied = active.length > 0 && active.every((l) => l.status === 'SIGNED');

  const preview = computeSigning(order, active.map((l) => ({
    id: l.id, written: Number(l.written_pct), toStand: !!l.to_stand,
  })));
  const previewSigned = new Map(preview.lines.map((l) => [l.id, l.signed]));
  const previewPremium = new Map(allocatePremium(premium100, preview.lines).map((a) => [a.id, a.premiumSigned]));

  const shaped = active.map((l) => ({
    id: l.id,
    market_id: l.market_id,
    market_name: l.market_name,
    market_rating: l.market_rating || null,
    market_ref: l.market_ref || null,
    written_pct: Number(l.written_pct),
    to_stand: !!l.to_stand,
    // What the line got: only once signing was applied to it.
    signed_pct: l.status === 'SIGNED' ? num(l.signed_pct) : null,
    premium_signed: l.status === 'SIGNED' ? num(l.premium_signed) : null,
    signing_factor: l.status === 'SIGNED' ? num(l.signing_factor) : null,
    // Where the engine would land it now, at the persisted stand set.
    preview_signed_pct: previewSigned.get(l.id) ?? null,
    preview_premium: previewPremium.get(l.id) ?? null,
    status: l.status,
    notes: l.notes || null,
    bound_date: isoDay(l.bound_date),
  }));

  const writtenTotal = roundPct(shaped.reduce((a, l) => a + l.written_pct, 0));
  const signedTotal = applied ? roundPct(shaped.reduce((a, l) => a + (l.signed_pct || 0), 0)) : null;
  const premiumTotal = applied ? round2(shaped.reduce((a, l) => a + (l.premium_signed || 0), 0)) : null;
  // The factor the pro-rata signing applied — the same on every line that
  // did not stand; a client instruction has none.
  const appliedFactor = applied && layer.signing_method !== 'client_instruction'
    ? (shaped.find((l) => !l.to_stand && l.signing_factor != null)?.signing_factor ?? 1)
    : null;

  return {
    id: layer.id,
    position,
    name: layer.name,
    type: layer.type,
    attachment: num(layer.attachment),
    limit_amt: num(layer.limit_amt),
    currency: layer.currency,
    order_pct: order,
    premium100,
    brokerage_pct: num(layer.brokerage_pct) ?? 0,
    reinstatements: layer.reinstatements ?? null,
    status: layer.status,
    signing_method: layer.signing_method || null,
    fot: fot || null,
    signing: {
      applied,
      method: applied ? layer.signing_method || 'pro_rata' : null,
      written_total: writtenTotal,
      signed_total: signedTotal,
      premium_signed_total: premiumTotal,
      factor: appliedFactor,
      // The engine's read of the panel as it stands, for a layer not yet signed.
      preview: {
        state: preview.state,
        signed_total: preview.signedTotal,
        factor: preview.signingFactor,
        shortfall: preview.shortfall,
        standing_total: preview.standingTotal,
      },
    },
    lines: shaped,
    declined: declined.map((l) => ({
      id: l.id, market_id: l.market_id, market_name: l.market_name, notes: l.notes || null,
    })),
  };
}

/**
 * The programme and the signings of one contract: the placement's layers in
 * tower order, each with its firm order terms, its written and signed lines,
 * and the state of its signing — plus the same lines read by reinsurer, as a
 * signing panel across a programme is read.
 */
export async function contractSignings(placementId) {
  const { rows: found } = await query(
    `SELECT p.*, c.name AS cedant_name, c.domicile AS cedant_domicile
       FROM placement p JOIN cedant c ON c.id = p.cedant_id
      WHERE p.id = $1`,
    [placementId],
  );
  const p = found[0];
  if (!p) throw new NotFoundError('Placement');

  const { rows: layers } = await query(
    'SELECT * FROM layer WHERE placement_id = $1 ORDER BY position, created_at',
    [placementId],
  );
  const layerIds = layers.map((l) => l.id);
  const [{ rows: lines }, fots] = await Promise.all([
    layerIds.length
      ? query(
        `SELECT ln.*, m.name AS market_name, m.rating AS market_rating
           FROM line ln JOIN market m ON m.id = ln.market_id
          WHERE ln.layer_id = ANY($1)
          ORDER BY ln.written_pct DESC, m.name`,
        [layerIds],
      )
      : Promise.resolve({ rows: [] }),
    fotByLayer(layerIds),
  ]);

  const programme = layers.map((layer, i) => layerShape(
    layer, i + 1, lines.filter((l) => l.layer_id === layer.id), fots.get(layer.id) || null,
  ));

  // The panel by reinsurer: every market with an active line anywhere on the
  // programme, its line on each layer it wrote.
  const byMarket = new Map();
  for (const layer of programme) {
    for (const l of layer.lines) {
      if (!byMarket.has(l.market_id)) {
        byMarket.set(l.market_id, { market_id: l.market_id, market_name: l.market_name, market_rating: l.market_rating, lines: [] });
      }
      byMarket.get(l.market_id).lines.push({
        layer_id: layer.id,
        layer_position: layer.position,
        layer_name: layer.name,
        written_pct: l.written_pct,
        to_stand: l.to_stand,
        signed_pct: l.signed_pct,
        preview_signed_pct: l.preview_signed_pct,
        premium_signed: l.premium_signed,
        preview_premium: l.preview_premium,
        applied: layer.signing.applied,
        status: l.status,
      });
    }
  }
  const markets = [...byMarket.values()].sort((a, b) => a.market_name.localeCompare(b.market_name));

  const linesWritten = programme.reduce((n, l) => n + l.lines.filter((x) => x.status === 'WRITTEN').length, 0);
  const linesSigned = programme.reduce((n, l) => n + l.lines.filter((x) => x.status === 'SIGNED').length, 0);

  return {
    contract: contractShape(p),
    programme,
    markets,
    totals: {
      layers: programme.length,
      layers_with_lines: programme.filter((l) => l.lines.length > 0).length,
      layers_signed: programme.filter((l) => l.signing.applied).length,
      markets: markets.length,
      lines_written: linesWritten,
      lines_signed: linesSigned,
      declined: programme.reduce((n, l) => n + l.declined.length, 0),
    },
    signing_state: signingStateOf({ lines_written: linesWritten, lines_signed: linesSigned }),
  };
}
