#!/bin/bash
# SessionStart hook: prepare the environment so the backend test suite and dev
# server work in Claude Code on the web. Installs npm deps, starts PostgreSQL,
# provisions the dev/test databases, persists connection env vars, and migrates.
# Idempotent and non-interactive.
set -euo pipefail

# Only run in the remote (web) environment; local machines manage their own setup.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

echo "[session-start] installing npm dependencies..."
npm install --no-audit --no-fund

# --- PostgreSQL ---
PGUSER_NAME=postgres
PGPASSWORD_VALUE=postgres
DEV_DB=broking_dev
TEST_DB=broking_test

echo "[session-start] starting PostgreSQL..."
service postgresql start >/dev/null 2>&1 || pg_ctlcluster "$(ls /etc/postgresql 2>/dev/null | head -1)" main start >/dev/null 2>&1 || true

# Wait for the server to accept connections (max ~15s).
for _ in $(seq 1 30); do
  if pg_isready -q 2>/dev/null; then break; fi
  sleep 0.5
done

echo "[session-start] provisioning databases..."
sudo -u "$PGUSER_NAME" psql -v ON_ERROR_STOP=1 -c "ALTER USER ${PGUSER_NAME} PASSWORD '${PGPASSWORD_VALUE}';" >/dev/null
for db in "$DEV_DB" "$TEST_DB"; do
  if ! sudo -u "$PGUSER_NAME" psql -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'" | grep -q 1; then
    sudo -u "$PGUSER_NAME" createdb "$db"
    echo "[session-start]   created ${db}"
  fi
done

DATABASE_URL="postgres://${PGUSER_NAME}:${PGPASSWORD_VALUE}@localhost:5432/${DEV_DB}"
TEST_DATABASE_URL="postgres://${PGUSER_NAME}:${PGPASSWORD_VALUE}@localhost:5432/${TEST_DB}"

# Persist for the session so tools inherit the connection strings.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export DATABASE_URL=\"${DATABASE_URL}\""
    echo "export TEST_DATABASE_URL=\"${TEST_DATABASE_URL}\""
  } >> "$CLAUDE_ENV_FILE"
fi

# backend/.env is gitignored; create it from the example on first run so the
# backend (which reads it via dotenv) is configured.
if [ ! -f backend/.env ] && [ -f backend/.env.example ]; then
  cp backend/.env.example backend/.env
  echo "[session-start]   wrote backend/.env"
fi

echo "[session-start] running migrations..."
DATABASE_URL="$DATABASE_URL" npm run migrate --silent

echo "[session-start] done."
