# Deploying to Render

The app deploys as **one web service** — the Express API also serves the built
React SPA, so the browser talks to a single origin and no CORS configuration is
needed — plus **one managed PostgreSQL instance**.

`render.yaml` at the repo root is a [Render Blueprint](https://render.com/docs/blueprint-spec)
describing both: a **Starter** web instance and a **Basic** PostgreSQL 16
instance. Both are paid tiers — the service never sleeps, and the database has
daily backups and no expiry.

## First deploy

1. Push this branch to GitHub (Render reads the blueprint from the repo).
2. In Render: **New → Blueprint**, pick the repository, and review the plan. It
   creates `broker-iq` (web) and `broker-iq-db` (PostgreSQL 16).
3. Apply. The build runs `npm ci --include=dev && npm --workspace frontend run build`;
   the pre-deploy hook then applies the migrations and runs the demo seed (see
   [Demo data on every deploy](#demo-data-on-every-deploy)), and
   `node src/server.js` starts.
4. Open the service URL. It **signs you in by itself** as the demo broker
   (`DEMO_AUTO_LOGIN`) and lands on the dashboard — no login screen. The demo
   renewal book is already there. **Sign out** in the account menu shows the
   login screen, which lists every demo user (the demo password `demo2026`,
   `DEMO_PASSWORD`, is filled in) and offers **Continue as Demo Broker** to
   take the automatic session back; a new tab is signed in again by itself.

That is the whole first deploy for a demonstration. For a real deployment:

1. Before the first deploy, remove `&& npm run seed` from `preDeployCommand`
   and the `DEMO_PASSWORD`, `DEMO_AUTO_LOGIN` and `SEED_RESET` variables from
   `render.yaml`, so no demo account with a password committed to this
   repository is ever created and nobody is signed in without one.
2. The service then comes up with **no users**, so nothing can sign in yet. In
   the service's **Environment** tab add:

   | Key | Value |
   |-----|-------|
   | `BOOTSTRAP_ADMIN_EMAIL` | your admin email |
   | `BOOTSTRAP_ADMIN_PASSWORD` | a strong password, min 12 chars |
   | `BOOTSTRAP_ADMIN_NAME` | display name (optional) |

   Save — Render redeploys, and the admin is created on boot.
3. Sign in, then create the real users via **Admin → users** (or
   `POST /api/auth/register`).
4. **Delete `BOOTSTRAP_ADMIN_PASSWORD`** from the environment and redeploy.

The bootstrap only fires when the users table is completely empty, so leaving it
set cannot resurrect a deleted account (and on a seeded demo deployment it does
nothing at all) — but a password sitting in the environment is a password that
can leak.

Paid instances also have a **Shell** tab, so you can create the first admin
there instead if you prefer.

## Why the build command uses `--include=dev`

```
buildCommand: npm ci --include=dev && npm --workspace frontend run build
```

`NODE_ENV=production` makes npm omit `devDependencies`, and Vite — which builds
the frontend — is one. A plain `npm ci` therefore installs nothing that can
build the SPA and the deploy dies with `sh: 1: vite: not found`. The runtime
genuinely does not need those packages; only the build step does.

## Environment variables

`render.yaml` sets these automatically:

| Key | Value | Why |
|-----|-------|-----|
| `NODE_ENV` | `production` | Enables the production guards below. |
| `NODE_VERSION` | `22` | Matches CI; the test runner needs ≥ 21. |
| `JWT_SECRET` | generated | Render mints a strong value and keeps it stable. |
| `DATABASE_URL` | from `broker-iq-db` | Internal connection string. |
| `DATABASE_SSL` | `false` | The internal URL is already on a private network. Set `true` for an external database. |
| `preDeployCommand` | `npm run migrate && npm run seed` | Applies schema changes, then the demo seed, once before the new version goes live. |
| `SERVE_STATIC` | `true` | Serve `frontend/dist` from the API process. |
| `MIGRATE_ON_BOOT` | `false` | Migrations run in `preDeployCommand` instead — see below. |
| `DEMO_PASSWORD` | `demo2026` | Demo sign-in: every user's password, and a user dropdown on the login screen. |
| `DEMO_AUTO_LOGIN` | `broker@broking.local` | Demo auto sign-in: a fresh visit is signed in as this user with no login screen (an email, or `1` for the first demo user). Anyone with the URL gets that session. |
| `SEED_RESET` | `0` | Whether the pre-deploy seed rebuilds the demo book on each deploy (`1`) or only adds what is missing (`0`). |

`PORT` is injected by Render and read automatically.

Optional: set `CORS_ORIGINS` (comma-separated) only if you split the frontend
onto a separate origin. Leave it empty for the single-service deploy — in
production an empty value means **no cross-origin requests are permitted at
all**, which is what you want here.

## What production mode changes

Booting with `NODE_ENV=production` is not just a label:

- **`JWT_SECRET` is mandatory.** The process refuses to start if it is missing,
  still set to the development default, or shorter than 32 characters. A
  predictable signing key lets anyone mint an admin token.
- **CORS is closed by default** — only origins listed in `CORS_ORIGINS` are
  allowed. Development stays open so the Vite dev server can reach the API.
- **`trust proxy` is on**, so `req.ip` is the real client address from
  `X-Forwarded-For` rather than Render's load balancer.
- **The SPA is served** from `frontend/dist` with hashed assets cached for a
  year and `index.html` marked `no-cache`, so a redeploy is picked up at once.
- **Login rate limiting is active** (see below).

## Login rate limiting

`POST /api/auth/login` is limited to **10 failed attempts per IP per 15 minutes**
(`RATE_LIMIT_LOGIN_FAILURES`, `RATE_LIMIT_WINDOW_MS`). Only *failures* count, so
ordinary users are never affected however often they sign in, while a guessing
loop is cut off in seconds and gets a `429` with `Retry-After`.

Two limits worth knowing:

- It is **in-memory and per-process**. Scaling to more than one instance gives
  each its own counters; a shared store (Redis) would be needed for a real
  distributed quota.
- It buckets by IP, so users behind the same NAT share a budget.

## Migrations

`render.yaml` runs them in the pre-deploy hook:

```yaml
    preDeployCommand: npm run migrate
```

with `MIGRATE_ON_BOOT=false` so the server does not also attempt them at
startup. The hook runs after the build and before the new version takes traffic,
which keeps schema changes out of the request path and stops multiple instances
racing to migrate if the service is ever scaled out.

A failing migration fails the deploy and the previous version keeps serving.

Migrations are applied in filename order and recorded in `schema_migrations`, so
re-running is a no-op. If you ever need to apply them by hand, the **Shell** tab
gives you `npm run migrate`.

## Demo data on every deploy

The same hook runs the demo seed after the migrations:

```yaml
    preDeployCommand: npm run migrate && npm run seed
```

`npm run seed` creates the demo users, the market register with an underwriter
contact at every reinsurer, the demo renewal book, the three demo renewal packs
(`DEMO-27-QS`, `DEMO-27-XL` and `DEMO-27-COMBINED` — every screen filled and a
pack version each) and the wording library. Every step is idempotent: users
upsert on email, the book and the packs are only created while absent, and no
clause anyone has edited is overwritten. So a redeploy adds whatever a newer
seed carries (a new demo placement, a new user) and leaves everything else
exactly as the last demonstration left it. The CI production job re-runs the
seed on an already-seeded database and fails if anything changes.

To start every deploy from a clean demonstration instead, set `SEED_RESET` to
`1` — in `render.yaml`, or in the service's **Environment** tab, where it holds
until the blueprint next syncs: the seed then drops **every placement** — the
demo book and anything created through the UI since — and rebuilds the book
and the packs. Users, the register and the wording library are left alone
either way. A one-off reset is `SEED_RESET=1 npm run seed` from the **Shell**
tab.

Like a failing migration, a failing seed fails the deploy and the previous
version keeps serving.

## Scaling

The blueprint runs a single instance. Two things to know before raising that:

- **The login rate limiter is per-process** (see above), so each instance would
  keep its own counters and the effective limit multiplies by the instance
  count. Move it to a shared store before scaling out.
- **Migrations and the demo seed** are already safe — the pre-deploy hook runs
  once per deploy, not once per instance.

Nothing else in the app holds local state; sessions are stateless JWTs and
uploads go to the database, so horizontal scaling is otherwise fine.

## Backups

The Basic tier takes daily backups with 7-day retention. Point-in-time recovery
requires a Pro instance. If this starts holding placement records you cannot
lose, that upgrade is the one worth making first.

## Auto-deploy on merge

Render deploys the service itself whenever `main` moves — a merged pull
request included. Two things make that happen, and both are worth checking
once in the Render dashboard, because for a service that already exists the
dashboard's settings are what count:

1. **The repository is linked.** Open the service → **Settings → Build &
   Deploy**: *Repository* should read `iwadaya/afro_broker` and *Branch*
   `main` (the `branch: main` the blueprint sets). If the repository is
   missing, Render's GitHub App has lost access to it — reconnect under
   **Account Settings → Git Providers**.
2. **Auto-Deploy is on.** In the same tab, *Auto-Deploy* should read
   **Yes** (or *On Commit*). `autoDeploy: true` in `render.yaml` is what the
   blueprint sets; if it was switched off in the dashboard at some point,
   switch it back on there.

The proof is the service's **Events** tab: every merge shows a *Deploy
started* event within a minute or two, naming the commit, then the
pre-deploy hook (migrations, seed) and *Deploy live*. A merge that shows
nothing there means one of the two above is off.

### Deploying only after CI is green (optional)

Render's auto-deploy fires on the push itself, before the GitHub Actions
checks have run. To deploy only once every check on `main` has passed, use
the **deploy** job at the end of `.github/workflows/ci.yml` instead:

1. In Render, open the service → **Settings → Deploy Hook** and copy the URL
   (it carries a key — treat it as a secret).
2. In GitHub, add it as the repository secret `RENDER_DEPLOY_HOOK_URL`
   (**Settings → Secrets and variables → Actions**).
3. Switch the service's *Auto-Deploy* to **No**, and set `autoDeploy: false`
   in `render.yaml` so a blueprint sync keeps it that way.

From then on every merge to `main` runs the tests, the browser suite and the
production rehearsal, and the **deploy** job calls the hook once they are
all green — its log shows Render's acknowledgement, and the deploy appears
in the Events tab as *Deploy hook*. Without the secret the job does nothing
and Render's own auto-deploy carries on as before, so adding the secret is
the only switch.

## Verifying a deploy

```bash
curl https://<service>.onrender.com/health
# {"status":"ok","service":"universe-broking"}
curl -s -X POST https://<service>.onrender.com/api/auth/auto-login
# {"enabled":true,"token":"…","user":{"email":"broker@broking.local",…}}
```

Then open the URL: it lands on the dashboard signed in as the demo broker.
Open **Contracts**, set up a proportional contract, and find it on the
renewal calendar.

## Running the same configuration locally

```bash
npm --workspace frontend run build
NODE_ENV=production \
  PORT=8080 \
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/broking_dev \
  JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
  npm --workspace backend run start
```

Everything is then on <http://localhost:8080> — API and UI on one origin,
exactly as on Render. The e2e suite runs against it unchanged:

```bash
BASE_URL=http://localhost:8080 npm --prefix e2e test
```
