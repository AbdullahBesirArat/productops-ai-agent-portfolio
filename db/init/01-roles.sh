#!/usr/bin/env bash
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname productops_dev \
  -v mig_pw="$PRODUCTOPS_MIGRATOR_PASSWORD" -v app_pw="$PRODUCTOPS_APP_PASSWORD" <<'SQL'
CREATE DATABASE productops_test;
CREATE ROLE productops_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'mig_pw';
CREATE ROLE productops_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT PASSWORD :'app_pw';
REVOKE ALL ON DATABASE productops_dev, productops_test FROM PUBLIC;
GRANT CONNECT ON DATABASE productops_dev, productops_test TO productops_migrator, productops_app;
SQL
for database in productops_dev productops_test; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$database" <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO productops_migrator;
GRANT USAGE ON SCHEMA public TO productops_app;
ALTER DEFAULT PRIVILEGES FOR ROLE productops_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO productops_app;
SQL
done
