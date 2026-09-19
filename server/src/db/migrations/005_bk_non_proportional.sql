-- 005: AABI broking — non-proportional programme and layers.
-- Source: project/data-model.md ("Non-proportional (Contract Details + Structure)").
-- Contract Details reuses bk_contract only. Derived columns (attachment cascade,
-- earned_premium, mdp_pct, rol) are recomputed on the server with shared/broking/calcs.js.
CREATE TABLE IF NOT EXISTS public.bk_np_programme (
  contract_id           uuid PRIMARY KEY REFERENCES public.bk_contract(contract_id) ON DELETE CASCADE,
  number_of_layers      int  NOT NULL DEFAULT 1 CHECK (number_of_layers BETWEEN 1 AND 20),
  deductible            numeric(18,2) CHECK (deductible >= 0),   -- layer-1 attachment; later layers cascade
  accounting_method     text CHECK (accounting_method IN ('Losses Occurring','Risks Attaching')),
  xl_type               text CHECK (xl_type IN ('Gross XL','Net XL')),
  accounts              text CHECK (accounts IN ('Half yearly','Quarterly','Annual')),
  est_gnpi              numeric(18,2) CHECK (est_gnpi >= 0),
  brokerage_pct         numeric(5,2) CHECK (brokerage_pct BETWEEN 0 AND 100),
  taxes_pct             numeric(5,2) CHECK (taxes_pct BETWEEN 0 AND 100),
  no_claims_bonus_pct   numeric(5,2) CHECK (no_claims_bonus_pct BETWEEN 0 AND 100),
  profit_commission_pct numeric(5,2) CHECK (profit_commission_pct BETWEEN 0 AND 100)
);

CREATE TABLE IF NOT EXISTS public.bk_np_layer (
  layer_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id          uuid NOT NULL REFERENCES public.bk_contract(contract_id) ON DELETE CASCADE,
  layer_number         int  NOT NULL CHECK (layer_number BETWEEN 1 AND 50),
  layer_limit          numeric(18,2) CHECK (layer_limit >= 0),
  attachment           numeric(18,2),           -- derived cascade, stored
  aggregate_limit      numeric(18,2) CHECK (aggregate_limit >= 0),   -- AAL
  egnpi                numeric(18,2) CHECK (egnpi >= 0),
  rate                 numeric(12,8) CHECK (rate >= 0),              -- whole percent on EGNPI
  earned_premium       numeric(18,2),           -- derived: EGNPI × rate / 100
  mdp                  numeric(18,2) CHECK (mdp >= 0),
  mdp_pct              numeric(12,8),           -- derived: MDP / earned premium
  num_reinstatements   int  CHECK (num_reinstatements IS NULL OR num_reinstatements = -1 OR num_reinstatements BETWEEN 0 AND 10),  -- NULL = none; -1 = unlimited
  reinstatement_pct    numeric(6,2) CHECK (reinstatement_pct BETWEEN 0 AND 1000),
  aad                  boolean NOT NULL DEFAULT false,
  aad_amount           numeric(18,2) CHECK (aad_amount >= 0),
  peril_scope          text NOT NULL DEFAULT 'RISK' CHECK (peril_scope IN ('RISK','CAT','BOTH')),
  rol                  numeric(12,8),           -- derived: earned premium / limit
  -- Stop Loss layers (loss-ratio basis) and Aggregate XL layers keep their own
  -- inputs here so one table serves all five NP treaty types.
  attach_lr_pct        numeric(6,2) CHECK (attach_lr_pct BETWEEN 0 AND 1000),
  limit_lr_pct         numeric(6,2) CHECK (limit_lr_pct BETWEEN 0 AND 1000),
  epi                  numeric(18,2) CHECK (epi >= 0),
  aggregate_deductible numeric(18,2) CHECK (aggregate_deductible >= 0),
  UNIQUE (contract_id, layer_number),
  CONSTRAINT bk_np_layer_aad_amount CHECK (aad OR aad_amount IS NULL)
);
CREATE INDEX IF NOT EXISTS bk_np_layer_contract ON public.bk_np_layer (contract_id, layer_number);

CREATE TABLE IF NOT EXISTS public.bk_np_layer_class_of_business (
  layer_id              uuid REFERENCES public.bk_np_layer(layer_id) ON DELETE CASCADE,
  class_of_business_id  uuid NOT NULL REFERENCES public.class_of_business(class_of_business_id),
  PRIMARY KEY (layer_id, class_of_business_id)
);
