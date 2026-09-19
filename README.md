# Afro-Asian Insurance Services — reinsurance placement

Placement and distribution system for treaty/fac reinsurance broking, linked to
[Universe](#universe-integration). Universe stays the technical engine (pricing,
portfolio, accumulation); **Broking owns the placement**: assembling the renewal
pack, taking it to market, capturing quotes, agreeing firm order terms,
collecting written lines, signing down, and binding.

This repository implements the design in `universebrokingdesign.md`: a complete
Express + PostgreSQL service covering all 12 phases / modules of the plan — with
the integrity-critical pieces (immutable FOT, four-eyes, the signing-down engine)
covered by tests — plus a React + Vite frontend **stripped to four functions**:
the **Contracts** function (a proportional treaty opens the Universe modelling
tool's treaty detail; a non-proportional one its contract details pane),
**Portfolio intelligence**, the **Renewal calendar** and **Market
intelligence**, under the home dashboard. The backend still serves the whole
placement lifecycle through its API — the sections below that describe the
placement page, the layer workspace, signing, wording, claims and premium,
renewal packs and the dynamic financial analysis document that API and its
rules; their screens are no longer in the interface.

## Stack

- **Backend:** Node 20+, Express, PostgreSQL, [Zod](https://zod.dev) validation,
  JWT auth, `pg`. ESM throughout.
- **Frontend:** React 18 + Vite + React Router. Role-aware UI (broker drives;
  underwriter authorises FOT/bind) talking to the API via a dev proxy.
- **Counterparty research:** ChatGPT via the shared `lib/llm.js` module, with
  server-side web search, used to gather a counterparty's group profile.
  Optional — with no key set, the market register is manual-entry only.
- **Tests:** Node's built-in test runner (`node:test`). Unit tests for the
  domain logic; HTTP integration tests against a real Postgres database.

## Layout

```
backend/
  src/
    domain/        signingDown.js, statusMachine.js, wordingDiff.js,  ← pure logic
                   compliance.js, dfa.js, structuring.js, capitalRegimes.js
    db/            pool, migration runner, SQL migrations, seed
    middleware/    auth (JWT + RBAC), error handling
    lib/           errors, http helpers, audit, four-eyes approvals, csv
    integrations/  universe.js (technical pull / inwards push; stubbed offline)
                   marketIntel.js (counterparty research via lib/llm.js)
    modules/       auth, register, markets, placements, bordereaux, packs,
                   marketing, fot, lines, signing, documents, shares, wordings, dashboards, dfa, admin
  test/
    unit/          signingDown, statusMachine, wordingDiff, occupancy, negotiation,
                   submissionEmail, compliance, dfa, capitalRegimes
    integration/   lifecycle, fot, signing, signingContracts, wordings, occupancyClasses,
                   negotiation, negotiationSubmission, markets
frontend/          React + Vite app
```

## The interface

The frontend wears **Daylight**, the theme carried over from the Universe
modelling tool: emerald on a light slate ground, glass panels with soft
elevation, rounded corners, and Inter throughout. Its tokens sit at the top of
`frontend/src/styles.css` and are the single place to retune colour, type,
radii and elevation — the six designed screens were drawn against their own
`--color-*` vocabulary, but those names now resolve to Daylight, so the whole
app follows one theme. Inter is self-hosted in `frontend/public/fonts`, so the
interface never depends on a CDN at runtime.

The theme picker in the account menu swaps those tokens for another palette
(`frontend/src/themes.css`): the Universe dark themes — Midnight, Ocean,
Graphite and Sunset — and **Maksure**, a client theme for demonstrations to
Maksure Risk Solutions in the orange and charcoal of maksure.co.za, light like
Daylight with statuses keeping their meaning. Each theme is one block of
tokens, so a client palette is retuned in one place; the choice persists in
the browser. The brand lockup in the top bar and on the login screen leads
with the **house logo** — Afro-Asian Insurance Services Ltd, broker at
Lloyd's, self-hosted under `frontend/public/brand/afro-asian` and set as
`HOUSE_BRAND` in `frontend/src/theme.js` — on every screen and every theme
(the dark themes put it on a white plate; a narrow window keeps the logo and
drops the wordmark). A client theme can carry a logo of its own under
`frontend/public/brand`, which then leads instead; and `/?theme=maksure`
opens a fresh browser in that theme for a demonstration.

There is no left rail: every screen runs the full width of the window, and
the **dashboard is the hub** — the treaty renewal book as it always was: the
welcome, the headline metrics, the placement spine, the renewal-pack store
by cedant and the renewal calendar shelf. Under its welcome, a launcher lists
the tool's four functions as one row of green pills — **Contracts**,
**Renewal calendar**, **Portfolio intelligence** and **Market
intelligence** — and **Home** in the top bar brings the hub back from any
page. The **Acting as** switch, the theme picker, Admin (for an admin or
underwriter) and sign-out live in the top bar's account menu, under the
signed-in user's name.

**Contracts** (`/contracts`) opens on two options — **Proportional** and
**Non-proportional** — above the contracts already on the book (every
placement, with its class of business, treaty type and basis, searchable
from the page or from the top bar's search box, and narrowed by basis). A
contract is a placement: the record the calendar, the portfolio and the
market intelligence read.

- **Proportional** (`/contracts/proportional`, then
  `/contracts/proportional/:id` once saved) is the Universe modelling tool's
  proportional Treaty Detail, field for field: the summary strip with the
  *Triangulations available* toggle, the contract line, then the 2×2 grid
  **CONTRACT DETAILS** · **LIMIT DETAILS** · **COMMISSIONS** · **LOSS
  PARTICIPATION** (with EPI and BROKERAGE & TAXES). The dropdowns are the
  tool's reference lookups (see *Reference data behind Treaty Detail*): the
  country filters the cedant register (a cedant can be registered from the
  dropdown), the treaty type offers the proportional types only, the line
  of business is the tool's class-of-business modal, the broker and the
  currency their lists. The tool's logic comes with it: the treaty type
  gates the quota-share and surplus fields (*Not applicable for this treaty
  type* on the rest); Retention % and Cession % always sum to 100; the
  retention and cession amounts, the total treaty capacity (QS limit · max
  retention × lines · both), the UW year and the contract description
  (*2027 Cedant Treaty Type (classes) GB*) derive live; the renewal date
  defaults to inception + 12 months until edited by hand; FIXED / SLIDING
  and YES / NO dim the inactive block; the manual slide, the stepped loss
  participation (up to five corridors) and the EPI split by class (an equal
  share until entered, reconciled against the total) open in modals; the
  required fields (the tool's rules: the active half's limit, retention and
  EPI, the fixed commissions or the sliding bounds with at least two rows of
  the slide, the loss-participation scalars when it is on) are highlighted
  after the first save attempt with a *Required: …* summary; Enter moves
  field to field and pane to pane, and Ctrl+S saves. Saving writes the
  contract details onto the placement, the terms onto its proportional
  structure (`quote_structures[].prop`) and its quota-share / surplus
  layers — one per half the treaty type activates, carrying the limit and
  the EPI at 100% — so the calendar and the portfolio read the treaty's
  size; a new contract lands on its own URL, and *Save & next* goes on to
  its documents.
- **Non-proportional** (`/contracts/non-proportional`, then
  `/contracts/non-proportional/:id`) is the tool's NP Treaty Detail:
  **CONTRACT DETAILS** on the left, with the non-proportional treaty types
  (Risk XL, CAT XL, Risk & CAT XL, Stop Loss, Aggregate XL) and the *Classes
  of Business* picker, the same derived UW year, description and renewal
  default, and the same required set (country, cedant, treaty type,
  classes, broker, currency, inception, experience start year); and
  **STRUCTURE** on the right — the layer configuration (number of layers,
  the expiring number, deductible, maximum retention, accounting method,
  type of XL, accounts) and the premium & commissions (Est. GNPI, brokerage,
  taxes, no claims bonus, profit commission), none of it required. Saving
  writes the placement's header, the terms onto its non-proportional
  structure (`quote_structures[].np`), and Est. GNPI as its estimated
  premium so the calendar reads the treaty's size.
- **Documents** (`/contracts/<basis>/:id/documents`) is the second step of
  both workflows, laid out as the tool's Documents screen: the *Files for
  Treaty* chip and the contract id; the drag-and-drop zone (*browse*, *+
  Select Files*); the upload form — a document type off the tool's list
  (Final Slip, Draft Slip, Expiring Slip, Renewal Pack, Large Loss List,
  Risk Profiles, Claims Profile, Presentation, CAT Modelling, Bordereaux,
  Accounts, Other), a title suggested from the type, an optional
  description, the picked file and *↑ Upload* (15 MB a file); and the
  *Uploaded Documents* card — file, type, title, size, uploaded and who by
  — with *View* (PDFs, images and text open in a preview over the page),
  *Download* and *Delete*. They are held on `contract_document` and served
  by `GET/POST /api/placements/:id/contract-documents`,
  `GET /api/contract-documents/:id/view` (inline; a file the browser could
  run as a page is sandboxed), `GET /api/contract-documents/:id/download`,
  `PATCH` and `DELETE /api/contract-documents/:id`; everyone signed in
  reads, a broker or admin writes.
- **Shares** (`/contracts/<basis>/:id/shares`) is the third step: who takes
  what of the programme, in percent of it. **BROKER SHARE** is this desk —
  Afro-Asian Insurance Services, the lead broker by default — and any co-broker the
  order is split with: each broker's **Order** (100% unless split), its
  **Placed order** — the reinsurers' signed total, pro rata to the order —
  and a **placement bar** showing how far the order is placed (fully
  placed, short, or over). **REINSURER SHARES** is the panel, each reinsurer
  off the market register (its domicile and rating show through) or typed,
  with a Lead mark, a **Written share** column (the line put down), a
  **Signed share** column (what it was signed down to), a market reference
  and a note. Totals foot both tables and the reinsurers' signed total says
  whether the programme is fully placed, short or over. The table is held
  on `contract_share` (a broker row's written share is its order; its
  signed share is unused, the placed order being derived) and saved whole —
  `GET/PUT /api/placements/:id/shares` (everyone signed in reads, a broker
  or admin writes).

All three steps carry the tool's **floating dock** at the foot of the window
— Back, Save and *Save & next: Documents* on the detail page; Back to the
detail and *Next: Shares* on the documents; Back to the documents (saving
what changed), Save and *Save & done: Contracts* on the shares — which fades
after a few idle seconds and returns on any movement or keystroke
(`frontend/src/WizardNav.jsx`).

A contract by id (`/contracts/:id` — where the calendar, the portfolio, the
market intelligence and the top bar's recents point) opens on its basis page,
the treaty type's category deciding; the placement page's old address
(`/placements/:id`) lands there too. The module is
`frontend/src/views/contracts/`: the Universe arithmetic and required-field
rules in `calcs.js`, the terms model and modals in `propTerms.jsx`, the
placement mapping in `contractModel.js`, the shared contract details pane and
its state in `ContractDetailsPane.jsx`, and the two pages.

The top bar, present on every page, carries a **Home** button that returns
to the dashboard from anywhere; the launcher's next two pills are
the **Renewal calendar** (`/renewals`) — every placement renewing in the
next 3, 6 or 12 months, with the treaty's shape and the desk's position on
it — and **Portfolio intelligence** (`/portfolio`), the book read by who
leads it, who places it and who writes it. It shows which reinsurers lead
which accounts (recorded at Final Placement, else the lead furthest along in
the marketing — co-leads both count, a declined lead never does), which
broker places each account (this desk when the full order runs through it;
the other house named at Final Placement when we follow), the accounts we
lead and the ones we follow, the reinsurer panel with its lines, shares and
premium, every account with its lead broker and lead reinsurer, and the book
by class of business, cedant region and stage. Both screens read the treaty
year set in the top bar. Everything on it comes from
`GET /api/dashboards/portfolio?year=YYYY`, computed from the book on every
call — no stored counter can drift from it — with money summed per currency
as well as in total, since the book holds no FX rates.

Its **Analyse programmes** button opens **Programme analysis**
(`/portfolio/programmes`): the same book cut by the house placing each
programme and the reinsurers writing it, drawn. One toggle — programmes or
premium — scales every chart at once: programmes by broker stacked by class
of business, our order behind each house's programmes, programmes by
reinsurer split by the role it was approached in, how concentrated the panel
is (the share of premium on lines the biggest writers carry), a brokers ×
reinsurers grid of who writes on whose programmes, the trend over the treaty
years, and the programmes themselves, narrowed by clicking any bar or cell.
Every chart carries a legend, a hover and keyboard-focus readout, and a
Figures table saying the same thing in numbers; the series colours are the
validated chart palette in `styles.css` / `themes.css`. It reads
`GET /api/dashboards/portfolio/programmes?year=YYYY`, built on the same
reading of the book as the portfolio screen
(`backend/src/modules/dashboards/portfolioBook.js`, with the aggregation in
`programmeAnalysis.js`), so the two can never disagree. A programme is an
account with an order to read — a layer on the placement, or a Final
Placement recording who leads it; an account with neither is counted as not
yet structured rather than dropped.

Its **Market intelligence** button opens **Market intelligence**
(`/portfolio/market-intelligence`): a market by country or by region of the
reference country list, read from three sources at once. Opening with no
market chosen shows the map — every region and country with what the desk
holds on it — and the trips log; picking a region or a country (held in the
URL, `?region=Europe&country=GB`) opens the market. Its **brief** is what
the AI gathers from the internet on demand (**Gather from internet**,
`POST /api/market-intelligence/brief/gather`), in six sections, each
researched as its own request and shown as its own tab (the tab is in the
URL too, `&section=statistics`):

- **Insurance and reinsurance sector** — the sector in a paragraph, gross
  written premium by segment and year, the top insurance companies by
  premium, the local brokers, and mergers and acquisitions in the insurance
  and reinsurance industry.
- **Economic indicators and major projects** — the headline indicators,
  latest available, and the government and private-sector projects above
  USD 50m, approved and in the pipeline, each with its sponsor and status.
- **Regulation** — who regulates, updates to the regulatory environment
  recent and pending, the capital regime, fines and findings on industry
  players, and other relevant news.
- **Market statistics** — gross written premium by class of business and in
  aggregate, loss ratios by class for the market and split by insurer or
  reinsurer where published, the 50 biggest insured risks and projects, and
  the largest reported losses with their insured and uninsured parts.
- **Events in the market** — catastrophes (flooding, hail, wildfire,
  earthquake, windstorm) and big individual fires, a factory burning down
  and the like, each with what it cost.
- **Market players** — competition among the brokers, the insurers and the
  reinsurers, new products, and government insurance pools.

Every section carries its own summary, a **From the desk** paragraph (what
the brokers' notes and trips added to or contradicted in it) and its
sources; the brief's `citations` are the sections' sources as one list. The
shape of each section is in `backend/src/integrations/marketBrief.js`, which
is also what fills it: every figure is nullable and the model is told to
leave a field empty rather than estimate. The gather goes through the same
`lib/llm.js` module as the counterparty profile, with ChatGPT's server-side
web search, so it needs `OPENAI_API_KEY` and nothing else; with no key — or
with any one section failing — it fails with `llm_unavailable` (503) and
writes nothing, and the rest of the screen works without it. A brief lands
unverified and says so until a broker, underwriter or admin marks it
verified; a fresh gather is unverified again.
**Our book in the market** is the accounts whose cedant is domiciled there,
as Portfolio intelligence reads them; the treaty year in the top bar narrows
this table alone. **Market visits** are every broker's trips — country,
city, dates, purpose, cost and currency, the cedants met, a trip report —
each logged by the signed-in broker and theirs (or an admin's) to correct
or remove. A trip's **return** is read from the book: the brokerage
expected (our order at the layers' rates) on the accounts of the cedants
met — or of every cedant in the country when none is named — incepting
from the trip's first day to twelve months after its last, against what the
trip cost. The ratio is read in the cost's currency only: the book holds no
FX rates, so a return in another currency is shown beside it, unconverted,
and a return that exists only in another currency reads as no ratio rather
than a loss; the scope's total counts an account once however many trips
it is credited to. **Notes** are kept on a cedant, a country or a region,
typed or uploaded (`.txt`, `.md` or `.pdf`, read into the note with the
file's name kept), on a trip or on their own. A cedant's note carries its
cedant's country and region and a country's its region, so a note rolls up
into the scopes above it — a country reads its own notes, its cedants' and
its region's — and the next gather folds every note and trip in the scope
into the brief, marking under *From the desk* what they added. The read
models are `GET /api/market-intelligence` (the map) and
`GET /api/market-intelligence/scope?scope_type=country&scope_key=GB` (one
market in full), with `/visits` and `/notes` beneath them
(`backend/src/modules/intelligence`, the ROI reading in `roi.js` and the
gather in `backend/src/integrations/marketBrief.js`).

Every action on the desk confirms itself with one transient toast.

The account menu's **Acting as** switch (Broker / Analyst / Underwriter) is a lens on
what the interface offers. It never grants anything: the server enforces RBAC
and four-eyes on every call, so an action is only surfaced when the signed-in
user's real role could actually perform it.

**What was stripped.** The placement page and its wizard, the layer
workspace and market operations, signing, the wording library, claims and
premium, renewal packs, the market and cedant registers, the spine's
contract-year workspace and the dynamic financial analysis are no longer in
the interface; their routes are gone and `*` returns to the hub. The backend
keeps every module and its API (documented below), the demo seed and the
tests, and the pure modules those tests and the seed pin — the modelling
engine, pricing and workflow, the occupancy grading and the servicing model
— stay under `frontend/src` as shared logic without a screen.

## Getting started

Requires a running PostgreSQL. Defaults assume
`postgres://postgres:postgres@localhost:5432`.

```bash
# 1. Install
npm install

# 2. Configure
cp backend/.env.example backend/.env      # adjust DATABASE_URL if needed

# 3. Create databases (once)
createdb broking_dev && createdb broking_test

# 4. Migrate + seed demo users and a demo renewal book
npm run migrate
npm run seed

# 5. Run
npm run dev                # backend on :4000
npm --workspace frontend run dev   # frontend on :5173 (proxies /api → :4000)
```

Seeded users (dev only): `admin@broking.local` / `broker@broking.local` /
`senior@broking.local` and `edwin@broking.local` (Senior Brokers, approve
renewal packs) / `uw@broking.local` / `a.vance@broking.local` /
`m.reyes@broking.local`, all
with the one demo password `demo2026` (`DEMO_PASSWORD`). **Demo sign-in:**
with `DEMO_PASSWORD` set, every user's password is reset to it at boot, and
the login screen offers a dropdown of users with it filled in
(`GET /api/auth/demo-users`, public). Clear the variable, and change the
passwords, for anything beyond a demonstration.

`npm run seed` also builds a demo renewal book so the screens have something to
show: a property cat renewal worked through to written lines (a 12-market panel
at 107.50% against a 100% order), the surrounding 1 Jan renewals, a book of
placements across the pipeline, and bordereaux carrying a 10-year loss exhibit.
Three accounts in that book are ones another house leads — the desk holds a
share of the order, and Final Placement records the lead broker (Guy
Carpenter, Aon Re, Howden Re) and the lead reinsurer — so Portfolio
intelligence shows both sides of the book, the accounts we lead and the ones
we follow, from the first sign-in.

It also seeds three **demo renewal packs** with every screen filled, one per
quoting structure, so the pack, approval, negotiation and final-placement flow
can be walked end to end without entering data:

| Reference | Cedant | Structure | Pack v1 |
|-----------|--------|-----------|---------|
| `DEMO-27-QS` | Iberia Mutua | Proportional only — a Property quota share | Approved by Edwin |
| `DEMO-27-XL` | Alzey Versicherung | Non-proportional only — a three-layer Risk & CAT XL | Submitted, awaiting Senior Broker approval |
| `DEMO-27-COMBINED` | Tyrrhenia Assicura | Combined — the quota share with a two-layer XL alongside, renewing an expiring `BOTH` structure | Approved by Edwin |

Each carries five years of premium and claims bordereaux (occupancy and CRESTA
zone on every risk, a large loss in every year), the table of retentions, two
special acceptances, every modelling screen (triangles, straight stats, large
and cat losses, loss selections, development factors, pricing, terms, risk and
claims profiles, CRESTA accumulations, event loss tables, and the
non-proportional premiums, LDF, excess-development and historical screens), a
layer register with the MRC slip and a draft wording built from the library
for the XL structures, and a cut pack version stored with its Excel and PDF.
The Renewal Pack checklist shows every screen ticked and every required
section filled. Delete the three placements (`DELETE FROM placement WHERE
reference LIKE 'DEMO-27-%'`) and re-run the seed to rebuild them.

| Env | Effect |
|-----|--------|
| `SEED_DEMO_BOOK=0` | Seed users only — no demo book |
| `SEED_RESET=1` | Drop the demo book and rebuild it (how to recover from a partial seed, and how a demo deploy starts clean) |

## AI bordereau analysis

The Data tab computes every figure from the imported bordereau rows in the
backend — premiums, sums insured, paid/outstanding/incurred, loss ratio, splits
by class, territory and cause, largest risks and losses, and data-quality flags.
No model is involved in the arithmetic, so the numbers are the same on every run.

"Analyse with AI" then hands those finished figures (plus a strided sample of
rows and the treaty structure) to ChatGPT and asks it to read them: what stands
out, what looks wrong, what to ask the cedant. The prompt forbids recomputing or
restating any total, and the model is constrained to the JSON schema
server-side. ChatGPT is the only provider — there is deliberately no fallback:
if the request fails, the endpoint reports why instead of asking another model.

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Enables ChatGPT — the sole provider for every AI feature. |
| `OPENAI_MODEL` | Defaults to `gpt-4.1`. |

With no key set the endpoint returns the computed figures and a 503 explaining
that no provider is configured — the analysis panel keeps working, minus the
commentary. Each saved analysis records which provider and model wrote it.

## Deployment

Deploys to [Render](https://render.com) as a single web service — the Express
API also serves the built SPA, so there is one origin and no CORS to configure —
plus a managed PostgreSQL instance. `render.yaml` at the repo root is the
blueprint; **[docs/DEPLOY.md](docs/DEPLOY.md)** has the step-by-step.

The blueprint is a **demo deployment**: its pre-deploy hook runs
`npm run migrate && npm run seed`, so every deploy applies the migrations and
then the demo seed — users, register, the demo renewal book and the three demo
renewal packs — adding only what is missing and leaving everything else as the
last demonstration left it. Set `SEED_RESET=1` (in `render.yaml`, or in the
service's environment until the blueprint next syncs) to have each deploy drop
every placement and rebuild the demo book instead. With `DEMO_AUTO_LOGIN`
(the blueprint sets it to the demo broker) opening the URL lands on the
dashboard already signed in — no login screen; Sign out shows it, with a
**Continue as** button, and a new tab is signed in again by itself.
Remove the seed step, `DEMO_PASSWORD` and `DEMO_AUTO_LOGIN` for anything
beyond a demonstration.

Production mode (`NODE_ENV=production`) tightens several things that stay
relaxed in development:

- `JWT_SECRET` is **required** (min 32 chars, and the dev default is rejected) —
  the process refuses to boot otherwise.
- CORS is closed unless `CORS_ORIGINS` names an origin.
- `POST /api/auth/login` is rate limited to 10 **failed** attempts per IP per
  15 minutes; successful sign-ins never count against it.
- The SPA is served from `frontend/dist`, hashed assets cached for a year and
  `index.html` `no-cache`.
- `trust proxy` is on, so client IPs survive the load balancer.

To run that exact configuration locally:

```bash
npm --workspace frontend run build
NODE_ENV=production PORT=8080 \
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/broking_dev \
  JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
  npm --workspace backend run start   # API + UI together on :8080
```

## Tests

```bash
npm test                              # full suite (uses broking_test)
npm --workspace backend run test:unit # domain unit tests only (no DB)
```

The integration suite resets the test schema between cases, so it needs the
`broking_test` database to exist and be reachable via `TEST_DATABASE_URL`.

## The placement lifecycle

A **Placement** moves through the market via a validated status machine
(`src/domain/statusMachine.js`):

```
DRAFT → DATA → PACK → LEAD_MARKETING → QUOTED → FOT_AGREED
  → FOLLOW_MARKETING → LINES_WRITTEN → SIGNED → BOUND
```

Branch/terminal states: `DECLINED`, `NTU`, `LAPSED`, `INCOMPLETE` (shortfall).
Every transition is checked; illegal jumps return `409`.

### Signing-down (the integrity core)

`src/domain/signingDown.js` implements written → signed exactly:

- **Oversubscribed** (Σ written > order): `signing factor = order / Σ written`,
  `signed = written × factor`. Rounding residual is distributed by the
  largest-remainder method so **Σ signed === order** to the basis point.
- **Undersubscribed** (Σ written < order): signed = written; `shortfall`
  reported; placement → `INCOMPLETE`. Resolve by continued marketing or
  firm-order-at-written (`accept_shortfall`).
- **Lines to stand:** a per-line flag reserves a line at its written value and
  excludes it from the factor, which then applies to the residual order.
  `GET /api/layers/:id/signing/preview?stands=<lineId,lineId>` recomputes
  against a provisional stand set without persisting it, so the worksheet can
  be explored before anything is committed.

- **Client signing instruction:** when written lines exceed the order the
  cedant may dictate the allocation instead of a proportional sign-down
  (relationships and other economic considerations). The instruction
  (`POST /api/layers/:id/signing/instruction`) must allocate the whole order,
  may not sign any market above its written line, and omitted markets sign at
  nought. The layer records which `signing_method` produced the signed lines.

Premium allocation (`signed % × premium100`) reconciles to the cent, and
**brokerage** (`brokerage_pct` on the layer) is carved out per signed line and
totalled per currency on `GET /api/dashboards/brokerage` (surfaced as the
dashboard's *Brokerage earned* KPI).

### Post-placement (XoL)

Once an XoL layer is signed/bound:

- **MDP** (`src/modules/mdp`): minimum & deposit premium terms are issued per
  layer (immutable versioning, like FOT); the deposit is spread over the
  instalment schedule and a **debit note per market per instalment** is
  auto-generated at its signed share with brokerage carved out, tracked
  `pending → sent → paid`. The schedule lands in the document worklist.
- **Treaty losses** (`src/modules/claims` + `src/domain/xol.js`): a loss event
  is advised from the ground up; the engine computes the loss to each bound
  XoL layer (attachment/limit), each reinsurer's share by signed line, and the
  **reinstatement premium** — pro rata to amount at the layer's reinstatement
  terms (migration 014's `reinstatements` count or `UNLIMITED`, at
  `reinstatement_pct`), with aggregate erosion across events in loss-date
  order. Calculation issues a loss advice document; events settle once advised.

The loss summary (`GET /api/placements/:id/loss-summary`) also shapes the
reinsurer-facing exhibits from the bordereaux: premiums and claims **by
underwriting year**, the **large-loss table** (threshold configurable via
`?large_loss_threshold=`), **cat losses** (flag/cat-code columns) and the
**risk profile** (sum-insured banding via the `risk_profile` bordereau type).

### Four-eyes

**Approving a renewal pack** requires a *second* user holding `senior_broker`
or `admin` — the broker who created or submitted the version cannot approve
it — and nothing goes to market until a version is approved (see *Create
Renewal Pack* below). FOT authorisation, bind, and **releasing a submission to
market** all require a
*second* user (the proposer cannot authorise their own action) holding
`underwriter` or `admin`. FOT is **immutable once authorised** — a change is a new version that supersedes the prior one;
there is at most one authorised FOT per layer (enforced by service logic and a
partial unique index).

## The modelling workflow on the placement page

After the Retentions tab, the placement page runs the **Universe modelling
tool's manual-input workflow** — the same screens, the same order, split by
basis exactly as the tool splits its wizards. The **structures to quote
decide which flows appear**: a proportional structure brings the
proportional screens, a non-proportional one the non-proportional screens,
and both bring both (merged in the tool's order, the shared loss, profile
and exposure screens once). Until a structure exists the Treaty Detail treaty
type's category decides. The non-proportional structures' treaty types filter
the NP screens as the tool's wizard does: all Risk XL drops the cat screens,
all CAT XL the large-loss screens.

A treaty over several classes of business carries **one set of data per
class on every modelling screen** — its own triangles, losses, profiles,
pricing — picked by the class pills at the top of the screen; switching
class saves the current one first. Each class's section is stored under
`section:class` (the first class also reads the plain key, so data saved
before the classes were split stays with it).

The proportional terms on the **Quote Structure tab carry the tool's full treaty
detail**, in its sections: LIMIT DETAILS, COMMISSIONS (fixed vs a **sliding
scale** — corridor fields plus the manual slide table with its provisional
commission — and management expenses, profit commission, LCF), LOSS
PARTICIPATION (corridor + up to five stepped slides), **EPI** (Quota Share and
Surplus EPIs with the **EPI split by class of business**, defaulting to an
equal share and reconciled against the total), and BROKERAGE & TAXES. The
financial engine reads all of it — the Quick Summary's terms section only
overrides.

**Proportional** — Triangles (Premium, Claims Paid, OS Claims, and the derived
Incurred = paid + OS), **and** the Straight Stats (no-triangulation) screen —
the two are not an either/or here: both are completed, the summaries prefer
the triangles and fall back to the stats. Then Large and Cat losses (list →
selection → Pareto), the four Dev Factor screens (chain ladder with weighted /
simple / last-3 / last-5 averaging, link-ratio exclusions, the exponential
parametrized fit, a Bornhuetter-Ferguson overlay, and the underwriter's chosen
factors), the Projected Summary (uncapped ultimates + the reserving check) and
Quick Summary (post-treaty-terms financial engine: loss cap, fixed/sliding
commission, profit commission with LCF, loss participation), Risk and Claims
profiles (per class, with the Swiss Re MBBEFD exposure rating on risk), CRESTA
aggregates and Event Loss Tables.

**Non-proportional** — the Premiums & Inflation cockpit (EGNPI by UW year,
inflation with cumulative factors, rate changes with on-level premium), the
same loss workflows plus per-peril loss dev factors, Excess Dev Factors
(direct LDFs or an excess triangle), Historical Performance (with moving
averages), the profiles and exposure screens.

Every screen persists the way the tool does — **one JSONB section per screen**
on `placement_modelling` (`GET /api/placements/:id/modelling`,
`PUT .../modelling/:section`), saved wholesale and flushed automatically when
leaving a tab; writes need `broker`/`admin` and are audited. The actuarial
logic (chain ladder, BF, straight-stats projection, the proportional financial
engine, Pareto/MBBEFD pricing, severity fits with KS) is ported verbatim from
the tool's shared-logic into `frontend/src/modelling/engine.js` and
`pricing.js`, and pinned by `backend/test/unit/modellingEngine.test.js`
against the tool's golden values.

The Renewal Pack tab's **Pack view is a checklist of every screen**: the
placement screens (Treaty Detail, Expiring Structure, Quote Structure,
Retentions, Data) marked once from the live pack preview, then the wizard's
modelling screens with a tick per class of business (a screen counts as
holding data when any of its saved sections carries a value, the first class
also reading the plain key saved before the classes split), each tick or
title opening that screen for that class; then the standard running order's
pack sections with their filled / empty / required status and the note saying
what would fill an empty one, a filled section expanding in place. The
trackers above each count what is missing. **Which screens are required is
decided by the quoting structure** (`requiredScreens()` in
`frontend/src/modelling/workflow.js`, from the same bases that pick the
wizards): the placement screens always; a proportional structure requires the
premium, paid and OS triangles, the straight stats, their development factors,
the projected and quick summaries and the risk profile; a non-proportional one
requires the premiums table and the historical performance, plus the large-loss
chain (list, selection, dev factors, excess dev factors, risk profile) unless
every NP structure is a CAT cover, and the cat chain (list, selection, dev
factors, CRESTA, event loss tables) unless every NP structure is a Risk cover.
Derived screens, the Paretos, the claims profile, retentions and the bordereau
data are never required. Required rows are marked on the checklist, the
tracker counts required screens with data and reads *ready for approval* when
none is missing, and a version records the required screens it was created
without — shown on its approval strip, on the Excel *Screens* sheet and the PDF
cover (starred). **Submit is held until every required screen has data**: a
version created without data on a required screen cannot be submitted (the
button is disabled and `POST /api/packs/:id/submit` answers 409 naming the
screens); the version is immutable, so the data goes on the screens and a new
version is created from them.

**Create Renewal Pack** (`POST /api/placements/:id/packs`, needs
`broker`/`admin`) cuts the next version in one call and in three forms: the
version row on `renewal_pack` (the snapshot of every section, the summary,
what changed since the previous version), and the **Excel workbook and PDF
rendered from that snapshot at that moment**, stored on `renewal_pack_file`
so a download of v2 is always the file that was cut (`GET
/api/packs/:id/export?format=xlsx|pdf` serves the stored bytes; CSV, and
versions from before files were stored, render on demand). The page sends the
screen checklist with the call; it is recorded on the snapshot as `screens`,
shown on the Excel cover and as its own *Screens* sheet, and printed on the
PDF cover, so a version says which screens held data when it was created. A
stored version shows the checklist it recorded; the live preview shows the
live one.

An admin gives someone the approver role on the Admin page's Users card
(`PATCH /api/auth/users/:id` with `{role}`; a user can also be renamed or
deactivated there, never the admin's own account).

**Approval.** Once created, a version goes for approval: the broker **submits**
it (`POST /api/packs/:id/submit`, `broker`/`admin`; status `draft` →
`submitted`), and a **Senior Broker** — the `senior_broker` role, everything a
broker can do plus this — **approves** it (`POST /api/packs/:id/approve`,
`senior_broker`/`admin`; four-eyes: not the user who created or submitted it)
or **returns it with a note** (`POST /api/packs/:id/reject` with `{note}`;
back to `draft`, the note shown on the version until it is resubmitted). The
version list and the approval strip on the tab carry the trail — who
submitted, approved or returned it and when. The dashboard's *Awaiting
approval* shelf lists the submitted versions. **The Negotiation tab stays
locked until a version of the pack is approved**: the tab shows a lock, and
the server refuses to send an unapproved pack to market or draft a submission
on one.

**The standardised renewal pack of the modelling data** lives on the
placement's Renewal Pack tab as its third view, *3 · Modelling Pack*. **Analyse
with AI** sends a digest of every modelling screen, per class of business, to
ChatGPT (`POST /api/placements/:id/modelling/analysis`, needs `OPENAI_API_KEY`;
a 503 with `code: llm_unavailable` otherwise) and stores the summary,
highlights, data gaps and a per-class read as the `ai_summary` section.
**⤓ Excel pack** (`GET .../modelling/pack.xlsx`) exports the standardised
workbook: a Cover sheet (placement facts, contents, the AI analysis) then one
sheet per screen per class of business in the wizards' running order —
triangles pivoted by origin year × development month, loss lists and other
row data as tables, settings as fact lists. `GET .../modelling/pack` lists
the sheets the workbook will carry.

The same view takes the **raw data behind the screens** — the cedant's loss
runs, premium listings, bordereaux and profiles as Excel, CSV, PDF or images
(`POST /api/placements/:id/modelling/documents`, base64 JSON body, 15MB,
stored on `placement_modelling_document`, each with a note saying what it
is). **Cross-check with AI** (`POST .../modelling/crosscheck`) sends every
screen's digest together with the raw data (Excel parsed sheet by sheet, CSV
inlined, PDFs and images attached) and stores the result as the
`ai_crosscheck` section: a summary, what the raw data confirms, every
discrepancy (class, screen, item, the value on screen, the value in the raw
data, severity, note), what could not be verified, and data quality issues.
The cross-check joins the AI summary on the Excel pack's cover sheet.

## Reference data behind Treaty Detail

The Treaty Detail dropdowns on the placement page (new and saved placements alike)
— **Country**, **Treaty Type**, **Line of Business**, **Broker** and
**Currency** — are the Universe modelling tool's reference data, held and
served exactly as the tool holds and serves it, so a treaty set up in either
product is described in the same vocabulary.

**Schema** (migration `035_universe_reference_data.sql`, the tool's
`005_ref_data` / `027` / `045` / `141` / `150` in one): one table per list with
the tool's columns — `country` (`country_id`, `country_name`, `country_code`,
`region`), `currency` (`currency_id`, `currency_code`, `currency_name`),
`brokers` (`broker_id`, `broker_name`), `treaty_type` (`treaty_type_id`,
`treaty_type`, `category` PROPORTIONAL / NON_PROPORTIONAL) and
`class_of_business` (`class_of_business_id`, `class_of_business`, `code`) — each
with the tool's `is_active` soft-delete flag and natural-key uniques, plus its
generic `ref_list` / `ref_list_item` pair. The seed is the tool's canonical
reference data: its 45 countries with the 30 its region mapping adds and their
regions (GCC, Levant, North Africa, Sub-Saharan Africa, Europe, South Asia,
Southeast Asia, East Asia & Pacific, Americas), 32 currencies, 11 brokers,
11 treaty types and 14 classes of business.

**Boot.** `backend/src/db/ensureReferenceData.js` is the tool's
`startup/ensureReferenceData.js`: on every start it asserts the canonical rows
into their tables (idempotent on each natural key) and soft-deactivates any
non-canonical treaty type so it leaves the dropdowns without anything being
deleted.

**API** — the tool's `lookups.js`, same paths and row shapes, active rows only,
behind a five-minute server-side cache that `DELETE /api/ref/cache` clears:

| Endpoint | Rows |
|----------|------|
| `GET /api/brokers` | `{ id, name }` by name |
| `GET /api/treaty-types` | `{ id, name, category }` by category, name |
| `GET /api/class-of-business` | `{ id, name, code }` by name |
| `GET /api/ref/lists/country/items` | `{ id, name, code }` by name (a `ref_list` keyed `country` takes precedence) |
| `GET /api/ref/lists/currency/items` | `{ id, name, code }` (name = code) by code |
| `GET /api/countries/:id` | the country row |

**Treaty detail.** `RefDataProvider` loads the five lookups together on
sign-in, as the tool's treaty detail does, and the placement page's dropdowns
(a new placement is set up on that same page) bind by row id:
the country filters the cedant register (a cedant's stored domicile — "UK",
"United Kingdom", "GB" — resolves to its row), the treaty type comes grouped by
category, the line-of-business modal is the tool's COB select over the
`class_of_business` lookup, the currency reads as its code. The placement
itself stores what it always stored — the class string
(`Property / Motor Quota Share`), the currency code, the broker in the notes —
so a pick is written as the row's name or code and read back to its row on
load; a stored value the lookups no longer carry stays pickable as itself.
Records written before the reference data carry the old treaty-type
codes, which resolve to their Universe types (`QS` → Quota Share, `XoL`/`XL` →
Risk XL, `Surplus` → First Surplus, `Fac` → Fac Oblig), and the treaty type's
category — not a code — decides the modelling basis.

`frontend/src/refData.js` carries the same seed as data for the parts of the
app that classify stored text without a round trip (the dashboard's territory
grouping, domicile normalisation); a backend test pins the migration and the
boot lists against it so the copies cannot drift.

**Cedants.** The tool's cedants (its `companies` table — the canonical list
its boot asserts plus the ones its reference seed adds: Saudi Arabia, the UAE,
Kuwait, Bahrain, Oman, Egypt and the UK) are carried into the app's cedant
register on every boot as well, each under its country with its entry on the
Insurers tab of the market register, so the placement page's Cedant Name
dropdown offers, for a country, the cedants Universe offers. The list is
`cedantsByCountry` in `backend/src/db/ensureReferenceData.js`; the insert is
guarded by name, so a cedant renamed or re-domiciled by hand is left alone.

## Table of retentions

Each placement carries a table of retentions: per occupancy category, the risk
class it falls into and the share of the treaty full limit those risks may use
(`usable limit = treaty full limit × %`). It feeds occupancy capacity in the
renewal pack.

The **Class & % of capacity** button opens the grading behind it, seeded as:

| Class | % of capacity | Typical occupancies |
|-------|---------------|---------------------|
| A — Non-hazardous | 100% | dwellings, offices & retail, schools, shops |
| B — Light hazard | 75% | warehousing, light industry, hotels, workshops |
| C — Heavy / hazardous | 50% | heavy industry, hazardous risks, mills, filling stations |

The grading is reference data (`occupancy_class`), read by everyone and
maintained by an **admin** from that same panel: **Edit class table** makes every
column editable — code, grading, description, % of capacity and the match terms
— and adds or removes classes. Saving replaces the table in one transaction, so
a re-lettering (swapping A and B, say) either lands whole or not at all, and a
duplicate code is refused rather than half-applied. Retention rows keep the code
they were given; a row whose class the table no longer carries is re-graded from
its occupancy the next time auto-detect runs.

`frontend/src/occupancy.js` grades a typed occupancy into one of those classes,
so the table fills itself in instead of being graded by eye:

- descriptions are lower-cased, singularised and de-gerunded, then matched
  against each class's terms as whole-word phrases — "Flour Milling" and
  "Spinning Mills" both meet `mill`, and `oil` never fires on `boiler`;
- longer phrases outrank shorter ones — *"petrol filling station"* beats a bare
  *"retail"* in another class;
- **ties break toward the more hazardous class**: *"chemical warehouse"* grades
  C, not B, and is flagged with low confidence;
- an occupancy the table does not recognise is left alone, never guessed at.

**Auto-detect classes** grades every category still missing a class and gives
each row its class's share; a class the table knows keeps its grading and only
takes that class's share, so a deliberate grading is never overridden. **Re-detect
all** re-grades everything from the descriptions. Per row, a chip offers what
the table would apply, and every percentage stays editable afterwards.

## The Data screen

The **Data** tab of the placement page ingests nothing. It reads everything
entered on the screens before it — treaty detail, expiring structure,
structures to quote, table of retentions and the modelling screens — as one
digest (`GET /api/placements/:id/data-analysis`) and compares this year with
the year it renews:

- a **renewal** (`renewal_of` set) compares with the prior year's placement
  in the book — structure 1 against the expiring structure layer by layer,
  the retentions category by category, the treaty detail field by field —
  computed on the server with no model involved (`computed.changes`);
- a placement **new to the house** takes the **expiring renewal pack** uploaded
  on the tab (`POST /api/placements/:id/expiring-pack` — PDF, Excel, CSV or an
  image, in whatever format the other broker wrote it). The upload is held as
  an uploaded pack (`renewal_pack_analysis`, role `expiring`) linked to the
  placement, so the renewal desk and the pack builder read it too.

**Analyse with AI** (`POST …/data-analysis`) hands the digest and the basis to
ChatGPT — the prior year's digest, or the uploaded pack's documents inlined
and attached — and stores the reading (`placement_data_analysis`): programme,
exposure and experience, retentions and terms, the comparison change by
change, gaps, questions for the cedant, recommendations. Bordereaux still
import through the API (`POST /api/placements/:id/bordereaux`) for the pack
builder's experience sections; the Data tab is not where they arrive.

## Pack Approval

The tab after the Renewal Pack (`GET /api/placements/:id/pack-approval`).
Every version with where it stands — draft, submitted, approved, returned —
who took each step and when (the audit trail of builds, submissions,
approvals, returns and comments, `audit_event` on `renewal_pack`), what
changed since the previous version, and the reviewers' thread. Submit,
Approve and Return with a note live here (`POST /api/packs/:id/{submit,
approve,reject}`; the broker who created or submitted a version never
approves it). Comments (`POST /api/packs/:id/comments`, any signed-in role)
are **versioned**: a revision is a new comment naming the one it replaces
(`replaces_id`), the table is append-only at the database, and the thread
shows the latest wording with every earlier one underneath. An approved
version opens the Quoting Stage.

## Quoting Stage

The Quoting Stage (once a version is approved) works from the approved pack:
its **Excel and its PDF, as stored when the version was cut, go with every
email** — the covering emails here and the firm order terms later. It runs
in six tabs, in the order the stage does:

1. **Renewal Pack** — the pack the markets are quoting on, as the Excel
   workbook it went to them as. The approved version opens by default (any
   version can be picked) as the stored file read back sheet by sheet —
   column letters across, row numbers down, the merged title bars, every
   figure as Excel formats it (`GET /api/packs/:id/workbook`; a version from
   before files were stored renders now, and says so) — with the Excel and
   PDF to download and **Send pack to market**.
2. **Emails** — the covering emails to be sent out: *Send pack to market*
   drafts one with AI market commentary for the chosen underwriters and
   attaches the approved pack as Excel and PDF; every submission (drafted,
   awaiting release, sent, withdrawn) and the **Responses** card with the
   replies and the AI's reading of them — see below.
3. **Sent to reinsurers** — the register of every reinsurer the pack has gone
   to for quotation: which underwriters at each were emailed, when and at
   which pack version, whether the email was delivered, what has come back
   from each (awaiting, or the kind of reply that came last), and the
   market's standing on the board. Every reinsurer approached here is
   approached for a lead quote, so a market carries no lead / follow role
   and none is shown. The board's `markets` carry `underwriters`, one per
   recipient of a released covering email. A market is withdrawn here, and
   a covering email still on its way (a draft, or awaiting release) is
   flagged until it goes.
4. **Responses & Quotes** — every reinsurer with the structures it quoted,
   line by line: the ones it was sent and any it put up itself, what it moved
   off the terms as sent, the underwriter who gave them, and the structures
   it still owes. Each structure a reinsurer has priced is a **lead quote or
   an indication**: the switch on the structure says which, and an
   indication is marked on every line it covers. **Different structure
   quoted** on a reinsurer's card enters a structure of its own on the
   capture sheet, starting from the structure it varies or from blank. Below
   the cards, the **Capture a quote** sheet and the board by structure.
5. **By Underwriter** — each reinsurer's quotes by structure (`by_underwriter`
   on `GET /api/placements/:id/negotiation`). A **proportional** structure is
   quoted as a whole: the reinsurer takes the structure it was sent or puts
   up a different one of its own, and its terms are kept against it. An
   **excess of loss** structure is quoted layer by layer, each layer with its
   rate on line, and under them the programme its layers add up to —
   premium, limit and the rate on line those make (`programmeRollup`). Under
   the cards the **combined quote** (`combined`): every reinsurer's programme
   side by side, and the **best of the market** — the keenest quote on each
   layer, whichever reinsurer gave it, added up into a programme.
6. **Rate on Line** — each layer of an excess of loss structure down the
   side, the reinsurers that quoted across the top, and in each cell that
   reinsurer's rate on line (premium over limit from what it quoted; a quote
   priced on a rate alone shows the rate), beside the layer as sent and the
   expiring layer (the recorded expiring structure, else the prior year's
   layers); the keenest on each layer is marked and the foot adds each
   reinsurer's layers into its programme (`rol_comparison`).

### Taking the pack to market: reinsurers, underwriters, Outlook, and the replies

**Send pack to market** on the Negotiation tab's Email tab (open once a
version of the pack is approved) picks the recipients in two levels: first the **reinsurers
to approach for quotation** (the register's markets with an underwriter
address on file; declined security cannot be ticked), then, under each one
chosen, **which of its underwriters** — ticking a reinsurer picks its primary
underwriter, and more can be added underneath; every one of them is asked
for a lead quote, so none is singled out. The covering email is then drafted
for them: the AI market commentary
plus the renewal pack summary (structures to quote, ceded premium, sum
insured, incurred, loss ratio, what is enclosed), with `{{contact_name}}`
substituted per underwriter at send. The broker edits it, confirms they have
read it, and a second pair of eyes releases it. Every subject carries a
reference tag `[BIQ-XXXXXXXX]` so a reply finds its submission.

**Outlook.** Submissions are sent from, and replies read into, one connected
Outlook mailbox — through Microsoft Graph, connected once from the Admin page
with the Microsoft sign-in (`POST /api/outlook/connect` → the sign-in URL,
`GET /api/outlook/callback` completes it; `GET /api/outlook/status`,
`POST /api/outlook/disconnect`, `POST /api/outlook/sync` to read the inbox
now). It needs an Azure app registration — `MS_CLIENT_ID`, `MS_CLIENT_SECRET`,
`MS_TENANT` (`common` takes a personal Outlook.com / Hotmail address or a
work account) and `MS_REDIRECT_URI` (`<API origin>/api/outlook/callback`),
see `backend/.env.example`. Tokens are held on `mail_account` and refreshed
server-side; each message is created as a draft and sent, so its internet
message id and conversation id are kept on the recipient. With
`MAIL_TRANSPORT` unset the send goes through the connected mailbox when
there is one, else SMTP, else the in-process stub — and the submission
context says so. The inbox is read every `MAIL_SYNC_INTERVAL_MS` (five
minutes) and on demand; a message is matched to an underwriter by the
conversation the send started, then by the reference tag and sender, then by
sender, and messages from the mailbox itself are ignored.

**The AI keeps track of the responses.** Every reply — read from the inbox or
**logged by hand** on the Responses card (`POST
/api/negotiation-submissions/:id/replies`) — is tied to the underwriter it
came from and read by ChatGPT: what kind of answer it is (quote, decline,
question, acknowledgement), a summary, every term it states (premium, rate,
line, commission, subjectivities), the questions it asks, any deadline, and
what to do next. With no `OPENAI_API_KEY` a keyword reader stands in. The
**Responses** card on the Email tab shows each underwriter's standing
(awaiting or replied, and what kind of reply came last), the replies with
their reading, and lets the broker mark one handled or re-read it
(`GET /api/placements/:id/negotiation/replies`,
`POST /api/negotiation-replies/:id/handled`, `.../reread`). The reading is a
reading, not a booking: the broker captures a quote on the sheet.

### Final Quote and Final Placement

Two tabs after the Quoting Stage (open once a pack version is approved)
close the placement out (`GET /api/placements/:id/final` carries all of it).
**Final Quote** captures the final terms; **Final Placement** sends them and
collects the lines:

- **Final Quote** (`PUT /api/placements/:id/final`). *Who leads the placement* —
  captured on every placement for market intelligence: whether **we won the
  lead** (the lead broker is then Afro-Asian Insurance Services) or another house did (its
  name entered, plus the **type of treaty** placed), and the **lead
  reinsurer** (picked from the register, or named; when we lead it follows
  from the terms taken). *Final terms*, one row per line of the structures to
  quote: when we lead, tick the lines placed and pick the **quote that became
  the final terms** — the terms are re-read from that quote, never from the
  screen; a decline cannot be final terms, and an indication is offered
  after the lead quotes, marked as such — and when another broker leads,
  enter them. Limit and attachment come from the structure.
- **Email** (`GET .../final/email-draft`, `POST .../final/emails`). The
  **firm order terms** email, drafted from the final terms and the approved
  pack's summary, edited by the broker, and sent — with the pack PDF — to the
  reinsurers and underwriters picked the same two-level way as the
  submission. Sends go through the connected Outlook mailbox when there is
  one. Every email from the stage is listed with who it went to.
- **Lines** (`PUT .../final/lines`, `POST .../final/confirm`). A sheet of
  markets × lines of the final terms: the **written line** each market gave
  on each, signed down to the order by the house signing engine when over
  100% (a line marked *to stand* keeps its written share), with totals,
  factor and shortfall per line. **Confirm shares** marks every line
  **signed** at its signed share, freezes the placement, and sends each
  underwriter a **confirmation carrying their written and signed lines** (to
  the underwriter the line was written with, else the one the FOT went to,
  else the market's primary contact).

**Demo without a mailbox.** *Simulate replies (demo)* on the Responses card
(`POST /api/placements/:id/negotiation/replies/simulate`, optional `{only}`
to pin one scenario) has the AI play every underwriter still awaited and
write back in the market's voice from the covering email and the structures
— they cycle quote → question → decline → acknowledgement, so the first
reinsurer quotes — each recorded as a reply (source `demo`, marked DEMO on
the card) and read by the usual reader, so the whole flow shows end to end.
Without an AI key a written template stands in, with figures derived from
the structures.

Once the renewal pack is built it goes to market, and the quotes come back
against **the structures that were quoted** — the Negotiation tab on a
placement.

- **Send pack to market** goes out as a covering email to named underwriters,
  under four eyes — see [Taking the pack to market](#taking-the-pack-to-market)
  below. Releasing it records which pack version each market is holding
  (`negotiation`). A version is immutable, so everyone quoting v1 is quoting the
  same figures even after v2 is cut. Sending again to a market that already
  holds it changes nothing.
- The board is one card per structure, its **lines** down the side: a
  non-proportional structure is quoted layer by layer, a proportional one as a
  whole (its commission and EPI), so it has a single line and no layer index.
  Each column is a market; each cell is that market's answer
  (`negotiation_quote`, one per market per line — re-quoting a line replaces it).
- **The whole layer is quoted, not just its price.** An underwriter rarely takes
  a layer exactly as it was sent: the rate moves, the reinstatements change, an
  AAD appears, the cover narrows to risk only. So every column of the structure
  is quotable — name, type, limit, attachment, reinstatements and their %,
  EGNPI, rate, AAD, order, premium, risk and CAT (a proportional line is quoted
  on its commission, EPI and order). ROL is never stored: it is read as premium
  ÷ limit, so the three figures cannot disagree.
- **What moved is kept against what was sent.** Each column starts at the terms
  as sent — accepting a layer as it stands takes no typing — and is marked the
  moment it moves, with what it moved from beside it. The terms are snapshotted
  onto the quote when it is captured (`negotiation_quote.original`), *not* read
  back off the structure: rework the structure afterwards and the quote still
  says what the underwriter was actually answering.
- **Add quote** on a structure card opens that form for a market, and records
  **which underwriter** gave the terms (`negotiation_quote.contact_id`, from the
  reinsurer's own contacts on the Markets register).
- **Capture a quote** works the other way round, market by market: pick a market
  and every structure it was sent comes through ready to price, with whatever it
  has already said filled in. Ticking **Not quoted** against a structure answers
  every one of its lines with a decline, so the board reads the same whether a
  market passed outright or line by line, and a line left blank clears what was
  there. A declined line holds no terms. The whole sheet saves in one transaction.
- **A lead quote or an indication.** Every reinsurer at this stage is
  approached for a lead quote, so the markets carry no role. What a reinsurer
  gives on a structure is either a lead quote — terms the placement can be
  built on — or an indication, and the switch on the structure (on the
  reinsurer's card, on the sheet, in the quote form) says which
  (`negotiation_quote.kind`; `PUT /api/negotiations/:id/quote-kind` with
  the structure and the kind). The kind is the structure's: every line the
  reinsurer priced on it moves together, and a decline carries none. An
  indication is marked wherever the quote is read — the board cell, the
  layer rows, the combined quote, the rate on line — counts in the line
  summary, and is offered after the lead quotes when the final terms are
  picked.
- A market — usually the lead — may come back with a **structure of its own**
  rather than the one it was sent. **Alternative structure** on the structure
  card — or **Different structure quoted** on the reinsurer's card of the
  Quotes tab, from a structure it varies or from blank — captures it
  (`negotiation_structure`), starting as a copy of the one it
  replaces, since a counter-structure is nearly always a variation on what was
  sent rather than a blank sheet. It joins the board as its own card, is its own
  baseline (nothing to have moved against), and only the market that put it up
  answers it.
- Every line carries what the cedant **asked** for and the **best** back so far:
  keenest premium and rate, highest commission, and the total line offered.
- A market's standing follows its answers — `SENT` until it replies, `QUOTED`
  once it prices anything, `DECLINED` when it passes on everything it was given.

`src/domain/negotiation.js` turns the stored `quote_structures` into those lines
and hangs the quotes off them; it is pure, so the board is unit-tested without a
database.

### Taking the pack to market

The send itself is gated, left to right, and nothing leaves the building on one
person's say-so.

1. **A pack and a wording.** A submission is built on a built renewal pack and a
   wording draft belonging to the placement; without either, the send is
   refused. A pack that is not approved, or a wording not yet issued, is a
   *warning* shown beside the send, not a block — that judgement is the
   broker's, but they are told.
2. **Named underwriters.** Addresses are held per person on the market register
   (`market_contact`, managed under **Underwriters** on the Markets page), so
   the send list is a tick-box of real people rather than a market name. A
   market on the declined-security list cannot be ticked, and one with no
   address on file says so.
3. **The broker reads the draft.** The covering email is rendered from the pack
   — structures to quote, experience summary, what is enclosed — around market
   commentary drafted by ChatGPT (via `lib/llm.js`).
   The model is given the computed pack figures and nothing else: it cannot
   quote a price the broker has not given it, and it leaves `[bracketed]`
   instructions wherever the judgement is the broker's. It cannot go for
   approval until the broker confirms they have read it, and any later edit to
   the subject or body clears that confirmation again. What the model wrote is
   kept separately (`ai_commentary`) from what actually went out.
4. **Four-eyes release.** Asking for approval freezes the content and the
   recipients (`submission_send` on the shared `approval` table, so it shows in
   the admin queue beside FOT and bind). A *different* user holding
   `underwriter` or `admin` releases it — that release is what emails the
   underwriters, with the pack PDF attached — or sends it back with a reason,
   which returns it to the broker as an unreviewed draft. Delivery is recorded
   per recipient, and the released markets land on the board holding the pack
   version they were emailed.

`{{contact_name}}` and `{{market_name}}` stay as tokens in the one reviewed
body and are substituted per underwriter at send, so a single approved email
serves the whole list. With no AI provider configured — and always under test —
a deterministic offline drafter stands in, stating only what the pack says.

Email goes through the `stub` transport by default, which records messages
in-process so the whole flow works with no SMTP server; set `MAIL_TRANSPORT=smtp`
with `SMTP_URL` (and install the optional `nodemailer`) to deliver for real.

## Wording library

A library of contract wordings, held **by class of business** and assembled into
draft wordings for a placement.

- **The library** (`wording_clause`) holds each clause under one of five
  categories — standard **coverages**, **extensions**, market **exclusions**,
  **conditions** and **definitions**, and is marked as either an authentic
  published market form or illustrative drafting. A clause is tagged with the class it
  belongs to; clauses with no class (the treaty-wide conditions and market
  exclusions) apply to every class, so asking for "Marine" returns the Marine
  clauses *plus* those. Editing a clause versions it: the outgoing text is kept
  in `wording_clause_revision`.
- **Reinsurer house wordings.** A clause may belong to a named reinsurer
  (Swiss Re, Munich Re, Lloyd's, Hannover Re, SCOR, …). A market's house version
  carries the *same title* as the standard clause it replaces, which is what
  lets the two be lined up and compared.
- **Draft wordings** (`wording_draft`) are assembled from the library for a
  class: the standard wording, with a chosen reinsurer's house clauses written
  over it wherever they have their own. Clause text is **snapshotted into the
  draft**, so amending a draft never touches the library — and the draft shows
  both when a clause has been amended off the library and when the library has
  moved on since.
- **Comparison** (`src/domain/wordingDiff.js`) aligns two wordings clause by
  clause — on market reference first, then title, then body similarity — and
  reports each clause as identical, reworded (with a word-level diff), dropped
  or added. Either side can be the standard library, a reinsurer, a draft, or a
  single clause.

### What the library ships with

The corpus loads itself on the first boot of a database, so a deployment comes
up with a full library rather than an empty one — the migrations create the
wording tables but carry no clauses, and a platform with no shell cannot run
`npm run seed`. It fires once per database, recorded as a `wording_library`
audit event: clear the library to load your own approved wordings and it stays
cleared. Set `SEED_WORDING_LIBRARY_ON_BOOT=false` to seed from a release phase
instead.

`npm run seed` loads the same two corpora, and every clause records which it is:

- **Authentic market forms** (`provenance = 'market_standard'`) —
  `backend/src/db/seedMarketClauses.js` holds the real published wordings, each
  with its reference, publishing body and a source URL on the row: the Lloyd's
  forms (NMA 464 war, LMA 3100 sanctions, LMA 5394 communicable disease for
  property treaty reinsurance, LMA 5401 property cyber and data), the Institute
  marine clauses (CL 380 cyber attack, CL 370 radioactive contamination), and
  the standard treaty articles (BRMA 23A intermediary, 19A insolvency, 44B
  ultimate net loss, 32B net retained lines, 14F errors and omissions, 6J
  arbitration, 36C offset, and the 72/168 hours loss-occurrence clause).
- **Illustrative drafting** (`provenance = 'illustrative'`) — the class-specific
  coverages and extensions in `backend/src/db/seedWordings.js`, where there is
  no single published market standard to reproduce. This is placeholder text
  written for this repository, clearly badged as such in the UI.

Copyright in the LMA, Institute/IUA and BRMA forms remains with those bodies;
they are held here for market use, with attribution, as they are in every
broking system. **Market forms get revised** (LMA3100 → LMA3100A; the cyber and
communicable-disease families), so check the publisher's current version before
putting a clause on a live slip — this library is a convenience, not the
authority.

Seeding is safe to re-run. A market form is laid over its illustrative
placeholder **in place** (same row, so existing drafts keep their link), but
only while nobody has edited that clause — a clause a firm has already worked on
is left exactly as it is and reported as skipped.

## The dashboard

The book leads with seven metrics (`GET /api/dashboards/metrics`). Each is
defined explicitly, because "premium" means several different things in a
broking book:

| Metric | Definition |
|--------|------------|
| Quoted premium | Sum of the premium on **live** quotes (`active` or `accepted`) — a superseded or withdrawn quote is not one we hold. |
| Number of lead quotes | How many of those live quotes sit on a `lead` approach; the follow and total counts come back beside it. |
| Lead markets won | Approaches made as `lead` that converted into a line we hold (`WRITTEN`/`SIGNED`), counted per layer × market. `lead_markets_won_distinct` counts markets rather than lines. |
| Follow markets won | The same, for `follow` approaches. |
| Number of cedants | The register count, plus how many have at least one placement. |
| Total premiums seen | Sum of layer premium at 100% across every placement — the premium that has crossed the desk. |
| Total premium placed | Sum of `premium_signed` on signed lines — what actually went into the market. `placed_ratio_pct` is placed ÷ seen. |

Two honesty rules hold this together:

- **Currency is never merged away.** Money metrics return
  `{ total, by_currency }`. The total is the cross-currency sum and the
  dashboard always prints the split beside it, because the system holds no FX
  rates and converting would be an invention.
- **Rate-only quotes are declared, not absorbed.** A quote priced by rate on
  line carries no premium figure and so cannot add to quoted premium.
  `quotes_without_premium` reports how many those are, and the tile says so —
  premium is never back-derived from the rate, because the book keeps no
  convention for it and a guess would misstate the one number the metric
  exists to report.

### The renewal-pack store

Packs are versioned per placement and browsable per cedant
(`GET /api/packs/by-cedant` → cedant → placement → versions, newest first;
`GET /api/packs` is the same store, flat and filterable). **Every version is
kept** — a restatement is a new version, never an edit.

Beyond the templated sections (see the renewal-pack wizard above), a version
holds:

- **the bordereaux it was built on, in full** — type, source, period, summary
  *and* the parsed rows, so a version still reads correctly after the source
  bordereau is restated or replaced
- `title`, `notes`, `attachments[]` (`name` / `kind` / `file` / `note`) and a
  free-form `extra` object, for whatever else belongs with the version

`PATCH /api/packs/:id` amends that metadata while the pack is a **draft**;
approval freezes it. The snapshot itself is never amended — it is the evidence
of what was sent.

## Dynamic financial analysis

`/dfa` is the what-if desk for an insurer buying reinsurance: eight stages
under one verdict, independent of any one placement, built to the shape of
the CAS *Dynamic Financial Analysis Handbook* — the financial condition of
the insurer is the ability of its capital and surplus to carry its future
operations through an unknown environment, so the desk tests the business
plan and a set of plausible adverse (and favourable) scenarios, reads what
each does to the surplus, and reads the result against the regulatory
monitors of the insurer's own country. Arriving asks **what to
model** — a **standalone book** typed from scratch (nothing read from the
register; the programme in force built by hand or left empty to measure
against running gross), **one contract** read from a placement, or the
**whole portfolio** (every placement with a premium, narrowed to a selection
if wanted). The **verdict strip** never leaves the top of the screen — one
sentence a buyer can take into the room (*"The proposed programme frees USD
12.4m of capital for an expected cost of USD 1.1m a year — an implied 8.9%
cost of capital against the 8% hurdle: dearer than holding the capital"*),
the five figures under it (capital needed, expected result, cost of the
cover, value added, chance of ruin — each with the current programme's figure
and the change, coloured by whether it is the move a buyer wants), the run's
terms, and the **Run analysis** button. A contract or the portfolio runs by
itself once chosen, so the desk opens on a verdict rather than a form; a
standalone book runs once its premium is typed. An edit anywhere marks the
standing run as older than the inputs — the strip says *Edits not yet run*,
the figures dim, the result stages say *Run needed* — until it is run again;
a run in flight shows its elapsed time.

Under the strip the desk walks left to right, each stage a tab whose
sub-label is its real state:

- **01 Scope** — the three ways in as cards (*One contract* offers the hub's
  working placement in one click, else a picker over every placement with a
  premium; the portfolio is a ticked table, and 02 says plainly that a
  combined book is an approximation, every placement's layers responding to
  the same events; a standalone book takes a currency and starts from market
  defaults), then the **loss model** read back in sentences — the subject
  premium and where it came from, the expected loss ratio and whether the
  bordereaux or a market default set it, the large losses, the cat events,
  the prior-year reserves (the outstanding on the claims bordereaux, and how
  they are expected to run off), how sure the model is — with a bar showing
  where the expected loss comes from (attritional, large, cat) that moves as
  figures are typed and warns when the event burdens alone exceed the loss
  ratio. *Adjust the model* unfolds the fifteen calibration fields; a
  standalone book opens with them unfolded, the premium first.
- **02 Programme** — the **current programme** as the placements carry it
  beside the **proposed** one. Each is drawn first as a tower to one shared
  scale (the quota share as a band on the left, the layers stacked up the
  retained account, the retention underneath; a layer the model prices has a
  dashed edge, a partly placed one is paler), then edited underneath: quota
  share with sliding-scale commission and loss corridor, excess-of-loss
  layers (the reinstatement, placing and deductible columns fold away until
  needed), a stop loss on what is kept. *Start again from current* resets the
  proposal; *Also explore* traces up to six variants along one dimension for
  the frontier.
- **03 Assumptions** — four cards: the insurer (available capital, its
  **country of domicile** — seeded from the cedant's domicile on the
  register — with the regulatory requirement typed if it is known from the
  last return, the capital standard as a 1-in-N year, the hurdle cost of
  capital, expenses, invested assets), the reinsurers (how an unquoted cover
  is priced, the panel's default probability seeded from its ratings), the
  projection (one to five years, growth, trend, yield) and the simulation
  (years and seed). Choosing a domicile reads its **capital regime** back as
  a card: Solvency II, risk-based capital, a solvency margin or a minimum
  capital; the regulator; the requirement in a sentence and how it is
  calibrated; the ratio the regulator reads; and the ladder of action levels
  with, once run, each programme's rung marked. Every label explains itself
  on hover; one button restores the book's defaults.
- **04 Impact** — the year's losses gross and net by return period for both
  programmes, the insurer's figures side by side with every change coloured,
  what the cover costs and what it buys (the RORAC and risk-transfer tests as
  plain yes/no pills), the losses by percentile, and the risk-against-return
  frontier.
- **05 Capital** — capital needed against the capital held, a bad year
  against it (1-in-10 and 1-in-100 losses, solvency, ruin, EPD), the
  **regulatory capital** reading under the domicile's regime (the
  requirement — typed, or the modelled capital at the regime's own
  calibration standing in for it — the ratio and its rung on the ladder, the
  *strain before action* the year can carry before the first action level,
  the chance of a breach in the year, the ratio at the year end on average
  and in a 1-in-10 and 1-in-100 year, and a standing in a word: holds,
  strained, breach), the **regulatory monitors** (premium and reserve
  leverage against the IRIS lines, the reserve run-off by return period)
  and, above a one-year horizon, the surplus path with the chance of ruin or
  a capital breach in any year.
- **06 Covers & panel** — each cover's premium, expected recovery, cost,
  payback, how often it pays and the capital the programme would need without
  it; what the reinsurers make at 100%; the signed panel's cut.
- **07 Scenarios** — the Handbook's process itself. The business plan is the
  base case; beside it a chooser lists the standard scenarios, one per
  section of the Handbook, each on or off with its one figure editable —
  rates inadequate (points on the loss ratio), excessive growth in
  under-priced business, large losses more often, claims inflation,
  prior-year reserves deteriorating, latent claims emerging (the mass-tort
  test), the cat PML event happening, a reinsurer failing (a share of
  recoveries uncollectible), investment markets falling, and a good year.
  Every scenario re-runs the same seed with one thing moved and holds the
  same capital, so the table reads each for what it does to the expected
  result, the capital needed, the chance of ruin, the regulatory ratio and
  its rung, the chance of a breach, the surplus at the end of the horizon
  (expected and 1-in-100) and the standing; the strip says how many breach.
- **08 Structuring** — from the simulation to a renewal decision, the
  treaty-structuring module. Two cards set it up: the **risk appetite** as
  the board would state it (the chance of ruin it will accept, how much of
  the capital a 1-in-100 year may eat, the solvency ratio to hold, the
  combined ratio a 1-in-10 year may reach, whether the programme must
  *hold* on the domicile's capital ladder, and a budget for the cover — a
  blank line switches its test off) and **what to test**: the four structure
  families — excess of loss, quota share, surplus, and a quota share with
  excess of loss over it — each across a range of retentions in equal steps
  (the attachment, the cession, the retained line), the top of the tower,
  the reinstatements, the commission, the surplus's lines. One button,
  **Test the structures**, runs every candidate on the same simulated years
  as the current programme and the gross book, then again under the
  stresses (the cat PML event, a reserve shock and rates running hot, at the
  figures on 07), and reads the lot against the appetite. The reading: the
  **frontier** — what the cover is expected to cost against how much the net
  result swings, every programme a point coloured by family, filled when it
  fits and hollow when it does not, the efficient ones joined, the pick
  ringed, the gross book and the current programme as bearings; **a
  defensible range** — the decision in a sentence, the range of retentions
  each family fits at (the room to negotiate in) and the **pick**, the
  cheapest programme inside the appetite, with its figures beside the
  current programme's, one button to adopt it as the proposed programme on
  02 (the desk re-runs on it) and one to open the **renewal one-pager**;
  **stress-tested** — the selected programme and the current one after each
  stress; **every programme tested** in one table (premium paid, expected
  cost, the swing of the result, the combined ratio's median and 1-in-10,
  net income expected and 1-in-100, capital needed, ruin, the 1-in-100 loss
  as a share of capital, the solvency or regime ratio, whether it fits and
  which lines it fails, its standing under each stress), a click on any row
  reading its **full outcome range** below — the combined ratio, the net
  income (underwriting result plus investment income) and the solvency
  position at the year end as bands from a good year to a bad one, beside
  the current programme and the gross book — with the appetite line by line.
  The **renewal one-pager** is one printable sheet: the recommendation in a
  sentence, the programme's terms, its figures beside current, the
  frontier, the appetite line by line, the stresses, and the assumptions it
  rests on; the print dialog saves it as a PDF. An edit anywhere marks the
  test stale, as it does the run.

The scope, the stage and the selection live in the URL (`?scope=`, `?tab=`,
`?placements=`, and `?ccy=` for a standalone book), so a reading can be
linked and survives a reload. `GET /api/dfa/portfolio` carries the defaults
a standalone book starts from beside the book itself — the cedants'
domicile, the standard scenarios, the reserve defaults among them. The
screen is `frontend/src/views/DFA.jsx` with one file per stage under
`frontend/src/views/dfa/` (the structuring stage's charts in
`structuringCharts.jsx`, the one-pager in `OnePager.jsx`); the engine is
`backend/src/domain/dfa.js`, pure functions mirrored by
`backend/test/unit/dfa.test.js`; the structuring decision layer — the
candidate builder, the appetite tests, the pick — is
`backend/src/domain/structuring.js` with `backend/test/unit/structuring.test.js`;
and the capital regimes are `backend/src/domain/capitalRegimes.js`. Every
structure is applied to identical gross trials, so a change in the numbers
is the change in the structure, never sampling noise. Nothing here writes
back to a placement.

**The Handbook's shape.** The CAS Handbook lists six sections of risk an
insurer's capital must carry, and the desk covers each: *pricing and
business planning* (the loss ratio, growth and trend, and the rates and
growth scenarios), *reserves* (the opening loss reserve with a one-year
lognormal run-off — process, parameter and specification uncertainty in one
dial — drawn from its own random stream so giving a book a reserve leaves
its underwriting years exactly as they were, plus the deterioration and
frequency scenarios), *mass tort* (the latent-claims charge), *reinsurance*
(the programme itself, its exhaustion and reinstatements, the cat PML event
and the reinsurer-failure scenarios, the credit-risk assumption), *invested
assets* (the yield on the float, invested assets and the market-fall
scenario) and *other assets and liabilities* (the leverage monitors). The
Handbook's "maximum withstandable strain" — how much can the company afford
before it triggers some unpleasant circumstance — is the strain-before-action
figure on 05, read against the regime's first action level.

**Capital regimes.** `capitalRegimes.js` is a reference table, one record a
country (the register's country list plus Bermuda): the regime and its
family — Solvency II or a direct equivalent (the EU and EEA, Solvency UK,
South Africa's SAM, Mexico, the UAE), risk-based capital (NAIC RBC, Canada's
MCT, Bermuda's BSCR, the Swiss Solvency Test, Japan's ESR, C-ROSS, K-ICS,
TW-ICS, HKRBC, RBC 2 in Singapore and Thailand, the frameworks in Malaysia,
Indonesia, the Philippines, Sri Lanka, Kenya, Ghana, Australia, New
Zealand, Brazil, Turkey, Russia and Qatar), a Solvency I-style solvency
margin (India's RSM, most of the Gulf and Levant, North Africa, Latin
America) or a fixed minimum capital (Zimbabwe, Zambia, Tanzania, Ethiopia,
Nepal, Iraq, Syria, Libya, Sudan) — whether it is factor-based or economic,
the regulator, the requirement in a sentence, the ratio read, the
calibration where there is one, and the ladder of action levels with what
the regulator does at each. Every record also says how the desk's modelled
capital stands in for the requirement when the regulatory figure is not
typed: the value at risk (or tail value at risk) at the regime's own
confidence level is read as the capital that puts the ratio at its reference
level — 100% of the SCR under Solvency II, 200% of the ACL under NAIC RBC,
150% of the RSM in India — and a fixed minimum capital has nothing modelled
to stand in for it, so the ladder waits for the figure. It is a summary as at
2026 and says so on screen: thresholds and minimums move, and the regulator's
current rules are the reference.

The model keeps the component structure of the DFA literature (the CAS DFA
Handbook; Kaufmann, Gadmer & Klett, *Introduction to Dynamic Financial
Analysis*, ASTIN Bulletin 2001; Diers on catastrophe modelling and multi-year
internal models) cut down to what a reinsurance buyer needs:

- **Losses in three components.** An attritional cost (lognormal), large
  non-cat events (Poisson frequency, Pareto severity above the large-loss
  threshold, capped at the largest single loss) and cat events (Poisson /
  Pareto with its own tail, capped at the cat PML). Calibration comes from the
  bordereaux and every figure is editable.
- **Parameter risk and common shock.** A gamma-distributed year factor with
  mean 1 scales the attritional mean and the large-loss frequency together, so
  a bad year is bad across the book and Poisson counts become negative
  binomial; the cat rate carries its own mixing factor. Both widen when fewer
  bordereau years are observed, which is where the literature says the tail
  is most under-estimated.
- **Structures.** Quota share with an optional per-event limit, sliding-scale
  commission and loss corridor; a **surplus** treaty (the cedant keeps one
  line of every risk and cedes the part above it up to a number of lines,
  for a commission); per-event excess-of-loss layers with reinstatements,
  placed share and an annual aggregate deductible; an aggregate excess of
  loss / stop loss on the net retained account, expressed in loss-ratio
  terms. Covers respond in that order, using the layer arithmetic in
  `domain/xol.js`.
- **The risk profile, for the surplus.** The engine has no risk list, so
  the book carries a risk profile — sum-insured bands with their share of
  the premium — seeded from the modelling pack's Profiles screen when the
  placement has one, else assumed from the large-loss calibration (five
  bands from the large-loss threshold to the largest single loss, the
  premium halving from band to band) and said so on 01 Scope, where it can
  be typed over. Every large event is read as a loss on a risk big enough to
  carry it, weighted by the band's premium and (a uniform damage ratio)
  inversely by its size, drawn once from its own random stream and shared
  by every structure; attritional and cat losses, spread across the book,
  cede at the profile's premium-weighted average cession — which is also
  the premium the treaty takes. Sums insured inflate with the loss trend.
- **Asset returns.** The investment yield on the surplus and the float can
  carry a volatility (03 Assumptions; 4% by default, the engine's own
  default a fixed yield), a standard normal a trial a year from its own
  stream and shared by every structure, so the year's **net income** —
  underwriting result plus investment income — and the **solvency position
  at the year end** are distributions too, alongside the combined ratio
  year by year.
- **Technical pricing.** A cover without a quoted premium is priced off its
  own simulated recoveries: expected loss plus a standard-deviation risk load
  (Kreps), floored at a minimum rate on line and grossed up for reinsurer
  expenses. Quoted layers show the technical price beside the quote.
- **Reinsurer credit risk.** A one-year default probability seeded from the
  signed panel's ratings (Britt & Krvavych), stressed in the worst 1% of gross
  years, costs the cedant a loss-given-default share of that year's
  recoveries. Default draws are shared by every structure.
- **Multi-year projection.** Up to five years: later years are resampled with
  the book grown and losses trended while the programme stays fixed in
  nominal terms, and the surplus rolls forward with investment income to give
  multi-year ruin and capital-breach probabilities.

The results read the way a buyer reads them (Mango, Major, Adler & Bunick,
*Capital Tranching*, Variance 2013; Goldfarb's RAROC/EVA note; the Actuaries
Institute's *Demystifying reinsurance optimisation*):

- **Reinsurance economics.** Ceded premium (including reinstatements),
  expected recoveries and commission give the **expected cost** (the ceded
  margin). Against the **capital relief** it buys at the chosen percentile,
  the engine reports the cost of capital saved, the **value added** at the
  hurdle rate (the change in EVA) and the **implied cost of the relief**, the
  RORAC test a buyer holds against its own cost of capital. A one-line
  verdict says whether the proposed programme is cheaper than holding the
  capital.
- **Cover by cover.** For every layer and the aggregate cover: premium,
  expected recovery and reinstatement premium, expected cost, rate and loss on
  line, payback years, probability of attaching and of exhausting, and the
  **marginal capital relief** (the programme without that cover, same trials)
  with its implied cost of capital, so the broker can see which layer earns
  its keep.
- **Capital against the capital held.** VaR and TVaR of the underwriting
  result, and against the insurer's available capital (defaulting to the
  gross 1-in-N loss): probability of ruin, expected policyholder deficit,
  solvency ratio, earnings at risk (the 1-in-10 loss) and the 1-in-100 net
  loss as a share of capital, the retention rule of thumb.
- **Risk transfer.** The reinsurer's expected deficit (ERD, Ruhm & Brehm)
  and the 10-10 reading, so a structure that is really a financing deal shows
  as one.
- **The frontier.** Gross, current, proposed and up to twelve **variants**
  plot required capital against expected result; *Also explore* on 02
  Programme scans the first layer's retention, the quota-share cession or the
  aggregate attachment along one dimension of the proposed structure.

Out of scope, and said so in the code: surplus treaties (no risk profile in
the engine), payment patterns (the reserve runs off as a one-year change in
the ultimate, not as a cash-flow), and a stochastic underwriting cycle.
Reinsurance premiums in later years follow the subject premium rather than
the market.

## Universe integration

- **Pull:** `GET /api/layers/:id/technical` and the quote board surface the
  technical rate / modelled output as a benchmark beside market quotes. When
  `UNIVERSE_API_URL` is unset, a deterministic stub derives a benchmark from the
  layer so the system is exercisable offline.
- **Push:** on bind, a bound layer optionally confirms the inwards contract in
  Universe (no-op unless configured).
- **Boundary:** Broking never writes pricing; Universe never writes lines.

## API surface (selected)

| Area | Endpoint |
|------|----------|
| Auth | `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/register` (admin) |
| Register | `GET/POST /api/cedants`, `GET/POST/PATCH /api/markets`, `GET /api/markets/facets` |
| Counterparty | `GET /api/markets/:id`, `PATCH /api/markets/:id/compliance`, `PUT /api/markets/:id/profile`, `POST /api/markets/:id/profile/enrich`, `POST /api/markets/:id/news`, `PUT /api/markets/:id/financials` |
| Placements | `GET/POST /api/placements` (search: `q`, `country`, `cedant_id`, `treaty_type`, `class`, `status`, `renewal_of`), `GET /api/placements/facets` (the countries, cedants, treaty types and classes of the book, narrowed by the same filters — the renewal wizard's cascade), `GET /api/placements/:id` (with `renewal_of_placement` and `renewed_by`), `POST /api/placements/:id/transition`, `POST /api/placements/:id/renew` |
| Layers | `POST /api/placements/:id/layers`, `GET/PATCH/DELETE /api/layers/:id` |
| Data | `GET/POST /api/placements/:id/data-analysis` (the screens read as one, compared with the prior year or the uploaded expiring pack; POST asks the model for its reading), `POST /api/placements/:id/expiring-pack` (the expiring pack of new business, any format), `POST /api/placements/:id/bordereaux` (premium / claims / risk_profile), `GET /api/placements/:id/loss-summary` |
| Modelling | `GET /api/placements/:id/modelling`, `GET/PUT/DELETE /api/placements/:id/modelling/:section` (per-screen JSONB sections) |
| Packs | `GET/POST /api/placements/:id/packs`, `GET /api/placements/:id/pack-preview`, `GET /api/packs`, `GET /api/packs/by-cedant`, `GET/PATCH /api/packs/:id`, `GET /api/packs/:id/export`, `GET /api/packs/:id/workbook`, `POST /api/packs/:id/{submit,approve,reject}`, `GET /api/placements/:id/pack-approval` (every version with its trail and comments), `POST /api/packs/:id/comments` (versioned via `replaces_id`) |
| Marketing | `POST /api/layers/:id/approaches`, `POST /api/approaches/:id/quotes`, `GET /api/layers/:id/quote-board` |
| FOT | `POST /api/layers/:id/fot`, `POST /api/layers/:id/fot/authorise` |
| Lines | `POST /api/layers/:id/lines`, `GET /api/layers/:id/signing/preview`, `POST /api/layers/:id/signing/apply`, `POST /api/layers/:id/signing/instruction`; signing by contract `GET /api/signing/contracts?q=` (every placement with a programme, with where its signing stands) and `GET /api/signing/contracts/:placementId` (the programme, and the written and signed line of every market on every layer, by layer and by reinsurer) |
| Bind | `POST /api/layers/:id/bind/propose`, `POST /api/layers/:id/bind/authorise` |
| Closing | `GET /api/layers/:id/premium-allocation`, `POST /api/layers/:id/documents` |
| MDP | `GET/POST /api/layers/:id/mdp`, `POST /api/mdp-notes/:id/status` |
| Losses | `GET/POST /api/placements/:id/losses`, `GET/PATCH /api/losses/:id`, `POST /api/losses/:id/calculate`, `POST /api/losses/:id/settle`, `GET /api/losses/:id/advices`, `GET /api/losses/:id/advice-draft`, `POST /api/losses/:id/preliminary-advice`, `POST /api/losses/:id/claim-advice` |
| Claim notifications | `GET /api/claim-notifications`, `POST /api/claim-notifications/ingest`, `GET /api/claim-notifications/:id`, `POST /api/claim-notifications/:id/{match,load,park}`; the claims desk's read model `GET /api/claims/contracts?q=` and `GET /api/claims/contracts/:placementId` |
| Renewal desk | `GET/POST /api/renewal-analyses`, `GET/POST /api/renewal-analyses/intake` (the quick renewal pack's AI read of the intake details), `GET/DELETE /api/renewal-analyses/:id`, `POST …/run`, `POST/DELETE …/documents`, `PUT …/placement`, `POST/DELETE …/verify`, `PATCH …/summary`, `GET/POST …/submission`, `GET …/responses`, `POST …/release`, `GET …/signed-lines`, `POST …/signed-lines/{send,courtesy}`; `PATCH /api/layers/:id/lines/:marketId` (signed override and notes) |
| Wordings | `GET /api/wordings/meta`, `GET/POST /api/wordings/clauses`, `GET/PATCH/DELETE /api/wordings/clauses/:id` |
| Clause review | `GET /api/wordings/clauses/:id/history` (against the version it supersedes), `/variants` (reinsurer versions), `/usage` (where it is in force) |
| Slip comparison | `POST /api/wordings/slips/parse` (read a slip into clauses), `POST /api/wordings/slips/compare` (one slip against the market standard, or two against each other) |
| Draft wordings | `GET/POST /api/wordings/drafts`, `GET/PATCH/DELETE /api/wordings/drafts/:id`, `POST /api/wordings/drafts/:id/clauses`, `.../clauses/:rowId/revert`, `.../reorder` |
| Compare | `GET /api/wordings/compare?left_type=…&right_type=…` |
| Dashboards | `GET /api/dashboards/metrics`, `/outstanding`, `/renewal-calendar`, `/portfolio` (`?year=YYYY` — who leads, who places, who writes the book), `/brokerage`, `/placements/:id/progress` |
| Market intelligence | `GET /api/market-intelligence` (the map: every region and country with the accounts, cedants, trips, notes and brief on it), `GET /api/market-intelligence/scope?scope_type=country|region&scope_key=…` (one market: the brief in its six sections — `sector`, `economy`, `regulation`, `statistics`, `events`, `players` — our book there, the trips with their return, the notes), `POST /api/market-intelligence/brief/gather` (research the market from the internet, one request per section, folding in the desk's notes and trips — `OPENAI_API_KEY`), `POST /api/market-intelligence/brief/:id/verify`, `GET/POST /api/market-intelligence/visits`, `PATCH/DELETE /api/market-intelligence/visits/:id` (a broker's trips, with cost, cedants met and the return the book shows), `GET/POST /api/market-intelligence/notes`, `PATCH/DELETE /api/market-intelligence/notes/:id` (notes by cedant, country or region, typed or uploaded) |
| Dynamic financial analysis | `GET /api/dfa/portfolio` (the analysable book: calibration from bordereau experience including the outstanding reserves and the modelling pack's risk profile, the current structure from the layers, the signed panel and its rating-based default probability, the cedants' domicile, the standard scenarios, the appetite and the structuring grid's defaults), `POST /api/dfa/run` (simulate up to 4 named structures — quota share, surplus, excess of loss, stop loss — and 12 frontier variants over identical gross trials: capital, ruin and EPD against available capital, reinsurance economics, cover-by-cover attribution, reinsurer returns, the combined ratio, net income and year-end solvency as distributions, multi-year surplus; with `assumptions.domicile` the capital read against that country's regime, and up to 12 `scenarios` re-run on the same seed with the inputs moved), `POST /api/dfa/structuring` (the treaty-structuring sweep: the families named in `grid` built across a range of retentions — up to 40 candidates — run on the same trials as the current programme and under up to 6 `stresses`, then read against the `appetite`: every candidate's tests, its place on the frontier and its standing under each stress, the defensible range family by family, and the pick), `GET /api/dfa/regimes` (the capital regimes by country — Solvency II, risk-based capital, solvency margin, minimum capital), `GET /api/dfa/regimes/:code` (one regime in full: regulator, requirement, calibration, the ladder of action levels) |
| Quoting stage | `GET /api/placements/:id/negotiation` (the board, plus `by_underwriter`, `combined` and `rol_comparison`), `POST /api/placements/:id/negotiation/send`, `GET/PUT /api/negotiations/:id/sheet`, `PUT /api/negotiations/:id/quotes`, `PATCH/DELETE /api/negotiations/:id`, `DELETE /api/negotiations/:id/structures/:structureId` |
| Submissions | `GET /api/placements/:id/negotiation/submission-context`, `GET/POST /api/placements/:id/negotiation/submissions`, `GET/PATCH /api/negotiation-submissions/:id`, `POST /api/negotiation-submissions/:id/{redraft,request-approval,approve,reject,cancel}` |
| Underwriters | `GET /api/underwriters`, `GET/POST /api/markets/:id/contacts`, `PATCH/DELETE /api/market-contacts/:id` |
| Final quote / placement | `GET/PUT /api/placements/:id/final`, `GET …/final/email-draft` (with the Excel + PDF the FOT will carry), `POST …/final/emails` (`attach_pack` for the approved pack as Excel + PDF, or `pack_upload_id`), `POST …/final/pack-upload` (a pack attached by hand — `reason` mandatory), `PUT …/final/lines`, `POST …/final/lines/read-emails` (the AI reads the reinsurers' emails on file, plus any pasted in, and enters the lines marked `source: ai`), `POST …/final/lines/accept`, `POST …/final/confirm` |
| Retentions | `GET /api/occupancy-classes`, `POST/PUT /api/occupancy-classes` (admin), `PATCH/DELETE /api/occupancy-classes/:id` (admin) |
| Reference data (Universe lookups) | `GET /api/brokers`, `GET /api/treaty-types`, `GET /api/class-of-business`, `GET /api/ref/lists/:key/items` (country, currency), `GET /api/countries/:id`, `DELETE /api/ref/cache` |
| Admin | `GET /api/admin/audit`, `GET /api/admin/approvals` |

## The market register

Every counterparty sits in one register, split by `type` into three tabs:

| Tab | What it holds |
|-----|---------------|
| **Reinsurers** | The capacity we place with. Only these can be approached on a layer. |
| **Insurers** | The cedant side. Creating a cedant creates (and links to) its insurer entry. |
| **Brokers** | Co-brokers and intermediaries we work alongside. |

The reinsurer list is filterable by everything a broker asks of it: markets we
already have business with (a written or signed line, not merely an approach),
whether they act as **lead** or **follow**, minimum share written, region,
country of domicile, rating, KYC status and the security list — composable, and
held in the URL so a filtered view can be shared.

Lead/follow shares come from the line ledger joined to the approach on
`(layer, market)` — so attribution holds whether or not the line recorded the
approach it came from.

### Compliance

`src/domain/compliance.js` is pure logic over three independent gates, each
resolving to `ok` / `attention` / `blocked`; the counterparty's overall status is
the worst of them, and a single blocked gate means it cannot be approached.

- **KYC** — approved and in date. Expiry inside 60 days flags; past expiry blocks.
- **Rating** — held, at or above A-, and confirmed within 400 days. A negative
  outlook flags.
- **Security** — the broker's own approved / watch / declined list.

KYC and rating sign-off is recorded by an `underwriter` or `admin` — the same
roles that authorise FOT and bind — not by the broker placing the business.

### Group profile

Each counterparty carries a group summary (market position, overview, strategy),
its latest news, and five years of headline financials (GWP, NWP, net income,
equity, total assets, loss / expense / combined ratios, ROE). All of it can be
keyed in by hand or uploaded as CSV, and all of it can instead be **gathered
from the internet**: `POST /api/markets/:id/profile/enrich` asks ChatGPT to
research the group with server-side web search and returns the same shape the
manual forms write, with its sources. It goes through the same `lib/llm.js`
module as the bordereau analysis, so it needs `OPENAI_API_KEY` and no second
key of its own.

Gathered content is never treated as authoritative. It lands marked `ai` and
unverified, the UI says so, and it stays that way until someone checks it and
signs it off. A year keyed in by hand is the source of record — a gather never
overwrites it. With no key configured the endpoint fails with `llm_unavailable`
(503) and writes nothing, rather than inventing figures that would be
indistinguishable from researched ones once stored.

## RBAC

`broker` (build placements, market, write lines, curate the wording library and
build draft wordings), `underwriter` (authorise FOT / bind, oversight; reads the
wording library), `admin` (everything incl. user provisioning and deleting
library clauses). All mutations write to the audit trail.
