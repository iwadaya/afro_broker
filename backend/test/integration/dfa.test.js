import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

let broker;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
});

/** A placement with an XoL layer and a proportional layer to read back. */
async function buildPlacement(api, { estGwp = 50_000_000 } = {}) {
  const cedant = await api('POST', '/api/cedants', {
    token: broker.token, body: { name: `Cedant ${Math.random().toString(36).slice(2, 8)}`, domicile: 'GB' },
  });
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: {
      cedant_id: cedant.body.id, class: 'Property Cat XoL',
      inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD',
      est_gwp: estGwp,
    },
  });
  const pid = placement.body.id;
  await api('POST', `/api/placements/${pid}/layers`, {
    token: broker.token,
    body: {
      name: '5m xs 5m', type: 'XoL', attachment: 5_000_000, limit_amt: 5_000_000,
      order_pct: 100, premium100: 900_000, currency: 'USD',
      reinstatements: '2', reinstatement_pct: 100,
    },
  });
  await api('POST', `/api/placements/${pid}/layers`, {
    token: broker.token,
    body: {
      name: 'QS 20%', type: 'QS', attachment: 0,
      order_pct: 100, premium100: 10_000_000, currency: 'USD',
    },
  });
  return pid;
}

test('GET /api/dfa/portfolio assembles calibration and the current structure', async () => {
  await withServer(async (api) => {
    const pid = await buildPlacement(api);

    const resp = await api('GET', '/api/dfa/portfolio', { token: broker.token });
    assert.equal(resp.status, 200);

    const block = resp.body.placements.find((p) => p.id === pid);
    assert.ok(block, 'the placement is listed');
    assert.equal(block.calibration.subject_premium, 50_000_000);
    assert.equal(block.calibration.premium_source, 'estimated GWP');
    // No bordereaux yet: the loss ratio falls back and says so.
    assert.equal(block.calibration.loss_ratio_source, 'market default');

    // The XoL layer maps to the engine's terms; the QS layer infers a cession
    // of treaty premium over subject premium (10m / 50m).
    assert.equal(block.structure.xol_layers.length, 1);
    assert.deepEqual(
      {
        attachment: block.structure.xol_layers[0].attachment,
        limit: block.structure.xol_layers[0].limit,
        reinstatements: block.structure.xol_layers[0].reinstatements,
      },
      { attachment: 5_000_000, limit: 5_000_000, reinstatements: 2 },
    );
    assert.equal(block.structure.quota_share.cession_pct, 20);
    assert.equal(block.structure.quota_share.inferred, true);
    // Parameter risk widens when the experience is thin: no bordereau years
    // observed ⇒ the mixing factors sit at their caps, shown and editable.
    assert.equal(block.calibration.years_observed, 0);
    assert.equal(block.calibration.parameter_uncertainty_pct, 25);
    assert.equal(block.calibration.cat_frequency_cv_pct, 50);
    // No signed lines yet: the reinsurer-default assumption is the A-rated default.
    assert.equal(resp.body.defaults.credit_pd_pct, 0.1);
    assert.equal(resp.body.defaults.credit_pd_source, 'A-rated panel default');
    assert.equal(resp.body.defaults.horizon_years, 1);
    // A standalone model, typed from scratch, starts from the same fallbacks
    // a placement without experience gets.
    assert.equal(resp.body.defaults.calibration.expected_loss_ratio_pct, 65);
    assert.equal(resp.body.defaults.calibration.large_loss_threshold, 250_000);
    assert.equal(resp.body.defaults.calibration.parameter_uncertainty_pct, 10);

    // The selection defaults to every placement with premium, and the
    // combined view carries the same subject premium for a one-placement book.
    assert.ok(resp.body.selected.includes(pid));
    assert.equal(resp.body.combined.calibration.subject_premium, 50_000_000);
    assert.equal(resp.body.mixed_currency, false);

    // Narrowing to an explicit selection returns the same combined view.
    const narrowed = await api('GET', `/api/dfa/portfolio?placements=${pid}`, { token: broker.token });
    assert.deepEqual(narrowed.body.combined.calibration, resp.body.combined.calibration);
  });
});

test('POST /api/dfa/run compares structures over identical trials', async () => {
  await withServer(async (api) => {
    const body = {
      portfolio: {
        subject_premium: 50_000_000,
        expected_loss_ratio_pct: 65,
        large_frequency: 3,
        large_severity_mean: 800_000,
        cat_frequency: 0.3,
        cat_severity_mean: 6_000_000,
      },
      structures: {
        current: {
          xol_layers: [{ attachment: 5_000_000, limit: 5_000_000, premium100: 900_000, reinstatements: '2' }],
        },
        proposed: {
          quota_share: { cession_pct: 20, commission_pct: 25 },
          xol_layers: [{ attachment: 5_000_000, limit: 5_000_000, premium100: 900_000, reinstatements: '2' }],
        },
      },
      assumptions: { trials: 2000, seed: 5 },
    };
    const resp = await api('POST', '/api/dfa/run', { token: broker.token, body });
    assert.equal(resp.status, 200);
    assert.equal(resp.body.trials, 2000);

    const { current, proposed } = resp.body.structures;
    // Both sides of the slip are reported for both structures.
    assert.ok(current.reinsurer.premium > 0);
    assert.ok(proposed.reinsurer.premium > current.reinsurer.premium);
    // The quota share narrows the net book: less capital, lower net loss.
    assert.ok(proposed.capital.required < current.capital.required);
    assert.ok(proposed.loss.mean < current.loss.mean);
    // Identical gross trials: the gross view never depends on the structure.
    assert.deepEqual(current.ep_curve.map((p) => p.gross), proposed.ep_curve.map((p) => p.gross));
    // The buyer's economics and the per-cover attribution come back too.
    assert.ok(proposed.reinsurance.ceded_premium > current.reinsurance.ceded_premium);
    assert.equal(typeof proposed.reinsurance.implied_coc_pct, 'number');
    assert.equal(current.layers.length, 1);
    assert.equal(resp.body.frontier.length, 3);
    assert.equal(resp.body.assumptions.available_capital, resp.body.gross.capital.required);
  });
});

test('POST /api/dfa/run prices unquoted covers, rolls the surplus forward and scans variants', async () => {
  await withServer(async (api) => {
    const body = {
      portfolio: {
        subject_premium: 50_000_000,
        expected_loss_ratio_pct: 65,
        large_frequency: 3,
        large_severity_mean: 800_000,
        cat_frequency: 0.3,
        cat_severity_mean: 6_000_000,
        parameter_uncertainty_pct: 15,
      },
      structures: {
        current: {
          xol_layers: [{ attachment: 5_000_000, limit: 5_000_000, premium100: 900_000, reinstatements: '2' }],
        },
        proposed: {
          quota_share: {
            cession_pct: 20, commission_pct: 25, event_limit: 2_000_000,
            sliding_scale: { min_pct: 15, max_pct: 35, min_lr_pct: 50, max_lr_pct: 70 },
          },
          xol_layers: [
            { attachment: 5_000_000, limit: 5_000_000, premium100: 900_000, reinstatements: '2', aggregate_deductible: 1_000_000 },
            { attachment: 10_000_000, limit: 15_000_000, reinstatements: '1' },
          ],
          aggregate_cover: { attachment_lr_pct: 90, exhaust_lr_pct: 110 },
        },
      },
      variants: {
        'QS 10%': { quota_share: { cession_pct: 10, commission_pct: 25 } },
        'QS 30%': { quota_share: { cession_pct: 30, commission_pct: 25 } },
      },
      assumptions: { trials: 1500, seed: 9, horizon_years: 3, available_capital: 20_000_000, premium_growth_pct: 5 },
    };
    const resp = await api('POST', '/api/dfa/run', { token: broker.token, body });
    assert.equal(resp.status, 200);
    const { proposed } = resp.body.structures;

    // Unquoted covers carry a technical price, flagged as such.
    const top = proposed.layers.find((l) => l.name === 'Layer 2');
    assert.equal(top.priced, 'technical');
    assert.ok(top.premium100 > 0 && top.premium100 === top.technical_premium100);
    const agg = proposed.layers.find((l) => l.kind === 'aggregate');
    assert.equal(agg.priced, 'technical');
    assert.equal(agg.attachment_lr_pct, 90);
    assert.equal(proposed.structure.aggregate_cover.exhaust_lr_pct, 110);
    assert.equal(proposed.structure.quota_share.sliding_scale.max_pct, 35);

    // The horizon rolls the given capital forward for three years.
    assert.equal(resp.body.assumptions.available_capital, 20_000_000);
    assert.equal(proposed.horizon.years, 3);
    assert.equal(proposed.horizon.by_year[2].subject_premium, 55_125_000);
    assert.ok(proposed.horizon.prob_ruin_pct >= proposed.capital.ruin_prob_pct);

    // Variants only appear on the frontier.
    assert.deepEqual(Object.keys(resp.body.structures), ['current', 'proposed']);
    assert.deepEqual(resp.body.frontier.map((f) => f.label), ['gross', 'current', 'proposed', 'QS 10%', 'QS 30%']);
    assert.ok(resp.body.variants['QS 30%'].capital_required < resp.body.variants['QS 10%'].capital_required);
  });
});

test('POST /api/dfa/run rejects a malformed spec', async () => {
  await withServer(async (api) => {
    const resp = await api('POST', '/api/dfa/run', {
      token: broker.token,
      body: { portfolio: { subject_premium: -5, expected_loss_ratio_pct: 65 }, structures: { a: {} } },
    });
    assert.equal(resp.status, 422);

    // Too many frontier variants, and a horizon beyond the engine's reach.
    const variants = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`v${i}`, {}]));
    const tooMany = await api('POST', '/api/dfa/run', {
      token: broker.token,
      body: { portfolio: { subject_premium: 1_000_000, expected_loss_ratio_pct: 65 }, structures: { a: {} }, variants },
    });
    assert.equal(tooMany.status, 422);
    const tooLong = await api('POST', '/api/dfa/run', {
      token: broker.token,
      body: { portfolio: { subject_premium: 1_000_000, expected_loss_ratio_pct: 65 }, structures: { a: {} }, assumptions: { horizon_years: 9 } },
    });
    assert.equal(tooLong.status, 422);
  });
});

test('the DFA surface requires authentication', async () => {
  await withServer(async (api) => {
    assert.equal((await api('GET', '/api/dfa/portfolio', {})).status, 401);
    assert.equal((await api('POST', '/api/dfa/run', { body: {} })).status, 401);
  });
});

test('GET /api/dfa/regimes lists the capital regimes and serves one in full', async () => {
  await withServer(async (api) => {
    const list = await api('GET', '/api/dfa/regimes', { token: broker.token });
    assert.equal(list.status, 200);
    assert.ok(list.body.regimes.length >= 70);
    assert.equal(list.body.as_at, '2026');
    assert.ok(list.body.families.solvency_ii && list.body.families.rbc);
    const gb = list.body.regimes.find((r) => r.code === 'GB');
    assert.equal(gb.family, 'solvency_ii');
    assert.equal(list.body.regimes.find((r) => r.code === 'US').family, 'rbc');

    const one = await api('GET', '/api/dfa/regimes/gb', { token: broker.token });
    assert.equal(one.status, 200);
    assert.equal(one.body.code, 'GB');
    assert.equal(one.body.family_label, 'Solvency II');
    assert.equal(one.body.ladder[0].min_pct, 100);
    assert.ok(one.body.requirement.includes('99.5%'));
    assert.equal((await api('GET', '/api/dfa/regimes/XX', { token: broker.token })).status, 404);
    assert.equal((await api('GET', '/api/dfa/regimes', {})).status, 401);
  });
});

test('the book carries its cedants\' domicile, its reserves and the standard scenarios', async () => {
  await withServer(async (api) => {
    const pid = await buildPlacement(api);
    const resp = await api('GET', `/api/dfa/portfolio?placements=${pid}`, { token: broker.token });
    assert.equal(resp.status, 200);
    const block = resp.body.placements.find((p) => p.id === pid);
    assert.equal(block.cedant_domicile, 'GB');
    assert.equal(block.domicile_code, 'GB');
    // No claims bordereau: the reserve opens at zero and says so.
    assert.equal(block.calibration.opening_reserves, 0);
    assert.equal(block.calibration.reserves_source, null);
    assert.equal(block.calibration.reserve_cv_pct, 8);
    assert.equal(resp.body.combined.calibration.opening_reserves, 0);
    // Every selected cedant sits in one country: the capital reads against it.
    assert.deepEqual(resp.body.domicile, { code: 'GB', regime: 'Solvency UK', source: 'the cedant\'s domicile on the register' });
    assert.equal(resp.body.defaults.domicile, 'GB');
    assert.ok(resp.body.defaults.scenarios.length >= 8);
    assert.equal(resp.body.defaults.scenarios.find((s) => s.key === 'rates').param.key, 'loss_ratio_delta_pts');
    assert.equal(resp.body.defaults.calibration.opening_reserves, 0);
  });
});

test('POST /api/dfa/run reads a domicile\'s regime and runs the scenarios', async () => {
  await withServer(async (api) => {
    const body = {
      portfolio: {
        subject_premium: 50_000_000, expected_loss_ratio_pct: 65, large_frequency: 3,
        large_severity_mean: 800_000, cat_frequency: 0.3, cat_severity_mean: 6_000_000,
        opening_reserves: 30_000_000, reserve_cv_pct: 8,
      },
      structures: {
        current: { xol_layers: [{ attachment: 5_000_000, limit: 5_000_000, premium100: 900_000, reinstatements: '2' }] },
        proposed: {
          quota_share: { cession_pct: 20, commission_pct: 25 },
          xol_layers: [{ attachment: 5_000_000, limit: 5_000_000, premium100: 900_000, reinstatements: '2' }],
        },
      },
      scenarios: {
        'Rates inadequate': { loss_ratio_delta_pts: 10 },
        'Prior-year reserves deteriorate': { reserve_shock_pct: 15 },
      },
      assumptions: { trials: 1500, seed: 9, domicile: 'GB', horizon_years: 2 },
    };
    const resp = await api('POST', '/api/dfa/run', { token: broker.token, body });
    assert.equal(resp.status, 200);
    assert.equal(resp.body.regime.code, 'GB');
    assert.equal(resp.body.regime.family, 'solvency_ii');
    const { proposed } = resp.body.structures;
    assert.equal(proposed.regime.required_source, 'modelled');
    assert.ok(proposed.regime.ratio_pct > 100);
    assert.equal(proposed.regime.band.level, 'SCR met');
    assert.equal(proposed.reserves.opening, 30_000_000);
    assert.ok(proposed.leverage.reserves_to_capital_pct > 0);
    assert.ok(['holds', 'strained', 'breach'].includes(proposed.standing));

    const s = resp.body.scenarios;
    assert.deepEqual(Object.keys(s), ['Rates inadequate', 'Prior-year reserves deteriorate']);
    assert.equal(s['Rates inadequate'].expected_loss_ratio_pct, 75);
    assert.equal(s['Prior-year reserves deteriorate'].surplus_charge, 4_500_000);
    assert.ok(s['Rates inadequate'].structures.proposed.result_mean < proposed.result.mean);
    assert.equal(s['Rates inadequate'].structures.proposed.horizon.years, 2);
    assert.equal(typeof s['Rates inadequate'].structures.proposed.regime.ratio_pct, 'number');

    // A scenario may only move what the engine knows how to move.
    const bad = await api('POST', '/api/dfa/run', {
      token: broker.token,
      body: { ...body, scenarios: { odd: { something_else: 1 } } },
    });
    assert.equal(bad.status, 422);
    const tooMany = await api('POST', '/api/dfa/run', {
      token: broker.token,
      body: { ...body, scenarios: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`s${i}`, { loss_ratio_delta_pts: 1 }])) },
    });
    assert.equal(tooMany.status, 422);
  });
});

// ---- Treaty structuring: the sweep, the appetite, the profile from the modelling pack ----

test('the book carries the appetite, the families and the modelling pack’s risk profile', async () => {
  await withServer(async (api) => {
    const pid = await buildPlacement(api);
    // The Profiles screen's bands, per class: a typical sum insured from the
    // total over the count, else the band's midpoint, and the premium share.
    await pool.query(
      "INSERT INTO placement_modelling (placement_id, section, data) VALUES ($1, 'risk_profile', $2)",
      [pid, JSON.stringify({
        Property: {
          bands: [
            { from_amt: 0, to_amt: 1_000_000, no_of_risks: 1000, total_sum_insured: 400_000_000, gross_premium: 6_000_000 },
            { from_amt: 1_000_000, to_amt: 5_000_000, no_of_risks: 100, total_sum_insured: 250_000_000, gross_premium: 3_000_000 },
            { from_amt: 5_000_000, to_amt: 25_000_000, gross_premium: 1_000_000 },
            { from_amt: 25_000_000, to_amt: 100_000_000, gross_premium: 0 },
          ],
        },
      })],
    );
    const resp = await api('GET', `/api/dfa/portfolio?placements=${pid}`, { token: broker.token });
    assert.equal(resp.status, 200);
    const block = resp.body.placements.find((p) => p.id === pid);
    assert.deepEqual(block.calibration.risk_profile, [
      { sum_insured: 400_000, premium_pct: 60 },
      { sum_insured: 2_500_000, premium_pct: 30 },
      { sum_insured: 15_000_000, premium_pct: 10 },
    ]);
    assert.equal(block.calibration.risk_profile_source, 'modelling pack risk profile');
    assert.deepEqual(resp.body.combined.calibration.risk_profile, block.calibration.risk_profile);
    assert.match(resp.body.combined.calibration.risk_profile_source, /1 of 1 placements/);
    // The stage's defaults ride with the book.
    assert.equal(resp.body.defaults.appetite.max_ruin_pct, 0.5);
    assert.equal(resp.body.defaults.appetite.require_standing_holds, true);
    assert.equal(resp.body.defaults.asset_return_volatility_pct, 4);
    assert.equal(resp.body.defaults.structuring.steps, 5);
    assert.deepEqual(resp.body.defaults.families.map((f) => f.key), ['xol', 'quota_share', 'surplus', 'blend']);
    assert.equal(resp.body.defaults.calibration.risk_profile, null);
    // A placement without a profile says so.
    const other = await buildPlacement(api);
    const again = await api('GET', '/api/dfa/portfolio', { token: broker.token });
    assert.equal(again.body.placements.find((p) => p.id === other).calibration.risk_profile, null);
    assert.equal(again.body.placements.find((p) => p.id === other).calibration.risk_profile_source, null);
  });
});

test('POST /api/dfa/structuring sweeps the families over the retention range and reads the appetite', async () => {
  await withServer(async (api) => {
    const portfolio = {
      subject_premium: 50_000_000, expected_loss_ratio_pct: 65, large_frequency: 3,
      large_severity_mean: 800_000, cat_frequency: 0.3, cat_severity_mean: 6_000_000, opening_reserves: 20_000_000,
      risk_profile: [{ sum_insured: 500_000, premium_pct: 60 }, { sum_insured: 4_000_000, premium_pct: 30 }, { sum_insured: 20_000_000, premium_pct: 10 }],
    };
    const current = { xol_layers: [{ attachment: 5_000_000, limit: 5_000_000, premium100: 900_000, reinstatements: '2' }] };
    const body = {
      portfolio,
      structures: { current },
      grid: { families: ['xol', 'quota_share', 'surplus', 'blend'], steps: 3, retention_from: 2_000_000, retention_to: 8_000_000, tower_top: 20_000_000, surplus_lines: 4 },
      appetite: { max_ruin_pct: 1, max_loss_1in100_pct_of_capital: 70, min_solvency_ratio_pct: 110, max_combined_ratio_1in10_pct: 120, require_standing_holds: false },
      stresses: { 'A major cat year': { forced_cat_pml_multiple: 1 }, 'Reserves deteriorate': { reserve_shock_pct: 15 } },
      assumptions: { trials: 1500, seed: 5, available_capital: 30_000_000, asset_return_volatility_pct: 4, domicile: 'GB' },
    };
    const resp = await api('POST', '/api/dfa/structuring', { token: broker.token, body });
    assert.equal(resp.status, 200);
    assert.equal(resp.body.trials, 1500);
    assert.equal(resp.body.candidates.length, 12);
    assert.deepEqual(resp.body.families.map((f) => f.key), ['xol', 'quota_share', 'surplus', 'blend']);
    assert.equal(resp.body.appetite.max_ruin_pct, 1);
    assert.equal(resp.body.grid.commission_pct, 25);
    assert.equal(resp.body.calibration.risk_profile.source, 'given');
    assert.equal(resp.body.regime.code, 'GB');
    for (const c of resp.body.candidates) {
      assert.ok(c.label && c.family && c.axis && c.structure);
      assert.deepEqual(c.appetite.tests.map((t) => t.key), ['ruin', 'tail', 'solvency', 'earnings']);
      assert.deepEqual(Object.keys(c.stress), ['A major cat year', 'Reserves deteriorate']);
      assert.ok(typeof c.efficient === 'boolean' && typeof c.recommended === 'boolean');
      assert.ok(c.combined_ratio.p90 > 0 && c.net_income && c.solvency_end && c.regime.ratio_pct > 0);
    }
    const surplus = resp.body.candidates.find((c) => c.family === 'surplus');
    assert.ok(surplus.structure.surplus.average_cession_pct > 0);
    assert.equal(surplus.structure.surplus.lines, 4);
    assert.ok(surplus.reinsurance.ceded_premium > 0);
    const d = resp.body.defensible;
    assert.equal(d.tested, 12);
    assert.equal(d.fits, resp.body.candidates.filter((c) => c.appetite.pass).length);
    assert.equal(resp.body.candidates.filter((c) => c.recommended).length, 1);
    assert.equal(resp.body.candidates.find((c) => c.recommended).label, d.recommended);
    assert.deepEqual(d.stresses, ['A major cat year', 'Reserves deteriorate']);
    assert.deepEqual(Object.keys(resp.body.references), ['gross', 'current']);
    assert.ok(resp.body.references.current.appetite.tests.length === 4);
    assert.equal(resp.body.stresses['Reserves deteriorate'].surplus_charge, 3_000_000);

    // The default stresses stand in when none are named; a proposed programme is a second reference.
    const dflt = await api('POST', '/api/dfa/structuring', {
      token: broker.token,
      body: { ...body, stresses: undefined, structures: { current, proposed: { ...current, quota_share: { cession_pct: 20, commission_pct: 25 } } } },
    });
    assert.equal(dflt.status, 200);
    assert.deepEqual(dflt.body.defensible.stresses, ['A major cat year', 'Reserves deteriorate', 'Rates inadequate']);
    assert.deepEqual(Object.keys(dflt.body.references), ['gross', 'current', 'proposed']);

    // A tower that cannot sit above the retentions, an unknown family, a third reference: refused.
    const lowTop = await api('POST', '/api/dfa/structuring', { token: broker.token, body: { ...body, grid: { ...body.grid, tower_top: 5_000_000 } } });
    assert.equal(lowTop.status, 422);
    const odd = await api('POST', '/api/dfa/structuring', { token: broker.token, body: { ...body, grid: { ...body.grid, families: ['facultative'] } } });
    assert.equal(odd.status, 422);
    const three = await api('POST', '/api/dfa/structuring', { token: broker.token, body: { ...body, structures: { a: current, b: current, c: current } } });
    assert.equal(three.status, 422);
    assert.equal((await api('POST', '/api/dfa/structuring', { body })).status, 401);
  });
});

test('POST /api/dfa/run takes a surplus treaty, a risk profile and an asset-return volatility', async () => {
  await withServer(async (api) => {
    const body = {
      portfolio: {
        subject_premium: 50_000_000, expected_loss_ratio_pct: 65, large_frequency: 3,
        large_severity_mean: 800_000, cat_frequency: 0.3, cat_severity_mean: 6_000_000,
        risk_profile: [{ sum_insured: 500_000, premium_pct: 60 }, { sum_insured: 4_000_000, premium_pct: 40 }],
      },
      structures: {
        current: { xol_layers: [{ attachment: 5_000_000, limit: 5_000_000, premium100: 900_000, reinstatements: '2' }] },
        proposed: { surplus: { retained_line: 1_000_000, lines: 5, commission_pct: 27.5 } },
      },
      assumptions: { trials: 1500, seed: 9, asset_return_volatility_pct: 6 },
    };
    const resp = await api('POST', '/api/dfa/run', { token: broker.token, body });
    assert.equal(resp.status, 200);
    const p = resp.body.structures.proposed;
    assert.equal(p.structure.surplus.commission_pct, 27.5);
    // 40% of the premium sits on 4m risks that cede 3m of 4m: 30% on average.
    assert.equal(p.structure.surplus.average_cession_pct, 30);
    assert.equal(p.flows.surplus_premium, 15_000_000);
    assert.ok(p.reinsurance.expected_commission > 0);
    assert.equal(resp.body.assumptions.asset_return_volatility_pct, 6);
    assert.equal(resp.body.calibration.risk_profile.source, 'given');
    assert.ok(p.net_income.sd > p.result.sd);
    const bad = await api('POST', '/api/dfa/run', {
      token: broker.token,
      body: { ...body, structures: { current: { surplus: { retained_line: 0, lines: 5 } } } },
    });
    assert.equal(bad.status, 422);
  });
});
