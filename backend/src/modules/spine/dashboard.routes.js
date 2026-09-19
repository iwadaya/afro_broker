import { Router } from 'express';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';
import { brokerageByCurrency } from '../../domain/brokerage.js';
import { fromMinor } from '../../lib/money.js';

/**
 * M10 — the home dashboard over the spine.
 *
 * "Real-time summaries: quotes, FOTs, written lines, signed lines, brokerage.
 * Upcoming renewals with lead time to inception." And, per M10's closing
 * instruction, everything here is computed from queries against the spine —
 * no denormalised counters exist to drift out of agreement with the book.
 *
 * The pre-spine dashboards (/dashboards/metrics et al.) keep serving the old
 * placement book; this endpoint serves the contract-year spine.
 */
const router = Router();
router.use(authenticate);

router.get(
  '/dashboards/spine',
  asyncHandler(async (req, res) => {
    const windowDays = Math.min(Math.max(Number(req.query.days) || 120, 1), 365);

    // M6 outcomes, as recorded — including the silences.
    const { rows: outcomes } = await query(
      'SELECT outcome, COUNT(*)::int AS n FROM structure_response GROUP BY outcome',
    );

    // Structures with live firm order terms.
    const { rows: fots } = await query(
      "SELECT COUNT(DISTINCT structure_id)::int AS n FROM structure_version WHERE status = 'FOT'",
    );

    // Participations on the book.
    const { rows: lineCounts } = await query(
      `SELECT COUNT(*) FILTER (WHERE status = 'WRITTEN')::int AS written,
              COUNT(*) FILTER (WHERE status = 'SIGNED')::int AS signed
       FROM structure_line`,
    );

    // D2 — brokerage from the stored signed allocations, with the rate read
    // from the FOT version's terms so it is the rate the lines were written
    // against, not whatever the structure says today.
    const { rows: brokerageRows } = await query(
      `SELECT l.premium_signed_minor, l.premium_currency,
              (sv.terms->>'brokerage_pct')::float8 AS brokerage_pct
       FROM structure_line l
       JOIN structure_version sv ON sv.id = l.structure_version_id
       WHERE l.status = 'SIGNED' AND l.premium_signed_minor IS NOT NULL`,
    );
    const brokerage = brokerageByCurrency(brokerageRows.map((r) => ({
      premiumSignedMinor: Number(r.premium_signed_minor),
      brokeragePct: r.brokerage_pct ?? 0,
      currency: r.premium_currency,
    }))).map((b) => ({
      currency: b.currency,
      amount_minor: b.brokerageMinor,
      amount: fromMinor(b.brokerageMinor, b.currency),
    }));

    // Upcoming renewals with lead time to inception (M10).
    const { rows: upcoming } = await query(
      `SELECT cy.id AS contract_year_id, cy.year_label, cy.inception,
              (cy.inception - CURRENT_DATE)::int AS days_to_inception,
              c.name AS contract_name, ced.name AS cedant_name
       FROM contract_year cy
       JOIN contract c ON c.id = cy.contract_id
       JOIN cedant ced ON ced.id = c.cedant_id
       WHERE cy.inception >= CURRENT_DATE
       ORDER BY cy.inception
       LIMIT 20`,
    );

    // Years expiring inside the window with no successor on the chain: a
    // renewal that has not been started. Derived from prior_contract_year_id
    // (§1.1), never typed in.
    const { rows: renewalsNotStarted } = await query(
      `SELECT cy.id AS contract_year_id, cy.year_label, cy.expiry,
              (cy.expiry - CURRENT_DATE)::int AS days_to_expiry,
              c.name AS contract_name, ced.name AS cedant_name
       FROM contract_year cy
       JOIN contract c ON c.id = cy.contract_id
       JOIN cedant ced ON ced.id = c.cedant_id
       WHERE cy.expiry >= CURRENT_DATE
         AND cy.expiry <= CURRENT_DATE + $1::int
         AND NOT EXISTS (
           SELECT 1 FROM contract_year nxt WHERE nxt.prior_contract_year_id = cy.id
         )
       ORDER BY cy.expiry`,
      [windowDays],
    );

    res.json({
      responses: {
        by_outcome: Object.fromEntries(outcomes.map((o) => [o.outcome, o.n])),
        total: outcomes.reduce((n, o) => n + o.n, 0),
      },
      fot_structures: fots[0].n,
      lines: { written: lineCounts[0].written, signed: lineCounts[0].signed },
      brokerage,
      upcoming_renewals: upcoming,
      renewals_not_started: { window_days: windowDays, years: renewalsNotStarted },
    });
  }),
);

export default router;
