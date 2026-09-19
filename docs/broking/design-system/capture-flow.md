# Capture flow

Every field below is copied from Universe (`PropTreatyDetail.jsx`, `NpTreatyDetail.jsx`, `NpStructure.jsx`); keys are the Universe slice keys so the two systems can exchange data.

## Step 1 — Identify (both business types)

A single pane, `IdentityField`, before anything else is enabled.

| Field | Control | Rule |
| --- | --- | --- |
| UMR | text, `umr` style, prefix `B` + broker number pre-filled | `^B[0-9]{4}[A-Z0-9]{1,12}$` after uppercase/trim; live format check; uniqueness check on blur (`GET /api/contracts/by-umr/:umr` → 404 means free) |
| Business type | toggle: PROPORTIONAL / NON-PROPORTIONAL | Decides the next screens |
| Renewal of | optional search by UMR or cedant | Sets `parent_contract_id`; copies prior-year details as a starting point |

"Create contract" inserts `bk_contract` (status `DRAFT`), returns the UUID, and routes to the next step. From here the summary bar shows **UMR** and **UUID** chips on every screen.

## Proportional — Treaty Detail (Universe 2×2)

Header pill `PROPORTIONAL TREATY: TREATY DETAIL`. Summary bar: Cedant · Country · Broker · Currency · Treaty Type · COB, the UMR/UUID chips, and the **Triangulations available** YES/NO toggle (default YES).

### Contract Details (top-left, tag `INPUT`)

| Label | Key | Control | Rule |
| --- | --- | --- | --- |
| Country | `countryId` | select | Required. Changing it clears Cedant |
| Cedant Name | `cedantId` | select, filtered by country | Required; disabled until a country is chosen |
| Treaty Type | `treatyTypeId` | select | Required. Quota Share · Quota Share & Surplus · First Surplus · Second Surplus · Third Surplus · Fac Oblig |
| Line of Business | `classIds[]` | button → checkbox modal | Required; shows first two, then "+N more"; first = primary |
| Broker | `brokerId` | select | Required |
| Contract ID | `contractId` | read-only | The UUID |
| Alt. Contract ID | `altContractId` | text | Optional, "External system reference…" |
| Currency | `currencyId` | select | Required |
| Treaty Inception Date | `inceptionDate` | date | Required |
| Treaty Renewal Date | `renewalDate` | date | Defaults to inception + 12 months until edited |
| UW Year | `startYear` | derived | Year of inception |
| Experience Start Year | `experienceStartYear` | select, current year − 40 … current year | Required |
| Contract Description | derived | read-only | `[UW year, cedant, treaty type, "(COB, …)", country code]` joined by spaces |

### Limit Details (top-right, tag `CAPACITY`)

Treaty mode from type: contains "quota" and "surplus" → `both`; "quota" → `quota`; "surplus" or "fac oblig" → `surplus`. QS fields are enabled in `quota`/`both`, surplus fields in `surplus`/`both`.

| Label | Key | Rule |
| --- | --- | --- |
| QS 100% Limit | `qsLimit` | QS; required |
| Retention % | `retentionPct` | QS; required; editing sets Cession % = 100 − Retention % |
| Retention Amount | derived | round(QS limit × Retention % / 100) |
| Cession % | `cessionPct` | QS; editing sets Retention % = 100 − Cession % |
| Cession Amount | derived | round(QS limit × Cession % / 100) |
| Surplus Max Retention | `surplusMaxRetention` | Surplus; required |
| Number of Lines | `numLines` | Surplus; required; ≥ 0 |
| Total Treaty Capacity | derived | quota: QS · both: QS + MR × N · surplus: MR + MR × N |
| Event Limit | `eventLimit` | Optional |
| AAL | `aal` | Optional |

### Commissions (bottom-left)

Head toggle **FIXED COMMISSION / SLIDING SCALE** (`commissionMode`, default fixed); the inactive block dims to 35%.

- Fixed: QS Commission % (QS types), Surplus Commission % (surplus types) — required in fixed mode.
- Sliding: Min Loss Ratio %, Max Loss Ratio %, Min Commission %, Max Commission % — required in sliding mode; "Enter slide manually" opens the slide table (Provisional Commission % + Loss Ratio % / Commission % rows, 10 pre-filled, ≥ 2 complete rows to save).
- Additional: Management Expenses %, Profit Commission %, Loss Carry Forward (None, 1–9 years, Extinction).

### Loss Participation · EPI · Brokerage & Taxes (bottom-right)

- Head toggle Loss Participation YES/NO (default NO). When YES: Min Loss Ratio %, Max Loss Ratio %, Reinsurer Share % required; "Enter slides manually" opens up to 5 corridors (Min LR %, Max LR %, Re Share %; max > min).
- EPI: Quota Share EPI (QS types), Surplus EPI (surplus types), both required when enabled. "EPI split" opens a per-class table; total must be within ±1 of QS EPI + Surplus EPI (amber warning otherwise, confirm to save). Unopened → split equally.
- Brokerage & Taxes: Brokerage %, Taxes % (0–100), Loss Cap % (0–1000).

## Non-proportional — Contract Details (left pane only)

Header pill `NON-PROPORTIONAL TREATY: CONTRACT DETAILS`. The Universe NP Treaty Detail **left pane**, unchanged: Country, Cedant Name, Treaty Type (Risk XL · CAT XL · Risk & CAT XL · Stop Loss · Aggregate XL), Classes of Business, Broker, Contract ID (UUID, read-only), Currency, Treaty Inception Date, Treaty Renewal Date, UW Year (derived), Experience Start Year, Contract Description (derived). Required: Country, Cedant, Treaty Type, Classes of Business, Broker, Currency, Inception.

The Universe right pane is not used; its structure fields live on the Structure screen instead.

## Non-proportional — Structure

Header pill `NON-PROPORTIONAL TREATY: STRUCTURE`, with RISK XL / CAT XL pills lit by treaty type (`RISK XL` → RISK, `CAT XL` → CAT, otherwise BOTH).

**Programme strip** (one row above the table, because the right pane was dropped): Deductible (layer-1 attachment), Type of XL (Gross XL / Net XL), Accounting Method (Losses Occurring / Risks Attaching), Accounts (Half yearly / Quarterly / Annual), Est. GNPI, Brokerage %, Taxes %, No Claims Bonus %, Profit Commission %.

**Layer table** — `+ Add Layer` appends, `Delete Layer` removes the last (never below 1, max 20). Sticky LAYER column; horizontal scroll.

| Column | Key | Input | Rule |
| --- | --- | --- | --- |
| LAYER | `layer` | label | 1…n |
| LIMIT | `limit` | money | integer |
| DEDUCTIBLE / ATTACHMENT | `deductible` | derived | layer 1 = programme Deductible; layer n = deductible(n−1) + limit(n−1) |
| AGGREGATE LIMIT | `annualAggLimit` | money | AAL |
| EGNPI | `egnpi` | money | defaults to Est. GNPI |
| RATE | `rate` | percent | whole %, 6 significant figures on blur |
| EARNED PREMIUM | derived | | round(EGNPI × rate / 100) |
| MDP | `mdp` | money | |
| MDP% | derived | | MDP / earned premium |
| NO. REINSTATEMENTS | `reinstatements` | select | —, 1–10, Unlimited |
| % REINSTATEMENTS | `reinstatementPct` | percent | 0–1000 |
| AAD | `aad` | checkbox | |
| AAD AMOUNT | `aadAmount` | money | enabled only when AAD ticked |
| RISK / CAT | `riskCover` / `catCover` | checkbox | forced and disabled in RISK or CAT mode; editable in BOTH |
| ROL | derived | | earned premium / limit |

**Totals row**: sums of Limit, Aggregate Limit, Earned Premium, MDP; Deductible = layer 1; EGNPI = max; MDP% = total MDP / total EP; Reinstatements = max or "Unlimited"; ROL = Σ(rate × EGNPI) / total limit.

**Excel paste**: a multi-cell paste fills across `limit, annualAggLimit, egnpi, rate, mdp, reinstatementPct, aadAmount`, one layer per pasted row, adding layers as needed.

Stop Loss and Aggregate XL swap in the Universe variants: Stop Loss per layer Attach LR %, Limit LR %, EPI (limit = EPI × Limit LR %, attachment = EPI × Attach LR %); Aggregate XL per layer Aggregate Limit, Aggregate Deductible, Deductible, AAD, Risk, Cat.

## Status pipeline

`DRAFT → SUBMITTED → QUOTED → FIRM_ORDER → BOUND → SIGNED`, with `NTU` and `CANCELLED` as exits. Moving past DRAFT requires every required field on every step; the sidebar shows a green dot per complete step and a `required` dot per incomplete one.
