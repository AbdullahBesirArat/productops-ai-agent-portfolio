#!/usr/bin/env bash
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username productops --dbname productops_dev \
  -v bs_pw="$PRODUCTOPS_BOOTSTRAP_PASSWORD" <<'SQL'
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='productops_bootstrap') THEN
  CREATE ROLE productops_bootstrap LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
 END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='productops_auth') THEN
  CREATE ROLE productops_auth NOLOGIN NOBYPASSRLS;
 END IF;
END $$;
ALTER ROLE productops_bootstrap PASSWORD :'bs_pw';
GRANT CONNECT ON DATABASE productops_dev,productops_test TO productops_bootstrap;
GRANT productops_auth TO productops_migrator;
SQL
for database in productops_dev productops_test; do
 psql -v ON_ERROR_STOP=1 --username productops --dbname "$database" <<'SQL'
GRANT USAGE ON SCHEMA public TO productops_bootstrap,productops_auth;
-- Required for migrator ALTER FUNCTION OWNER TO productops_auth.
GRANT CREATE ON SCHEMA public TO productops_auth;
SQL
done
