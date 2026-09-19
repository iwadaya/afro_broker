// server/src/broking/service.js — the broking use-cases. Each write runs in ONE
// transaction: lock the contract row (org-scoped), check row_version, apply the
// slice, recompute every derived column with shared/broking/calcs.js, write the
// field-level audit diff, bump row_version, and return the fresh bundle.
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/withTransaction.js';
import { env } from '../config/env.js';
import * as repo from './repo.js';
import { ApiError, notFound } from './errors.js';
import { writeAudit, diffRecords, diffList } from './audit.js';
import * as calcs from '../../../shared/broking/calcs.js';

const orgOf = (user) => {
  if (!user?.orgId) throw new ApiError(403, 'FORBIDDEN', 'Your account is not attached to a broking organisation.');
  return user.orgId;
};

/* ────────────────────────────── settings ───────────────────────────── */
export function settings(user) {
  const no = env.lloydsBrokerNo || user?.lloydsBrokerNo || '';
  return { lloydsBrokerNo: no || null, umrPrefix: `B${no}`, orgName: user?.orgName || null, brokingEnabled: env.brokingEnabled };
}

/* ─────────────────────────────── list ──────────────────────────────── */
const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listContracts(user, { search = '', limit = 200 } = {}) {
  const orgId = orgOf(user);
  const term = String(search || '').trim();
  const params = [orgId, Math.min(500, Math.max(1, limit))];
  let where = '';
  if (term) {
    params.push(`${escapeLike(calcs.normaliseUmr(term))}%`, `%${escapeLike(term)}%`, term, term.toUpperCase());
    where = ` AND (c.umr LIKE $3 ESCAPE '\\' OR ced.company_name ILIKE $4 ESCAPE '\\' OR c.uw_year::text = $5 OR c.status::text = $6)`;
  }
  const { rows } = await pool.query(
    `SELECT c.contract_id, c.umr, c.business_type, c.status, c.uw_year, c.row_version, c.updated_at, c.inception_date, c.parent_contract_id,
            ced.company_name AS cedant_name, cnt.country_name, cnt.country_code, cur.currency_code, tt.treaty_type AS treaty_type_name
       FROM public.bk_contract c
       LEFT JOIN public.companies ced ON ced.company_id = c.cedant_id
       LEFT JOIN public.country cnt ON cnt.country_id = c.country_id
       LEFT JOIN public.currency cur ON cur.currency_id = c.currency_id
       LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id
      WHERE c.org_id = $1${where}
      ORDER BY c.updated_at DESC LIMIT $2`, params);
  return rows.map((r) => ({
    contractId: r.contract_id, umr: r.umr, businessType: r.business_type, status: r.status, uwYear: r.uw_year,
    rowVersion: r.row_version, updatedAt: r.updated_at, inceptionDate: r.inception_date, parentContractId: r.parent_contract_id,
    cedantName: r.cedant_name, countryName: r.country_name, countryCode: r.country_code, currencyCode: r.currency_code, treatyTypeName: r.treaty_type_name,
  }));
}

/* ───────────────────────────── by-umr ─────────────────────────────── */
async function findUmrOwner(db, umr) {
  const { rows } = await db.query(
    `SELECT c.contract_id, c.org_id, c.uw_year, c.status, c.business_type, ced.company_name AS cedant_name, tt.treaty_type AS treaty_type_name
       FROM public.bk_contract c
       LEFT JOIN public.companies ced ON ced.company_id = c.cedant_id
       LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id
      WHERE c.umr = $1`, [umr]);
  return rows[0] || null;
}

const describeOwner = (o) => [o.cedant_name, o.treaty_type_name, o.uw_year].filter(Boolean).join(' ') || 'another contract';

export async function findByUmr(user, raw) {
  const orgId = orgOf(user);
  const umr = calcs.normaliseUmr(raw);
  if (!calcs.isValidUmr(umr)) throw new ApiError(400, 'VALIDATION_FAILED', calcs.umrFormatMessage(umr) || 'Invalid UMR', { fields: [{ path: 'umr', message: calcs.umrFormatMessage(umr) }] });
  const owner = await findUmrOwner(pool, umr);
  if (!owner) throw new ApiError(404, 'UMR_AVAILABLE', `UMR ${umr} is available`, { umr, available: true });
  if (owner.org_id !== orgId) {
    return { umr, contractId: null, cedant: null, treatyType: null, uwYear: null, businessType: null, status: null, ownedByOtherOrganisation: true };
  }
  return { umr, contractId: owner.contract_id, cedant: owner.cedant_name, treatyType: owner.treaty_type_name, uwYear: owner.uw_year, businessType: owner.business_type, status: owner.status };
}

function umrTakenError(umr, owner, orgId) {
  const mine = owner && owner.org_id === orgId;
  return new ApiError(409, 'UMR_TAKEN', `UMR ${umr} is already used by ${owner ? describeOwner(owner) : 'another contract'} — open it or change the reference.`, {
    umr, contractId: mine ? owner.contract_id : null, cedant: mine ? owner.cedant_name : null, treatyType: mine ? owner.treaty_type_name : null, uwYear: mine ? owner.uw_year : null,
    ownedByOtherOrganisation: !!owner && !mine,
  });
}

/* ────────────────────────────── create ─────────────────────────────── */
export async function createContract(user, { umr, businessType, parentContractId }) {
  const orgId = orgOf(user);
  return withTransaction(async (client) => {
    let parent = null;
    if (parentContractId) {
      parent = await repo.loadContractRow(client, parentContractId, orgId);
      if (!parent) throw notFound('Parent contract');
      if (parent.business_type !== businessType) {
        throw new ApiError(400, 'VALIDATION_FAILED', `A renewal keeps the parent contract's business type (${parent.business_type}).`, { fields: [{ path: 'businessType', message: 'must match the parent contract' }] });
      }
    }
    const owner = await findUmrOwner(client, umr);
    if (owner) throw umrTakenError(umr, owner, orgId);

    let row;
    try {
      if (parent) {
        const inception = parent.renewal_date || (parent.inception_date ? calcs.defaultRenewalDate(parent.inception_date) : null);
        const renewal = inception ? calcs.defaultRenewalDate(inception) : null;
        const uwYear = inception ? calcs.uwYearFromInception(inception) : null;
        const classes = await repo.loadClasses(client, parent.contract_id);
        const description = calcs.buildContractDescription({ uwYear, cedantName: parent.cedant_name, treatyTypeName: parent.treaty_type_name, classNames: classes.map((c) => c.name), countryCode: parent.country_code });
        ({ rows: [row] } = await client.query(
          `INSERT INTO public.bk_contract (umr, business_type, org_id, parent_contract_id, created_by_user_id,
             country_id, cedant_id, broker_id, currency_id, treaty_type_id, primary_class_of_business_id,
             uw_year, inception_date, renewal_date, experience_start_year, contract_description)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
          [umr, businessType, orgId, parent.contract_id, user.userId, parent.country_id, parent.cedant_id, parent.broker_id, parent.currency_id,
           parent.treaty_type_id, parent.primary_class_of_business_id, uwYear, inception, renewal, parent.experience_start_year, description]));
        await copyDetails(client, parent, row.contract_id);
      } else {
        ({ rows: [row] } = await client.query(
          `INSERT INTO public.bk_contract (umr, business_type, org_id, created_by_user_id) VALUES ($1,$2,$3,$4) RETURNING *`,
          [umr, businessType, orgId, user.userId]));
      }
    } catch (e) {
      if (e.code === '23505' && String(e.constraint || '').includes('umr')) throw umrTakenError(umr, await findUmrOwner(pool, umr), orgId);
      throw e;
    }
    await writeAudit(client, {
      contractId: row.contract_id, umr, userId: user.userId, action: parent ? 'RENEW' : 'CREATE',
      changes: { 'bk_contract.umr': { from: null, to: umr }, 'bk_contract.business_type': { from: null, to: businessType } },
      meta: parent ? { parentContractId: parent.contract_id, parentUmr: parent.umr } : {},
    });
    return { contractId: row.contract_id, umr: row.umr, businessType: row.business_type, status: row.status, rowVersion: row.row_version, parentContractId: row.parent_contract_id || null };
  });
}

/** Renewal: copy classes and the business-type specific details from the parent (INSERT … SELECT). */
async function copyDetails(client, parent, newId) {
  const p = parent.contract_id;
  await client.query(`INSERT INTO public.bk_contract_class_of_business (contract_id, class_of_business_id, sort_order) SELECT $2, class_of_business_id, sort_order FROM public.bk_contract_class_of_business WHERE contract_id=$1`, [p, newId]);
  if (parent.business_type === 'PROPORTIONAL') {
    await client.query(`INSERT INTO public.bk_prop_details SELECT $2, triangulations_available, qs_limit, retention_pct, retention_amt, cession_pct, cession_amt, surplus_max_retention, num_lines, total_capacity, event_limit, aal, quota_share_epi, surplus_epi, brokerage_pct, taxes_pct, loss_cap_pct FROM public.bk_prop_details WHERE contract_id=$1`, [p, newId]);
    await client.query(`INSERT INTO public.bk_commissions SELECT $2, mode, fixed_commission_qs_pct, fixed_commission_surplus_pct, provisional_commission_pct, sliding_min_loss_ratio, sliding_max_loss_ratio, sliding_min_commission, sliding_max_commission, mgmt_expenses_pct, profit_commission_pct, lcf_years, lcf_extinction FROM public.bk_commissions WHERE contract_id=$1`, [p, newId]);
    await client.query(`INSERT INTO public.bk_commission_slides SELECT $2, row_no, loss_ratio_pct, commission_pct FROM public.bk_commission_slides WHERE contract_id=$1`, [p, newId]);
    await client.query(`INSERT INTO public.bk_loss_participation SELECT $2, enabled, min_loss_ratio_pct, max_loss_ratio_pct, reinsurer_share_pct, slides FROM public.bk_loss_participation WHERE contract_id=$1`, [p, newId]);
    await client.query(`INSERT INTO public.bk_epi_split SELECT $2, class_of_business_id, premium FROM public.bk_epi_split WHERE contract_id=$1`, [p, newId]);
  } else {
    await client.query(`INSERT INTO public.bk_np_programme SELECT $2, number_of_layers, deductible, accounting_method, xl_type, accounts, est_gnpi, brokerage_pct, taxes_pct, no_claims_bonus_pct, profit_commission_pct FROM public.bk_np_programme WHERE contract_id=$1`, [p, newId]);
    const { rows: layers } = await client.query(`SELECT * FROM public.bk_np_layer WHERE contract_id=$1 ORDER BY layer_number`, [p]);
    for (const l of layers) {
      const { rows: [nl] } = await client.query(
        `INSERT INTO public.bk_np_layer (contract_id, layer_number, layer_limit, attachment, aggregate_limit, egnpi, rate, earned_premium, mdp, mdp_pct, num_reinstatements, reinstatement_pct, aad, aad_amount, peril_scope, rol, attach_lr_pct, limit_lr_pct, epi, aggregate_deductible)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING layer_id`,
        [newId, l.layer_number, l.layer_limit, l.attachment, l.aggregate_limit, l.egnpi, l.rate, l.earned_premium, l.mdp, l.mdp_pct, l.num_reinstatements, l.reinstatement_pct, l.aad, l.aad_amount, l.peril_scope, l.rol, l.attach_lr_pct, l.limit_lr_pct, l.epi, l.aggregate_deductible]);
      await client.query(`INSERT INTO public.bk_np_layer_class_of_business (layer_id, class_of_business_id) SELECT $2, class_of_business_id FROM public.bk_np_layer_class_of_business WHERE layer_id=$1`, [l.layer_id, nl.layer_id]);
    }
  }
}

/* ───────────────────────────── bundle ─────────────────────────────── */
export async function getBundle(user, contractId, db = pool) {
  const orgId = orgOf(user);
  const row = await repo.loadContractRow(db, contractId, orgId);
  if (!row) throw notFound();
  return buildBundle(db, row);
}

async function buildBundle(db, row) {
  const classes = await repo.loadClasses(db, row.contract_id);
  const bundle = { ...repo.mapContractMeta(row), header: repo.mapHeader(row, classes), umrHistory: await repo.loadUmrHistory(db, row.contract_id) };
  if (row.business_type === 'PROPORTIONAL') bundle.propDetail = repo.mapPropDetail(await repo.loadPropDetail(db, row.contract_id));
  else bundle.npStructure = repo.mapNpStructure(await repo.loadNpStructure(db, row.contract_id));
  return bundle;
}

export async function getAudit(user, contractId) {
  const orgId = orgOf(user);
  const row = await repo.loadContractRow(pool, contractId, orgId);
  if (!row) throw notFound();
  return repo.loadAudit(pool, contractId);
}

/* ───────────────────────── shared write helpers ───────────────────── */
async function lockContract(client, contractId, orgId, body) {
  const row = await repo.loadContractRow(client, contractId, orgId, { forUpdate: true });
  if (!row) throw notFound();
  const sent = body?.rowVersion ?? body?.row_version;
  if (sent != null && !body?.force && Number(sent) !== Number(row.row_version)) {
    throw new ApiError(409, 'STALE_WRITE', `This contract was changed by someone else (it is now version ${row.row_version}; you have version ${sent}). Reload or overwrite.`, { current: row.row_version, expected: Number(sent) });
  }
  return row;
}

async function bumpVersion(client, contractId) {
  const { rows } = await client.query(`UPDATE public.bk_contract SET row_version = row_version + 1 WHERE contract_id=$1 RETURNING row_version`, [contractId]);
  return rows[0].row_version;
}

const headerColumns = (row) => ({
  country_id: row.country_id, cedant_id: row.cedant_id, broker_id: row.broker_id, currency_id: row.currency_id, treaty_type_id: row.treaty_type_id,
  primary_class_of_business_id: row.primary_class_of_business_id, alt_contract_id: row.alt_contract_id, inception_date: row.inception_date,
  renewal_date: row.renewal_date, uw_year: row.uw_year, experience_start_year: row.experience_start_year, contract_description: row.contract_description,
});

/** Replace the Contract Details fields, recomputing UW year, renewal default and the description. */
async function applyHeader(client, row, h, changes) {
  const before = headerColumns(row);
  const beforeClasses = (await repo.loadClasses(client, row.contract_id)).map((c) => c.id);
  const classIds = h.classIds ?? beforeClasses;
  const names = await repo.lookupNames(client, { cedantId: h.cedantId, treatyTypeId: h.treatyTypeId, countryId: h.countryId, classIds });
  if (h.treatyTypeId && names.treatyCategory && names.treatyCategory !== row.business_type) {
    throw new ApiError(400, 'VALIDATION_FAILED', `Treaty type "${names.treatyTypeName}" is ${names.treatyCategory}; this is a ${row.business_type} contract.`, { fields: [{ path: 'header.treatyTypeId', message: `must be a ${row.business_type} treaty type` }] });
  }
  const inception = h.inceptionDate ?? null;
  const renewal = h.renewalDate ?? (inception ? calcs.defaultRenewalDate(inception) : null);
  const uwYear = inception ? calcs.uwYearFromInception(inception) : null;
  const description = calcs.buildContractDescription({ uwYear, cedantName: names.cedantName, treatyTypeName: names.treatyTypeName, classNames: names.classNames, countryCode: names.countryCode }) || null;
  const after = {
    country_id: h.countryId ?? null, cedant_id: h.cedantId ?? null, broker_id: h.brokerId ?? null, currency_id: h.currencyId ?? null, treaty_type_id: h.treatyTypeId ?? null,
    primary_class_of_business_id: classIds[0] ?? null, alt_contract_id: h.altContractId ?? null, inception_date: inception, renewal_date: renewal,
    uw_year: uwYear, experience_start_year: h.experienceStartYear ?? null, contract_description: description,
  };
  await client.query(
    `UPDATE public.bk_contract SET country_id=$2, cedant_id=$3, broker_id=$4, currency_id=$5, treaty_type_id=$6, primary_class_of_business_id=$7,
       alt_contract_id=$8, inception_date=$9, renewal_date=$10, uw_year=$11, experience_start_year=$12, contract_description=$13
     WHERE contract_id=$1`,
    [row.contract_id, after.country_id, after.cedant_id, after.broker_id, after.currency_id, after.treaty_type_id, after.primary_class_of_business_id,
     after.alt_contract_id, after.inception_date, after.renewal_date, after.uw_year, after.experience_start_year, after.contract_description]);
  if (h.classIds) {
    await client.query(`DELETE FROM public.bk_contract_class_of_business WHERE contract_id=$1`, [row.contract_id]);
    for (let i = 0; i < classIds.length; i++) {
      await client.query(`INSERT INTO public.bk_contract_class_of_business (contract_id, class_of_business_id, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [row.contract_id, classIds[i], i]);
    }
  }
  Object.assign(changes, diffRecords(before, after, 'bk_contract'), diffList(beforeClasses, classIds, 'bk_contract_class_of_business.class_ids'));
  return { ...row, ...after, treaty_type_name: names.treatyTypeName || (h.treatyTypeId ? row.treaty_type_name : null) };
}

export async function saveHeader(user, contractId, body) {
  const orgId = orgOf(user);
  return withTransaction(async (client) => {
    const row = await lockContract(client, contractId, orgId, body);
    const changes = {};
    await applyHeader(client, row, body.header || {}, changes);
    await writeAudit(client, { contractId, umr: row.umr, userId: user.userId, action: 'HEADER_UPDATE', changes });
    await bumpVersion(client, contractId);
    return buildBundle(client, await repo.loadContractRow(client, contractId, orgId));
  });
}

/* ───────────────────────── proportional save ──────────────────────── */
const propDetailColumns = (d) => ({
  triangulations_available: d.triangulations_available ?? true, qs_limit: d.qs_limit ?? null, retention_pct: d.retention_pct ?? null, retention_amt: d.retention_amt ?? null,
  cession_pct: d.cession_pct ?? null, cession_amt: d.cession_amt ?? null, surplus_max_retention: d.surplus_max_retention ?? null, num_lines: d.num_lines ?? null,
  total_capacity: d.total_capacity ?? null, event_limit: d.event_limit ?? null, aal: d.aal ?? null, quota_share_epi: d.quota_share_epi ?? null, surplus_epi: d.surplus_epi ?? null,
  brokerage_pct: d.brokerage_pct ?? null, taxes_pct: d.taxes_pct ?? null, loss_cap_pct: d.loss_cap_pct ?? null,
});
const commissionColumns = (c) => ({
  mode: c.mode || 'FIXED', fixed_commission_qs_pct: c.fixed_commission_qs_pct ?? null, fixed_commission_surplus_pct: c.fixed_commission_surplus_pct ?? null,
  provisional_commission_pct: c.provisional_commission_pct ?? null, sliding_min_loss_ratio: c.sliding_min_loss_ratio ?? null, sliding_max_loss_ratio: c.sliding_max_loss_ratio ?? null,
  sliding_min_commission: c.sliding_min_commission ?? null, sliding_max_commission: c.sliding_max_commission ?? null, mgmt_expenses_pct: c.mgmt_expenses_pct ?? null,
  profit_commission_pct: c.profit_commission_pct ?? null, lcf_years: c.lcf_years ?? null, lcf_extinction: c.lcf_extinction === true,
});
const lpColumns = (l) => ({ enabled: l.enabled === true, min_loss_ratio_pct: l.min_loss_ratio_pct ?? null, max_loss_ratio_pct: l.max_loss_ratio_pct ?? null, reinsurer_share_pct: l.reinsurer_share_pct ?? null, slides: l.slides || [] });

export async function savePropDetail(user, contractId, body) {
  const orgId = orgOf(user);
  return withTransaction(async (client) => {
    let row = await lockContract(client, contractId, orgId, body);
    if (row.business_type !== 'PROPORTIONAL') throw new ApiError(400, 'WRONG_BUSINESS_TYPE', 'Treaty Detail applies to proportional contracts only.');
    const changes = {};
    if (body.header) row = await applyHeader(client, row, body.header, changes);
    const current = await repo.loadPropDetail(client, contractId);
    const mode = calcs.treatyModeFromType(row.treaty_type_name);

    if (body.detail) {
      const d = body.detail;
      const after = propDetailColumns({
        triangulations_available: d.triangulationsAvailable ?? true,
        qs_limit: d.qsLimit, retention_pct: d.retentionPct, cession_pct: d.cessionPct,
        retention_amt: calcs.isQsMode(mode) ? calcs.retentionAmt(d.qsLimit, d.retentionPct) : null,
        cession_amt: calcs.isQsMode(mode) ? calcs.cessionAmt(d.qsLimit, d.cessionPct) : null,
        surplus_max_retention: d.surplusMaxRetention, num_lines: d.numLines,
        total_capacity: calcs.totalCapacity({ mode, qsLimit: d.qsLimit, surplusMaxRetention: d.surplusMaxRetention, numLines: d.numLines }),
        event_limit: d.eventLimit, aal: d.aal, quota_share_epi: d.quotaShareEpi, surplus_epi: d.surplusEpi,
        brokerage_pct: d.brokeragePct, taxes_pct: d.taxesPct, loss_cap_pct: d.lossCapPct,
      });
      await client.query(
        `INSERT INTO public.bk_prop_details (contract_id, triangulations_available, qs_limit, retention_pct, retention_amt, cession_pct, cession_amt, surplus_max_retention, num_lines, total_capacity, event_limit, aal, quota_share_epi, surplus_epi, brokerage_pct, taxes_pct, loss_cap_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (contract_id) DO UPDATE SET triangulations_available=EXCLUDED.triangulations_available, qs_limit=EXCLUDED.qs_limit, retention_pct=EXCLUDED.retention_pct, retention_amt=EXCLUDED.retention_amt, cession_pct=EXCLUDED.cession_pct, cession_amt=EXCLUDED.cession_amt, surplus_max_retention=EXCLUDED.surplus_max_retention, num_lines=EXCLUDED.num_lines, total_capacity=EXCLUDED.total_capacity, event_limit=EXCLUDED.event_limit, aal=EXCLUDED.aal, quota_share_epi=EXCLUDED.quota_share_epi, surplus_epi=EXCLUDED.surplus_epi, brokerage_pct=EXCLUDED.brokerage_pct, taxes_pct=EXCLUDED.taxes_pct, loss_cap_pct=EXCLUDED.loss_cap_pct`,
        [contractId, after.triangulations_available, after.qs_limit, after.retention_pct, after.retention_amt, after.cession_pct, after.cession_amt, after.surplus_max_retention, after.num_lines, after.total_capacity, after.event_limit, after.aal, after.quota_share_epi, after.surplus_epi, after.brokerage_pct, after.taxes_pct, after.loss_cap_pct]);
      Object.assign(changes, diffRecords(current.detail ? propDetailColumns(current.detail) : {}, after, 'bk_prop_details'));
    }

    if (body.commissions) {
      const c = body.commissions;
      const after = commissionColumns({
        mode: c.mode, fixed_commission_qs_pct: c.fixedCommissionQSPct, fixed_commission_surplus_pct: c.fixedCommissionSurplusPct, provisional_commission_pct: c.provisionalCommissionPct,
        sliding_min_loss_ratio: c.slidingMinLossRatio, sliding_max_loss_ratio: c.slidingMaxLossRatio, sliding_min_commission: c.slidingMinCommission, sliding_max_commission: c.slidingMaxCommission,
        mgmt_expenses_pct: c.mgmtExpensesPct, profit_commission_pct: c.profitCommissionPct, lcf_years: c.lcfYears, lcf_extinction: c.lcfExtinction,
      });
      await client.query(
        `INSERT INTO public.bk_commissions (contract_id, mode, fixed_commission_qs_pct, fixed_commission_surplus_pct, provisional_commission_pct, sliding_min_loss_ratio, sliding_max_loss_ratio, sliding_min_commission, sliding_max_commission, mgmt_expenses_pct, profit_commission_pct, lcf_years, lcf_extinction)
         VALUES ($1,$2::public.bk_commission_mode,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (contract_id) DO UPDATE SET mode=EXCLUDED.mode, fixed_commission_qs_pct=EXCLUDED.fixed_commission_qs_pct, fixed_commission_surplus_pct=EXCLUDED.fixed_commission_surplus_pct, provisional_commission_pct=EXCLUDED.provisional_commission_pct, sliding_min_loss_ratio=EXCLUDED.sliding_min_loss_ratio, sliding_max_loss_ratio=EXCLUDED.sliding_max_loss_ratio, sliding_min_commission=EXCLUDED.sliding_min_commission, sliding_max_commission=EXCLUDED.sliding_max_commission, mgmt_expenses_pct=EXCLUDED.mgmt_expenses_pct, profit_commission_pct=EXCLUDED.profit_commission_pct, lcf_years=EXCLUDED.lcf_years, lcf_extinction=EXCLUDED.lcf_extinction`,
        [contractId, after.mode, after.fixed_commission_qs_pct, after.fixed_commission_surplus_pct, after.provisional_commission_pct, after.sliding_min_loss_ratio, after.sliding_max_loss_ratio, after.sliding_min_commission, after.sliding_max_commission, after.mgmt_expenses_pct, after.profit_commission_pct, after.lcf_years, after.lcf_extinction]);
      Object.assign(changes, diffRecords(current.commissions ? commissionColumns(current.commissions) : {}, after, 'bk_commissions'));
      if (c.slidingTable) {
        const rows = c.slidingTable.map((r, i) => ({ row_no: i + 1, loss_ratio_pct: r.lossRatioPct, commission_pct: r.commissionPct }));
        await client.query(`DELETE FROM public.bk_commission_slides WHERE contract_id=$1`, [contractId]);
        for (const r of rows) await client.query(`INSERT INTO public.bk_commission_slides (contract_id, row_no, loss_ratio_pct, commission_pct) VALUES ($1,$2,$3,$4)`, [contractId, r.row_no, r.loss_ratio_pct, r.commission_pct]);
        const beforeRows = (current.slides || []).map((r) => ({ row_no: r.row_no, loss_ratio_pct: calcs.toNumber(r.loss_ratio_pct), commission_pct: calcs.toNumber(r.commission_pct) }));
        Object.assign(changes, diffList(beforeRows, rows, 'bk_commission_slides.rows'));
      }
    }

    if (body.lossParticipation) {
      const l = body.lossParticipation;
      const after = lpColumns({ enabled: l.enabled, min_loss_ratio_pct: l.minLossRatioPct, max_loss_ratio_pct: l.maxLossRatioPct, reinsurer_share_pct: l.reinsurerSharePct,
        slides: (l.slides || []).map((s) => ({ min_lr: s.minLr, max_lr: s.maxLr, share: s.share })) });
      await client.query(
        `INSERT INTO public.bk_loss_participation (contract_id, enabled, min_loss_ratio_pct, max_loss_ratio_pct, reinsurer_share_pct, slides)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT (contract_id) DO UPDATE SET enabled=EXCLUDED.enabled, min_loss_ratio_pct=EXCLUDED.min_loss_ratio_pct, max_loss_ratio_pct=EXCLUDED.max_loss_ratio_pct, reinsurer_share_pct=EXCLUDED.reinsurer_share_pct, slides=EXCLUDED.slides`,
        [contractId, after.enabled, after.min_loss_ratio_pct, after.max_loss_ratio_pct, after.reinsurer_share_pct, JSON.stringify(after.slides)]);
      Object.assign(changes, diffRecords(current.lossParticipation ? lpColumns(current.lossParticipation) : {}, after, 'bk_loss_participation'));
    }

    if (body.epiSplit) {
      const rows = body.epiSplit.map((r) => ({ class_of_business_id: r.classId, premium: r.premium ?? 0 }));
      await client.query(`DELETE FROM public.bk_epi_split WHERE contract_id=$1`, [contractId]);
      for (const r of rows) await client.query(`INSERT INTO public.bk_epi_split (contract_id, class_of_business_id, premium) VALUES ($1,$2,$3) ON CONFLICT (contract_id, class_of_business_id) DO UPDATE SET premium=EXCLUDED.premium`, [contractId, r.class_of_business_id, r.premium]);
      const beforeRows = (current.epiSplit || []).map((r) => ({ class_of_business_id: r.class_of_business_id, premium: calcs.toNumber(r.premium) }));
      Object.assign(changes, diffList(beforeRows, rows, 'bk_epi_split.rows'));
    }

    await writeAudit(client, { contractId, umr: row.umr, userId: user.userId, action: 'PROP_DETAIL_UPDATE', changes });
    await bumpVersion(client, contractId);
    return buildBundle(client, await repo.loadContractRow(client, contractId, orgId));
  });
}

/* ────────────────────────── NP structure save ─────────────────────── */
const programmeColumns = (p, numberOfLayers) => ({
  number_of_layers: numberOfLayers, deductible: p.deductible ?? null, accounting_method: p.accountingMethod ?? null, xl_type: p.xlType ?? null, accounts: p.accounts ?? null,
  est_gnpi: p.estGnpi ?? null, brokerage_pct: p.brokeragePct ?? null, taxes_pct: p.taxesPct ?? null, no_claims_bonus_pct: p.noClaimsBonusPct ?? null, profit_commission_pct: p.profitCommissionPct ?? null,
});

export async function saveNpStructure(user, contractId, body) {
  const orgId = orgOf(user);
  return withTransaction(async (client) => {
    const row = await lockContract(client, contractId, orgId, body);
    if (row.business_type !== 'NON_PROPORTIONAL') throw new ApiError(400, 'WRONG_BUSINESS_TYPE', 'Structure applies to non-proportional contracts only.');
    const changes = {};
    const current = await repo.loadNpStructure(client, contractId);
    const typeName = row.treaty_type_name || '';
    const perilMode = calcs.perilModeFromTreatyType(typeName);
    const stopLoss = calcs.isStopLossType(typeName);
    const aggXl = calcs.isAggregateXlType(typeName);

    const layersIn = body.layers;
    const numberOfLayers = layersIn ? layersIn.length : (current.programme?.number_of_layers ?? Math.max(1, current.layers.length));
    const programmeIn = body.programme ?? (current.programme ? repo.mapNpStructure(current).programme : {});
    const programme = programmeColumns(programmeIn, numberOfLayers);
    await client.query(
      `INSERT INTO public.bk_np_programme (contract_id, number_of_layers, deductible, accounting_method, xl_type, accounts, est_gnpi, brokerage_pct, taxes_pct, no_claims_bonus_pct, profit_commission_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (contract_id) DO UPDATE SET number_of_layers=EXCLUDED.number_of_layers, deductible=EXCLUDED.deductible, accounting_method=EXCLUDED.accounting_method, xl_type=EXCLUDED.xl_type, accounts=EXCLUDED.accounts, est_gnpi=EXCLUDED.est_gnpi, brokerage_pct=EXCLUDED.brokerage_pct, taxes_pct=EXCLUDED.taxes_pct, no_claims_bonus_pct=EXCLUDED.no_claims_bonus_pct, profit_commission_pct=EXCLUDED.profit_commission_pct`,
      [contractId, programme.number_of_layers, programme.deductible, programme.accounting_method, programme.xl_type, programme.accounts, programme.est_gnpi, programme.brokerage_pct, programme.taxes_pct, programme.no_claims_bonus_pct, programme.profit_commission_pct]);
    Object.assign(changes, diffRecords(current.programme ? programmeColumns(repo.mapNpStructure(current).programme, current.programme.number_of_layers) : {}, programme, 'bk_np_programme'));

    if (layersIn) {
      const contractClassIds = (await repo.loadClasses(client, contractId)).map((c) => c.id);
      // Derived columns: attachment cascade + EP / MDP% / ROL (Risk / CAT tables);
      // Stop Loss resolves limit + attachment from EPI × loss ratios; Aggregate XL
      // keeps its own per-layer deductible.
      let computed;
      if (stopLoss) {
        computed = layersIn.map((l) => { const r = calcs.stopLossResolve({ epi: l.epi, limitLrPct: l.limitLrPct, attachLrPct: l.attachLrPct }); return { ...l, limit: r.limit, attachment: r.attachment, earnedPremium: null, mdpPct: null, rol: null }; });
      } else if (aggXl) {
        computed = layersIn.map((l) => ({ ...l, attachment: calcs.toNumber(l.attachment ?? l.deductible), earnedPremium: null, mdpPct: null, rol: null }));
      } else {
        computed = calcs.computeLayers(layersIn, programme.deductible);
      }
      await client.query(`DELETE FROM public.bk_np_layer WHERE contract_id=$1 AND layer_number > $2`, [contractId, computed.length]);
      const stored = [];
      for (let i = 0; i < computed.length; i++) {
        const l = computed[i];
        const covers = calcs.applyPerilMode(perilMode, { riskCover: l.riskCover, catCover: l.catCover });
        const vals = {
          layer_number: i + 1, layer_limit: l.limit ?? null, attachment: l.attachment ?? null, aggregate_limit: l.aggregateLimit ?? null, egnpi: l.egnpi ?? null,
          rate: l.rate ?? null, earned_premium: l.earnedPremium ?? null, mdp: l.mdp ?? null, mdp_pct: l.mdpPct ?? null,
          num_reinstatements: l.numReinstatements ?? null, reinstatement_pct: l.reinstatementPct ?? null,
          aad: l.aad === true, aad_amount: l.aad === true ? (l.aadAmount ?? null) : null,
          peril_scope: calcs.perilScopeFromCovers(covers), rol: l.rol ?? null,
          attach_lr_pct: l.attachLrPct ?? null, limit_lr_pct: l.limitLrPct ?? null, epi: l.epi ?? null, aggregate_deductible: l.aggregateDeductible ?? null,
          class_ids: l.classIds ?? contractClassIds,
        };
        const { rows: [saved] } = await client.query(
          `INSERT INTO public.bk_np_layer (contract_id, layer_number, layer_limit, attachment, aggregate_limit, egnpi, rate, earned_premium, mdp, mdp_pct, num_reinstatements, reinstatement_pct, aad, aad_amount, peril_scope, rol, attach_lr_pct, limit_lr_pct, epi, aggregate_deductible)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
           ON CONFLICT (contract_id, layer_number) DO UPDATE SET layer_limit=EXCLUDED.layer_limit, attachment=EXCLUDED.attachment, aggregate_limit=EXCLUDED.aggregate_limit, egnpi=EXCLUDED.egnpi, rate=EXCLUDED.rate, earned_premium=EXCLUDED.earned_premium, mdp=EXCLUDED.mdp, mdp_pct=EXCLUDED.mdp_pct, num_reinstatements=EXCLUDED.num_reinstatements, reinstatement_pct=EXCLUDED.reinstatement_pct, aad=EXCLUDED.aad, aad_amount=EXCLUDED.aad_amount, peril_scope=EXCLUDED.peril_scope, rol=EXCLUDED.rol, attach_lr_pct=EXCLUDED.attach_lr_pct, limit_lr_pct=EXCLUDED.limit_lr_pct, epi=EXCLUDED.epi, aggregate_deductible=EXCLUDED.aggregate_deductible
           RETURNING layer_id`,
          [contractId, vals.layer_number, vals.layer_limit, vals.attachment, vals.aggregate_limit, vals.egnpi, vals.rate, vals.earned_premium, vals.mdp, vals.mdp_pct, vals.num_reinstatements, vals.reinstatement_pct, vals.aad, vals.aad_amount, vals.peril_scope, vals.rol, vals.attach_lr_pct, vals.limit_lr_pct, vals.epi, vals.aggregate_deductible]);
        await client.query(`DELETE FROM public.bk_np_layer_class_of_business WHERE layer_id=$1`, [saved.layer_id]);
        for (const cid of vals.class_ids) await client.query(`INSERT INTO public.bk_np_layer_class_of_business (layer_id, class_of_business_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [saved.layer_id, cid]);
        stored.push(vals);
      }
      const beforeLayers = current.layers.map((l) => ({
        layer_number: l.layer_number, layer_limit: calcs.toNumber(l.layer_limit), attachment: calcs.toNumber(l.attachment), aggregate_limit: calcs.toNumber(l.aggregate_limit), egnpi: calcs.toNumber(l.egnpi),
        rate: calcs.toNumber(l.rate), earned_premium: calcs.toNumber(l.earned_premium), mdp: calcs.toNumber(l.mdp), mdp_pct: calcs.toNumber(l.mdp_pct), num_reinstatements: l.num_reinstatements,
        reinstatement_pct: calcs.toNumber(l.reinstatement_pct), aad: l.aad, aad_amount: calcs.toNumber(l.aad_amount), peril_scope: l.peril_scope, rol: calcs.toNumber(l.rol),
        attach_lr_pct: calcs.toNumber(l.attach_lr_pct), limit_lr_pct: calcs.toNumber(l.limit_lr_pct), epi: calcs.toNumber(l.epi), aggregate_deductible: calcs.toNumber(l.aggregate_deductible), class_ids: l.class_ids,
      }));
      Object.assign(changes, diffList(beforeLayers, stored, 'bk_np_layer.rows'));
    }

    await writeAudit(client, { contractId, umr: row.umr, userId: user.userId, action: 'NP_STRUCTURE_UPDATE', changes });
    await bumpVersion(client, contractId);
    return buildBundle(client, await repo.loadContractRow(client, contractId, orgId));
  });
}

/* ─────────────────────────── amend UMR ────────────────────────────── */
export async function amendUmr(user, contractId, { newUmr, reason }) {
  const orgId = orgOf(user);
  return withTransaction(async (client) => {
    const row = await lockContract(client, contractId, orgId, {});
    if (newUmr === row.umr) throw new ApiError(400, 'VALIDATION_FAILED', 'The new UMR is the same as the current one.', { fields: [{ path: 'newUmr', message: 'unchanged' }] });
    const owner = await findUmrOwner(client, newUmr);
    if (owner) throw umrTakenError(newUmr, owner, orgId);
    try {
      await client.query(`UPDATE public.bk_contract SET umr=$2 WHERE contract_id=$1`, [contractId, newUmr]);
    } catch (e) {
      if (e.code === '23505') throw umrTakenError(newUmr, await findUmrOwner(pool, newUmr), orgId);
      throw e;
    }
    await client.query(`INSERT INTO public.bk_umr_history (contract_id, old_umr, new_umr, changed_by, reason) VALUES ($1,$2,$3,$4,$5)`, [contractId, row.umr, newUmr, user.userId, reason]);
    await writeAudit(client, { contractId, umr: newUmr, userId: user.userId, action: 'AMEND_UMR', changes: { 'bk_contract.umr': { from: row.umr, to: newUmr } }, meta: { reason } });
    const rowVersion = await bumpVersion(client, contractId);
    return { contractId, umr: newUmr, oldUmr: row.umr, rowVersion };
  });
}

/* ─────────────────────────── status pipeline ──────────────────────── */
/** Every required field from capture-flow.md, on every step of this contract. */
export async function missingForLeavingDraft(db, row) {
  const classes = await repo.loadClasses(db, row.contract_id);
  const header = { countryId: row.country_id, cedantId: row.cedant_id, treatyTypeId: row.treaty_type_id, classIds: classes.map((c) => c.id), brokerId: row.broker_id, currencyId: row.currency_id, inceptionDate: row.inception_date, experienceStartYear: row.experience_start_year };
  if (row.business_type === 'PROPORTIONAL') {
    const pd = repo.mapPropDetail(await repo.loadPropDetail(db, row.contract_id));
    const slice = { ...header, ...pd.detail,
      commissionMode: String(pd.commissions.mode || 'FIXED').toLowerCase(), fixedCommissionQSPct: pd.commissions.fixedCommissionQSPct, fixedCommissionSurplusPct: pd.commissions.fixedCommissionSurplusPct,
      slidingMinLossRatio: pd.commissions.slidingMinLossRatio, slidingMaxLossRatio: pd.commissions.slidingMaxLossRatio, slidingMinCommission: pd.commissions.slidingMinCommission, slidingMaxCommission: pd.commissions.slidingMaxCommission,
      provisionalCommissionPct: pd.commissions.provisionalCommissionPct, slidingTable: pd.commissions.slidingTable,
      lossPartEnabled: pd.lossParticipation.enabled, minLossRatioPct: pd.lossParticipation.minLossRatioPct, maxLossRatioPct: pd.lossParticipation.maxLossRatioPct, reinsurerSharePct: pd.lossParticipation.reinsurerSharePct };
    return calcs.propMissingRequiredFields(slice, { tMode: calcs.treatyModeFromType(row.treaty_type_name), commMode: slice.commissionMode });
  }
  const missing = calcs.npMissingRequiredFields(header);
  const np = repo.mapNpStructure(await repo.loadNpStructure(db, row.contract_id));
  const typeName = row.treaty_type_name || '';
  if (!np.layers.length) missing.push('Structure (at least one layer)');
  np.layers.forEach((l, i) => {
    if (calcs.isStopLossType(typeName)) {
      if (!(l.epi > 0)) missing.push(`Layer ${i + 1} EPI`);
      if (l.attachLrPct == null) missing.push(`Layer ${i + 1} Attach LR %`);
      if (l.limitLrPct == null) missing.push(`Layer ${i + 1} Limit LR %`);
    } else if (calcs.isAggregateXlType(typeName)) {
      if (!(l.aggregateLimit > 0)) missing.push(`Layer ${i + 1} Aggregate Limit`);
    } else {
      if (!(l.limit > 0)) missing.push(`Layer ${i + 1} Limit`);
      if (l.attachment == null) missing.push(`Layer ${i + 1} Deductible`);
    }
  });
  if (!calcs.isStopLossType(typeName) && !calcs.isAggregateXlType(typeName) && np.programme.deductible == null) missing.push('Deductible');
  return missing;
}

export async function changeStatus(user, contractId, body) {
  const orgId = orgOf(user);
  return withTransaction(async (client) => {
    const row = await lockContract(client, contractId, orgId, body);
    const to = body.status;
    if (to === row.status) return { contractId, status: row.status, rowVersion: row.row_version, unchanged: true };
    if (!calcs.canTransition(row.status, to)) {
      throw new ApiError(422, 'INVALID_TRANSITION', `A ${row.status} contract cannot move to ${to}.`, { from: row.status, to, allowed: calcs.allowedNextStatuses(row.status) });
    }
    if (row.status === 'DRAFT' && to !== 'NTU' && to !== 'CANCELLED') {
      const missing = await missingForLeavingDraft(client, row);
      if (missing.length) throw new ApiError(422, 'REQUIRED_FIELDS', `Required: ${missing.join(', ')}`, { missing });
    }
    await client.query(`UPDATE public.bk_contract SET status=$2 WHERE contract_id=$1`, [contractId, to]);
    await writeAudit(client, { contractId, umr: row.umr, userId: user.userId, action: 'STATUS_CHANGE', changes: { 'bk_contract.status': { from: row.status, to } } });
    const rowVersion = await bumpVersion(client, contractId);
    return { contractId, status: to, rowVersion };
  });
}
