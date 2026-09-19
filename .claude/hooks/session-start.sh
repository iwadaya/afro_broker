#!/bin/bash
# SessionStart hook for Claude Code on the web: install deps and stand up the
# test database so lint, unit, integration and Playwright suites work out of the box.
set -euo pipefail
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then exit 0; fi
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"
echo "[session-start] installing npm deps (root + server + client)…"
npm install; npm install --prefix server; npm install --prefix client
TEST_DB_URL="postgresql://postgres:postgres@localhost:5432/afro_broker_test"
if command -v psql >/dev/null 2>&1; then
  (service postgresql start >/dev/null 2>&1 || true)
  for _ in 1 2 3 4 5 6 7 8 9 10; do pg_isready -h localhost -p 5432 >/dev/null 2>&1 && break; sleep 1; done
  if pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
    su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\"" >/dev/null 2>&1 || sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';" >/dev/null 2>&1 || true
    su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='afro_broker_test'\"" 2>/dev/null | grep -q 1 \
      || su postgres -c "psql -c 'CREATE DATABASE afro_broker_test;'" >/dev/null 2>&1 || true
    DATABASE_URL="$TEST_DB_URL" npm run migrate --prefix server >/dev/null 2>&1 && DATABASE_URL="$TEST_DB_URL" npm run seed --prefix server >/dev/null 2>&1 \
      && echo "[session-start] test DB migrated + seeded." || echo "[session-start] WARN: migrations failed — run scripts/test-db.sh"
    if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
      { echo "export DATABASE_URL=\"$TEST_DB_URL\""; echo "export TEST_WITH_DB=1"; echo "export ALLOW_DEMO_AUTH=true"; echo "export BROKING_ENABLED=true"; echo "export BROKING_LLOYDS_BROKER_NO=0621"; } >> "$CLAUDE_ENV_FILE"
    fi
  fi
fi
echo "[session-start] done."
