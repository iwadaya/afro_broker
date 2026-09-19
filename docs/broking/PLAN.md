# AABI broking module — plan

Afro_Asian_Business_Intelligence (AABI) captures reinsurance treaty contracts for a
broking house. Every contract carries a system **UUID** (primary key, every route and
foreign key) and a Lloyd's **UMR** (unique business key, every human-facing reference).
Proportional contracts are captured on a copy of the Universe Treaty Detail; non-proportional
contracts on the Universe NP Contract Details left pane plus the Universe Structure layer table.

The specification is the design system at https://claude.ai/artifact/QKzT3CoXkHuvRQ4naiCr8W
(`project/README.md`, `project/data-model.md`, `project/capture-flow.md`, the component
READMEs and `components/bundle.css`). An offline copy of every file is kept in
`docs/broking/design-system/` because the artifact is private.

## Where this repo sits relative to Universe

The prompts describe adding the module to the Universe (`Saudi_re`) monorepo. This repository
(`afro_broker`) is a **standalone deployment of the module** that keeps the Universe layout, so
the three module folders drop into `Saudi_re` unchanged:

| Folder | Role |
| --- | --- |
| `server/src/broking/` | Express router mounted at `/api/broking`, Zod schemas, repository, audit |
| `client/src/broking/` | React screens, components, hooks and the `ab-` stylesheet |
| `shared/broking/` | `calcs.js`: the pure calculation library used by client and server |

Everything else in `server/`, `client/` and `shared/` is the slice of Universe the module
depends on, copied with a provenance banner (`Copied verbatim from Universe (iwadaya/Saudi_re @
<sha>)`) or ported with the Universe pattern named in the file header. Reference tables, lookup
routes, auth, migrations runner, tokens and themes are therefore identical to Universe.

## Reused as-is (verbatim copies at their Universe paths)

| File | Used for |
| --- | --- |
| `client/src/components/PctInput.jsx` | `NumericInput kind="pct"` wraps it (className is passed in) |
| `client/src/utils/format.js` | `fmtComma`, `stripDigits`, `cleanNum`, `addMonthsClamped`, `yearFromDateInput`, `numOrNull` |
| `client/src/screens/proportional/treaty_detail/propTreatyHelpers.js` | `treatyModeFromType`, `getMissingRequiredFields`, `clampPct`, `extractLpSlides`, `canPersistTreatyHeader`; the oracle for the cross-check tests |
| `client/src/screens/proportional/treaty_detail/PropTreatyModals.jsx` | reference for `CobSelectModal`, `SlidingScaleModal`, `EpiSplitModal` behaviour (10 pre-filled rows, ±1 EPI tolerance, equal split) |
| `client/src/screens/non_proportional/structure/state/structureReducer.ts` | `recomputeDeductibles`, `recomputeFinancials`, `fullRecalc`, `applyTreatyModeCovers`, the paste matrix; the broking layer reducer composes these |
| `client/src/screens/non_proportional/structure/NpStructureHelpers.jsx` | `toNum`, `rateToFloat`, `fmtPctMaybe`, `parseExcelInt`, `parseClipboard`, `PASTE_FIELD_ORDER`, `emptyLayer` |
| `client/src/screens/non_proportional/structure/components/LayerTableCard.jsx` | the totals-row oracle rendered in the cross-check tests |
| `client/src/screens/non_proportional/reinstatementOptions.js` | the reinstatement select options |
| `client/src/utils/npTreatyType.js` | RISK / CAT / BOTH mode, Stop Loss and Aggregate XL detection |
| `client/src/styles/tokens.css`, `themes.css` | the Universe variables the design tokens map onto |
| `server/src/validation/common.js`, `lib/validate.js`, `helpers.js`, `lib/auth*.js`, `lib/csrf.js`, `lib/passwordHash.js`, `db/withTransaction.js`, `startup/runMigrations.js`, `middleware/errorHandler.js` | server plumbing |

## Copied and adapted

| Universe source | AABI file | Why not reused directly |
| --- | --- | --- |
| `CommaInput` (PropTreatyModals.jsx / NpStructureHelpers.jsx) | `client/src/broking/components/NumericInput.jsx` | the Universe versions hard-code the `fi` / `np-mini-input` class names and have no `min`/`max`/`derived` props; the formatting (`fmtComma` + `stripDigits`) is imported from the copy |
| `FR` (PropTreatyModals.jsx) | `client/src/broking/components/FormRow.jsx` | adds the required asterisk, `disabledReason` tooltip and `label-col` token |
| `TogglePill` (PropTreatyModals.jsx) | `client/src/broking/components/TogglePill.jsx` | adds arrow-key support and the `ab-toggle` classes |
| Layer totals (LayerTableCard.jsx, inline in JSX) | `shared/broking/calcs.js` `layerTotals` | needed server-side |
| `recomputeDeductibles` / `recomputeFinancials` (structureReducer.ts) | `shared/broking/calcs.js` `cascadeDeductibles`, `layerFinancials` | the Universe functions work on formatted strings; the shared library works on numbers so the server can recompute derived columns |
| `structureReducer.ts` | `client/src/broking/screens/structure/layerReducer.js` | the broking screen has no COB participation, expiring or quote surfaces |
| `server/src/routes/treaties.js` PUT pattern | `server/src/broking/routes/*.js` | one transaction per screen, `row_version` instead of `If-Unmodified-Since` |
| `server/src/routes/lookups.js` | `server/src/routes/lookups.js` | same wire shapes, no HTTP cache layer |

## Database

Migrations live in `server/src/db/migrations/` and run in filename order through the Universe
runner (`_migrations` table, per-file transaction, advisory lock).

| Number | File | Contents |
| --- | --- | --- |
| 001 | `001_reference_tables.sql` | Universe reference tables (`country`, `currency`, `brokers`, `companies`, `treaty_type`, `class_of_business`) + `set_updated_at()` |
| 002 | `002_org_users_sessions.sql` | `bk_org` (name, Lloyd's broker number), `uw_user`, `auth_session` |
| 003 | `003_bk_enums_contract.sql` | `bk_business_type`, `bk_contract_status`, `bk_commission_mode`; `bk_contract`, `bk_umr_history`, `bk_contract_class_of_business` |
| 004 | `004_bk_proportional.sql` | `bk_prop_details`, `bk_commissions`, `bk_commission_slides`, `bk_loss_participation`, `bk_epi_split` |
| 005 | `005_bk_non_proportional.sql` | `bk_np_programme`, `bk_np_layer`, `bk_np_layer_class_of_business` |
| 006 | `006_bk_audit.sql` | `bk_audit` |

In `Saudi_re` the latest migration is `157_quote_offer_status_checks.sql`, so the same four
broking files would be numbered 158–161 there (001–002 already exist as Universe tables).

Seeds (`server/src/db/seeds/`, `npm run seed`): demo org + users, reference data, and the two
sample contracts (a Quota Share & Surplus, a 3-layer CAT XL).

## API

Route prefix **`/api/broking`**, mounted only when `BROKING_ENABLED=true`, behind the same
`authenticate` → `csrfProtection` → `requireAuth` chain as every other API route. Contracts are
addressed by UUID everywhere except `GET /contracts/by-umr/:umr`. Every read and write is scoped
to the caller's `bk_org` (no IDOR). `GET /api/config` exposes the flag; `GET /api/broking/settings`
exposes the org's Lloyd's broker number (`BROKING_LLOYDS_BROKER_NO` overrides the org row).

## Feature flag

`BROKING_ENABLED` (server env, default **off**): the router is not mounted and `/api/config`
reports `brokingEnabled:false`, so the client hides the Broking navigation and redirects
`/broking/*` to the home screen. `BROKING_LLOYDS_BROKER_NO` (4 digits) pre-fills new UMRs.

## Build order

1. **01** — this plan, folders, flag, and the standalone base (auth, lookups, reference tables). ✓
2. **02** — `bk_*` migrations, seed contracts, SQL constraint proofs.
3. **03** — `shared/broking/calcs.js` + unit tests cross-checked against the copied Universe helpers.
4. **04** — `/api/broking` routes, Zod schemas, `row_version` locking, field-level audit, supertest suite.
5. **05** — client foundation: `broking.css`, components, routes, `useBrokingContract`.
6. **06** — Identify step (UMR), renewal copy, Amend UMR, Playwright e2e.
7. **07** — Proportional Treaty Detail.
8. **08** — NP Contract Details + Structure (layer table, Stop Loss, Aggregate XL).
9. **09** — verification, security review, DEPLOYMENT.md, CHANGELOG.md.
