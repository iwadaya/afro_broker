# AABI broking module — changelog

All changes for the reinsurance broking treaty-capture module, built to the nine
prompts in `aabi-prompts/` (01 plan → 09 verify) on top of the Universe
(`iwadaya/Saudi_re` @ 2918ee3) screens and helpers.

## 0.1.0 — first complete capture path

### Added

- **Plan and layout** (`docs/broking/PLAN.md`): `server/src/broking`, `client/src/broking`, `shared/broking` drop into the Universe monorepo unchanged; the rest of this repository is the minimal Universe slice they depend on, copied verbatim with a provenance banner.
- **Feature flag** `BROKING_ENABLED` (default off): mounts `/api/broking` and shows the Broking navigation entry; `BROKING_LLOYDS_BROKER_NO` pre-fills new UMRs.
- **Database** (migrations 003–006): `bk_business_type` / `bk_contract_status` / `bk_commission_mode` enums; `bk_contract` (UUID PK, `umr varchar(17) NOT NULL UNIQUE`, `CHECK umr ~ '^B[0-9]{4}[A-Z0-9]{1,12}$'`, `row_version`, `updated_at` trigger); `bk_umr_history`; `bk_contract_class_of_business`; `bk_prop_details`, `bk_commissions`, `bk_commission_slides`, `bk_loss_participation` (≤ 5 slides), `bk_epi_split`; `bk_np_programme`, `bk_np_layer` (`UNIQUE (contract_id, layer_number)`, `aad_amount` only with `aad`), `bk_np_layer_class_of_business`; `bk_audit` with a field-level JSONB diff. Seeds: reference data, three demo users in two organisations, one Quota Share & Surplus and one CAT XL (3 layers) sample contract. SQL proofs for duplicate / malformed UMRs, `aad_amount` without `aad`, layer-number uniqueness.
- **Shared calcs** (`shared/broking/calcs.js`): treaty mode, retention ⇄ cession pairing, retention / cession amounts, total capacity, renewal default, contract description, deductible cascade, earned premium / MDP% / ROL, layer totals, Stop Loss resolution, UMR normalisation and validation, required-field rules, status pipeline — unit tests plus cross-checks that feed the same inputs to the Universe functions.
- **API** `/api/broking` (auth + flag): contract list/search, `by-umr`, create (with renewal copy of the prior year's header and details), header, prop-detail, np-structure, amend-umr (audited, history table), status pipeline `DRAFT → SUBMITTED → QUOTED → FIRM_ORDER → BOUND → SIGNED` plus `NTU` / `CANCELLED`; Zod validation; optimistic locking via `row_version` (409 `STALE_WRITE`); derived columns recomputed server side; audit diff on every write; org scoping (IDOR sweep in tests). 46 supertest cases.
- **Client shell**: design tokens mapped onto the Universe CSS variables (Daylight / Midnight), `ab-` component styles, WizardShell, SummaryBar (UMR / UUID chips copy on click, status badge, actions menu), Pane, FormRow, NumericInput, TogglePill, Button, Badge, SlideTable, Modal; `useBrokingContract` (load / save with `row_version`, 409 Reload / Overwrite dialog, draft autosave on leave, "Draft saved HH:MM").
- **Identify step** `/broking/new`: UMR pre-filled with `B` + broker number, normalised as typed, live format message, uniqueness on blur (owner + "Open it"), business type, "Renewal of" search; the UMR is read-only afterwards except through **Amend UMR**.
- **Proportional Treaty Detail**: the Universe 2×2 screen field for field (Contract Details, Limit Details, Commissions FIXED / SLIDING, Loss Participation + EPI + Brokerage & Taxes), modals for classes, sliding scale, corridors and EPI split (±1 amber confirm), required-field highlighting after the first save attempt, Enter-to-next-field, Ctrl+S.
- **Non-proportional**: Contract Details (Universe left pane only) and Structure (programme strip + the 16-column layer table ported from `LayerTableCard` / `structureReducer`: cascade, derived columns, totals, reinstatement options, Risk / Cat lock by treaty type, arrow keys, Excel multi-cell paste, max 20 layers) with Stop Loss and Aggregate XL variants.
- **Tests**: server 105 (unit + integration incl. constraints and seed-derived checks), client 95 (calcs cross-checks, components, screens, reducer), Playwright e2e for Identify, Treaty Detail and NP capture; a screenshot harness that renders every design-system `preview.html` next to the app's component in both themes, and 1440 / 1280 walkthroughs (`docs/broking/screenshots`).
- **Deployment**: `deploy/provision-db.sh`, `deploy/deploy.sh --ref <ref>` (fetch → install → build → migrate → restart), `DEPLOYMENT.md`, Dockerfile + compose, CI workflow.

### Found by deploying and testing locally (`deploy/deploy.sh` + the suites against the running instance)

- The client kept its signed-in session only as a stored copy and never asked the server whether it was still valid: an expired or revoked cookie session left the shell on screen with every call failing. The request layer now signs out on any 401 outside sign-in (`SESSION_EXPIRED_EVENT`), the app re-validates a stored session against `/api/auth/me` on boot, and the sign-in screen says why the user is back ("Your session has expired…") before returning them to the page they were on.
- The e2e helper signs in once per user and reuses the session (cookies and web storage), so `E2E_BASE_URL=http://localhost:4000 npm run test:e2e` runs against a deployed server within its 10 sign-ins per 15 minutes.
- `DEPLOYMENT.md` gained the local recipe (`RESTART_CMD` instead of systemd, `--seed-demo`, pointing the suites at a deployment).

### Deviations from `data-model.md` (documented, deliberate)

- `bk_contract.org_id` — contracts belong to the signed-in user's organisation; every query is org-scoped (IDOR protection). Another organisation's UMR is reported as "taken" without leaking the contract.
- Header columns are nullable while `status = 'DRAFT'` (a contract exists from the Identify step onward); `CHECK bk_contract_header_complete` enforces completeness once the status leaves DRAFT, and `PATCH /status` refuses to leave DRAFT with required fields missing.
- `bk_np_layer` carries the Stop Loss / Aggregate XL inputs (`attach_lr_pct`, `limit_lr_pct`, `epi`, `aggregate_deductible`) so the Universe variants persist without extra tables.
- `bk_contract_class_of_business.sort_order` keeps the Universe "first selected = primary" order; `bk_audit` has its own PK and stores `{action, changes, ...meta}` in `diff`.
- Sessions: an httpOnly HMAC cookie with a readable CSRF cookie (Universe pattern), server-side `auth_session` rows.

### Universe quirks carried over on purpose ("Universe wins")

- `rateToFloat` uses `parseFloat`, so a rate typed with a thousands separator stops at the comma ("1,000" → 1).
- The totals row's reinstatement reduce is order dependent: an UNLIMITED layer followed by a numeric layer shows the number.
- NP money cells are whole currency amounts: fractions are truncated, not rounded (`toNum`).
- Retention ⇄ cession pairing is kept to 6 decimals (the design preview shows 2).
- Class order in "Line of Business" is the order the user ticked them (first = primary).

### Not carried over

- Universe quote mode, edit locks, slip ingest, expiring structures, COB participation and covered proportional programmes on the Structure screen — outside the broking capture scope.
- Aggregate XL policy-shape toggles (Franchise Deductible, Structured Deal) and per-class inner limits have no columns in the AABI data model.
- The Placement steps in the sidebar (Documents, Markets) are placeholders for a later phase.

### Security notes

- Every `/api` route requires a session (`requireAuth`), broking routes additionally require the flag; CSRF header check on mutating requests; helmet CSP; rate limits (disabled only under `ALLOW_DEMO_AUTH` for tests).
- UMR search is parameterised and LIKE-escaped; UUID path params are validated before any query; client-sent derived values are stripped by the Zod schemas.
