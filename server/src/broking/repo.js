// server/src/broking/repo.js — SQL access for the broking module. Every contract
// query is scoped to the caller's organisation (org_id) so a user can never reach
// another broking house's contracts by UUID or UMR (no IDOR).
import { toNumber } from '../../../shared/broking/calcs.js';

const n = (v) => toNumber(v);
const CONTRACT_SELECT = `
  SELECT c.*, cnt.country_name, cnt.country_code, ced.company_name AS cedant_name, bk.broker_name,
         cur.currency_code, tt.treaty_type AS treaty_type_name, tt.category AS treaty_category,
         p.umr AS parent_umr, u.display_name AS created_by_name
    FROM public.bk_contract c
    LEFT JOIN public.country cnt ON cnt.country_id = c.country_id
    LEFT JOIN public.companies ced ON ced.company_id = c.cedant_id
    LEFT JOIN public.brokers bk ON bk.broker_id = c.broker_id
    LEFT JOIN public.currency cur ON cur.currency_id = c.currency_id
    LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id
    LEFT JOIN public.bk_contract p ON p.contract_id = c.parent_contract_id
    LEFT JOIN public.uw_user u ON u.user_id = c.created_by_user_id`;

/** The contract + names, org-scoped. `forUpdate` takes the row lock (inside a transaction). */
export async function loadContractRow(db, contractId, orgId, { forUpdate = false } = {}) {
  const { rows } = await db.query(`${CONTRACT_SELECT} WHERE c.contract_id = $1 AND c.org_id = $2${forUpdate ? ' FOR UPDATE OF c' : ''}`, [contractId, orgId]);
  return rows[0] || null;
}

export async function loadClasses(db, contractId) {
  const { rows } = await db.query(
    `SELECT ccb.class_of_business_id AS id, cob.class_of_business AS name, ccb.sort_order
       FROM public.bk_contract_class_of_business ccb
       JOIN public.class_of_business cob ON cob.class_of_business_id = ccb.class_of_business_id
      WHERE ccb.contract_id = $1 ORDER BY ccb.sort_order, cob.class_of_business`, [contractId]);
  return rows;
}

export function mapHeader(row, classes = []) {
  return {
    countryId: row.country_id, countryName: row.country_name || null, countryCode: row.country_code || null,
    cedantId: row.cedant_id, cedantName: row.cedant_name || null,
    brokerId: row.broker_id, brokerName: row.broker_name || null,
    currencyId: row.currency_id, currencyCode: row.currency_code || null,
    treatyTypeId: row.treaty_type_id, treatyTypeName: row.treaty_type_name || null, treatyCategory: row.treaty_category || null,
    classIds: classes.map((c) => c.id), classNames: classes.map((c) => c.name),
    primaryClassOfBusinessId: row.primary_class_of_business_id,
    altContractId: row.alt_contract_id, inceptionDate: row.inception_date, renewalDate: row.renewal_date,
    uwYear: row.uw_year, experienceStartYear: row.experience_start_year, contractDescription: row.contract_description,
  };
}

export function mapContractMeta(row) {
  return {
    contractId: row.contract_id, umr: row.umr, businessType: row.business_type, status: row.status,
    rowVersion: row.row_version, parentContractId: row.parent_contract_id, parentUmr: row.parent_umr || null,
    createdAt: row.created_at, updatedAt: row.updated_at, createdBy: row.created_by_name || null,
  };
}

/* ── proportional ── */
export async function loadPropDetail(db, contractId) {
  const [d, cm, sl, lp, epi] = await Promise.all([
    db.query(`SELECT * FROM public.bk_prop_details WHERE contract_id=$1`, [contractId]),
    db.query(`SELECT * FROM public.bk_commissions WHERE contract_id=$1`, [contractId]),
    db.query(`SELECT row_no, loss_ratio_pct, commission_pct FROM public.bk_commission_slides WHERE contract_id=$1 ORDER BY row_no`, [contractId]),
    db.query(`SELECT * FROM public.bk_loss_participation WHERE contract_id=$1`, [contractId]),
    db.query(`SELECT e.class_of_business_id, e.premium, cob.class_of_business AS name FROM public.bk_epi_split e JOIN public.class_of_business cob USING (class_of_business_id) WHERE e.contract_id=$1 ORDER BY cob.class_of_business`, [contractId]),
  ]);
  return { detail: d.rows[0] || null, commissions: cm.rows[0] || null, slides: sl.rows, lossParticipation: lp.rows[0] || null, epiSplit: epi.rows };
}

export function mapPropDetail({ detail, commissions, slides, lossParticipation, epiSplit }) {
  const d = detail || {}, cm = commissions || {}, lp = lossParticipation || {};
  return {
    detail: {
      triangulationsAvailable: d.triangulations_available ?? true,
      qsLimit: n(d.qs_limit), retentionPct: n(d.retention_pct), retentionAmt: n(d.retention_amt),
      cessionPct: n(d.cession_pct), cessionAmt: n(d.cession_amt),
      surplusMaxRetention: n(d.surplus_max_retention), numLines: n(d.num_lines), totalCapacity: n(d.total_capacity),
      eventLimit: n(d.event_limit), aal: n(d.aal), quotaShareEpi: n(d.quota_share_epi), surplusEpi: n(d.surplus_epi),
      brokeragePct: n(d.brokerage_pct), taxesPct: n(d.taxes_pct), lossCapPct: n(d.loss_cap_pct),
    },
    commissions: {
      mode: cm.mode || 'FIXED',
      fixedCommissionQSPct: n(cm.fixed_commission_qs_pct), fixedCommissionSurplusPct: n(cm.fixed_commission_surplus_pct),
      provisionalCommissionPct: n(cm.provisional_commission_pct),
      slidingMinLossRatio: n(cm.sliding_min_loss_ratio), slidingMaxLossRatio: n(cm.sliding_max_loss_ratio),
      slidingMinCommission: n(cm.sliding_min_commission), slidingMaxCommission: n(cm.sliding_max_commission),
      mgmtExpensesPct: n(cm.mgmt_expenses_pct), profitCommissionPct: n(cm.profit_commission_pct),
      lcfYears: cm.lcf_years ?? null, lcfExtinction: cm.lcf_extinction === true,
      slidingTable: (slides || []).map((r) => ({ lossRatioPct: n(r.loss_ratio_pct), commissionPct: n(r.commission_pct) })),
    },
    lossParticipation: {
      enabled: lp.enabled === true,
      minLossRatioPct: n(lp.min_loss_ratio_pct), maxLossRatioPct: n(lp.max_loss_ratio_pct), reinsurerSharePct: n(lp.reinsurer_share_pct),
      slides: Array.isArray(lp.slides) ? lp.slides.map((s) => ({ minLr: n(s.min_lr ?? s.minLr), maxLr: n(s.max_lr ?? s.maxLr), share: n(s.share) })) : [],
    },
    epiSplit: (epiSplit || []).map((r) => ({ classId: r.class_of_business_id, className: r.name, premium: n(r.premium) })),
  };
}

/* ── non-proportional ── */
export async function loadNpStructure(db, contractId) {
  const [p, l, lc] = await Promise.all([
    db.query(`SELECT * FROM public.bk_np_programme WHERE contract_id=$1`, [contractId]),
    db.query(`SELECT * FROM public.bk_np_layer WHERE contract_id=$1 ORDER BY layer_number`, [contractId]),
    db.query(`SELECT lc.layer_id, lc.class_of_business_id FROM public.bk_np_layer_class_of_business lc JOIN public.bk_np_layer l USING (layer_id) WHERE l.contract_id=$1`, [contractId]),
  ]);
  const byLayer = new Map();
  for (const r of lc.rows) { if (!byLayer.has(r.layer_id)) byLayer.set(r.layer_id, []); byLayer.get(r.layer_id).push(r.class_of_business_id); }
  return { programme: p.rows[0] || null, layers: l.rows.map((r) => ({ ...r, class_ids: byLayer.get(r.layer_id) || [] })) };
}

export function mapNpStructure({ programme, layers }) {
  const p = programme || {};
  return {
    programme: {
      numberOfLayers: p.number_of_layers ?? (layers?.length || 1),
      deductible: n(p.deductible), accountingMethod: p.accounting_method || null, xlType: p.xl_type || null, accounts: p.accounts || null,
      estGnpi: n(p.est_gnpi), brokeragePct: n(p.brokerage_pct), taxesPct: n(p.taxes_pct), noClaimsBonusPct: n(p.no_claims_bonus_pct), profitCommissionPct: n(p.profit_commission_pct),
    },
    layers: (layers || []).map((l) => ({
      layerId: l.layer_id, layerNumber: l.layer_number,
      limit: n(l.layer_limit), attachment: n(l.attachment), aggregateLimit: n(l.aggregate_limit), egnpi: n(l.egnpi), rate: n(l.rate),
      earnedPremium: n(l.earned_premium), mdp: n(l.mdp), mdpPct: n(l.mdp_pct),
      numReinstatements: l.num_reinstatements, reinstatementPct: n(l.reinstatement_pct),
      aad: l.aad === true, aadAmount: n(l.aad_amount), perilScope: l.peril_scope,
      riskCover: l.peril_scope === 'RISK' || l.peril_scope === 'BOTH', catCover: l.peril_scope === 'CAT' || l.peril_scope === 'BOTH',
      rol: n(l.rol), classIds: l.class_ids || [],
      attachLrPct: n(l.attach_lr_pct), limitLrPct: n(l.limit_lr_pct), epi: n(l.epi), aggregateDeductible: n(l.aggregate_deductible),
    })),
  };
}

export async function loadUmrHistory(db, contractId) {
  const { rows } = await db.query(
    `SELECT h.old_umr, h.new_umr, h.changed_at, h.reason, u.display_name AS changed_by
       FROM public.bk_umr_history h LEFT JOIN public.uw_user u ON u.user_id = h.changed_by
      WHERE h.contract_id=$1 ORDER BY h.changed_at DESC`, [contractId]);
  return rows.map((r) => ({ oldUmr: r.old_umr, newUmr: r.new_umr, changedAt: r.changed_at, changedBy: r.changed_by, reason: r.reason }));
}

export async function loadAudit(db, contractId) {
  const { rows } = await db.query(
    `SELECT a.audit_id, a.umr, a.diff, a.created_at, u.display_name AS user_name
       FROM public.bk_audit a LEFT JOIN public.uw_user u ON u.user_id = a.user_id
      WHERE a.contract_id=$1 ORDER BY a.created_at DESC LIMIT 500`, [contractId]);
  return rows.map((r) => ({ auditId: r.audit_id, umr: r.umr, action: r.diff?.action || null, changes: r.diff?.changes || {}, meta: r.diff, userName: r.user_name, createdAt: r.created_at }));
}

/** Names for the derived contract description (only the ids the header carries). */
export async function lookupNames(db, { cedantId, treatyTypeId, countryId, classIds }) {
  const [ced, tt, cnt, cls] = await Promise.all([
    cedantId ? db.query(`SELECT company_name FROM public.companies WHERE company_id=$1`, [cedantId]) : { rows: [] },
    treatyTypeId ? db.query(`SELECT treaty_type, category FROM public.treaty_type WHERE treaty_type_id=$1`, [treatyTypeId]) : { rows: [] },
    countryId ? db.query(`SELECT country_code FROM public.country WHERE country_id=$1`, [countryId]) : { rows: [] },
    classIds?.length ? db.query(`SELECT class_of_business_id, class_of_business FROM public.class_of_business WHERE class_of_business_id = ANY($1::uuid[])`, [classIds]) : { rows: [] },
  ]);
  const byId = new Map(cls.rows.map((r) => [r.class_of_business_id, r.class_of_business]));
  return {
    cedantName: ced.rows[0]?.company_name || '',
    treatyTypeName: tt.rows[0]?.treaty_type || '',
    treatyCategory: tt.rows[0]?.category || '',
    countryCode: cnt.rows[0]?.country_code || '',
    classNames: (classIds || []).map((id) => byId.get(id)).filter(Boolean),
  };
}
