-- 004: AABI broking — proportional Treaty Detail tables.
-- Source: project/data-model.md ("Proportional (Treaty Detail)"). One row per
-- contract; columns mirror Universe contract_prop_details / contract_commissions /
-- contract_loss_participation. Derived columns (retention_amt, cession_amt,
-- total_capacity) are recomputed on the server with shared/broking/calcs.js.
CREATE TABLE IF NOT EXISTS public.bk_prop_details (
  contract_id              uuid PRIMARY KEY REFERENCES public.bk_contract(contract_id) ON DELETE CASCADE,
  triangulations_available boolean NOT NULL DEFAULT true,
  qs_limit                 numeric(18,2) CHECK (qs_limit >= 0),
  retention_pct            numeric(5,2) CHECK (retention_pct BETWEEN 0 AND 100),
  retention_amt            numeric(18,2),        -- derived, stored for reporting
  cession_pct              numeric(5,2) CHECK (cession_pct BETWEEN 0 AND 100),
  cession_amt              numeric(18,2),        -- derived
  surplus_max_retention    numeric(18,2) CHECK (surplus_max_retention >= 0),
  num_lines                numeric(10,2) CHECK (num_lines >= 0),
  total_capacity           numeric(18,2),        -- derived
  event_limit              numeric(18,2) CHECK (event_limit >= 0),
  aal                      numeric(18,2) CHECK (aal >= 0),
  quota_share_epi          numeric(18,2) CHECK (quota_share_epi >= 0),
  surplus_epi              numeric(18,2) CHECK (surplus_epi >= 0),
  brokerage_pct            numeric(5,2) CHECK (brokerage_pct BETWEEN 0 AND 100),
  taxes_pct                numeric(5,2) CHECK (taxes_pct BETWEEN 0 AND 100),
  loss_cap_pct             numeric(6,2) CHECK (loss_cap_pct BETWEEN 0 AND 1000)
);

CREATE TABLE IF NOT EXISTS public.bk_commissions (
  contract_id                  uuid PRIMARY KEY REFERENCES public.bk_contract(contract_id) ON DELETE CASCADE,
  mode                         public.bk_commission_mode NOT NULL DEFAULT 'FIXED',
  fixed_commission_qs_pct      numeric(5,2) CHECK (fixed_commission_qs_pct BETWEEN 0 AND 100),
  fixed_commission_surplus_pct numeric(5,2) CHECK (fixed_commission_surplus_pct BETWEEN 0 AND 100),
  provisional_commission_pct   numeric(5,2) CHECK (provisional_commission_pct BETWEEN 0 AND 100),
  sliding_min_loss_ratio       numeric(5,2) CHECK (sliding_min_loss_ratio BETWEEN 0 AND 100),
  sliding_max_loss_ratio       numeric(5,2) CHECK (sliding_max_loss_ratio BETWEEN 0 AND 100),
  sliding_min_commission       numeric(5,2) CHECK (sliding_min_commission BETWEEN 0 AND 100),
  sliding_max_commission       numeric(5,2) CHECK (sliding_max_commission BETWEEN 0 AND 100),
  mgmt_expenses_pct            numeric(5,2) CHECK (mgmt_expenses_pct BETWEEN 0 AND 100),
  profit_commission_pct        numeric(5,2) CHECK (profit_commission_pct BETWEEN 0 AND 100),
  lcf_years                    int CHECK (lcf_years BETWEEN 0 AND 20),
  lcf_extinction               boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.bk_commission_slides (
  contract_id     uuid REFERENCES public.bk_contract(contract_id) ON DELETE CASCADE,
  row_no          int  NOT NULL,
  loss_ratio_pct  numeric(6,2) NOT NULL,
  commission_pct  numeric(5,2) NOT NULL,
  PRIMARY KEY (contract_id, row_no)
);

CREATE TABLE IF NOT EXISTS public.bk_loss_participation (
  contract_id          uuid PRIMARY KEY REFERENCES public.bk_contract(contract_id) ON DELETE CASCADE,
  enabled              boolean NOT NULL DEFAULT false,
  min_loss_ratio_pct   numeric(6,2) CHECK (min_loss_ratio_pct BETWEEN 0 AND 1000),
  max_loss_ratio_pct   numeric(6,2) CHECK (max_loss_ratio_pct BETWEEN 0 AND 1000),
  reinsurer_share_pct  numeric(5,2) CHECK (reinsurer_share_pct BETWEEN 0 AND 100),
  slides               jsonb NOT NULL DEFAULT '[]',   -- ≤5 × {min_lr, max_lr, share}, max_lr > min_lr
  CONSTRAINT bk_loss_participation_slides_shape CHECK (jsonb_typeof(slides) = 'array' AND jsonb_array_length(slides) <= 5)
);

CREATE TABLE IF NOT EXISTS public.bk_epi_split (
  contract_id           uuid REFERENCES public.bk_contract(contract_id) ON DELETE CASCADE,
  class_of_business_id  uuid NOT NULL REFERENCES public.class_of_business(class_of_business_id),
  premium               numeric(18,2) NOT NULL CHECK (premium >= 0),
  PRIMARY KEY (contract_id, class_of_business_id)
);
