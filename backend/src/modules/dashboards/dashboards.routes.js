import { Router } from 'express';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';

const router = Router();
router.use(authenticate);

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/** Sum a `{currency, amount}` row set into a total plus a per-currency map. */
function money(rows, field = 'amount') {
  const by_currency = {};
  let total = 0;
  for (const r of rows) {
    const amount = round2(r[field]);
    if (!amount) continue;
    by_currency[r.currency] = round2((by_currency[r.currency] || 0) + amount);
    total += amount;
  }
  return { total: round2(total), by_currency };
}

/**
 * The book's headline metrics — the KPI row the dashboard leads with.
 *
 * Definitions are spelled out because "premium" means several different things
 * in a broking book:
 *  - quoted premium      Sum of the premium on *live* quotes (active or
 *                        accepted); a superseded or withdrawn quote is not a
 *                        quote we hold. A quote priced on rate on line alone
 *                        carries no premium figure and cannot contribute —
 *                        `quotes_without_premium` says how many those are, so
 *                        the total is never silently understated. Premium is
 *                        not derived from the rate: the book keeps no
 *                        convention for it, and guessing would misstate the
 *                        one number this metric exists to report.
 *  - lead/follow quotes  How many of those live quotes sit on an approach made
 *                        in that role.
 *  - markets won         An approach that converted into a line we hold
 *                        (WRITTEN or SIGNED), counted per layer x market and
 *                        split by the role the market was approached in.
 *  - cedants             The register count, plus how many have a placement.
 *  - premium seen        Sum of layer premium at 100% across every placement —
 *                        the premium that has crossed the desk.
 *  - premium placed      Sum of the signed premium on signed lines — what we
 *                        actually put into the market.
 *
 * Money is summed across currencies for the headline *and* broken out per
 * currency, because the book holds no FX rates: the UI shows the split beside
 * the total so a mixed book is never passed off as one number.
 */
router.get(
  '/metrics',
  asyncHandler(async (_req, res) => {
    const [quotes, won, cedants, seen, placed] = await Promise.all([
      query(
        `SELECT ly.currency,
                COALESCE(SUM(q.premium), 0)                AS amount,
                COUNT(*)                                   AS quotes,
                COUNT(*) FILTER (WHERE a.role = 'lead')    AS lead_quotes,
                COUNT(*) FILTER (WHERE a.role = 'follow')  AS follow_quotes,
                COUNT(*) FILTER (WHERE q.premium IS NULL)  AS without_premium
         FROM quote q
         JOIN approach a ON a.id = q.approach_id
         JOIN layer ly   ON ly.id = a.layer_id
         WHERE q.status IN ('active', 'accepted')
         GROUP BY ly.currency`,
      ),
      query(
        `SELECT a.role,
                COUNT(*)                     AS lines_won,
                COUNT(DISTINCT li.market_id) AS markets
         FROM line li
         JOIN approach a ON a.layer_id = li.layer_id AND a.market_id = li.market_id
         WHERE li.status IN ('WRITTEN', 'SIGNED')
         GROUP BY a.role`,
      ),
      query(
        `SELECT (SELECT COUNT(*) FROM cedant)::int AS total,
                (SELECT COUNT(DISTINCT cedant_id) FROM placement)::int AS with_placements`,
      ),
      query(
        `SELECT currency, COALESCE(SUM(premium100), 0) AS amount, COUNT(*)::int AS layers
         FROM layer GROUP BY currency`,
      ),
      query(
        `SELECT ly.currency, COALESCE(SUM(li.premium_signed), 0) AS amount, COUNT(*)::int AS lines
         FROM line li JOIN layer ly ON ly.id = li.layer_id
         WHERE li.status = 'SIGNED'
         GROUP BY ly.currency`,
      ),
    ]);

    const role = (r) => won.rows.find((w) => w.role === r) || {};
    const quotedPremium = money(quotes.rows);
    const premiumSeen = money(seen.rows);
    const premiumPlaced = money(placed.rows);
    const sum = (field) => quotes.rows.reduce((a, r) => a + Number(r[field]), 0);

    res.json({
      quoted_premium: quotedPremium,
      lead_quotes: sum('lead_quotes'),
      follow_quotes: sum('follow_quotes'),
      quotes_total: sum('quotes'),
      // A quote priced on rate alone carries no premium figure, so it cannot
      // add to quoted premium. Reported so an understated total explains
      // itself rather than reading as "nobody quoted".
      quotes_without_premium: sum('without_premium'),
      lead_markets_won: Number(role('lead').lines_won || 0),
      lead_markets_won_distinct: Number(role('lead').markets || 0),
      follow_markets_won: Number(role('follow').lines_won || 0),
      follow_markets_won_distinct: Number(role('follow').markets || 0),
      cedants: cedants.rows[0].total,
      cedants_with_placements: cedants.rows[0].with_placements,
      total_premium_seen: premiumSeen,
      total_premium_placed: premiumPlaced,
      placed_ratio_pct: premiumSeen.total > 0
        ? round2((premiumPlaced.total / premiumSeen.total) * 100)
        : null,
      layers: seen.rows.reduce((a, r) => a + r.layers, 0),
      signed_lines: placed.rows.reduce((a, r) => a + r.lines, 0),
    });
  }),
);

// Per-layer placement progress: % written and % signed against the order.
router.get(
  '/placements/:placementId/progress',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT l.id, l.name, l.order_pct, l.status,
              COALESCE(SUM(li.written_pct) FILTER (WHERE li.status IN ('WRITTEN','SIGNED')),0) AS written_total,
              COALESCE(SUM(li.signed_pct) FILTER (WHERE li.status = 'SIGNED'),0) AS signed_total
       FROM layer l LEFT JOIN line li ON li.layer_id = l.id
       WHERE l.placement_id = $1
       GROUP BY l.id ORDER BY l.position`,
      [req.params.placementId],
    );
    res.json(rows.map((r) => {
      const order = Number(r.order_pct);
      const written = Number(r.written_total);
      const signed = Number(r.signed_total);
      return {
        layer_id: r.id,
        name: r.name,
        status: r.status,
        order_pct: order,
        written_total: Math.round(written * 1e4) / 1e4,
        signed_total: Math.round(signed * 1e4) / 1e4,
        pct_placed: order > 0 ? Math.round((written / order) * 1e4) / 1e2 : null,
        oversubscribed: written > order,
        shortfall: written < order ? Math.round((order - written) * 1e4) / 1e4 : 0,
      };
    }));
  }),
);

// Outstanding work: active quotes, open subjectivities, and the counts the
// dashboard's outstanding panel lists (packs awaiting approval, quotes past
// validity, wording changes in review).
router.get(
  '/outstanding',
  asyncHandler(async (_req, res) => {
    const { rows: quotes } = await query(
      `SELECT q.id AS quote_id, q.type, a.layer_id, m.name AS market_name, q.validity
       FROM quote q JOIN approach a ON a.id = q.approach_id JOIN market m ON m.id = a.market_id
       WHERE q.status = 'active' ORDER BY q.validity NULLS LAST`,
    );
    const { rows: subs } = await query(
      `SELECT s.id, s.text, q.id AS quote_id, a.layer_id
       FROM subjectivity s JOIN quote q ON q.id = s.quote_id JOIN approach a ON a.id = q.approach_id
       WHERE NOT s.resolved ORDER BY s.created_at`,
    );
    const { rows: amendments } = await query(
      `SELECT am.id, am.placement_id, am.type, am.title, am.effective_date, am.created_at,
              p.reference AS placement_reference
       FROM amendment am JOIN placement p ON p.id = am.placement_id
       WHERE am.status = 'outstanding' ORDER BY am.created_at`,
    );
    const { rows: packRows } = await query(
      "SELECT COUNT(*)::int AS n FROM renewal_pack WHERE status = 'submitted'",
    );
    const { rows: pastRows } = await query(
      `SELECT COUNT(*)::int AS n, MIN(m.name) AS example
       FROM quote q JOIN approach a ON a.id = q.approach_id JOIN market m ON m.id = a.market_id
       WHERE q.status = 'active' AND q.validity IS NOT NULL AND q.validity < CURRENT_DATE`,
    );
    // Library clauses still being drafted — the wording changes an underwriter
    // has yet to sign off.
    const { rows: wordRows } = await query(
      `SELECT COUNT(*)::int AS n, COALESCE(string_agg(title, ', ' ORDER BY title), '') AS names
       FROM wording_clause WHERE status = 'draft'`,
    );
    res.json({
      outstanding_quotes: quotes,
      open_subjectivities: subs,
      outstanding_amendments: amendments,
      counts: {
        packs_awaiting_approval: packRows[0].n,
        quotes_past_validity: pastRows[0].n,
        quotes_past_validity_example: pastRows[0].example,
        open_subjectivities: subs.length,
        outstanding_amendments: amendments.length,
        wording_in_review: wordRows[0].n,
        wording_in_review_names: wordRows[0].names,
      },
    });
  }),
);

// Renewal calendar: placements renewing within a window (default 90 days, or
// `months=N` for a calendar-month window) — an in-force treaty expiring in the
// window, or a new-period placement already being worked that incepts in it.
// `renews_on` is the in-window date.
//
// Each row also carries what the calendar page shows per renewal:
//  - cedant country/region  Country is the cedant's domicile; region comes from
//                           its register entry (the insurer side of the market
//                           register), where the territory grouping lives.
//  - treaty_types           Distinct layer types on the placement (QS/Surplus/
//                           XoL/Fac) — one placement can carry both bases.
//  - current_leader         The lead-role market that is furthest along
//                           (signed > written > agreed > quoted > approached);
//                           a declined lead never counts as leading.
//  - broker_role            Lead when the broker is mandated to place the full
//                           order on every layer (order_pct = 100), Follow when
//                           it holds only a share of the order (§1.4). Null
//                           until the placement has a layer to read it from.
//  - order_share_pct        The broker's share of the programme — order_pct
//                           weighted by layer premium (plain average when no
//                           premium is recorded yet).
//  - total_premium100       Sum of layer premium at 100% across the placement.
//  - brokerage_pct          Brokerage on that premium, premium-weighted the
//                           same way. Null until a layer records it.
router.get(
  '/renewal-calendar',
  asyncHandler(async (req, res) => {
    const months = req.query.months
      ? Math.min(Math.max(Number(req.query.months) || 0, 1), 24)
      : null;
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
    const window = months ? `${months} months` : `${days} days`;
    const { rows } = await query(
      `SELECT p.id, p.reference, p.class, p.inception, p.expiry, p.est_gwp,
              p.status, p.currency,
              c.name AS cedant_name, c.domicile AS cedant_country,
              reg.region AS cedant_region,
              CASE WHEN p.inception BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::interval
                   THEN p.inception ELSE p.expiry END AS renews_on,
              ly.treaty_types, ly.layer_count, ly.total_premium100,
              ly.order_share_pct, ly.brokerage_pct, ly.full_order,
              leader.name AS current_leader
       FROM placement p
       JOIN cedant c ON c.id = p.cedant_id
       LEFT JOIN market reg ON reg.id = c.market_id
       LEFT JOIN LATERAL (
         SELECT string_agg(DISTINCT l.type, ' + ' ORDER BY l.type) AS treaty_types,
                COUNT(*)::int AS layer_count,
                SUM(l.premium100) AS total_premium100,
                CASE WHEN SUM(l.premium100) > 0
                     THEN SUM(l.order_pct * l.premium100) / SUM(l.premium100)
                     ELSE AVG(l.order_pct) END AS order_share_pct,
                CASE WHEN SUM(l.premium100) > 0
                     THEN SUM(l.brokerage_pct * l.premium100) / SUM(l.premium100)
                     ELSE AVG(l.brokerage_pct) END AS brokerage_pct,
                BOOL_AND(l.order_pct >= 100) AS full_order
         FROM layer l WHERE l.placement_id = p.id
       ) ly ON TRUE
       LEFT JOIN LATERAL (
         SELECT m.name
         FROM approach a
         JOIN layer al ON al.id = a.layer_id
         JOIN market m ON m.id = a.market_id
         WHERE al.placement_id = p.id AND a.role = 'lead' AND a.status <> 'DECLINED'
         ORDER BY array_position(
                    ARRAY['SIGNED','WRITTEN','AGREED','QUOTED','APPROACHED'], a.status),
                  a.sent_date DESC NULLS LAST
         LIMIT 1
       ) leader ON TRUE
       WHERE (p.expiry BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::interval
              OR p.inception BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::interval)
         AND p.status NOT IN ('BOUND','DECLINED','NTU','LAPSED')
       ORDER BY renews_on, p.est_gwp DESC NULLS LAST, p.reference`,
      [window],
    );
    const num = (v) => (v == null ? null : round2(v));
    res.json({
      window_days: months ? null : days,
      window_months: months,
      renewals: rows.map((r) => ({
        ...r,
        est_gwp: r.est_gwp == null ? null : Number(r.est_gwp),
        total_premium100: num(r.total_premium100),
        order_share_pct: num(r.order_share_pct),
        brokerage_pct: num(r.brokerage_pct),
        broker_role: r.layer_count > 0 ? (r.full_order ? 'Lead' : 'Follow') : null,
      })),
    });
  }),
);

// Brokerage: what the broker earns on each signed/bound layer, per currency.
router.get(
  '/brokerage',
  asyncHandler(async (_req, res) => {
    const { rows } = await query(
      `SELECT l.id AS layer_id, l.name AS layer_name, l.status, l.currency, l.brokerage_pct,
              l.signing_method, p.id AS placement_id, p.reference, p.class, c.name AS cedant_name,
              COALESCE(SUM(li.signed_pct) FILTER (WHERE li.status = 'SIGNED'),0) AS signed_total,
              COALESCE(SUM(li.premium_signed) FILTER (WHERE li.status = 'SIGNED'),0) AS premium_signed,
              COALESCE(SUM(li.brokerage_amount) FILTER (WHERE li.status = 'SIGNED'),0) AS brokerage
       FROM layer l
       JOIN placement p ON p.id = l.placement_id
       JOIN cedant c ON c.id = p.cedant_id
       LEFT JOIN line li ON li.layer_id = l.id
       WHERE l.status IN ('SIGNED','BOUND','CLOSED')
       GROUP BY l.id, p.id, c.name
       ORDER BY p.reference, l.position`,
    );
    const layers = rows.map((r) => ({
      ...r,
      brokerage_pct: Number(r.brokerage_pct),
      signed_total: Math.round(Number(r.signed_total) * 1e4) / 1e4,
      premium_signed: Math.round(Number(r.premium_signed) * 100) / 100,
      brokerage: Math.round(Number(r.brokerage) * 100) / 100,
    }));
    const byCurrency = {};
    for (const l of layers) {
      const bucket = byCurrency[l.currency] || { premium_signed: 0, brokerage: 0, layers: 0 };
      bucket.premium_signed = Math.round((bucket.premium_signed + l.premium_signed) * 100) / 100;
      bucket.brokerage = Math.round((bucket.brokerage + l.brokerage) * 100) / 100;
      bucket.layers += 1;
      byCurrency[l.currency] = bucket;
    }
    res.json({ layers, by_currency: byCurrency });
  }),
);

export default router;
