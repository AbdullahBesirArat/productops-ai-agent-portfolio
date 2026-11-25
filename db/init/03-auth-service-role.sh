#!/usr/bin/env bash
set -euo pipefail
: "${PRODUCTOPS_AUTH_PASSWORD:?required}"
psql -v ON_ERROR_STOP=1 --username productops --dbname productops_dev \
  -v auth_pw="$PRODUCTOPS_AUTH_PASSWORD" <<'SQL'
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='productops_authsvc') THEN
  CREATE ROLE productops_authsvc LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
 END IF;
END $$;
ALTER ROLE productops_authsvc PASSWORD :'auth_pw';
GRANT CONNECT ON DATABASE productops_dev,productops_test TO productops_authsvc;
SQL
for database in productops_dev productops_test; do
 psql -v ON_ERROR_STOP=1 --username productops --dbname "$database" <<'SQL'
GRANT USAGE ON SCHEMA public TO productops_authsvc;
SQL
done
