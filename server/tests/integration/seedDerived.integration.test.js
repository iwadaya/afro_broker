// The derived columns the seeds store must equal what shared/broking/calcs.js
// computes from the same inputs (prompt 09: "DB derived columns match calcs for
// seeds"). Runs against the migrated + seeded database (TEST_WITH_DB=1).
import { describe, it, expect, afterAll } from 'vitest';
import { pool, shouldSkipDb, closePools } from './helpers.js';
import * as calcs from '../../../shared/broking/calcs.js';

const QSS = '00000000-0000-0000-0000-00000000c001';
const CAT = '00000000-0000-0000-0000-00000000c002';
const n = (v) => (v == null ? null : Number(v));

describe.skipIf(shouldSkipDb)('seeded derived columns vs calcs', () => {
  afterAll(async () => { await closePools(); });

  it('Quota Share & Surplus: retention / cession amounts, capacity, UW year and description', async () => {
    const { rows: [c] } = await pool.query(
      `SELECT c.uw_year, c.inception_date, c.renewal_date, c.contract_description, ced.company_name, tt.treaty_type, cnt.country_code, d.*
         FROM public.bk_contract c JOIN public.bk_prop_details d USING (contract_id)
         JOIN public.companies ced ON ced.company_id=c.cedant_id JOIN public.treaty_type tt ON tt.treaty_type_id=c.treaty_type_id JOIN public.country cnt ON cnt.country_id=c.country_id
        WHERE c.contract_id=$1`, [QSS]);
    const { rows: classes } = await pool.query(`SELECT cob.class_of_business FROM public.bk_contract_class_of_business x JOIN public.class_of_business cob USING (class_of_business_id) WHERE x.contract_id=$1 ORDER BY x.sort_order`, [QSS]);
    const mode = calcs.treatyModeFromType(c.treaty_type);
    expect(mode).toBe('both');
    expect(n(c.retention_amt)).toBe(calcs.retentionAmt(c.qs_limit, c.retention_pct));
    expect(n(c.cession_amt)).toBe(calcs.cessionAmt(c.qs_limit, c.cession_pct));
    expect(n(c.cession_pct)).toBe(calcs.cessionFromRetention(c.retention_pct));
    expect(n(c.total_capacity)).toBe(calcs.totalCapacity({ mode, qsLimit: c.qs_limit, surplusMaxRetention: c.surplus_max_retention, numLines: c.num_lines }));
    expect(c.uw_year).toBe(calcs.uwYearFromInception(c.inception_date));
    expect(c.renewal_date).toBe(calcs.defaultRenewalDate(c.inception_date));
    expect(c.contract_description).toBe(calcs.buildContractDescription({ uwYear: c.uw_year, cedantName: c.company_name, treatyTypeName: c.treaty_type, classNames: classes.map((x) => x.class_of_business), countryCode: c.country_code }));
  });

  it('CAT XL: attachment cascade, earned premium, MDP%, ROL and the peril scope', async () => {
    const { rows: [p] } = await pool.query(`SELECT * FROM public.bk_np_programme WHERE contract_id=$1`, [CAT]);
    const { rows: [h] } = await pool.query(`SELECT tt.treaty_type FROM public.bk_contract c JOIN public.treaty_type tt ON tt.treaty_type_id=c.treaty_type_id WHERE c.contract_id=$1`, [CAT]);
    const { rows: layers } = await pool.query(`SELECT * FROM public.bk_np_layer WHERE contract_id=$1 ORDER BY layer_number`, [CAT]);
    expect(layers).toHaveLength(p.number_of_layers);
    const computed = calcs.computeLayers(layers.map((l) => ({ limit: l.layer_limit, egnpi: l.egnpi, rate: l.rate, mdp: l.mdp })), p.deductible);
    const mode = calcs.perilModeFromTreatyType(h.treaty_type);
    layers.forEach((l, i) => {
      expect(n(l.attachment)).toBe(computed[i].attachment);
      expect(n(l.earned_premium)).toBe(computed[i].earnedPremium);
      expect(n(l.mdp_pct)).toBeCloseTo(computed[i].mdpPct, 6);
      expect(n(l.rol)).toBeCloseTo(computed[i].rol, 6);
      expect(l.peril_scope).toBe(calcs.perilScopeFromCovers(calcs.applyPerilMode(mode, {})));
      if (!l.aad) expect(l.aad_amount).toBeNull();
    });
    const totals = calcs.layerTotals(layers.map((l) => ({ limit: l.layer_limit, attachment: l.attachment, aggregateLimit: l.aggregate_limit, egnpi: l.egnpi, rate: l.rate, earnedPremium: l.earned_premium, mdp: l.mdp, numReinstatements: l.num_reinstatements })));
    expect(totals).toMatchObject({ limit: 30000000, deductible: 2500000, earnedPremium: 3240000, reinstatements: 2 });
  });
});
