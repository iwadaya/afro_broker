#!/usr/bin/env bash
# scripts/test-db.sh — create the test database if needed, migrate, seed, and run
# the DB-backed server suite with TEST_WITH_DB=1 (same steps CI uses).
#
#   scripts/test-db.sh
#   DATABASE_URL=postgres://… scripts/test-db.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
DEFAULT_URL="postgresql://postgres:postgres@localhost:5432/afro_broker_test"
export DATABASE_URL="${DATABASE_URL:-$DEFAULT_URL}"
export TEST_WITH_DB=1
export NODE_ENV="${NODE_ENV:-test}"
export ALLOW_DEMO_AUTH=true
export BROKING_ENABLED=true
export BROKING_LLOYDS_BROKER_NO="${BROKING_LLOYDS_BROKER_NO:-0621}"
echo "▶ DATABASE_URL = $(printf '%s' "$DATABASE_URL" | sed -E 's#(://[^:]+:)[^@]*@#\1***@#')"
DB_NAME="$(node -e 'try{process.stdout.write(new URL(process.env.DATABASE_URL).pathname.replace(/^\//,""))}catch{process.stdout.write("")}')"
if command -v psql >/dev/null 2>&1 && [ -n "$DB_NAME" ]; then
  ADMIN_URL="$(node -e 'const u=new URL(process.env.DATABASE_URL);u.pathname="/postgres";process.stdout.write(u.toString())')"
  if psql "$ADMIN_URL" -tAc "SELECT 1" >/dev/null 2>&1; then
    if ! psql "$ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
      echo "▶ creating database ${DB_NAME}"; psql "$ADMIN_URL" -c "CREATE DATABASE \"${DB_NAME}\""
    fi
  fi
fi
[ -d node_modules ] || npm ci
[ -d server/node_modules ] || npm ci --prefix server
echo "▶ running migrations"; npm run migrate --prefix server
echo "▶ seeding reference data + demo users"; npm run seed --prefix server
echo "▶ running server tests (TEST_WITH_DB=1)"; npm test --prefix server
echo "✓ DB-backed server tests complete"
