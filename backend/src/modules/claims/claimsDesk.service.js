/*
 * The claims stage's read model: the contracts the desk can open, and
 * everything the tab shows for one — the header plate, the inbox sources
 * and the notices matched to it, the non-proportional advices with their
 * settlement figures, and the proportional bordereaux and large losses.
 * Every figure comes from the server: the ladders the XoL engine and the
 * settlement domain computed, the bordereaux as ingested.
 */

import { query } from '../../db/pool.js';
import { NotFoundError } from '../../lib/errors.js';
import { loadAccount, publicAccount } from '../../integrations/outlook.js';
import { listLosses } from './claims.service.js';
import { panelFor } from './claimAdvices.service.js';

const NP_TYPES = new Set(['XoL', 'Fac']);
const P_TYPES = new Set(['QS', 'Surplus']);
const num = (v) => (v == null || v === '' ? null : Number(v));
const isoDay = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

/** What a placement's layers make it: excess of loss, proportional, or both. */
function sectionsOf(layers) {
  const np = layers.some((l) => NP_TYPES.has(l.type));
  const p = layers.some((l) => P_TYPES.has(l.type));
  return { np, p, label: np && p ? 'Proportional + non-proportional' : np ? 'Non-proportional only' : p ? 'Proportional only' : 'No layers yet' };
}

function structureOf(layers) {
  if (!layers.length) return 'No layers';
  const counts = {};
  for (const l of layers) counts[l.type] = (counts[l.type] || 0) + 1;
  const label = (t, n) => `${n} ${t === 'XoL' ? `excess layer${n === 1 ? '' : 's'}` : t === 'QS' ? `quota share${n === 1 ? '' : 's'}` : t === 'Surplus' ? `surplus treat${n === 1 ? 'y' : 'ies'}` : `fac${n === 1 ? '' : 's'}`}`;
  return Object.entries(counts).map(([t, n]) => label(t, n)).join(' · ');
}

function contractShape(p, layers) {
  const sections = sectionsOf(layers);
  const orders = layers.map((l) => Number(l.order_pct)).filter((n) => Number.isFinite(n));
  return {
    id: p.id,
    reference: p.reference,
    name: p.treaty_type ? `${p.treaty_type} ${isoDay(p.inception)?.slice(0, 4) || ''}`.trim() : p.class,
    cedant: p.cedant_name,
    class: p.class,
    status: p.status,
    currency: p.currency,
    inception: isoDay(p.inception),
    expiry: isoDay(p.expiry),
    period: `${isoDay(p.inception)} – ${isoDay(p.expiry)}`,
    uy: isoDay(p.inception)?.slice(0, 4) || null,
    order: orders.length ? `${Math.min(...orders).toFixed(0)}%` : '—',
    structure: structureOf(layers),
    layers: layers.length,
    sections,
  };
}

/** The contracts the desk can open, matched on reference, name, cedant and class. */
export async function searchContracts(q, { limit = 25 } = {}) {
  const params = [];
  let where = 'WHERE EXISTS (SELECT 1 FROM layer ly WHERE ly.placement_id = p.id)';
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    where += ` AND (p.reference ILIKE $1 OR c.name ILIKE $1 OR p.class ILIKE $1 OR a.treaty_type ILIKE $1)`;
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT p.*, c.name AS cedant_name,
            (SELECT a2.treaty_type FROM renewal_pack_analysis a2 WHERE a2.placement_id = p.id ORDER BY a2.created_at DESC LIMIT 1) AS treaty_type
       FROM placement p
       LEFT JOIN cedant c ON c.id = p.cedant_id
       LEFT JOIN renewal_pack_analysis a ON a.placement_id = p.id
       ${where}
      GROUP BY p.id, c.name
      ORDER BY p.inception DESC, p.reference
      LIMIT $${params.length}`,
    params,
  );
  const ids = rows.map((r) => r.id);
  const { rows: layers } = ids.length
    ? await query('SELECT placement_id, type, order_pct FROM layer WHERE placement_id = ANY($1)', [ids])
    : { rows: [] };
  return rows.map((p) => contractShape(p, layers.filter((l) => l.placement_id === p.id)));
}

/** The watched sources, as they really stand on this deployment. */
async function inboxSources() {
  const account = publicAccount(await loadAccount());
  return [
    {
      key: 'broker_claims_inbox',
      box: account?.address || 'Broker claims inbox',
      note: account ? 'Connected mailbox · loss advices are read and matched on arrival' : 'No mailbox connected — advices are pasted in',
      state: account ? 'Monitored' : 'Not connected',
    },
    { key: 'cedant_claims_inbox', box: 'Cedant claims inbox', note: 'Cedant advices · matched on treaty reference, then cedant and period, then the insured schedule', state: account ? 'Monitored' : 'Via broker inbox' },
    { key: 'cedant_portal', box: 'Cedant portal', note: 'Loss advices and bordereaux', state: 'Not connected' },
  ];
}

/** How far the loss has eroded the layer it attaches to, and where the claim stands. */
function adviceRow(e, advices) {
  const ladder = e.settlement?.ladder || null;
  const attaching = ladder?.layers?.find((l) => l.loss_to_layer > 0) || null;
  const kinds = new Set(advices.filter((a) => a.loss_event_id === e.id).map((a) => a.kind));
  const cash = e.status === 'settled' ? 'Settled'
    : num(e.cash_funded) > 0 ? 'Cash call funded'
      : kinds.has('claim') ? 'Cash call issued'
        : kinds.has('preliminary') ? 'PLA sent'
          : 'Advice only';
  return {
    id: e.id,
    reference: e.reference || e.name,
    insured: e.insured || e.name,
    cause: e.cause || e.description || null,
    loss_date: isoDay(e.loss_date),
    status: e.status,
    layer: attaching?.layer_name || null,
    layer_limit: attaching?.limit ?? null,
    erosion_pct: attaching?.erosion_pct ?? null,
    incurred: num(e.gross_loss),
    paid: num(e.paid),
    outstanding: num(e.outstanding) ?? (num(e.gross_loss) != null && num(e.paid) != null ? Number(e.gross_loss) - Number(e.paid) : null),
    net_due: ladder?.net_due ?? null,
    gross_to_layer: ladder?.gross_to_layer ?? null,
    cash_status: cash,
    pla_sent: kinds.has('preliminary'),
    advice_sent: kinds.has('claim'),
  };
}

/**
 * The layer an advised reserve attaches to — the lowest excess layer it
 * exceeds — or, with no reserve advised, the cedant's own word for it.
 */
function attachesAt(parsed, layers) {
  const reserve = Number(parsed?.advised_reserve) || 0;
  const xol = layers.filter((l) => l.type === 'XoL').sort((a, b) => a.position - b.position);
  if (reserve > 0 && xol.length) {
    const hit = xol.find((l) => reserve > Number(l.attachment));
    return hit ? hit.name : 'Below the programme';
  }
  return parsed?.attaching_layer || null;
}

/** The proportional side: the bordereaux as ingested, paired premium to claims by period, and the large losses. */
async function proportional(placementId, placement) {
  const { rows: bdx } = await query(
    `SELECT id, type, source_file, period_start, period_end, row_count, summary, created_at
       FROM bordereau WHERE placement_id = $1 ORDER BY period_start, created_at`,
    [placementId],
  );
  const live = bdx.filter((b) => b.summary?.state !== 'superseded');
  // The large-loss listing is a subset of the claims bordereau, not an account of its own.
  const listing = bdx.find((b) => /large ?loss|large_loss/i.test(b.source_file || b.summary?.label || ''));
  const premiums = live.filter((b) => b.type === 'premium');
  const claims = live.filter((b) => b.type === 'claims' && b.id !== listing?.id);
  const overlaps = (a, b) => isoDay(a.period_start) <= isoDay(b.period_end) && isoDay(b.period_start) <= isoDay(a.period_end);
  const commission = (placement.quote_structures || []).map((s) => s?.prop?.commission_pct).find((c) => c != null) ?? null;
  const stateChip = (b) => {
    const state = b.summary?.state || 'reconciled';
    if (state === 'reconciled') return 'Reconciled';
    if (state === 'warnings') return 'Query raised';
    if (state === 'superseded') return 'Superseded';
    return 'Awaiting cedant';
  };
  const rows = claims.map((b) => {
    const premium = premiums.filter((p) => overlaps(p, b)).reduce((t, p) => t + (p.summary?.premium || 0), 0);
    const incurred = b.summary?.incurred || 0;
    return {
      id: b.id,
      section: b.summary?.label || b.source_file || 'Claims bordereau',
      period: `${isoDay(b.period_start)} – ${isoDay(b.period_end)}`,
      premium_ceded: premium || null,
      claims_paid: b.summary?.paid ?? null,
      outstanding: b.summary?.outstanding ?? null,
      loss_ratio_pct: premium > 0 ? Math.round((incurred / premium) * 1000) / 10 : null,
      commission_pct: commission,
      status: stateChip(b),
      rows: b.row_count,
    };
  });
  const premiumOnly = premiums.filter((p) => !claims.some((c) => overlaps(c, p))).map((p) => ({
    id: p.id,
    section: p.summary?.label || p.source_file || 'Premium bordereau',
    period: `${isoDay(p.period_start)} – ${isoDay(p.period_end)}`,
    premium_ceded: p.summary?.premium ?? null,
    claims_paid: null, outstanding: null, loss_ratio_pct: null, commission_pct: commission,
    status: stateChip(p), rows: p.row_count,
  }));

  const year = isoDay(placement.inception)?.slice(0, 4);
  const inYear = (b) => !year || isoDay(b.period_end)?.startsWith(year) || isoDay(b.period_start)?.startsWith(year);
  const premiumYtd = premiums.filter(inYear).reduce((t, p) => t + (p.summary?.premium || 0), 0);
  const paidYtd = claims.filter(inYear).reduce((t, c) => t + (c.summary?.paid || 0), 0);
  const osYtd = claims.filter(inYear).reduce((t, c) => t + (c.summary?.outstanding || 0), 0);
  const incurredYtd = claims.filter(inYear).reduce((t, c) => t + (c.summary?.incurred || 0), 0);
  const unreconciled = live.filter((b) => (b.summary?.state || 'reconciled') !== 'reconciled').length;

  // The large losses: the listing's rows over the threshold.
  let large = [];
  const threshold = 5000000;
  if (listing) {
    const { rows: full } = await query('SELECT parsed_rows FROM bordereau WHERE id = $1', [listing.id]);
    large = (full[0]?.parsed_rows || [])
      .filter((r) => r.event && !/attritional/i.test(r.event) && Number(r.fgu || r.gross || 0) >= threshold)
      .map((r) => ({
        reference: r.claim_ref || r.reference || r.ref || null,
        insured: r.insured || r.event,
        cause: r.peril || r.cause || null,
        loss_date: isoDay(r.date || r.loss_date),
        section: listing.summary?.label || 'Large loss listing',
        gross: num(r.fgu ?? r.gross),
        ceded: num(r.ceded ?? r.to_layer_2 ?? r.to_layer),
        status: r.status || null,
      }))
      .sort((a, b) => (b.gross || 0) - (a.gross || 0));
  }

  return {
    kpis: {
      sections: (placement.layers || []).filter((l) => P_TYPES.has(l.type)).length,
      premium_ceded_ytd: premiumYtd,
      claims_paid_ytd: paidYtd,
      outstanding_ytd: osYtd,
      blended_loss_ratio_pct: premiumYtd > 0 ? Math.round((incurredYtd / premiumYtd) * 1000) / 10 : null,
      unreconciled,
      year,
    },
    bordereaux: [...rows, ...premiumOnly],
    large_losses: large,
    large_loss_threshold: threshold,
    has_listing: Boolean(listing),
  };
}

/** Everything the claims tab shows for one contract. */
export async function contractContext(placementId) {
  const { rows } = await query(
    `SELECT p.*, c.name AS cedant_name,
            (SELECT a.treaty_type FROM renewal_pack_analysis a WHERE a.placement_id = p.id ORDER BY a.created_at DESC LIMIT 1) AS treaty_type
       FROM placement p LEFT JOIN cedant c ON c.id = p.cedant_id WHERE p.id = $1`,
    [placementId],
  );
  if (!rows[0]) throw new NotFoundError('Contract');
  const placement = rows[0];
  const { rows: layers } = await query('SELECT * FROM layer WHERE placement_id = $1 ORDER BY position, created_at', [placementId]);
  const contract = contractShape(placement, layers);

  const [events, advicesRes, notificationsRes] = await Promise.all([
    listLosses(placementId),
    query(`SELECT a.id, a.loss_event_id, a.kind, a.sent_at, a.delivered FROM claim_advice a JOIN loss_event e ON e.id = a.loss_event_id WHERE e.placement_id = $1`, [placementId]),
    query(
      `SELECT n.*, p.reference AS placement_reference FROM claim_notification n LEFT JOIN placement p ON p.id = n.placement_id
        WHERE n.status <> 'loaded' AND (n.placement_id = $1 OR (n.placement_id IS NULL AND n.parsed->'suggestion'->>'placement_id' = $1::text))
        ORDER BY n.received_at DESC`,
      [placementId],
    ),
  ]);
  const advices = advicesRes.rows;
  const advicesTable = events.map((e) => adviceRow(e, advices));
  const open = advicesTable.filter((r) => r.status !== 'settled');
  // The panel the advices go to: every market with a signed line on any layer.
  const panel = contract.sections.np ? await panelFor(placementId) : [];

  const np = contract.sections.np ? {
    inbox: await inboxSources(),
    notifications: notificationsRes.rows.map((n) => ({
      id: n.id,
      status: n.status,
      subject: n.subject,
      sender: n.sender,
      received_at: n.received_at,
      source: n.source,
      parsed: n.parsed,
      match_basis: n.match_basis || n.parsed?.suggestion?.basis || null,
      match_confidence: n.match_confidence != null ? Number(n.match_confidence) : n.parsed?.suggestion?.confidence ?? null,
      matched: n.status === 'matched',
      notes: n.notes,
      attaches: attachesAt(n.parsed, layers),
    })),
    panel,
    panel_size: panel.length,
    kpis: {
      open: open.length,
      incurred: open.reduce((t, r) => t + (r.incurred || 0), 0),
      cash_calls: open.filter((r) => r.cash_status === 'Cash call funded' || r.net_due > 0).length,
      incurred_to_layers: open.reduce((t, r) => t + (r.gross_to_layer || 0), 0),
      paid: advicesTable.reduce((t, r) => t + (r.paid || 0), 0),
      net_due: open.reduce((t, r) => t + (r.net_due || 0), 0),
      layers_reached: [...new Set(open.map((r) => r.layer).filter(Boolean))],
    },
    advices: advicesTable,
  } : null;

  const p = contract.sections.p ? await proportional(placementId, { ...placement, layers }) : null;

  const basis = contract.sections.np && contract.sections.p ? 'both' : contract.sections.np ? 'np' : contract.sections.p ? 'p' : 'none';
  return {
    contract,
    basis,
    written_as: basis === 'np' ? 'excess of loss only' : basis === 'p' ? 'a proportional treaty only' : basis === 'both' ? 'both proportional and excess of loss' : 'no layers yet',
    np,
    p,
  };
}
