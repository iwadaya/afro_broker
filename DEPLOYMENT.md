# Deployment — AABI broking

The app is one Node 20 process: the Express API serves `/api/*` and the built
client from `client/dist`. State lives in PostgreSQL 16. Everything below is
driven by `deploy/deploy.sh`; the Docker files (`Dockerfile`,
`docker-compose.yml`) are the container equivalent.

## 1. Provision

```bash
# PostgreSQL role + database (idempotent). Prompts for the role password.
ADMIN_URL=postgresql://postgres@localhost:5432/postgres deploy/provision-db.sh
# → DATABASE_URL=postgresql://afro_broker:<password>@localhost:5432/afro_broker
```

Node 20.20 (`.nvmrc`), `npm`, `git` and `psql` on the host; a systemd unit
`aabi-broking.service` that runs `node server/src/index.js` from the checkout
with `EnvironmentFile=/path/to/.env` (or set `RESTART_CMD` for pm2 / Docker).

## 2. Configure `.env` (repo root; see `.env.example`)

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `AUTH_JWT_SECRET` | yes (≥ 32 chars) | HMAC secret for the httpOnly auth cookie; `SESSION_SECRET` optional for CSRF |
| `PORT` | no (4000) | HTTP port |
| `CORS_ORIGIN` | yes in production | allowed browser origin(s), comma separated |
| `BROKING_ENABLED` | no (false) | **Feature flag.** `true` mounts `/api/broking` and shows Broking in the navigation. Default OFF, so an upgrade never exposes the module by accident |
| `BROKING_LLOYDS_BROKER_NO` | no | The broking house's 4-digit Lloyd's number; every new UMR is pre-filled `B` + this number on the Identify step. Unset → just `B` |
| `RUN_MIGRATIONS_ON_BOOT` | no (false) | Leave false: `deploy.sh` migrates before the restart |
| `ALLOW_DEMO_AUTH` | never in production | Universal demo password + `x-user-id` identity for tests |

## 3. Deploy

```bash
deploy/deploy.sh --ref main            # fetch origin/main → npm ci → client build → migrate → restart
deploy/deploy.sh --ref v1.3.0          # any branch, tag or commit
deploy/deploy.sh --ref main --seed     # also load reference data (countries, currencies, classes, treaty types)
deploy/deploy.sh --ref main --seed-demo   # reference data + demo users and the two sample contracts (never in production)
deploy/deploy.sh --ref main --no-restart   # first install / dry run: everything except the restart
```

Order of operations and why it is safe:

1. **Code** is checked out at the requested ref (detached HEAD, so a hot-fix branch can be deployed and rolled back by ref).
2. **Dependencies** with `npm ci` (root without dev deps, server without dev deps, client with dev deps for the Vite build).
3. **Client build** to `client/dist`; the running server keeps serving the old bundle until the restart.
4. **Migrations** run *before* the restart (`server/src/db/migrate.js`): each `server/src/db/migrations/NNN_*.sql` file is applied once, inside its own transaction, recorded in `_migrations`, under a Postgres advisory lock so two deploys cannot double-apply. A failed migration aborts the deploy with the old process still running.
5. **Restart** via `systemctl restart <service>` (or `RESTART_CMD`), then `/api/health` is polled for 20 s.

`npm run migrate:status --prefix server` lists applied / pending files. The broking module's migrations are `003_bk_enums_contract.sql` … `006_bk_audit.sql` (see `docs/broking/PLAN.md`
for the numbering in the Universe monorepo).

### Verified

`deploy/deploy.sh --ref <branch> --no-restart --seed` was run with `NODE_ENV=production` in a fresh clone against an empty database `afro_broker_deploy_test`: 6 migrations applied, reference data seeded, demo data skipped, `migrate:status` clean; `--seed-demo` then loaded the demo users and the two sample contracts. `--ref main` fails fast with "ref 'main' not found on origin" until the repository has a `main` branch.

### First user

Demo users are only seeded with `--seed-demo` / `ALLOW_DEMO_AUTH=true`. On a production database
create the first sign-in with the CLI (the password is hashed with scrypt; the user must change it
at first sign-in):

```bash
npm run user:create --prefix server -- --username jane.broker --email jane@example.com --display "Jane Broker" --role ADMIN
# roles: ADMIN | BROKER | VIEWER; the organisation defaults to the seeded broking house
```

## 4. Turning the module on

1. Set `BROKING_ENABLED=true` and `BROKING_LLOYDS_BROKER_NO=<4 digits>` in `.env`.
2. `deploy/deploy.sh --ref main` (the restart picks the flags up; `/api/config` reports `brokingEnabled`).
3. Sign in and open **Broking** → **New contract**.

With the flag off the routes return 404 and the navigation entry is hidden; the tables and data stay in place.

## 5. Docker

```bash
docker compose up --build        # app on :4000 + PostgreSQL 16, migrations on boot, demo auth ON (local only)
```

The image (`Dockerfile`) builds the client, installs production server deps and runs `node server/src/index.js` under tini with a `/api/health` healthcheck. For production supply the same `.env` variables (never `ALLOW_DEMO_AUTH`).

## 6. Rollback

`deploy/deploy.sh --ref <previous tag or commit>`. Migrations are forward-only; the broking tables are additive (`bk_*`) and gated by the flag, so rolling the code back while leaving the schema in place is safe.
