#!/usr/bin/env bash
# deploy/deploy.sh — build, migrate and restart AABI broking on a server.
#
#   deploy/deploy.sh --ref main                 # fetch + check out origin/main, install, build, migrate, restart
#   deploy/deploy.sh --ref v1.2.0 --service aabi-broking
#   deploy/deploy.sh --ref main --no-restart    # everything except the service restart (first install, CI checks)
#   deploy/deploy.sh --ref main --skip-git      # deploy the working tree as it is (no fetch/checkout)
#   deploy/deploy.sh --ref main --seed          # also load reference data; --seed-demo adds demo users + samples
#
# Steps, in order — each one stops the deploy on failure, BEFORE the restart:
#   1. git fetch + checkout of the requested ref (unless --skip-git)
#   2. npm ci for root, server and client (unless --skip-install)
#   3. client build (Vite) → client/dist, served by the API server
#   4. database migrations (server/src/db/migrate.js — transactional per file,
#      advisory-locked, so a concurrent run waits instead of double-applying)
#   5. optional seed of reference data (--seed). Demo users and the sample
#      contracts are only loaded with --seed-demo (or ALLOW_DEMO_AUTH=true)
#   6. restart the systemd service (or the command in RESTART_CMD)
#
# Environment: the server reads .env from the repo root (see .env.example).
# DATABASE_URL must point at the production database; BROKING_ENABLED=true turns
# the module on; BROKING_LLOYDS_BROKER_NO pre-fills new UMRs.
set -euo pipefail
REF="main"; SERVICE="${SERVICE:-aabi-broking}"; RESTART=1; DO_GIT=1; DO_INSTALL=1; DO_SEED=0; SEED_DEMO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --ref=*) REF="${1#--ref=}"; shift ;;
    --service) SERVICE="$2"; shift 2 ;;
    --no-restart) RESTART=0; shift ;;
    --skip-git) DO_GIT=0; shift ;;
    --skip-install) DO_INSTALL=0; shift ;;
    --seed) DO_SEED=1; shift ;;
    --seed-demo) DO_SEED=1; SEED_DEMO=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
log() { printf '▶ %s\n' "$*"; }

# ── 0. environment ────────────────────────────────────────────────────────────
if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${DATABASE_URL:?DATABASE_URL is required (set it in .env or the environment)}"
export NODE_ENV="${NODE_ENV:-production}"
log "ref=${REF} service=${SERVICE} node=$(node -v) env=${NODE_ENV} db=$(printf '%s' "$DATABASE_URL" | sed -E 's#(://[^:]+:)[^@]*@#\1***@#')"

# ── 1. code ───────────────────────────────────────────────────────────────────
if [ "$DO_GIT" = 1 ]; then
  git fetch --prune origin
  if git rev-parse --verify -q "origin/${REF}" >/dev/null; then
    log "checking out origin/${REF}"; git checkout -q --detach "origin/${REF}"
  elif git rev-parse --verify -q "${REF}^{commit}" >/dev/null; then
    log "checking out ${REF}"; git checkout -q --detach "${REF}"
  else
    echo "ref '${REF}' not found on origin (branch, tag or commit expected)" >&2; exit 1
  fi
fi
log "deploying $(git rev-parse --short HEAD 2>/dev/null || echo 'working tree') — $(git log -1 --pretty=%s 2>/dev/null || true)"

# ── 2. dependencies ───────────────────────────────────────────────────────────
if [ "$DO_INSTALL" = 1 ]; then
  log "installing dependencies"
  npm ci --omit=dev --ignore-scripts >/dev/null
  npm ci --prefix server --omit=dev >/dev/null
  npm ci --prefix client --include=dev >/dev/null   # NODE_ENV=production would omit the dev deps Vite needs
fi

# ── 3. client build ───────────────────────────────────────────────────────────
log "building client"; npm run build --prefix client >/dev/null

# ── 4. migrations (before the restart: the new code never runs against an old schema) ──
log "applying migrations"; npm run migrate --prefix server
npm run migrate:status --prefix server | tail -n 3 || true

# ── 5. seed (reference data; demo users only when ALLOW_DEMO_AUTH=true) ───────
if [ "$DO_SEED" = 1 ]; then
  log "seeding reference data${SEED_DEMO:+ + demo data}"
  if [ "$SEED_DEMO" = 1 ]; then npm run seed --prefix server -- --demo; else npm run seed --prefix server; fi
fi

# ── 6. restart ────────────────────────────────────────────────────────────────
if [ "$RESTART" = 1 ]; then
  if [ -n "${RESTART_CMD:-}" ]; then log "restart: ${RESTART_CMD}"; bash -c "$RESTART_CMD";
  elif command -v systemctl >/dev/null 2>&1; then log "restarting ${SERVICE}"; sudo systemctl restart "$SERVICE"; sudo systemctl --no-pager --lines=5 status "$SERVICE" || true;
  else echo "no systemctl and no RESTART_CMD — start the server with: NODE_ENV=production node server/src/index.js" >&2; fi
  PORT="${PORT:-4000}"
  for _ in $(seq 1 20); do
    if node -e "fetch('http://127.0.0.1:${PORT}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then log "healthy on :${PORT}"; exit 0; fi
    sleep 1
  done
  echo "health check on :${PORT} did not pass within 20s" >&2; exit 1
fi
log "done (no restart requested)"
