// server/tests/integration/broking.integration.test.js — supertest coverage of
// every /api/broking endpoint, including the 409 (UMR taken / stale write) cases
// and the org-scoping (IDOR) rules. Needs TEST_WITH_DB=1 + a migrated, seeded DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools, pool, refIds, BROKER_USER_ID, ADMIN_USER_ID, OTHER_ORG_USER_ID } from './helpers.js';
import * as calcs from '../../../shared/broking/calcs.js';

const SEED_QSS = '00000000-0000-0000-0000-00000000c001';
const SEED_CAT = '00000000-0000-0000-0000-00000000c002';
const TAG = Date.now().toString(36).toUpperCase().slice(-5);
const umr = (s) => `B0621T${TAG}${s}`;

describe.skipIf(shouldSkipDb)('integration: /api/broking', () => {
  let h, me, admin, other, refs;

  beforeAll(async () => {
    h = await bootApp();
    me = h.as(BROKER_USER_ID); admin = h.as(ADMIN_USER_ID); other = h.as(OTHER_ORG_USER_ID);
    refs = await refIds();
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM public.bk_contract WHERE umr LIKE 'B0621T%' AND parent_contract_id IS NOT NULL`);
    await pool.query(`DELETE FROM public.bk_contract WHERE umr LIKE 'B0621T%' OR umr LIKE 'B0999T%'`);
    await closePools();
  });

  const fullHeader = (over = {}) => ({
    countryId: refs.countryId, cedantId: refs.cedantId, brokerId: refs.brokerId, currencyId: refs.currencyId,
    treatyTypeId: refs.type('Quota Share & Surplus'), classIds: [refs.cls('Fire'), refs.cls('Engineering')],
    altContractId: 'KRE-2026-01', inceptionDate: '2026-01-01', experienceStartYear: 2016, ...over,
  });

  /* ───────────────────────────── auth + settings ───────────────────────────── */
  describe('auth + settings', () => {
    it('every route requires authentication', async () => {
      for (const [m, p] of [['get', '/api/broking/settings'], ['get', '/api/broking/contracts'], ['post', '/api/broking/contracts'], ['get', `/api/broking/contracts/${SEED_QSS}`], ['put', `/api/broking/contracts/${SEED_QSS}/header`], ['patch', `/api/broking/contracts/${SEED_QSS}/status`]]) {
        const res = await h.anon[m](p).send({});
        expect(res.status, `${m} ${p}`).toBe(401);
        expect(res.body.code).toBe('UNAUTHORIZED');
      }
    });
    it('exposes the org Lloyd\'s broker number as the UMR prefix', async () => {
      const res = await me.get('/api/broking/settings');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ lloydsBrokerNo: '0621', umrPrefix: 'B0621', orgName: 'Afro-Asian Re Brokers' });
    });
  });

  /* ───────────────────────────── search ───────────────────────────── */
  describe('GET /contracts?search=', () => {
    it('finds by UMR prefix, cedant, UW year and status; the other organisation sees nothing', async () => {
      const umrs = async (client, q) => (await client.get(`/api/broking/contracts?search=${encodeURIComponent(q)}`)).body.map((c) => c.umr);
      expect(await umrs(me, 'b0621dar26')).toEqual(expect.arrayContaining(['B0621DAR26TR001', 'B0621DAR26CX002']));
      expect(await umrs(me, 'kenya')).toEqual(expect.arrayContaining(['B0621DAR26TR001']));
      expect(await umrs(me, '2026')).toEqual(expect.arrayContaining(['B0621DAR26CX002']));
      expect(await umrs(me, 'draft')).toEqual(expect.arrayContaining(['B0621DAR26TR001']));
      expect(await umrs(me, 'zzz-nothing')).toEqual([]);
      expect(await umrs(other, 'B0621')).toEqual([]);
    });
    it('escapes LIKE wildcards in the search term (parameterised query)', async () => {
      const res = await me.get(`/api/broking/contracts?search=${encodeURIComponent('%')}`);
      expect(res.status).toBe(200); expect(res.body).toEqual([]);
      const inj = await me.get(`/api/broking/contracts?search=${encodeURIComponent("' OR 1=1 --")}`);
      expect(inj.status).toBe(200); expect(inj.body).toEqual([]);
    });
    it('rows carry the list fields', async () => {
      const res = await me.get('/api/broking/contracts?search=B0621DAR26TR001');
      expect(res.body[0]).toMatchObject({ contractId: SEED_QSS, businessType: 'PROPORTIONAL', status: 'DRAFT', uwYear: 2026, cedantName: 'Kenya Re', treatyTypeName: 'Quota Share & Surplus', currencyCode: 'USD' });
    });
  });

  /* ───────────────────────────── by-umr ───────────────────────────── */
  describe('GET /contracts/by-umr/:umr', () => {
    it('400 on a bad format, after normalising', async () => {
      const res = await me.get('/api/broking/contracts/by-umr/not-a-umr');
      expect(res.status).toBe(400); expect(res.body.code).toBe('VALIDATION_FAILED');
    });
    it('200 with the owning contract, normalising case and spaces', async () => {
      const res = await me.get(`/api/broking/contracts/by-umr/${encodeURIComponent(' b0621 dar26tr001 ')}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ contractId: SEED_QSS, umr: 'B0621DAR26TR001', cedant: 'Kenya Re', treatyType: 'Quota Share & Surplus', uwYear: 2026 });
    });
    it('404 when the UMR is free', async () => {
      const res = await me.get(`/api/broking/contracts/by-umr/${umr('FREE')}`);
      expect(res.status).toBe(404); expect(res.body.code).toBe('UMR_AVAILABLE');
    });
    it('reports a UMR owned by another organisation as taken without leaking the contract', async () => {
      const res = await other.get('/api/broking/contracts/by-umr/B0621DAR26TR001');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ contractId: null, cedant: null, treatyType: null, uwYear: null, ownedByOtherOrganisation: true });
    });
  });

  /* ───────────────────────────── create ───────────────────────────── */
  describe('POST /contracts', () => {
    it('creates a DRAFT and returns {contractId, umr}; normalises the UMR; writes the audit row', async () => {
      const res = await me.post('/api/broking/contracts', { umr: umr('p1').toLowerCase(), businessType: 'PROPORTIONAL' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ umr: umr('P1'), businessType: 'PROPORTIONAL', status: 'DRAFT', rowVersion: 1 });
      expect(res.body.contractId).toMatch(/^[0-9a-f-]{36}$/);
      const audit = await me.get(`/api/broking/contracts/${res.body.contractId}/audit`);
      expect(audit.body.map((a) => a.action)).toEqual(['CREATE']);
    });
    it('409 when the UMR is taken, naming the owning contract', async () => {
      const res = await me.post('/api/broking/contracts', { umr: 'B0621DAR26TR001', businessType: 'PROPORTIONAL' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'UMR_TAKEN', contractId: SEED_QSS, cedant: 'Kenya Re', treatyType: 'Quota Share & Surplus', uwYear: 2026 });
      expect(res.body.error).toContain('Kenya Re');
    });
    it('409 when another organisation owns the UMR, without leaking the contract', async () => {
      const res = await other.post('/api/broking/contracts', { umr: 'B0621DAR26TR001', businessType: 'PROPORTIONAL' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'UMR_TAKEN', contractId: null, ownedByOtherOrganisation: true });
    });
    it('400 on a bad UMR or business type with fields[]', async () => {
      const bad = await me.post('/api/broking/contracts', { umr: 'X123', businessType: 'PROPORTIONAL' });
      expect(bad.status).toBe(400); expect(bad.body.code).toBe('VALIDATION_FAILED');
      expect(bad.body.fields.some((f) => f.path === 'umr')).toBe(true);
      const badType = await me.post('/api/broking/contracts', { umr: umr('P2'), businessType: 'FACULTATIVE' });
      expect(badType.status).toBe(400);
    });
    it('renewal copies the header and the proportional details and links the parent', async () => {
      const res = await me.post('/api/broking/contracts', { umr: umr('R1'), businessType: 'PROPORTIONAL', parentContractId: SEED_QSS });
      expect(res.status).toBe(201);
      expect(res.body.parentContractId).toBe(SEED_QSS);
      const b = (await me.get(`/api/broking/contracts/${res.body.contractId}`)).body;
      expect(b.parentUmr).toBe('B0621DAR26TR001');
      expect(b.header).toMatchObject({ cedantName: 'Kenya Re', treatyTypeName: 'Quota Share & Surplus', inceptionDate: '2027-01-01', renewalDate: '2028-01-01', uwYear: 2027, experienceStartYear: 2016 });
      expect(b.header.classNames).toEqual(['Fire', 'Engineering']);
      expect(b.header.contractDescription).toBe('2027 Kenya Re Quota Share & Surplus (Fire, Engineering) KE');
      expect(b.propDetail.detail).toMatchObject({ qsLimit: 10_000_000, retentionPct: 30, retentionAmt: 3_000_000, totalCapacity: 25_000_000 });
      expect(b.propDetail.commissions).toMatchObject({ mode: 'FIXED', fixedCommissionQSPct: 32.5, lcfYears: 3 });
      expect(b.propDetail.epiSplit).toHaveLength(2);
      const audit = await me.get(`/api/broking/contracts/${res.body.contractId}/audit`);
      expect(audit.body[0]).toMatchObject({ action: 'RENEW' });
    });
    it('renewal of a CAT XL copies the programme and the three layers', async () => {
      const res = await me.post('/api/broking/contracts', { umr: umr('R2'), businessType: 'NON_PROPORTIONAL', parentContractId: SEED_CAT });
      expect(res.status).toBe(201);
      const b = (await me.get(`/api/broking/contracts/${res.body.contractId}`)).body;
      expect(b.npStructure.programme).toMatchObject({ numberOfLayers: 3, deductible: 2_500_000, xlType: 'Gross XL' });
      expect(b.npStructure.layers.map((l) => l.attachment)).toEqual([2_500_000, 7_500_000, 17_500_000]);
      expect(b.npStructure.layers[2]).toMatchObject({ aad: true, aadAmount: 2_000_000, perilScope: 'CAT' });
    });
    it('renewal must keep the parent business type and cannot cross organisations', async () => {
      const wrong = await me.post('/api/broking/contracts', { umr: umr('R3'), businessType: 'NON_PROPORTIONAL', parentContractId: SEED_QSS });
      expect(wrong.status).toBe(400);
      const foreign = await other.post('/api/broking/contracts', { umr: `B0999T${TAG}R4`, businessType: 'PROPORTIONAL', parentContractId: SEED_QSS });
      expect(foreign.status).toBe(404);
    });
  });

  /* ───────────────────────────── header ───────────────────────────── */
  describe('GET/PUT /contracts/:id/header', () => {
    let id;
    beforeAll(async () => { id = (await me.post('/api/broking/contracts', { umr: umr('H1'), businessType: 'PROPORTIONAL' })).body.contractId; });

    it('starts empty', async () => {
      const res = await me.get(`/api/broking/contracts/${id}/header`);
      expect(res.status).toBe(200);
      expect(res.body.header).toMatchObject({ countryId: null, cedantId: null, classIds: [], uwYear: null, renewalDate: null });
    });
    it('saves Contract Details and derives UW year, the renewal default and the description', async () => {
      const res = await me.put(`/api/broking/contracts/${id}/header`, { rowVersion: 1, header: fullHeader() });
      expect(res.status).toBe(200);
      expect(res.body.rowVersion).toBe(2);
      expect(res.body.header).toMatchObject({ uwYear: 2026, renewalDate: '2027-01-01', cedantName: 'Kenya Re', countryCode: 'KE', currencyCode: 'USD', altContractId: 'KRE-2026-01', primaryClassOfBusinessId: refs.cls('Fire') });
      expect(res.body.header.classNames).toEqual(['Fire', 'Engineering']);
      expect(res.body.header.contractDescription).toBe('2026 Kenya Re Quota Share & Surplus (Fire, Engineering) KE');
      const audit = (await me.get(`/api/broking/contracts/${id}/audit`)).body;
      expect(audit[0].action).toBe('HEADER_UPDATE');
      expect(audit[0].changes['bk_contract.cedant_id']).toEqual({ from: null, to: refs.cedantId });
      expect(audit[0].changes['bk_contract_class_of_business.class_ids'].to).toHaveLength(2);
    });
    it('keeps an explicit renewal date', async () => {
      const res = await me.put(`/api/broking/contracts/${id}/header`, { rowVersion: 2, header: fullHeader({ renewalDate: '2026-12-31' }) });
      expect(res.status).toBe(200); expect(res.body.header.renewalDate).toBe('2026-12-31');
    });
    it('409 STALE_WRITE on a row_version mismatch; force overwrites', async () => {
      const stale = await me.put(`/api/broking/contracts/${id}/header`, { row_version: 1, header: fullHeader() });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: 'STALE_WRITE', current: 3, expected: 1 });
      const forced = await me.put(`/api/broking/contracts/${id}/header`, { rowVersion: 1, force: true, header: fullHeader() });
      expect(forced.status).toBe(200); expect(forced.body.rowVersion).toBe(4);
    });
    it('rejects a treaty type of the wrong category', async () => {
      const res = await me.put(`/api/broking/contracts/${id}/header`, { header: fullHeader({ treatyTypeId: refs.type('CAT XL') }) });
      expect(res.status).toBe(400); expect(res.body.fields[0].path).toBe('header.treatyTypeId');
    });
    it('rejects an unknown reference id (FK) with 400, not 500', async () => {
      const res = await me.put(`/api/broking/contracts/${id}/header`, { header: fullHeader({ cedantId: '00000000-0000-0000-0000-0000000000ff' }) });
      expect(res.status).toBe(400); expect(res.body.code).toBe('FK_VIOLATION');
    });
    it('is invisible to another organisation (404 on read and write) and to a malformed id', async () => {
      expect((await other.get(`/api/broking/contracts/${id}/header`)).status).toBe(404);
      expect((await other.put(`/api/broking/contracts/${id}/header`, { header: fullHeader() })).status).toBe(404);
      expect((await me.get('/api/broking/contracts/not-a-uuid/header')).status).toBe(404);
    });
  });

  /* ───────────────────────────── prop-detail ───────────────────────────── */
  describe('GET/PUT /contracts/:id/prop-detail', () => {
    let id;
    const detailBody = () => ({
      header: fullHeader(),
      detail: { triangulationsAvailable: true, qsLimit: '10,000,000', retentionPct: 30, cessionPct: 70, surplusMaxRetention: 3_000_000, numLines: 5, eventLimit: 25_000_000, quotaShareEpi: 18_000_000, surplusEpi: 6_500_000, brokeragePct: 10, taxesPct: 2, lossCapPct: 150,
        retentionAmt: 1, cessionAmt: 1, totalCapacity: 1 },   // client-sent derived values are ignored
      commissions: { mode: 'fixed', fixedCommissionQSPct: 32.5, fixedCommissionSurplusPct: 30, profitCommissionPct: 15, lcfYears: 3, lcfExtinction: false, slidingTable: [] },
      lossParticipation: { enabled: true, minLossRatioPct: 70, maxLossRatioPct: 100, reinsurerSharePct: 50, slides: [{ minLr: 70, maxLr: 100, share: 50 }, { minLr: 100, maxLr: 120, share: 70 }] },
      epiSplit: [{ classId: refs.cls('Fire'), premium: 12_250_000 }, { classId: refs.cls('Engineering'), premium: 12_250_000 }],
    });
    beforeAll(async () => { id = (await me.post('/api/broking/contracts', { umr: umr('D1'), businessType: 'PROPORTIONAL' })).body.contractId; });

    it('400 WRONG_BUSINESS_TYPE on a non-proportional contract', async () => {
      const res = await me.get(`/api/broking/contracts/${SEED_CAT}/prop-detail`);
      expect(res.status).toBe(400); expect(res.body.code).toBe('WRONG_BUSINESS_TYPE');
    });
    it('upserts every table in one transaction and recomputes the derived columns server-side', async () => {
      const res = await me.put(`/api/broking/contracts/${id}/prop-detail`, { rowVersion: 1, ...detailBody() });
      expect(res.status).toBe(200);
      expect(res.body.rowVersion).toBe(2);
      expect(res.body.propDetail.detail).toMatchObject({ qsLimit: 10_000_000, retentionAmt: 3_000_000, cessionAmt: 7_000_000, totalCapacity: 25_000_000, lossCapPct: 150 });
      expect(res.body.propDetail.commissions).toMatchObject({ mode: 'FIXED', fixedCommissionQSPct: 32.5, lcfYears: 3, slidingTable: [] });
      expect(res.body.propDetail.lossParticipation).toMatchObject({ enabled: true, reinsurerSharePct: 50 });
      expect(res.body.propDetail.lossParticipation.slides).toEqual([{ minLr: 70, maxLr: 100, share: 50 }, { minLr: 100, maxLr: 120, share: 70 }]);
      expect(res.body.propDetail.epiSplit.map((r) => r.premium)).toEqual([12_250_000, 12_250_000]);
      const { rows } = await pool.query(`SELECT retention_amt::float8 AS r, cession_amt::float8 AS c, total_capacity::float8 AS t FROM public.bk_prop_details WHERE contract_id=$1`, [id]);
      expect(rows[0]).toEqual({ r: calcs.retentionAmt(10_000_000, 30), c: calcs.cessionAmt(10_000_000, 70), t: calcs.totalCapacity({ mode: 'both', qsLimit: 10_000_000, surplusMaxRetention: 3_000_000, numLines: 5 }) });
      const audit = (await me.get(`/api/broking/contracts/${id}/audit`)).body;
      expect(audit[0].action).toBe('PROP_DETAIL_UPDATE');
      expect(audit[0].changes['bk_prop_details.qs_limit']).toEqual({ from: null, to: 10_000_000 });
      expect(audit[0].changes['bk_loss_participation.enabled']).toEqual({ from: null, to: true });
    });
    it('reads back the same bundle', async () => {
      const res = await me.get(`/api/broking/contracts/${id}/prop-detail`);
      expect(res.status).toBe(200); expect(res.body.propDetail.detail.retentionAmt).toBe(3_000_000); expect(res.body.header.cedantName).toBe('Kenya Re');
    });
    it('saves a sliding scale with ≥2 rows and rejects a single row', async () => {
      const sliding = { mode: 'SLIDING', slidingMinLossRatio: 40, slidingMaxLossRatio: 80, slidingMinCommission: 20, slidingMaxCommission: 35, provisionalCommissionPct: 30, lcfYears: null, lcfExtinction: true, slidingTable: [{ lossRatioPct: 50, commissionPct: 35 }, { lossRatioPct: 60, commissionPct: 31 }] };
      const ok = await me.put(`/api/broking/contracts/${id}/prop-detail`, { commissions: sliding });
      expect(ok.status).toBe(200);
      expect(ok.body.propDetail.commissions).toMatchObject({ mode: 'SLIDING', lcfExtinction: true, lcfYears: null });
      expect(ok.body.propDetail.commissions.slidingTable).toEqual([{ lossRatioPct: 50, commissionPct: 35 }, { lossRatioPct: 60, commissionPct: 31 }]);
      const one = await me.put(`/api/broking/contracts/${id}/prop-detail`, { commissions: { ...sliding, slidingTable: [{ lossRatioPct: 50, commissionPct: 35 }] } });
      expect(one.status).toBe(400); expect(one.body.fields[0].path).toContain('commissions.slidingTable');
    });
    it('validates ranges: pct100, loss cap 0–1000, lcf_years 0–20, ≤5 LP slides with max > min', async () => {
      const cases = [
        [{ detail: { retentionPct: 150 } }, 'detail.retentionPct'],
        [{ detail: { lossCapPct: 1001 } }, 'detail.lossCapPct'],
        [{ detail: { qsLimit: -5 } }, 'detail.qsLimit'],
        [{ commissions: { lcfYears: 21 } }, 'commissions.lcfYears'],
        [{ lossParticipation: { slides: Array(6).fill({ minLr: 1, maxLr: 2, share: 3 }) } }, 'lossParticipation.slides'],
        [{ lossParticipation: { slides: [{ minLr: 80, maxLr: 70, share: 50 }] } }, 'lossParticipation.slides'],
      ];
      for (const [body, path] of cases) {
        const res = await me.put(`/api/broking/contracts/${id}/prop-detail`, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(res.body.fields.some((f) => f.path.startsWith(path)), `${path}: ${JSON.stringify(res.body.fields)}`).toBe(true);
      }
    });
    it('409 on a stale row_version and 404 for another organisation', async () => {
      const stale = await me.put(`/api/broking/contracts/${id}/prop-detail`, { rowVersion: 1, detail: { qsLimit: 1 } });
      expect(stale.status).toBe(409); expect(stale.body.code).toBe('STALE_WRITE');
      expect((await other.put(`/api/broking/contracts/${id}/prop-detail`, { detail: { qsLimit: 1 } })).status).toBe(404);
    });
  });

  /* ───────────────────────────── np-structure ───────────────────────────── */
  describe('GET/PUT /contracts/:id/np-structure', () => {
    let id;
    const layers3 = () => [
      { limit: 5_000_000, aggregateLimit: 10_000_000, egnpi: 80_000_000, rate: '1.8%', mdp: 1_200_000, numReinstatements: '1', reinstatementPct: 100, aad: false, aadAmount: 999, riskCover: true, catCover: true },
      { limit: 10_000_000, aggregateLimit: 20_000_000, egnpi: 80_000_000, rate: 1.35, mdp: 900_000, numReinstatements: 'UNLIMITED', reinstatementPct: 100, aad: false },
      { limit: 15_000_000, aggregateLimit: 30_000_000, egnpi: 80_000_000, rate: 0.9, mdp: 600_000, numReinstatements: '2', reinstatementPct: 100, aad: true, aadAmount: 2_000_000, attachment: 1 },
    ];
    const programme = { deductible: 2_500_000, xlType: 'Gross XL', accountingMethod: 'Losses Occurring', accounts: 'Quarterly', estGnpi: 80_000_000, brokeragePct: 10, taxesPct: 0 };
    beforeAll(async () => {
      id = (await me.post('/api/broking/contracts', { umr: umr('N1'), businessType: 'NON_PROPORTIONAL' })).body.contractId;
      await me.put(`/api/broking/contracts/${id}/header`, { header: fullHeader({ treatyTypeId: refs.type('CAT XL') }) });
    });

    it('400 WRONG_BUSINESS_TYPE on a proportional contract', async () => {
      expect((await me.get(`/api/broking/contracts/${SEED_QSS}/np-structure`)).status).toBe(400);
      expect((await me.put(`/api/broking/contracts/${SEED_QSS}/np-structure`, { layers: layers3() })).status).toBe(400);
    });
    it('saves programme + layers in one transaction with the cascade, EP, MDP%, ROL and forced peril scope', async () => {
      const res = await me.put(`/api/broking/contracts/${id}/np-structure`, { rowVersion: 2, programme, layers: layers3() });
      expect(res.status).toBe(200);
      const s = res.body.npStructure;
      expect(s.programme).toMatchObject({ numberOfLayers: 3, deductible: 2_500_000, accounts: 'Quarterly' });
      expect(s.layers.map((l) => l.attachment)).toEqual([2_500_000, 7_500_000, 17_500_000]);
      expect(s.layers.map((l) => l.earnedPremium)).toEqual([1_440_000, 1_080_000, 720_000]);
      expect(s.layers[0].mdpPct).toBeCloseTo(1_200_000 / 1_440_000, 6);
      expect(s.layers[0].rol).toBeCloseTo(0.288, 6);
      expect(s.layers.map((l) => l.perilScope)).toEqual(['CAT', 'CAT', 'CAT']);      // CAT XL forces cat only
      expect(s.layers.map((l) => l.numReinstatements)).toEqual([1, -1, 2]);
      expect(s.layers[0].aadAmount).toBeNull();                                        // AAD unticked → amount dropped
      expect(s.layers[2]).toMatchObject({ aad: true, aadAmount: 2_000_000 });
      expect(s.layers[0].classIds).toEqual(expect.arrayContaining([refs.cls('Fire'), refs.cls('Engineering')]));
      const { rows } = await pool.query(`SELECT earned_premium::float8 AS ep, rol::float8 AS rol FROM public.bk_np_layer WHERE contract_id=$1 ORDER BY layer_number`, [id]);
      const expected = calcs.computeLayers(layers3(), 2_500_000);
      rows.forEach((r, i) => { expect(r.ep).toBe(expected[i].earnedPremium); expect(r.rol).toBeCloseTo(expected[i].rol, 6); });
      const audit = (await me.get(`/api/broking/contracts/${id}/audit`)).body;
      expect(audit[0].action).toBe('NP_STRUCTURE_UPDATE');
      expect(audit[0].changes['bk_np_layer.rows'].to).toHaveLength(3);
    });
    it('deletes the layers above the new count', async () => {
      const res = await me.put(`/api/broking/contracts/${id}/np-structure`, { programme, layers: layers3().slice(0, 2) });
      expect(res.status).toBe(200);
      expect(res.body.npStructure.layers).toHaveLength(2);
      expect(res.body.npStructure.programme.numberOfLayers).toBe(2);
      expect((await pool.query(`SELECT count(*)::int AS n FROM public.bk_np_layer WHERE contract_id=$1`, [id])).rows[0].n).toBe(2);
    });
    it('validates: 1–20 layers, % reinstatements 0–1000, money ≥ 0', async () => {
      expect((await me.put(`/api/broking/contracts/${id}/np-structure`, { layers: Array(21).fill(layers3()[0]) })).status).toBe(400);
      expect((await me.put(`/api/broking/contracts/${id}/np-structure`, { layers: [] })).status).toBe(400);
      const pct = await me.put(`/api/broking/contracts/${id}/np-structure`, { layers: [{ ...layers3()[0], reinstatementPct: 1001 }] });
      expect(pct.status).toBe(400); expect(pct.body.fields[0].path).toBe('layers.0.reinstatementPct');
      expect((await me.put(`/api/broking/contracts/${id}/np-structure`, { layers: [{ ...layers3()[0], limit: -1 }] })).status).toBe(400);
    });
    it('Risk & CAT XL keeps the per-layer cover choice', async () => {
      const rc = (await me.post('/api/broking/contracts', { umr: umr('N2'), businessType: 'NON_PROPORTIONAL' })).body.contractId;
      await me.put(`/api/broking/contracts/${rc}/header`, { header: fullHeader({ treatyTypeId: refs.type('Risk & CAT XL') }) });
      const res = await me.put(`/api/broking/contracts/${rc}/np-structure`, { programme, layers: [{ ...layers3()[0], riskCover: true, catCover: false }, { ...layers3()[1], riskCover: false, catCover: true }, { ...layers3()[2], riskCover: true, catCover: true }] });
      expect(res.status).toBe(200);
      expect(res.body.npStructure.layers.map((l) => l.perilScope)).toEqual(['RISK', 'CAT', 'BOTH']);
    });
    it('Stop Loss resolves limit and attachment from EPI × loss ratios', async () => {
      const sl = (await me.post('/api/broking/contracts', { umr: umr('N3'), businessType: 'NON_PROPORTIONAL' })).body.contractId;
      await me.put(`/api/broking/contracts/${sl}/header`, { header: fullHeader({ treatyTypeId: refs.type('Stop Loss') }) });
      const res = await me.put(`/api/broking/contracts/${sl}/np-structure`, { programme: { estGnpi: 50_000_000 }, layers: [{ epi: 50_000_000, attachLrPct: 80, limitLrPct: 20 }] });
      expect(res.status).toBe(200);
      expect(res.body.npStructure.layers[0]).toMatchObject({ epi: 50_000_000, attachLrPct: 80, limitLrPct: 20, limit: 10_000_000, attachment: 40_000_000 });
    });
    it('409 on a stale row_version and 404 for another organisation', async () => {
      const stale = await me.put(`/api/broking/contracts/${id}/np-structure`, { rowVersion: 1, layers: layers3() });
      expect(stale.status).toBe(409); expect(stale.body.code).toBe('STALE_WRITE');
      expect((await other.put(`/api/broking/contracts/${id}/np-structure`, { layers: layers3() })).status).toBe(404);
      expect((await other.get(`/api/broking/contracts/${id}/np-structure`)).status).toBe(404);
    });
  });

  /* ───────────────────────────── amend-umr ───────────────────────────── */
  describe('POST /contracts/:id/amend-umr', () => {
    let id;
    beforeAll(async () => { id = (await me.post('/api/broking/contracts', { umr: umr('A1'), businessType: 'PROPORTIONAL' })).body.contractId; });
    it('changes the UMR, keeps the history and audits the reason', async () => {
      const res = await me.post(`/api/broking/contracts/${id}/amend-umr`, { newUmr: umr('a2').toLowerCase(), reason: 'Market reference re-issued by the slip leader' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ contractId: id, umr: umr('A2'), oldUmr: umr('A1'), rowVersion: 2 });
      const b = (await me.get(`/api/broking/contracts/${id}`)).body;
      expect(b.umr).toBe(umr('A2'));
      expect(b.umrHistory[0]).toMatchObject({ oldUmr: umr('A1'), newUmr: umr('A2'), reason: 'Market reference re-issued by the slip leader' });
      const audit = (await me.get(`/api/broking/contracts/${id}/audit`)).body;
      expect(audit[0]).toMatchObject({ action: 'AMEND_UMR', umr: umr('A2') });
      expect(audit[0].changes['bk_contract.umr']).toEqual({ from: umr('A1'), to: umr('A2') });
      expect((await me.get(`/api/broking/contracts/by-umr/${umr('A1')}`)).status).toBe(404);
    });
    it('rejects the same UMR, a taken UMR, a bad format and a missing reason', async () => {
      expect((await me.post(`/api/broking/contracts/${id}/amend-umr`, { newUmr: umr('A2'), reason: 'unchanged' })).status).toBe(400);
      const taken = await me.post(`/api/broking/contracts/${id}/amend-umr`, { newUmr: 'B0621DAR26CX002', reason: 'collides' });
      expect(taken.status).toBe(409); expect(taken.body).toMatchObject({ code: 'UMR_TAKEN', contractId: SEED_CAT });
      expect((await me.post(`/api/broking/contracts/${id}/amend-umr`, { newUmr: 'nope', reason: 'bad format' })).status).toBe(400);
      expect((await me.post(`/api/broking/contracts/${id}/amend-umr`, { newUmr: umr('A3'), reason: '' })).status).toBe(400);
      expect((await other.post(`/api/broking/contracts/${id}/amend-umr`, { newUmr: umr('A3'), reason: 'not mine' })).status).toBe(404);
    });
  });

  /* ───────────────────────────── status ───────────────────────────── */
  describe('PATCH /contracts/:id/status', () => {
    it('blocks leaving DRAFT until every required field is captured', async () => {
      const id = (await me.post('/api/broking/contracts', { umr: umr('S1'), businessType: 'PROPORTIONAL' })).body.contractId;
      const res = await me.patch(`/api/broking/contracts/${id}/status`, { status: 'SUBMITTED' });
      expect(res.status).toBe(422); expect(res.body.code).toBe('REQUIRED_FIELDS');
      expect(res.body.missing).toEqual(expect.arrayContaining(['Country', 'Cedant Name', 'Treaty Type', 'Line of Business', 'QS 100% Limit', 'Fixed QS Commission %']));
      // Header alone is not enough: the Treaty Detail required fields are checked too.
      await me.put(`/api/broking/contracts/${id}/header`, { header: fullHeader() });
      const still = await me.patch(`/api/broking/contracts/${id}/status`, { status: 'SUBMITTED' });
      expect(still.status).toBe(422); expect(still.body.missing).not.toContain('Country'); expect(still.body.missing).toContain('Surplus Max Retention');
    });
    it('walks the pipeline DRAFT→SUBMITTED→QUOTED, refuses a jump, allows the NTU exit, then freezes', async () => {
      const id = (await me.post('/api/broking/contracts', { umr: umr('S2'), businessType: 'PROPORTIONAL' })).body.contractId;
      await me.put(`/api/broking/contracts/${id}/prop-detail`, {
        header: fullHeader(),
        detail: { qsLimit: 10_000_000, retentionPct: 30, cessionPct: 70, surplusMaxRetention: 3_000_000, numLines: 5, quotaShareEpi: 18_000_000, surplusEpi: 6_500_000 },
        commissions: { mode: 'FIXED', fixedCommissionQSPct: 32.5, fixedCommissionSurplusPct: 30 },
        lossParticipation: { enabled: false },
      });
      const b = (await me.get(`/api/broking/contracts/${id}`)).body;
      const sub = await me.patch(`/api/broking/contracts/${id}/status`, { status: 'SUBMITTED', rowVersion: b.rowVersion });
      expect(sub.status).toBe(200); expect(sub.body.status).toBe('SUBMITTED');
      const stale = await me.patch(`/api/broking/contracts/${id}/status`, { status: 'QUOTED', rowVersion: b.rowVersion });
      expect(stale.status).toBe(409);
      const quoted = await me.patch(`/api/broking/contracts/${id}/status`, { status: 'QUOTED', rowVersion: sub.body.rowVersion });
      expect(quoted.status).toBe(200);
      const jump = await me.patch(`/api/broking/contracts/${id}/status`, { status: 'BOUND' });
      expect(jump.status).toBe(422); expect(jump.body).toMatchObject({ code: 'INVALID_TRANSITION', from: 'QUOTED', to: 'BOUND' });
      const bad = await me.patch(`/api/broking/contracts/${id}/status`, { status: 'LOST' });
      expect(bad.status).toBe(400);
      const ntu = await me.patch(`/api/broking/contracts/${id}/status`, { status: 'NTU' });
      expect(ntu.status).toBe(200);
      expect((await me.patch(`/api/broking/contracts/${id}/status`, { status: 'SUBMITTED' })).status).toBe(422);
      const audit = (await me.get(`/api/broking/contracts/${id}/audit`)).body;
      expect(audit.filter((a) => a.action === 'STATUS_CHANGE')).toHaveLength(3);
      expect((await other.patch(`/api/broking/contracts/${id}/status`, { status: 'CANCELLED' })).status).toBe(404);
    });
    it('a non-proportional contract needs its structure before leaving DRAFT', async () => {
      const id = (await me.post('/api/broking/contracts', { umr: umr('S3'), businessType: 'NON_PROPORTIONAL' })).body.contractId;
      await me.put(`/api/broking/contracts/${id}/header`, { header: fullHeader({ treatyTypeId: refs.type('CAT XL') }) });
      const missing = await me.patch(`/api/broking/contracts/${id}/status`, { status: 'SUBMITTED' });
      expect(missing.status).toBe(422); expect(missing.body.missing).toContain('Structure (at least one layer)');
      await me.put(`/api/broking/contracts/${id}/np-structure`, { programme: { deductible: 1_000_000 }, layers: [{ limit: 5_000_000, egnpi: 10_000_000, rate: 2 }] });
      expect((await me.patch(`/api/broking/contracts/${id}/status`, { status: 'SUBMITTED' })).status).toBe(200);
    });
  });

  /* ───────────────────────────── IDOR sweep ───────────────────────────── */
  describe('organisation scoping', () => {
    it('another organisation cannot reach a contract by UUID on any route', async () => {
      const id = SEED_QSS;
      const checks = [
        other.get(`/api/broking/contracts/${id}`), other.get(`/api/broking/contracts/${id}/audit`), other.get(`/api/broking/contracts/${id}/header`),
        other.get(`/api/broking/contracts/${id}/prop-detail`), other.put(`/api/broking/contracts/${id}/prop-detail`, { detail: {} }),
        other.post(`/api/broking/contracts/${id}/amend-umr`, { newUmr: `B0999T${TAG}X1`, reason: 'idor test' }), other.patch(`/api/broking/contracts/${id}/status`, { status: 'NTU' }),
      ];
      for (const res of await Promise.all(checks)) expect(res.status).toBe(404);
      // …and the contract is untouched.
      const b = (await me.get(`/api/broking/contracts/${id}`)).body;
      expect(b).toMatchObject({ umr: 'B0621DAR26TR001', status: 'DRAFT' });
    });
    it('an admin of the same organisation shares the contracts', async () => {
      expect((await admin.get(`/api/broking/contracts/${SEED_QSS}`)).status).toBe(200);
    });
  });
});
