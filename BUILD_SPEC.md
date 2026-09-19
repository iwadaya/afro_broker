# Afro-Asian Insurance Services — Build Specification

**Product:** Placement platform for reinsurance brokers.
**Scope now:** Treaty. **Scope later:** Facultative.
**Status:** Prototype deployed; repo accessible to Claude Code.

This document is the source of truth for the domain model and build order.
Read it before touching schema or writing endpoints.

---

## 1. The spine

Everything in this system hangs off one chain. Get this right and the rest is CRUD.

```
Cedant
  └── Contract              (a treaty programme, e.g. "Property Surplus")
        └── ContractYear     (the annual renewal — 2026, 2025, 2024 …)
              └── Structure  (what is being placed: layers / QS sections)
                    └── StructureVersion   ← the critical one
                          └── Line         (a reinsurer's participation)
```

### 1.1 Contract vs ContractYear

A cedant has many contracts. A contract renews annually. **ContractYear links to its
predecessor** (`prior_contract_year_id`).

That single link buys three features for free:
- expiring vs current slip diff (Module 1)
- the "was on expiring panel" flag on the bordereau (Module 9)
- expiring structures shown alongside the ones being quoted (Module 5)

Do not model renewal as "copy the record and edit it." Model it as a linked chain.

### 1.2 StructureVersion — one entity, not five tables

A structure is quoted, counter-quoted, negotiated, and firmed. Naive designs create
separate tables for expiring / quoted / alternative / negotiated / FOT structures.
Do not. Use **one versioned entity**:

```
StructureVersion
  id
  structure_id
  version_no
  status            enum: EXPIRING | SUBMITTED | QUOTED | ALTERNATIVE |
                          NEGOTIATED | FOT | BOUND
  origin            enum: BROKER | REINSURER | CEDANT
  origin_party_id   which reinsurer proposed it (null if broker/cedant)
  parent_version_id what it was derived from
  terms             structured terms (see §1.3)
  created_by, created_at
```

Consequences, all of them good:
- diffing any two states is one generic function over `terms`
- the negotiation history is the version chain, already audit-ready
- the ML dataset (Module 6) is a query, not an ETL job
- "reinsurer X always counters with a higher deductible" is answerable

### 1.3 Terms must be structured, not prose

This is the dependency that runs backwards through the entire system. The claims and
premium engine (Module 11) cannot compute anything from slip text. Capture terms as
typed fields from the first submission onward.

**Non-proportional:**
- `deductible` (attachment / priority)
- `limit`
- `layer_no`, `layer_of` (e.g. layer 2 of 4)
- `reinstatements[]` — each with `count`, `rate_pct` (100% / 50% …), `pro_rata_time`, `pro_rata_amount`
- `rate_pct` (rate on EGNPI), `rate_type` (flat / swing / variable)
- `egnpi`, `currency`
- `mdp` (minimum & deposit premium), `mdp_instalments[]`
- `aggregate_limit`, `aggregate_deductible` (nullable)
- `loss_occurrence` / `hours_clause`
- `brokerage_pct`

**Proportional:**
- `cession_pct` or `lines_ceded` (surplus)
- `retention`, `max_cession`
- `commission_pct`, `sliding_scale[]` (min/max/provisional, loss ratio bands)
- `profit_commission_pct`, `pc_expenses_pct`, `pc_deficit_carryforward_yrs`
- `epi`, `event_limit`, `currency`
- `brokerage_pct`

Store as a typed JSONB column with a discriminator on treaty type, plus a JSON Schema
per (treaty_type × class_of_business) for validation. Not free-form JSON.

A single placement may carry proportional and non-proportional structures together —
they are siblings under the same ContractYear, not separate placements.

### 1.4 Order, written, signed

```
Order         the share the broker is mandated to place (e.g. 50% of 100%)
Written line  what a reinsurer says it will take
Signed line   what it actually gets after signing down
```

If total written exceeds the order, lines sign down:

```
signing_down_factor = order_pct / total_written_pct
signed_pct = written_pct × signing_down_factor
```

Store `written_pct` and `signed_pct` separately and never overwrite one with the other.
Support per-line overrides (a reinsurer may refuse to sign down, or hold a guaranteed line)
so the factor is not blindly applied to every line. Placement completion = sum of signed
against order, exposed on the dashboard.

---

## 2. Cross-cutting decisions (apply everywhere)

### 2.1 Provenance on every extracted field
Anything AI or a parser populates carries:
`source_document_id`, `source_locator` (sheet!cell, or page + bbox), `confidence`,
`review_state` (UNREVIEWED | ACCEPTED | CORRECTED), `reviewed_by`, `reviewed_at`.

The UI must let a broker see where a number came from and accept or correct it. Corrections
are logged — that log is your cheapest source of extraction improvement.

**No AI-populated field is treated as authoritative until reviewed.** Nothing goes to
market off unreviewed data.

### 2.2 Audit log
Append-only. Every write to reference data (reinsurers, cedants, KYC status, ratings),
every structure version, every line, every outbound send. Record actor, timestamp, before,
after. KYC status and ratings are fields people later need to prove the state of.

### 2.3 RBAC
Roles: `ADMIN` (reference data write), `BROKER` (placements), `VIEWER`.
Enforce server-side on every route. Never rely on the UI hiding a button.

### 2.4 Confidentiality of ingested wordings
Reinsurer-specific wordings extracted from a cedant's slip are **not** automatically
publishable to the shared library. Every clause record carries `visibility`:
`MARKET_STANDARD | ORG_INTERNAL | PLACEMENT_ONLY`. Promotion to a wider visibility is an
explicit admin action, logged. Decide the policy before ingesting a single slip.

### 2.5 Determinism
All money and share arithmetic — signing down, reinstatements, allocations, adjustments —
runs in deterministic, unit-tested code. LLMs summarise, classify, extract, and draft.
LLMs never compute a number that appears on a document sent to a market or a cedant.

### 2.6 Money
Integer minor units. Currency on every amount. Never floats.

---

## 3. Modules

### M1 — Wordings & Clauses Library
- Clause and exclusion library indexed by class of business.
- Three provenance tiers: market standard, reinsurer-specific, internal.
- Compare a clause across market standard vs any reinsurer variant (rendered diff).
- Sources: online data + ingestion from slips.
- Slip upload (single and batch).
- Slip vs library check → flag non-standard and missing wordings.
- Slip vs slip diff (expiring vs current) with an AI-written summary of the differences.
- Draft slip generator: cedant details + classes of business + treaty type → market-standard draft.

**Hard problem — clause identity.** "Is this the same clause?" underpins the missing-wording
check, the variant comparison, and the diff. Solve it with a `ClauseType` layer:

```
ClauseType          canonical concept — "Cyber Exclusion", LMA5400 etc.
  └── ClauseVariant  a concrete text under a tier + owner
        └── text, normalised_text, embedding, market_reference (LMA/NMA no.)
```

Matching pipeline, in order:
1. exact match on `normalised_text` hash (whitespace, case, punctuation normalised)
2. market reference number if present (LMA/NMA codes are the strongest signal)
3. embedding similarity above threshold → candidate
4. LLM adjudication on candidates, returning a decision plus reasoning
5. below threshold → queue for human classification

Never auto-assign a ClauseType below the confidence threshold. An unclassified clause is
a safe state; a wrongly matched one silently corrupts the missing-wording check.

Diffs render at word level within paragraph alignment, not raw line diff — legal text
reflows and line diffs are unreadable.

### M2 — Renewal Pack Creator
- Standardised: same tabs, same fields, every pack.
- Empty tabs stay and render blank; they are never dropped.
- Some tabs vary by treaty type × class of business.
- Created from (a) an existing pack, reformatted to standard, or (b) uploaded bordereaux
  (premium, claims, contract data).
- AI-assisted with mandatory human review.

**Template as data, not code.** A `PackTemplate` defines tabs, sections, and fields, with
conditional inclusion rules keyed on (treaty_type, class_of_business). Adding a class of
business is then a config change, not a deploy. Version templates — a pack must render as
it did when it was issued.

Ingestion pipeline: upload → classify document → extract to canonical fields with provenance
→ present tab-by-tab for review → broker accepts/corrects → pack marked reviewed → issuable.

#### M2b — The renewal desk over uploaded packs (landed)
An uploaded pack (`renewal_pack_analysis`) opens as a six-stage desk — *01 Renewal pack*,
*02 AI summary*, *03 Market email*, *04 Responses*, *05 Signed lines*, *06 Claims* — one tab
strip with the stage in the URL (`?tab=`). The stages after the first two run on the
placement the pack is linked to (`PUT /api/renewal-analyses/:id/placement`): its layers,
lines, submissions and documents, never a parallel copy.

- **Two intakes, one record.** Uploading asks *quick or full*. Full is the manual route: the
  broker types the cedant, country, treaty type and classes. Quick hands the packs to the model
  first (`POST /api/renewal-analyses/intake`), which reads those same details off them —
  constrained to the reference lists the dropdowns hold, each pick with its source and
  confidence (§2.1) — and fills the form for the broker to correct and add to; the packs then
  go onto the record with the create. The record keeps `intake_mode` and, for a quick intake,
  the model's picks beside the broker's review of each field (`accepted | corrected | added`),
  worked out server-side from the two sides — the correction log §2.1 asks for.
- **Sign-off is a state on the record**, not a checkbox in the browser: `verified_at` and
  `verified_by`, set by `POST /api/renewal-analyses/:id/verify` (broker, senior broker or
  admin) and withdrawn by `DELETE`. A run, an upload, a removed document or any edit to the
  summary prose (`PATCH …/summary`) clears it, and the market email refuses to send without
  it. Every one of those is audited with before and after.
- The model's schema carries provenance (§2.1): every programme fact, layer, experience year
  and change has a `trace` entry naming its source, and anything the model could not read is
  a `flag` (`missing | conflict | judgement | unreadable`), never an estimate.
- The market send is a `negotiation_submission` on the analysis (`analysis_id`; `pack_id` is
  now optional) under the same four-eyes approval as a pack send (D7): the broker submits,
  an underwriter or admin releases, and a reminder goes to each recipient three days before
  `response_deadline` if they have not replied.
- Responses write to the line ledger. A signed line may be overridden below the written line
  (`PATCH /api/layers/:id/lines/:marketId`, with notes) and never above it; a short layer is
  firmed at written only by an explicit accept-shortfall (§1.4). `POST …/release` is the gate
  into the signing advice, which sends one template merged per reinsurer through the final
  placement module and is audited per recipient.

### M3 — Distribution & Market Approach
Two stages, one engine:
1. Pack to quoting markets for terms.
2. Once FOT is set, pack + FOT to follow markets for follow shares.

Select reinsurers from the register, pull stored underwriter contacts, send a templated
email with the structures to be quoted. Track: sent, delivered, opened (if available),
responded. Every send is a logged record tied to the ContractYear and the version sent.

### M4 — Reinsurer Register
Reinsurer profile: legal entity, domicile, ratings (agency, rating, date, outlook), KYC
status and expiry, capital base, classes written, appetite notes, security approval status.
Underwriter contacts with role, class, and territory so recipient selection is filtered,
not manual. Admin-write only.

### M5 — Structures
Capture structures to be quoted (proportional, non-proportional, or both). Capture
underwriting limits. Capture expiring structures — these come from the prior ContractYear
automatically where linked, and are otherwise entered or extracted.

### M6 — Quote Response Tracking
Per reinsurer per structure, record the outcome:
`QUOTED | DECLINED | ALTERNATIVE_QUOTED | NO_RESPONSE | ABSTAINED`

`NO_RESPONSE` is a distinct outcome from a decline and is easy to lose — capture it
explicitly when a placement closes, do not infer it from absent rows.

An alternative quote creates a new StructureVersion with `origin = REINSURER` and
`status = ALTERNATIVE`, linked by `parent_version_id` to what was submitted. Decline
reasons as a coded enum plus free text.

Builds a per-reinsurer history across placements. **Design the response schema for the
future ML model now** — reinsurer, class of business, treaty type, territory, cedant rating,
layer attributes, rate, market conditions at the time, outcome, all as structured fields.
The model is far off; capturing the data badly for two years is not recoverable.

### M7 — Cedant Register
Cedants with KYC information and expiry, rating, domicile, classes written, contacts.
Admin-write. A cedant has many contracts.

### M8 — Quote-to-Client Cycle
Send quotes to the cedant. Track through the client stage. Support negotiation: threaded
comments against a structure version, and negotiated structures as new versions
(`origin = CEDANT` or `BROKER`, `status = NEGOTIATED`).

Outcome: taken up or not. On take-up the version is promoted to `FOT` and released to
follow markets via M3. **FOT promotion is the point where terms must be complete and
validated against the JSON Schema** — the claims and premium engine reads from here.

### M9 — Lines & Placement Completion
Order tracking against progress. Written lines and signed lines per contract. Written lines
sent to the cedant incrementally as they arrive from follow markets — not one final send.

Written lines bordereau per contract: reinsurer, share, rating, and a flag for whether the
reinsurer was on the expiring panel (derived from `prior_contract_year_id`, not typed in).
Export to Excel and PDF.

### M10 — Home Dashboard
Real-time summaries: quotes, FOTs, written lines, signed lines, brokerage. Upcoming
renewals with lead time to inception.

Brokerage depends on `brokerage_pct` living on the structure terms and potentially differing
between quoting and follow panels — resolve where it sits before building the dashboard
number, or it will be wrong and quietly so.

Compute from queries against the spine; do not maintain denormalised counters until you
have measured a need.

### M11 — Claims & Premium (non-proportional first)
Proportional deferred. On an NP claim:

```
recovery = min(max(loss - deductible, 0), limit)
```

Reinstatement premium, per reinstatement consumed:

```
RI premium = (recovery / limit) × reinstatement_rate × premium
             × (pro-rata time factor, if time pro-rata applies)
```

Honour the reinstatement schedule (1st at 100%, 2nd at 50%, etc.), aggregate limits, and
free reinstatements. Allocate to each reinsurer by **signed** share. Produce the calculation
document and a covering email to the panel.

Premium received: allocate by signed share.

Year-end adjustment:

```
final premium = actual GNPI × rate
adjustment    = final premium − premium already paid (MDP + instalments)
```

Handle swing rates with their min/max, and burning-cost formulae where the rate is
loss-driven. Every calculation is stored with its inputs and the FOT version it ran
against, so it can be reproduced years later.


**Landed — the claims desk and claim-notification intake.** The non-proportional side is
built to this; the proportional side reads the bordereaux module as ingested.

- `claim_notification`: an inbound loss advice (from a mailbox, or pasted in through
  `POST /api/claim-notifications/ingest`) is read — the provider's structured output when a
  key is set, a labelled-line fallback otherwise, `parsed.source` saying which — and matched
  to a placement on the treaty reference (0.9), cedant + class + period (0.85), insured +
  date of loss (0.8), cedant + period (0.7) or the insured alone (0.6). Below 0.75 it waits
  as `unmatched` with the best suggestion kept, and a broker can `match`, `park` or `load` it.
- **Load** creates the `loss_event` from the parsed particulars (reference, insured, cause,
  date of loss, reserve — never invented), runs the calculation and issues the **preliminary
  loss advice** to every market with a signed line on any layer: once per market, once per
  notification, idempotent. The calculation accepts SIGNED as well as BOUND layers — a signed
  layer's shares are fixed.
- The **settlement ladder** (`domain/claimSettlement.js`, pure and unit-tested) reads the
  XoL engine's loss to layer and reinstatement premium: gross to layer + LAE − salvage −
  reinstatement premium (waivable; pro rata to amount, 100% as to time; offset against the
  claim, so no separate invoice) − cash already funded = net due. Expenses, salvage and cash
  are apportioned on each market's share of the gross by largest remainder, so every column
  sums to the ladder to the cent. The ladder is stored on the event and in the loss-advice
  document with its inputs.
- The **claim advice** (`claim_advice`, `POST /api/losses/:id/claim-advice`) is one template
  carrying the 100%-of-layer breakdown, merged per reinsurer with its own share schedule, and
  audited per recipient. `GET /api/claims/contracts?q=` and `GET /api/claims/contracts/:id`
  are the desk's read model: the contracts a handler can open, and everything the tab shows
  for one.

### M12 — Admin
Admin-only management of reference data: reinsurers, cedants, underwriter contacts, clause
types and market-standard variants, pack templates, users and roles. Everything logged.

### M13 — Pack read API (Universe-facing)
Versioned, service-authenticated read API over reviewed renewal packs, consumed by Universe
to populate its pricing inputs. See D8 for the full requirements and the unresolved data
scope question. Afro-Asian must function fully with Universe absent — this is a publisher,
never a dependency.

Build after M2. The endpoint is small; the discipline is in treating the pack projection as
a frozen contract.

---

## 4. Build order

Each phase ends shippable. Do not start a phase before the one above it is merged.

**Phase 0 — Reconcile — COMPLETE**
Audit done. Verdict: rebuild the spine, harvest the prototype. See §6 and §7.

**Phase 1 — Foundation**
Schema for the spine (§1). RBAC. Audit log. Four-eyes framework (D7) with break-glass.
Admin module. Reinsurer and cedant registers.
Acceptance: an admin can maintain reference data; a broker can create a cedant, contract,
and contract year linked to a prior year; every write is audited; no outbound action can
complete on one user's authority.

**Phase 2 — Structures & placement core**
Structures with versioning and typed terms. Term JSON Schemas for the first treaty types.
Expiring structures pulled from the prior year.
Acceptance: a broker can build a placement with proportional and non-proportional structures
and see expiring alongside current.

**Phase 3 — Distribution & quote capture**
Email engine, recipient selection, send tracking. Quote response capture with all outcome
types including alternative quotes as versions.
Acceptance: send to a panel, record every response type, see a reinsurer's history.

**Phase 4 — Client cycle, FOT, lines**
Quotes to cedant, negotiation comments and versions, FOT promotion with term validation.
Written and signed lines, signing down, bordereau export, incremental sends to cedant.
Acceptance: a placement runs end to end from submission to a signed bordereau.

**Phase 5 — Dashboard**
Summaries and brokerage over the now-complete spine.

**Phase 6 — Renewal pack creator**
Template engine as data, versioned. Bordereaux ingestion with provenance. Pack-to-standard
reformatting. Tab-by-tab review UI. M13 pack read API once packs are stable.

**Phase 7 — Wordings & clauses library**
ClauseType and variants. Normalisation and matching pipeline. Slip ingestion. Library vs
slip check. Slip vs slip diff with AI summary. Draft slip generator.

**Phase 8 — Claims & premium (NP)**
Recovery, reinstatements, allocation, year-end adjustment, documents and emails.

**Later:** proportional claims and premium, facultative, ML on quote history.

Rationale for the order: the pack creator and the clause library are the most visible parts
and the most tempting to build first, but both write into the spine. Built early they encode
assumptions the spine later contradicts, and you rewrite them. Placement flow first.

---

## 5. Decisions taken

These are settled. Implement them as written; do not re-litigate in code review.

### D1 — Single-tenant
One deployment, one broking firm. No `tenant_id`, no tenant scoping, no row-level tenant
guards. Keep the schema simple. Serving multiple firms later is an accepted migration cost.

### D2 — Brokerage sits on the structure
`brokerage_pct` lives in the structure terms (§1.3), so it versions with the structure and
any movement during negotiation is captured in the version chain automatically. No
line-level override.

Dashboard brokerage:
```
Σ over signed lines: premium × signed_pct × structure.brokerage_pct
```

### D3 — Harvested clauses: abstract, strip, then reuse
Clause variants harvested from ingested slips may enter the shared library, but only after
scrubbing: remove cedant names, limits, dates, territories, and any deal-identifying
particulars.

Promotion from `PLACEMENT_ONLY` to library visibility is an **explicit human action**, with
original and scrubbed text shown side by side for approval. Never automatic. Auto-scrubbing
is exactly where an identifier survives unnoticed — and once it is in the shared library it
gets shown to the next cedant.

Log every promotion: who approved, when, source document.

### D4 — Quote responses captured manually (Phase 3)
Broker records outcome and terms by hand. AI parsing of reply emails is a later ingestion
path writing to the **same** response schema — no schema change when it arrives, just the
provenance block from §2.1 populated.

UI requirement: recording a decline must be as fast as recording a quote — one click plus a
reason code. If declining is slower than ignoring, brokers ignore it, and the negative
examples the ML model depends on are never captured. A model trained only on quotes learns
nothing about who says no.

### D5 — Email: hybrid sender
Send **as the broker** (`ane@yourbroker.com`), with a shared placements mailbox on
`reply-to`. Personal sender for the market; one place the system can read responses.

Two requirements, both non-negotiable or mail silently stops arriving:
- SPF, DKIM and DMARC aligned on the sending domain when relaying through a transactional
  provider. Monitor DMARC reports — junked submissions fail invisibly.
- Plus-addressed reply-to carrying the placement id:
  `placements+<contract_year_id>@yourbroker.com`. This is what lets the D4 parser attach a
  reply to the right placement later without guessing.

### D6 — Retention: keep everything, archive not delete
Object storage with signed URLs. Deletion in the UI sets `archived_at`; nothing is hard
deleted by ordinary flows. Reinsurance disputes surface years after inception and long-tail
classes run a decade or more.

**Required exception:** KYC files hold personal data on named individuals (directors,
beneficial owners, signatories) and Saudi PDPL grants erasure rights in some circumstances.
Build a hard-delete capability behind an admin-only role that writes an immutable deletion
record (what, who, when, on what basis) to the audit log. It may never be used. Without it,
compliance has no answer to a valid request short of a rebuild.

### D7 — Four-eyes approval on all outbound
Nothing leaves the system to a market or a cedant on one person's authority. Submissions,
FOTs, written-line advices, and claim calculations all require a second user to approve
before send. Preparer and approver must be different users; enforce server-side.

The prototype's existing four-eyes framework is a **harvest candidate** — see §7.

**Break-glass is mandatory.** Provide a documented single-user override, admin-authorised,
that writes a loud audit record (who overrode, what, when, stated reason) and is reportable.
Not because it should be used, but because a control with no legitimate escape hatch at 11pm
on 31 December gets bypassed with a shared login — and then you have neither the control nor
the audit trail.

### D8 — Universe integration: separate products, Afro-Asian publishes
Afro-Asian and Universe remain separate products with separate databases and separate release
cycles. Afro-Asian **exposes a read API**; Universe consumes it to populate its own inputs
from the standard renewal pack. No shared data layer, no reverse dependency — Afro-Asian must
function fully with Universe absent.

Requirements:

- **The pack shape is a published contract.** Version the API from day one (`/v1/packs/…`).
  M2 templates may evolve freely, but the API projection over them stays stable. Breaking a
  field breaks a downstream system.
- **Only reviewed packs are exposed.** §2.1 makes unreviewed AI-extracted fields
  non-authoritative. If Universe can pull an unreviewed pack, that rule breaks silently and
  unreviewed extractions get priced. Gate the endpoint on pack review state.
- **Service-to-service auth**, not a user session. Universe authenticates as a client with
  its own credential and scope. Every pull is audit-logged: which pack, when, by which client.
- Rate limit and paginate. Assume the consumer will pull more than you expect.

**Unresolved and blocking the endpoint (not the rest of M2):** which packs Universe may read.
A pack carries a named cedant's premium and claims experience; Universe serves reinsurance
pricing. Cedant data crossing from the broking side into a reinsurer-facing tool is an
information-barrier question and a mandate question, not a technical one. Options: full
access / per-cedant consent flag / anonymised packs only (identifiers stripped, experience
intact — which is all a pricing engine actually needs). Default to anonymised until decided.

### D9 — First treaty types: Property Cat XL and Property Surplus
Phase 2 builds term JSON Schemas (§1.3) for exactly these two. Nothing else, until they are
in production use.

Selection rationale — coverage, not volume:
- **Property Cat XL** exercises nearly every non-proportional field: attachment, limit,
  layering, reinstatement schedule, EGNPI, rate, hours clause. The reinstatement logic is
  the hard part of M11 regardless, so it is built once and reused.
- **Property Surplus** is the demanding proportional shape — lines, retention, max cession,
  sliding-scale commission, profit commission. Quota Share is a near-subset and falls out
  cheaply afterwards. Building QS first does **not** give you Surplus.
- Engineering shares most of Property's shape and is the cheapest third.

Second and subsequent treaty types of a shape already built are cheap. The first of each
shape is not. Do not add a third schema before these two have run a real placement.

---

## 5b. Still to settle

**Blocking Phase 1 (answer before the first migration):**
- Does the deployed Render instance hold any real placement data, or is it test-only? If
  test-only, reset the migration series and start Phase 1 with a clean initial migration —
  §6's never-edit rule protects production history, and there is none yet. Confirm no one
  else has been entering real data against it.

**Blocking further merges:**
- **CI has been red on `main` for days.** All three jobs die in ~4 seconds before any step
  executes, with no retrievable logs — runner provisioning, most likely an org-level Actions
  billing or spending limit. Four PRs have landed on local verification alone. Nothing in
  this repo currently has automated verification, including the tests that are the only
  evidence the spine constraints hold. Fix billing, then re-run the last four merges through
  CI before adding a fifth.

  Merging on local verification is a temporary exception, not a working practice. Four PRs
  in, it has already become the normal state.

**Blocking Phase 2 completion:**
- **Is `StructureVersion` in?** §1.2 names it the critical entity, and M6 and M8 depend on
  it most. If those modules are still built against `quote`/`fot`/`layer`, the spine is
  half-landed and the harder half remains.
- **Backfill needs an owner and a date.** `placement.contract_year_id` is nullable, so two
  entity models now coexist. That is fine as a transition and corrosive as a destination:
  every module built while it persists must handle both shapes, and the nullable FK stops
  being a migration aid and becomes a permanent branch in the code.

  Deferring was right — inferring programme grouping from `(cedant, class)` would invent a
  domain rule, and a wrong grouping corrupts the chain it is meant to create. But the
  grouping is a judgement a broker makes about the book, cedant by cedant, probably an
  afternoon with a spreadsheet. Assign it to a person, not a migration. Once done, make
  `contract_year_id` NOT NULL.

**Blocking the M13 endpoint only:**
- Which packs Universe may read — full / per-cedant consent / anonymised. See D8.

**Own change, not to be bundled:**
- §2.3 role rename to `ADMIN`/`BROKER`/`VIEWER`. Touches 39 files across every module;
  bundling it breaks authorisation app-wide.

**Not blocking:**
- Whether cedants ever get direct read access, or receive everything by email.

---

## 6. Repo state

**Landed:**
- The spine's upper levels (§1.1): `contract` and `contract_year`, renewal chain enforced in
  schema — composite FK keeps a predecessor inside its own contract, partial unique index
  prevents a year renewing twice. `placement.contract_year_id` nullable, one placement per
  year.
- Audit before/after (§2.2), append-only enforced by trigger, existing `detail` untouched.
- Break-glass (D7): admin-only override, mandatory stated reason enforced by table
  constraint, loudly audited and reported. `assertApproved` gates an outbound action and
  consumes the approval, so one authorisation cannot cover two sends.
- Much of M1, M2, M3, M4, M6, M8 — **built on the old placement model**, predating the spine.
- The renewal desk over uploaded packs (M2b): the six-stage tab spine, sign-off on the
  record with the verify endpoints, the desk submission under four-eyes, responses on the
  line ledger with the signed override, and the merged signing advice.
- Claims intake (M11): claim notifications read and matched, loaded into a loss event with
  the preliminary advice to the signed panel, the settlement ladder and the per-reinsurer
  claim advice, and the claims desk read model on both bases.

**Superseded:** the original Phase 0 gap analysis audited a stale snapshot (`fe576a5`) and
described a codebase that no longer exists. Its "rebuild the spine, harvest the prototype"
verdict and its ~25–30%-survives estimate no longer describe reality and should not be cited.
A fresh gap analysis against current `main` is worthwhile — the useful question now is which
of the already-built modules need rework onto the spine, and in what order.

**Preserved elsewhere:** branch `phase1-on-stale-base` (`c040f3c`) holds the money library
(§2.6 integer minor units) and the KYC-erasure flow (D6). Push it somewhere durable — the
container it lives in is ephemeral, and the money library underpins every calculation in M11.

## 7. Harvest list

Name files before deleting anything.

Confirmed keepers:
- **`signingDown.js`** — implements §1.4 correctly including the per-line override:
  `to_stand` lines are reserved and the factor applies to the residual order rather than
  blindly to every line, with largest-remainder reconciliation so `Σ signed === order`
  exactly. Needs integer minor units (§2.6). Keep its tests. Fiddly, easy to get subtly
  wrong, boring to rewrite.
- **Four-eyes approval framework** — required by D7, now extended with break-glass.
- **RBAC enforcement pattern** — server-side on every write, correct per §2.3.
- **Money library** and **KYC-erasure flow** — on `phase1-on-stale-base`, see §6.

**Note on tenancy:** no tenant column exists anywhere. Per D1 that is the target state, not
a gap. Do not add one defensively.

---

## 8. Working rules for Claude Code

- Read this file before schema or endpoint work.
- Migrations only; never edit a migration that has run. (Exception: the initial reset, if
  §5b confirms the deployed instance holds no real data.)
- Financial arithmetic in pure, unit-tested functions with worked examples from the spec.
- No LLM output reaches a market-facing document without a review state.
- Enforce authorisation server-side on every route.
- No outbound action completes on one user's authority (D7). Preparer ≠ approver, enforced
  server-side, break-glass audited.
- Check §7 before deleting prototype code. Harvest, don't rewrite what already works.
- Small PRs, one concern each. Stop and ask rather than inventing domain rules.
- Do not merge on local verification while CI is down (§5b). If CI is red for reasons
  unrelated to the change, say so and stop — do not treat prior merges as precedent.
- When a spec item is ambiguous, raise it — do not guess. Wrong domain assumptions here
  are expensive and quiet.
