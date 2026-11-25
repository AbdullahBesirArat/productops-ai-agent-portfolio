import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { loadDatabaseConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';

const migrator = loadDatabaseConfig(process.env.PRODUCTOPS_MIGRATOR_TEST_DB_URL, 'productops_migrator');
const bootstrap = loadDatabaseConfig(process.env.PRODUCTOPS_BOOTSTRAP_TEST_DB_URL, 'productops_bootstrap');
assert.equal(migrator.database, 'productops_test');
assert.equal(bootstrap.database, 'productops_test');
let pool: Pool;
before(async () => { await runMigrations(migrator); pool = createPool(bootstrap); });
after(async () => { await pool.end(); });

// Default privileges hand the runtime role DML on every NEW migrator table, so every table is audited here:
// a future migration that forgets ENABLE/FORCE RLS or a REVOKE fails this test.
const EXPECTED_RUNTIME_PRIVILEGES: Record<string, string[]> = {
  agent_runs: ['INSERT', 'SELECT'],
  draft_review_events: ['INSERT', 'SELECT'], draft_reviews: ['INSERT', 'SELECT'], draft_revisions: ['INSERT', 'SELECT'],
  memberships: ['SELECT'], orders: ['SELECT'], organizations: ['SELECT'], policy_snippets: ['SELECT'],
  products: ['SELECT'], projects: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], tool_audit_events: ['INSERT'], users: ['SELECT'],
};

test('every public table other than migration metadata has ENABLE and FORCE row level security', async () => {
  const rows = (await pool.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY 1`)).rows;
  assert.ok(rows.length >= 12);
  for (const row of rows) {
    if (row.relname === 'schema_migrations') continue;
    assert.equal(row.relrowsecurity, true, `${row.relname}: RLS not enabled`);
    assert.equal(row.relforcerowsecurity, true, `${row.relname}: RLS not forced`);
  }
});

test('draft runtime UPDATE grants and hardened database triggers match the review contract', async () => {
  const columns = (await pool.query(
    `SELECT c.relname, a.attname
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
       WHERE c.oid IN ('public.draft_reviews'::regclass, 'public.draft_revisions'::regclass, 'public.draft_review_events'::regclass)
         AND a.attnum > 0 AND NOT a.attisdropped
         AND has_column_privilege('productops_app', c.oid, a.attname, 'UPDATE') ORDER BY 1, 2`)).rows;
  assert.deepEqual(columns.map((row) => [row.relname, row.attname]),
    ['approved_revision', 'current_revision', 'decided_at', 'decided_by', 'decision_reason_code', 'state', 'updated_at', 'version']
      .map((column) => ['draft_reviews', column]));

  const triggers = (await pool.query(
    `SELECT t.tgname, t.tgtype, t.tgenabled, p.prosecdef, p.proconfig
       FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
       WHERE t.tgrelid IN ('public.draft_reviews'::regclass, 'public.draft_revisions'::regclass)
         AND NOT t.tgisinternal ORDER BY 1`)).rows;
  assert.deepEqual(triggers, [
    { tgname: 'draft_review_transition', tgtype: 19, tgenabled: 'O', prosecdef: false, proconfig: ['search_path=pg_catalog, pg_temp'] },
    { tgname: 'draft_revision_insert', tgtype: 7, tgenabled: 'O', prosecdef: false, proconfig: ['search_path=pg_catalog, pg_temp'] },
  ]);
});

test('the runtime role holds exactly the expected privileges on public tables; PUBLIC holds none', async () => {
  const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  const tables = (await pool.query(
    "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY 1")).rows.map((row) => row.relname as string);
  const actual: Record<string, string[]> = {};
  for (const table of tables) {
    for (const privilege of privileges) {
      const held = (await pool.query(
        'SELECT has_table_privilege($1, $2, $3) AS app, has_table_privilege($4, $2, $3) AS pub',
        ['productops_app', `public.${table}`, privilege, 'public'])).rows[0];
      assert.equal(held.pub, false, `PUBLIC must hold no ${privilege} on ${table}`);
      if (held.app) (actual[table] ??= []).push(privilege);
    }
  }
  for (const list of Object.values(actual)) list.sort();
  assert.deepEqual(actual, EXPECTED_RUNTIME_PRIVILEGES);
  const credentials = (await pool.query(
    "SELECT has_any_column_privilege('productops_app', 'public.user_credentials', 'SELECT') AS s, has_any_column_privilege('productops_app', 'public.user_credentials', 'INSERT') AS i")).rows[0];
  assert.deepEqual(credentials, { s: false, i: false }, 'runtime must have no privilege on credential columns');
  // agent_runs: UPDATE is granted per column (outcome columns only), never table-wide.
  const columns = (await pool.query(
    `SELECT a.attname, has_column_privilege('productops_app', 'public.agent_runs', a.attname, 'UPDATE') AS can_update
       FROM pg_attribute a WHERE a.attrelid='public.agent_runs'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1`)).rows;
  assert.deepEqual(columns.filter((column) => column.can_update).map((column) => column.attname), ['duration_ms', 'error_code', 'response', 'status', 'tool_calls']);
});

test('runtime run and audit policies enforce actor context', async () => {
  const fn = (await pool.query("SELECT to_regprocedure('public.app_current_actor()') IS NOT NULL AS present")).rows[0];
  assert.equal(fn.present, true);
  const rows = (await pool.query(
    `SELECT tablename, cmd, qual, with_check FROM pg_policies
      WHERE schemaname='public' AND tablename IN ('agent_runs', 'tool_audit_events')
        AND 'productops_app'=ANY(roles) ORDER BY tablename, cmd`)).rows;
  assert.deepEqual(rows.map((row) => [row.tablename, row.cmd]), [
    ['agent_runs', 'INSERT'], ['agent_runs', 'SELECT'], ['agent_runs', 'UPDATE'], ['tool_audit_events', 'INSERT'],
  ]);
  for (const row of rows) {
    if (row.cmd !== 'INSERT') assert.match(row.qual, /actor_id = (?:public\.)?app_current_actor\(\)/u);
    if (row.cmd !== 'SELECT') assert.match(row.with_check, /actor_id = (?:public\.)?app_current_actor\(\)/u);
  }
});

test('auth_login_lookup is a hardened SECURITY DEFINER function with effective EXECUTE for auth service and inherited EXECUTE for migrator', async () => {
  const fn = (await pool.query(
    `SELECT proname, pg_get_userbyid(proowner) AS owner, prosecdef, proconfig,
            has_function_privilege('public',oid,'EXECUTE') AS public_exec,
            has_function_privilege('productops_app',oid,'EXECUTE') AS app_exec,
            has_function_privilege('productops_bootstrap',oid,'EXECUTE') AS bootstrap_exec,
            has_function_privilege('productops_migrator',oid,'EXECUTE') AS migrator_exec,
            has_function_privilege('productops_authsvc',oid,'EXECUTE') AS auth_exec
       FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('auth_login_lookup','auth_membership_exists')`)).rows;
  assert.equal(fn.length, 2);
  for (const entry of fn) {
    assert.equal(entry.owner, 'productops_auth');
    assert.equal(entry.prosecdef, true);
    assert.deepEqual(entry.proconfig, ['search_path=pg_catalog, pg_temp']);
    assert.deepEqual([entry.public_exec, entry.app_exec, entry.bootstrap_exec], [false, false, false]);
    assert.equal(entry.migrator_exec, true);
    assert.equal(entry.auth_exec, true);
  }
  const roles = (await pool.query(
    "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('productops_app','productops_auth','productops_authsvc','productops_bootstrap','productops_migrator')")).rows;
  assert.equal(roles.length, 5);
  for (const role of roles) assert.deepEqual([role.rolsuper, role.rolbypassrls], [false, false], role.rolname);
});
