import { Router } from 'express';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';

const router = Router();
router.use(authenticate);

// Aggregate each ledger separately before joining: a claim must never be
// multiplied by its layer count, instalments, panel size or PLA resend count.
export const servicingSql = `
WITH placed_layers AS (
  SELECT l.* FROM layer l
  WHERE l.type = 'XoL' AND (l.status IN ('SIGNED','BOUND','CLOSED')
    OR EXISTS (SELECT 1 FROM line li WHERE li.layer_id = l.id
      AND li.status = 'SIGNED' AND li.signed_pct > 0))
), confirmed_np AS (
  SELECT f.placement_id, COUNT(*)::int AS term_count
  FROM final_placement f CROSS JOIN LATERAL jsonb_array_elements(f.terms) t
  WHERE f.status = 'confirmed' AND t->>'basis' = 'NP'
    AND EXISTS (SELECT 1 FROM final_placement_line fl WHERE fl.final_placement_id = f.id
      AND fl.term_key = t->>'key' AND fl.status = 'signed' AND fl.signed_pct > 0)
  GROUP BY f.placement_id
), latest_pla AS (
  SELECT DISTINCT ON (a.loss_event_id) a.loss_event_id, a.breakdown
  FROM claim_advice a WHERE a.kind = 'preliminary' AND a.delivered > 0
  ORDER BY a.loss_event_id, a.sent_at DESC, a.id DESC
)
SELECT p.id, p.reference, p.class, p.inception, p.expiry, p.currency,
       c.name AS cedant_name, c.domicile AS country,
       GREATEST((SELECT COUNT(*)::int FROM placed_layers l WHERE l.placement_id = p.id), COALESCE(f.term_count,0)) AS layer_count,
       COALESCE(prem.balances, '[]'::jsonb) AS premiums,
       COALESCE(cl.reported_count, 0)::int AS reported_count,
       COALESCE(cl.reported_amount, 0) AS reported_amount,
       COALESCE(cl.pla_count, 0)::int AS pla_count,
       COALESCE(cl.pla_amount, 0) AS pla_amount,
       (CURRENT_DATE >= (p.inception + INTERVAL '12 months')::date AND CURRENT_DATE > p.expiry
        AND NOT EXISTS (SELECT 1 FROM premium_workflow w WHERE w.placement_id=p.id AND w.kind='adjustment' AND w.status='issued')) AS adjustment_due
FROM placement p JOIN cedant c ON c.id = p.cedant_id
LEFT JOIN confirmed_np f ON f.placement_id = p.id
LEFT JOIN LATERAL (
  SELECT jsonb_agg(b) AS balances FROM (
    SELECT currency,MAX(layers)::int AS layers,SUM(scheduled_layers)::int AS scheduled_layers,SUM(paid) AS paid,SUM(due) AS due,SUM(upcoming) AS upcoming,SUM(accounts_due)::int AS accounts_due,MIN(next_due) AS next_due FROM (
    SELECT l.currency,
      COUNT(DISTINCT l.id)::int AS layers,
      COUNT(DISTINCT m.layer_id)::int AS scheduled_layers,
      COALESCE(SUM(n.gross_amount) FILTER (WHERE n.status = 'paid'),0) AS paid,
      COALESCE(SUM(n.gross_amount) FILTER (WHERE n.status <> 'paid' AND n.due_date <= CURRENT_DATE),0) AS due,
      COALESCE(SUM(n.gross_amount) FILTER (WHERE n.status <> 'paid' AND n.due_date > CURRENT_DATE),0) AS upcoming,
      COUNT(n.id) FILTER (WHERE n.status <> 'paid' AND n.due_date <= CURRENT_DATE)::int AS accounts_due,
      MIN(n.due_date) FILTER (WHERE n.status <> 'paid') AS next_due
    FROM placed_layers l
    LEFT JOIN mdp m ON m.layer_id = l.id AND m.status = 'issued'
    LEFT JOIN mdp_debit_note n ON n.mdp_id = m.id
    WHERE l.placement_id = p.id GROUP BY l.currency
    UNION ALL
    SELECT n.currency,COUNT(DISTINCT n.layer_key)::int,
      0::int,
      COALESCE(SUM(n.gross_amount) FILTER (WHERE n.paid_at IS NOT NULL),0),
      COALESCE(SUM(n.gross_amount) FILTER (WHERE n.paid_at IS NULL AND n.due_date<=CURRENT_DATE),0),
      COALESCE(SUM(n.gross_amount) FILTER (WHERE n.paid_at IS NULL AND n.due_date>CURRENT_DATE),0),
      COUNT(*) FILTER (WHERE n.paid_at IS NULL AND n.due_date<=CURRENT_DATE)::int,
      MIN(n.due_date) FILTER (WHERE n.paid_at IS NULL)
    FROM premium_note n JOIN premium_workflow w ON w.id=n.workflow_id
    WHERE w.placement_id=p.id AND w.status='issued' AND n.kind='debit' GROUP BY n.currency
    UNION ALL
    SELECT l->>'currency',COUNT(*)::int,COUNT(*) FILTER (WHERE NOT COALESCE((l->>'already_billed')::boolean,false))::int,0,0,0,0,NULL::date
    FROM premium_workflow w CROSS JOIN LATERAL jsonb_array_elements(w.snapshot->'layers') l
    WHERE w.placement_id=p.id AND w.kind='mdp' AND w.status='issued' GROUP BY l->>'currency'
    ) raw_balances GROUP BY currency
  ) b
) prem ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS reported_count, SUM(e.gross_loss) AS reported_amount,
    COUNT(a.loss_event_id) AS pla_count,
    SUM(COALESCE((a.breakdown->>'reserve')::numeric,0)) FILTER (WHERE a.loss_event_id IS NOT NULL) AS pla_amount
  FROM loss_event e LEFT JOIN latest_pla a ON a.loss_event_id = e.id
  WHERE e.placement_id = p.id
) cl ON TRUE
WHERE f.placement_id IS NOT NULL OR EXISTS (SELECT 1 FROM placed_layers l WHERE l.placement_id = p.id)
ORDER BY p.inception DESC, c.name, p.reference`;

router.get('/servicing/non-proportional', asyncHandler(async (_req, res) => {
  const { rows } = await query(servicingSql);
  res.json({ as_of: new Date().toISOString(), treaties: rows, adjustment_calculations_due: rows.filter(r=>r.adjustment_due).length });
}));
export default router;
