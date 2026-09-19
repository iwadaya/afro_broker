import { query, withTransaction } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { calculateClaim, validateClaim } from '../../domain/claimsAccounting.js';
import { dateOnly } from '../../domain/premiumAccounting.js';
import { createPremiumService } from '../premium/premium.service.js';
import { loadClaimSource } from './claimsWorkspace.source.js';

export function createClaimsWorkspaceService({ db = { query }, transaction = withTransaction } = {}) {
  const reviewRoles = ['senior_broker', 'underwriter', 'admin'];
  const log = (client, id, action, user, detail = {}) => audit({ entityType: 'loss_event', entityId: id, action, userId: user.id, detail }, client);
  const find = async (client, id, lock = false) => {
    const w = (await client.query(`SELECT w.*,e.placement_id,e.created_at,e.workspace_claim FROM claim_workflow w JOIN loss_event e ON e.id=w.loss_event_id WHERE w.loss_event_id=$1${lock ? ' FOR UPDATE OF w,e' : ''}`, [id])).rows[0];
    if (!w) throw new NotFoundError('Claim workflow');
    return w;
  };
  const eventOf = w => ({ id: w.loss_event_id, created_at: w.created_at });
  async function activeRole(client, user, roles) {
    const r = (await client.query('SELECT id FROM users WHERE id=$1 AND active AND role=ANY($2::text[])', [user.id, roles])).rows[0];
    if (!r) throw new ForbiddenError('An active authorised user is required');
  }
  async function contracts() {
    const rows = await createPremiumService({ db, transaction }).contracts();
    const pending = (await db.query("SELECT DISTINCT e.placement_id FROM claim_workflow w JOIN loss_event e ON e.id=w.loss_event_id WHERE w.status='submitted'")).rows;
    return rows.map(r => ({ ...r, awaiting_review: pending.some(p => p.placement_id === r.id) }));
  }
  async function workspace(id) {
    const p = (await db.query('SELECT inception FROM placement WHERE id=$1', [id])).rows[0];
    if (!p) throw new NotFoundError('Contract');
    const source = await loadClaimSource(db, id, { loss_date: dateOnly(p.inception) });
    const claims = (await db.query(`SELECT e.id,e.name,e.reference,e.loss_date,e.gross_loss,e.paid,e.outstanding,e.workspace_claim,
      COALESCE(w.status,e.status) AS status,w.reviewer_id,u.name AS preparer_name
      FROM loss_event e LEFT JOIN claim_workflow w ON w.loss_event_id=e.id LEFT JOIN users u ON u.id=e.created_by
      WHERE e.placement_id=$1 ORDER BY e.loss_date DESC,e.created_at DESC,e.id`, [id])).rows;
    const reviewers = (await db.query('SELECT id,name,role FROM users WHERE active AND role=ANY($1::text[]) ORDER BY name,id', [reviewRoles])).rows;
    return { ...source, claims: claims.map(c => ({ ...c, loss_date: dateOnly(c.loss_date) })), reviewers };
  }
  async function detail(id) {
    const w = await find(db, id);
    const history = (await db.query('SELECT r.*,u.name AS approver_name FROM claim_workflow_revision r JOIN users u ON u.id=r.approved_by WHERE r.loss_event_id=$1 ORDER BY r.revision DESC', [id])).rows;
    try {
      const src = await loadClaimSource(db, w.placement_id, w.input, eventOf(w));
      return { ...w, history, stale: src.source_hash !== w.source_hash };
    } catch (e) { return { ...w, history, stale: true, stale_reason: e.message }; }
  }
  async function preview(placementId, input, id = null, client = db) {
    const existing = id ? (await client.query('SELECT id,created_at,placement_id FROM loss_event WHERE id=$1', [id])).rows[0] : null;
    if (existing && existing.placement_id !== placementId) throw new ConflictError('This claim belongs to another contract');
    const src = await loadClaimSource(client, placementId, input, existing);
    return { ...calculateClaim({ ...src, input }), source: src.source, source_hash: src.source_hash };
  }
  async function save(id, placementId, input, revision, user) {
    return transaction(async client => {
      await activeRole(client, user, ['broker', 'senior_broker', 'admin']);
      const p = (await client.query('SELECT * FROM placement WHERE id=$1 FOR UPDATE', [placementId])).rows[0];
      if (!p) throw new NotFoundError('Contract');
      const event = (await client.query('SELECT * FROM loss_event WHERE id=$1 FOR UPDATE', [id])).rows[0];
      let w;
      if (event) {
        if (event.placement_id !== placementId || !event.workspace_claim) throw new ConflictError('Use this claim’s original workspace');
        w = await find(client, id, true);
        if (w.created_by !== user.id || w.status !== 'draft') throw new ConflictError('Only the preparer can edit a draft; submitted and approved claims are locked');
        if (w.revision !== revision) throw new ConflictError('This draft was updated elsewhere. Reload it before saving');
      } else if (revision !== 0) throw new ConflictError('This claim no longer exists; start a new claim');
      const clean = validateClaim(input, p);
      // New claims, including backdated claims, must not alter an approved
      // later claim's aggregate allocation. Same-day entries follow save order.
      const from = event && dateOnly(event.loss_date) < clean.loss_date ? dateOnly(event.loss_date) : clean.loss_date;
      const later = (await client.query(`SELECT e.id FROM loss_event e LEFT JOIN claim_workflow w ON w.loss_event_id=e.id
        WHERE e.placement_id=$1 AND e.id<>$2 AND (w.status='approved' OR e.status='settled')
        AND (e.loss_date>$3::date OR ($4::boolean AND e.loss_date=$3::date)) LIMIT 1`, [placementId, id, from, !!event])).rows[0];
      const changesAggregate = !event || Number(event.gross_loss) !== clean.retained_loss || dateOnly(event.loss_date) !== clean.loss_date || event.cat_event !== clean.cat_event;
      if (later && changesAggregate) throw new ConflictError('A later claim is already approved or settled. Reconcile its aggregate allocation before changing an earlier loss');
      if (event) {
        await client.query(`UPDATE loss_event SET name=$2,reference=$3,loss_date=$4,cat_event=$5,gross_loss=$6,paid=$7,outstanding=$8,description=$9,status='open',settlement=NULL,updated_at=now() WHERE id=$1`, [id, clean.name, clean.reference || null, clean.loss_date, clean.cat_event, clean.retained_loss, clean.paid, clean.outstanding, clean.description || null]);
      } else {
        await client.query(`INSERT INTO loss_event(id,placement_id,name,reference,loss_date,cat_event,gross_loss,paid,outstanding,description,created_by,workspace_claim)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)`, [id, placementId, clean.name, clean.reference || null, clean.loss_date, clean.cat_event, clean.retained_loss, clean.paid, clean.outstanding, clean.description || null, user.id]);
      }
      const snapshot = await preview(placementId, clean, id, client);
      if (w) await client.query('UPDATE claim_workflow SET input=$2,snapshot=$3,source_hash=$4,revision=revision+1,updated_at=now() WHERE loss_event_id=$1', [id, JSON.stringify(clean), JSON.stringify(snapshot), snapshot.source_hash]);
      else await client.query('INSERT INTO claim_workflow(loss_event_id,input,snapshot,source_hash,created_by) VALUES ($1,$2,$3,$4,$5)', [id, JSON.stringify(clean), JSON.stringify(snapshot), snapshot.source_hash, user.id]);
      await log(client, id, 'claim_calculated_and_saved', user, { revision: (w?.revision || 0) + 1 });
      return { ...(await find(client, id)), stale: false };
    });
  }
  async function submit(id, reviewerId, user) {
    return transaction(async client => {
      await activeRole(client, user, ['broker', 'senior_broker', 'admin']);
      const w = await find(client, id, true);
      if (w.created_by !== user.id || w.status !== 'draft') throw new ConflictError('Only the preparer can submit a draft');
      if (reviewerId === user.id) throw new ConflictError('Four-eyes: choose a different approver');
      await activeRole(client, { id: reviewerId }, reviewRoles);
      const src = await loadClaimSource(client, w.placement_id, w.input, eventOf(w));
      if (src.source_hash !== w.source_hash) throw new ConflictError('The structure, signing or earlier claims changed. Recalculate and save first');
      await client.query("UPDATE claim_workflow SET status='submitted',reviewer_id=$2,submitted_at=now(),return_reason=NULL,updated_at=now() WHERE loss_event_id=$1", [id, reviewerId]);
      await log(client, id, 'claim_submitted', user, { reviewer_id: reviewerId }); return find(client, id);
    });
  }
  async function review(id, user, reason = null) {
    return transaction(async client => {
      const initial = await find(client, id);
      await client.query('SELECT id FROM placement WHERE id=$1 FOR UPDATE', [initial.placement_id]);
      const w = await find(client, id, true);
      await activeRole(client, user, reviewRoles);
      if (w.created_by === user.id) throw new ConflictError('Four-eyes: the preparer cannot approve their own claim');
      if (w.status !== 'submitted' || w.reviewer_id !== user.id) throw new ForbiddenError('Only the assigned reviewer can review a submitted claim');
      if (reason != null) {
        if (reason.trim().length < 5) throw new ValidationError('Explain what the preparer should change');
        await client.query("UPDATE claim_workflow SET status='draft',reviewer_id=NULL,submitted_at=NULL,return_reason=$2,updated_at=now() WHERE loss_event_id=$1", [id, reason]);
        await log(client, id, 'claim_returned', user, { reason }); return find(client, id);
      }
      const src = await loadClaimSource(client, w.placement_id, w.input, eventOf(w));
      if (src.source_hash !== w.source_hash) throw new ConflictError('The structure, signing or earlier claims changed. Return this claim for recalculation');
      const s = w.snapshot;
      // Keep the existing loss exhibit's read model populated, including claims
      // whose final-placement structure has no corresponding layer-ledger IDs.
      const settlement = {
        ladder: { gross_to_layer: s.totals.recovery, reinstatement_premium: s.totals.reinstatement_premium, net_due: s.totals.net,
          paid_recovery: s.totals.paid_recovery, outstanding_recovery: s.totals.outstanding_recovery,
          net_paid: s.totals.net_paid, net_outstanding: s.totals.net_outstanding,
          layers: s.layers.filter(l => l.calculation).map(l => ({ layer_id: l.id || l.key, layer_name: l.name, loss_to_layer: l.calculation.recovery, limit: Number(l.limit_amt), erosion_pct: l.calculation.recovery / Number(l.limit_amt) * 100 })) },
        markets: s.markets.map(m => ({ ...m, gross: m.recovery, net_due: m.net, lines: m.layers })),
      };
      await client.query("UPDATE claim_workflow SET status='approved',approved_by=$2,approved_at=now(),updated_at=now() WHERE loss_event_id=$1", [id, user.id]);
      await client.query('INSERT INTO claim_workflow_revision(loss_event_id,revision,input,snapshot,source_hash,prepared_by,approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, w.revision, JSON.stringify(w.input), JSON.stringify(w.snapshot), w.source_hash, w.created_by, user.id]);
      await client.query("UPDATE loss_event SET status='advised',settlement=$2,updated_at=now() WHERE id=$1", [id, JSON.stringify(settlement)]);
      await log(client, id, 'claim_independently_approved', user, { retained_loss: s.claim.retained_loss, currency: s.placement.currency });
      return find(client, id);
    });
  }
  async function reopen(id, user) {
    return transaction(async client => {
      await activeRole(client, user, ['broker','senior_broker','admin']);
      const initial = await find(client, id);
      await client.query('SELECT id FROM placement WHERE id=$1 FOR UPDATE', [initial.placement_id]);
      const w = await find(client, id, true);
      if (w.created_by !== user.id || w.status !== 'approved') throw new ConflictError('Only the preparer can start a revision of an approved claim');
      await client.query("UPDATE claim_workflow SET status='draft',reviewer_id=NULL,approved_by=NULL,approved_at=NULL,submitted_at=NULL,return_reason=NULL,revision=revision+1,updated_at=now() WHERE loss_event_id=$1", [id]);
      await client.query("UPDATE loss_event SET status='open',settlement=NULL,updated_at=now() WHERE id=$1", [id]);
      await log(client, id, 'claim_revision_started', user, { previous_revision: w.revision });
      return find(client, id);
    });
  }
  return { contracts, workspace, detail, preview, save, submit, reopen, approve: (id, user) => review(id, user), returnDraft: (id, reason, user) => review(id, user, reason) };
}
export const claimsWorkspaceService = createClaimsWorkspaceService();
