-- Seed 003: two sample broking contracts for Afro-Asian Re Brokers (org a0b1),
-- created by the demo broker. Derived columns are computed in SQL with the same
-- formulas as shared/broking/calcs.js (the verification step compares them).
--   B0621DAR26TR001  Kenya Re · Quota Share & Surplus · 2026   (contract c001)
--   B0621DAR26CX002  Kenya Re · CAT XL · 2026 · 3 layers        (contract c002)
DO $$
DECLARE
  v_org     uuid := '00000000-0000-0000-0000-00000000a0b1';
  v_user    uuid := '00000000-0000-0000-0000-000000000002';
  v_c1      uuid := '00000000-0000-0000-0000-00000000c001';
  v_c2      uuid := '00000000-0000-0000-0000-00000000c002';
  v_country uuid; v_cedant uuid; v_broker uuid; v_ccy uuid;
  v_qss     uuid; v_catxl uuid; v_fire uuid; v_eng uuid;
BEGIN
  SELECT country_id INTO v_country FROM public.country WHERE country_code = 'KE' AND is_active IS NOT FALSE LIMIT 1;
  SELECT company_id INTO v_cedant  FROM public.companies WHERE company_name = 'Kenya Re' LIMIT 1;
  SELECT broker_id  INTO v_broker  FROM public.brokers WHERE broker_name = 'Afro-Asian Re Brokers' LIMIT 1;
  SELECT currency_id INTO v_ccy    FROM public.currency WHERE currency_code = 'USD' LIMIT 1;
  SELECT treaty_type_id INTO v_qss   FROM public.treaty_type WHERE treaty_type = 'Quota Share & Surplus';
  SELECT treaty_type_id INTO v_catxl FROM public.treaty_type WHERE treaty_type = 'CAT XL';
  SELECT class_of_business_id INTO v_fire FROM public.class_of_business WHERE class_of_business = 'Fire';
  SELECT class_of_business_id INTO v_eng  FROM public.class_of_business WHERE class_of_business = 'Engineering';
  IF v_country IS NULL OR v_cedant IS NULL OR v_broker IS NULL OR v_ccy IS NULL OR v_qss IS NULL OR v_catxl IS NULL OR v_fire IS NULL OR v_eng IS NULL THEN
    RAISE EXCEPTION 'seed 003 needs the reference data from seed 002';
  END IF;

  -- ── 1. Quota Share & Surplus ─────────────────────────────────────────────
  INSERT INTO public.bk_contract (contract_id, umr, business_type, org_id, country_id, cedant_id, broker_id, currency_id,
    treaty_type_id, primary_class_of_business_id, uw_year, inception_date, renewal_date, experience_start_year,
    contract_description, status, created_by_user_id)
  VALUES (v_c1, 'B0621DAR26TR001', 'PROPORTIONAL', v_org, v_country, v_cedant, v_broker, v_ccy,
    v_qss, v_fire, 2026, DATE '2026-01-01', DATE '2027-01-01', 2016,
    '2026 Kenya Re Quota Share & Surplus (Fire, Engineering) KE', 'DRAFT', v_user)
  ON CONFLICT (contract_id) DO NOTHING;

  INSERT INTO public.bk_contract_class_of_business (contract_id, class_of_business_id, sort_order)
  VALUES (v_c1, v_fire, 0), (v_c1, v_eng, 1) ON CONFLICT DO NOTHING;

  INSERT INTO public.bk_prop_details (contract_id, triangulations_available, qs_limit, retention_pct, retention_amt, cession_pct, cession_amt,
    surplus_max_retention, num_lines, total_capacity, event_limit, aal, quota_share_epi, surplus_epi, brokerage_pct, taxes_pct, loss_cap_pct)
  VALUES (v_c1, true, 10000000, 30, round(10000000 * 30 / 100.0), 70, round(10000000 * 70 / 100.0),
    3000000, 5, 10000000 + 3000000 * 5, 25000000, NULL, 18000000, 6500000, 10, 2, NULL)
  ON CONFLICT (contract_id) DO NOTHING;

  INSERT INTO public.bk_commissions (contract_id, mode, fixed_commission_qs_pct, fixed_commission_surplus_pct, profit_commission_pct, lcf_years, lcf_extinction)
  VALUES (v_c1, 'FIXED', 32.5, 30, 15, 3, false) ON CONFLICT (contract_id) DO NOTHING;

  INSERT INTO public.bk_loss_participation (contract_id, enabled) VALUES (v_c1, false) ON CONFLICT (contract_id) DO NOTHING;

  -- EPI split never opened → equal split of QS EPI + Surplus EPI across the classes.
  INSERT INTO public.bk_epi_split (contract_id, class_of_business_id, premium)
  VALUES (v_c1, v_fire, (18000000 + 6500000) / 2.0), (v_c1, v_eng, (18000000 + 6500000) / 2.0) ON CONFLICT DO NOTHING;

  -- ── 2. CAT XL, 3 layers (values from the design system LayerTable preview) ──
  INSERT INTO public.bk_contract (contract_id, umr, business_type, org_id, country_id, cedant_id, broker_id, currency_id,
    treaty_type_id, primary_class_of_business_id, uw_year, inception_date, renewal_date, experience_start_year,
    contract_description, status, created_by_user_id)
  VALUES (v_c2, 'B0621DAR26CX002', 'NON_PROPORTIONAL', v_org, v_country, v_cedant, v_broker, v_ccy,
    v_catxl, v_fire, 2026, DATE '2026-01-01', DATE '2027-01-01', 2016,
    '2026 Kenya Re CAT XL (Fire, Engineering) KE', 'DRAFT', v_user)
  ON CONFLICT (contract_id) DO NOTHING;

  INSERT INTO public.bk_contract_class_of_business (contract_id, class_of_business_id, sort_order)
  VALUES (v_c2, v_fire, 0), (v_c2, v_eng, 1) ON CONFLICT DO NOTHING;

  INSERT INTO public.bk_np_programme (contract_id, number_of_layers, deductible, accounting_method, xl_type, accounts, est_gnpi, brokerage_pct, taxes_pct, no_claims_bonus_pct, profit_commission_pct)
  VALUES (v_c2, 3, 2500000, 'Losses Occurring', 'Gross XL', 'Quarterly', 80000000, 10, 0, NULL, NULL)
  ON CONFLICT (contract_id) DO NOTHING;

  -- Layers: attachment cascades from the programme deductible; EP = round(EGNPI × rate / 100);
  -- MDP% = MDP / EP; ROL = EP / limit.
  INSERT INTO public.bk_np_layer (contract_id, layer_number, layer_limit, attachment, aggregate_limit, egnpi, rate, earned_premium, mdp, mdp_pct,
    num_reinstatements, reinstatement_pct, aad, aad_amount, peril_scope, rol)
  SELECT v_c2, l.n, l.lim, l.att, l.agg, l.egnpi, l.rate, round(l.egnpi * l.rate / 100.0),
         l.mdp, l.mdp / round(l.egnpi * l.rate / 100.0), l.ri, 100, l.aad, l.aada, 'CAT',
         round(l.egnpi * l.rate / 100.0) / l.lim
  FROM (VALUES
    (1,  5000000::numeric, 2500000::numeric, 10000000::numeric, 80000000::numeric, 1.80::numeric, 1200000::numeric, 1, false, NULL::numeric),
    (2, 10000000::numeric, 7500000::numeric, 20000000::numeric, 80000000::numeric, 1.35::numeric,  900000::numeric, 1, false, NULL::numeric),
    (3, 15000000::numeric, 17500000::numeric, 30000000::numeric, 80000000::numeric, 0.90::numeric,  600000::numeric, 2, true, 2000000::numeric)
  ) AS l(n, lim, att, agg, egnpi, rate, mdp, ri, aad, aada)
  ON CONFLICT (contract_id, layer_number) DO NOTHING;

  INSERT INTO public.bk_np_layer_class_of_business (layer_id, class_of_business_id)
  SELECT ly.layer_id, c.class_of_business_id
  FROM public.bk_np_layer ly CROSS JOIN (VALUES (v_fire), (v_eng)) AS c(class_of_business_id)
  WHERE ly.contract_id = v_c2
  ON CONFLICT DO NOTHING;

  INSERT INTO public.bk_audit (contract_id, umr, user_id, diff)
  SELECT c.contract_id, c.umr, v_user, jsonb_build_object('action', 'SEED', 'changes', '{}'::jsonb)
  FROM public.bk_contract c WHERE c.contract_id IN (v_c1, v_c2)
    AND NOT EXISTS (SELECT 1 FROM public.bk_audit a WHERE a.contract_id = c.contract_id);
END $$;
