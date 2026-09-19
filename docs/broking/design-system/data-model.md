# Data model

PostgreSQL 16, following the Universe schema conventions (`server/src/db/migrations/000_core_schema.sql`) so the capture screens map one-to-one onto columns. Tables are prefixed `bk_` to keep the broking store separate from Universe underwriting tables.

## Two identifiers, two jobs

| | `contract_id` (UUID) | `umr` (Unique Market Reference) |
| --- | --- | --- |
| Who makes it | The database: `gen_random_uuid()` on insert | The broker, on the Identify step (prefix pre-filled from the broker's Lloyd's number) |
| Used for | Every foreign key, every API route, audit rows | Search, the summary bar, documents, correspondence with the market, imports |
| Changes? | Never | Only by the audited "Amend UMR" action (old value kept in `bk_umr_history`) |
| Format | RFC 4122 v4 | `B` + 4-digit broker number + 1–12 uppercase letters/digits, max 17 chars — e.g. `B0621DAR26TR001` |

Rules:

- Store the UMR normalised: trimmed, uppercase, no spaces. The UI normalises as the user types.
- Unique across **all** contracts regardless of status — a cancelled or NTU contract still owns its UMR.
- A renewal is a new contract with a new UMR and a new UUID, linked by `parent_contract_id`.
- APIs address contracts by UUID (`/api/contracts/:contractId`). `GET /api/contracts/by-umr/:umr` resolves a UMR to its UUID for search and deep links.

## Core table

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE bk_business_type AS ENUM ('PROPORTIONAL', 'NON_PROPORTIONAL');
CREATE TYPE bk_contract_status AS ENUM
  ('DRAFT', 'SUBMITTED', 'QUOTED', 'FIRM_ORDER', 'BOUND', 'SIGNED', 'NTU', 'CANCELLED');

CREATE TABLE bk_contract (
  contract_id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  umr                          varchar(17) NOT NULL,
  business_type                bk_business_type NOT NULL,
  parent_contract_id           uuid REFERENCES bk_contract(contract_id),   -- prior year (renewal)
  alt_contract_id              text,                                        -- cedant / Universe reference
  country_id                   uuid NOT NULL,
  cedant_id                    uuid NOT NULL,
  broker_id                    uuid NOT NULL,
  currency_id                  uuid NOT NULL,
  treaty_type_id               uuid NOT NULL REFERENCES treaty_type(treaty_type_id),
  primary_class_of_business_id uuid,
  uw_year                      int  NOT NULL CHECK (uw_year BETWEEN 1900 AND 2200),
  inception_date               date NOT NULL,
  renewal_date                 date,
  experience_start_year        int,
  contract_description         text,                                        -- generated, see Capture flow
  status                       bk_contract_status NOT NULL DEFAULT 'DRAFT',
  row_version                  int  NOT NULL DEFAULT 1,                     -- optimistic locking
  created_by_user_id           uuid NOT NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bk_contract_umr_format CHECK (umr ~ '^B[0-9]{4}[A-Z0-9]{1,12}$'),
  CONSTRAINT bk_contract_umr_unique UNIQUE (umr),
  CONSTRAINT bk_contract_dates CHECK (renewal_date IS NULL OR renewal_date > inception_date)
);
CREATE INDEX bk_contract_cedant_year ON bk_contract (cedant_id, uw_year);

CREATE TABLE bk_umr_history (
  contract_id  uuid NOT NULL REFERENCES bk_contract(contract_id) ON DELETE CASCADE,
  old_umr      varchar(17) NOT NULL,
  new_umr      varchar(17) NOT NULL,
  changed_by   uuid NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  reason       text NOT NULL
);

CREATE TABLE bk_contract_class_of_business (
  contract_id           uuid REFERENCES bk_contract(contract_id) ON DELETE CASCADE,
  class_of_business_id  uuid NOT NULL,
  PRIMARY KEY (contract_id, class_of_business_id)
);
```

Reference tables (`treaty_type`, `brokers`, `class_of_business`, country, currency, cedants) are reused from Universe unchanged.

## Proportional (Treaty Detail)

One row per contract in each table; columns mirror Universe `contract_prop_details`, `contract_commissions`, `contract_loss_participation`.

```sql
CREATE TABLE bk_prop_details (
  contract_id              uuid PRIMARY KEY REFERENCES bk_contract(contract_id) ON DELETE CASCADE,
  triangulations_available boolean NOT NULL DEFAULT true,
  qs_limit                 numeric(18,2),
  retention_pct            numeric(5,2) CHECK (retention_pct BETWEEN 0 AND 100),
  retention_amt            numeric(18,2),        -- derived, stored for reporting
  cession_pct              numeric(5,2) CHECK (cession_pct BETWEEN 0 AND 100),
  cession_amt              numeric(18,2),        -- derived
  surplus_max_retention    numeric(18,2),
  num_lines                numeric(10,2) CHECK (num_lines >= 0),
  total_capacity           numeric(18,2),        -- derived
  event_limit              numeric(18,2),
  aal                      numeric(18,2),
  quota_share_epi          numeric(18,2),
  surplus_epi              numeric(18,2),
  brokerage_pct            numeric(5,2) CHECK (brokerage_pct BETWEEN 0 AND 100),
  taxes_pct                numeric(5,2) CHECK (taxes_pct BETWEEN 0 AND 100),
  loss_cap_pct             numeric(6,2) CHECK (loss_cap_pct BETWEEN 0 AND 1000)
);

CREATE TYPE bk_commission_mode AS ENUM ('FIXED', 'SLIDING');
CREATE TABLE bk_commissions (
  contract_id                  uuid PRIMARY KEY REFERENCES bk_contract(contract_id) ON DELETE CASCADE,
  mode                         bk_commission_mode NOT NULL DEFAULT 'FIXED',
  fixed_commission_qs_pct      numeric(5,2),
  fixed_commission_surplus_pct numeric(5,2),
  provisional_commission_pct   numeric(5,2),
  sliding_min_loss_ratio       numeric(5,2),
  sliding_max_loss_ratio       numeric(5,2),
  sliding_min_commission       numeric(5,2),
  sliding_max_commission       numeric(5,2),
  mgmt_expenses_pct            numeric(5,2),
  profit_commission_pct        numeric(5,2),
  lcf_years                    int CHECK (lcf_years BETWEEN 0 AND 20),
  lcf_extinction               boolean NOT NULL DEFAULT false
);
CREATE TABLE bk_commission_slides (
  contract_id     uuid REFERENCES bk_contract(contract_id) ON DELETE CASCADE,
  row_no          int  NOT NULL,
  loss_ratio_pct  numeric(6,2) NOT NULL,
  commission_pct  numeric(5,2) NOT NULL,
  PRIMARY KEY (contract_id, row_no)
);

CREATE TABLE bk_loss_participation (
  contract_id          uuid PRIMARY KEY REFERENCES bk_contract(contract_id) ON DELETE CASCADE,
  enabled              boolean NOT NULL DEFAULT false,
  min_loss_ratio_pct   numeric(6,2),
  max_loss_ratio_pct   numeric(6,2),
  reinsurer_share_pct  numeric(5,2),
  slides               jsonb NOT NULL DEFAULT '[]'   -- ≤5 × {min_lr, max_lr, share}, max_lr > min_lr
);

CREATE TABLE bk_epi_split (
  contract_id           uuid REFERENCES bk_contract(contract_id) ON DELETE CASCADE,
  class_of_business_id  uuid NOT NULL,
  premium               numeric(18,2) NOT NULL,
  PRIMARY KEY (contract_id, class_of_business_id)
);
```

## Non-proportional (Contract Details + Structure)

Contract Details reuses `bk_contract` only. The Structure screen writes a programme row and one row per layer, mirroring Universe `contract_np_details` / `contract_np_layers`.

```sql
CREATE TABLE bk_np_programme (
  contract_id          uuid PRIMARY KEY REFERENCES bk_contract(contract_id) ON DELETE CASCADE,
  number_of_layers     int  NOT NULL DEFAULT 1 CHECK (number_of_layers BETWEEN 1 AND 20),
  deductible           numeric(18,2),           -- layer-1 attachment; later layers cascade
  accounting_method    text CHECK (accounting_method IN ('Losses Occurring','Risks Attaching')),
  xl_type              text CHECK (xl_type IN ('Gross XL','Net XL')),
  accounts             text CHECK (accounts IN ('Half yearly','Quarterly','Annual')),
  est_gnpi             numeric(18,2),
  brokerage_pct        numeric(5,2),
  taxes_pct            numeric(5,2),
  no_claims_bonus_pct  numeric(5,2),
  profit_commission_pct numeric(5,2)
);

CREATE TABLE bk_np_layer (
  layer_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id          uuid NOT NULL REFERENCES bk_contract(contract_id) ON DELETE CASCADE,
  layer_number         int  NOT NULL CHECK (layer_number BETWEEN 1 AND 50),
  layer_limit          numeric(18,2),
  attachment           numeric(18,2),           -- derived cascade, stored
  aggregate_limit      numeric(18,2),           -- AAL
  egnpi                numeric(18,2),
  rate                 numeric(12,8),           -- whole percent on EGNPI
  earned_premium       numeric(18,2),           -- derived: EGNPI × rate / 100
  mdp                  numeric(18,2),
  mdp_pct              numeric(12,8),           -- derived: MDP / earned premium
  num_reinstatements   int,                     -- NULL = none; -1 = unlimited
  reinstatement_pct    numeric(6,2) CHECK (reinstatement_pct BETWEEN 0 AND 1000),
  aad                  boolean NOT NULL DEFAULT false,
  aad_amount           numeric(18,2),
  peril_scope          text NOT NULL DEFAULT 'RISK' CHECK (peril_scope IN ('RISK','CAT','BOTH')),
  rol                  numeric(12,8),           -- derived: earned premium / limit
  UNIQUE (contract_id, layer_number),
  CHECK (aad OR aad_amount IS NULL)
);

CREATE TABLE bk_np_layer_class_of_business (
  layer_id              uuid REFERENCES bk_np_layer(layer_id) ON DELETE CASCADE,
  class_of_business_id  uuid NOT NULL,
  PRIMARY KEY (layer_id, class_of_business_id)
);
```

## Saving

- One endpoint per screen: `PUT /api/contracts/:contractId/prop-detail` and `PUT /api/contracts/:contractId/np-structure`, each in a single transaction that upserts the child rows and bumps `bk_contract.row_version`.
- The client sends `row_version`; a mismatch returns 409 and the screen offers "Reload" or "Overwrite".
- Derived columns are recomputed on the server with the same formulas as the client (see Capture flow) — the client value is never trusted.
- Every write appends to an `bk_audit` table (`contract_id`, `umr`, user, field-level diff as jsonb, timestamp).
