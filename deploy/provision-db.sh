#!/usr/bin/env bash
# deploy/provision-db.sh — create the PostgreSQL role and database for AABI broking.
#
#   deploy/provision-db.sh                      # afro_broker / afro_broker role, prompts for a password
#   DB_NAME=afro_broker DB_USER=afro_broker DB_PASSWORD=… ADMIN_URL=postgresql://postgres@localhost/postgres deploy/provision-db.sh
#
# Idempotent: an existing role or database is left as it is. Extensions
# (pgcrypto) are created by migration 001, so the app role only needs to own
# the database.
set -euo pipefail
DB_NAME="${DB_NAME:-afro_broker}"
DB_USER="${DB_USER:-afro_broker}"
ADMIN_URL="${ADMIN_URL:-postgresql://postgres@localhost:5432/postgres}"
if [ -z "${DB_PASSWORD:-}" ]; then read -r -s -p "Password for role ${DB_USER}: " DB_PASSWORD; echo; fi
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 \
  || psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE ROLE \"${DB_USER}\" LOGIN PASSWORD '${DB_PASSWORD//\'/\'\'}'"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${DB_NAME}\" OWNER \"${DB_USER}\""
# pgcrypto (gen_random_uuid) needs a superuser or the database owner on PG13+; grant CREATE so migration 001 can add it.
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "GRANT ALL PRIVILEGES ON DATABASE \"${DB_NAME}\" TO \"${DB_USER}\"" >/dev/null
echo "✓ role ${DB_USER} and database ${DB_NAME} ready"
echo "  DATABASE_URL=postgresql://${DB_USER}:<password>@localhost:5432/${DB_NAME}"
