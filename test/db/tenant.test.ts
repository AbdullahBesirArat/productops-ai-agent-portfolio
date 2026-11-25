import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { loadDatabaseConfig } from '../../src/config.js';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withTenant } from '../../src/db/tenant.js';

// Fail at collection if configuration is absent; never silently skip DB security tests.
const appConfig = loadDatabaseConfig(process.env.PRODUCTOPS_TEST_DB_URL, 'productops_app');
const migratorConfig = loadDatabaseConfig(process.env.PRODUCTOPS_MIGRATOR_TEST_DB_URL, 'productops_migrator');
const bootstrapConfig = loadDatabaseConfig(process.env.PRODUCTOPS_BOOTSTRAP_TEST_DB_URL, 'productops_bootstrap');
for (const config of [appConfig, migratorConfig, bootstrapConfig]) {
  assert.equal(config.host, '127.0.0.1');
  assert.ok([54329, 54330].includes(config.port));
  assert.equal(config.database, 'productops_test');
}

test('tenant isolation, transaction lifecycle and database role boundaries', async () => {
  await runMigrations(migratorConfig);
  const migrationPool = createPool(migratorConfig);
  const fixtures = createPool(bootstrapConfig);
  const pool = createPool(appConfig);
  pool.options.max = 1;
  const a = randomUUID(), b = randomUUID(), user = randomUUID();
  const pa = randomUUID(), pb = randomUUID();
  const tables = ['organizations', 'memberships', 'projects', 'users'] as const;
  const empty = async () => {
    const context = await pool.query("SELECT current_setting('productops.org_id', true) AS org");
    assert.ok(context.rows[0].org === null || context.rows[0].org === '');
    for (const table of tables) assert.equal((await pool.query(`SELECT * FROM public.${table}`)).rowCount, 0);
  };
  try {
    const first = await migrationPool.query('SELECT * FROM public.schema_migrations ORDER BY version');
    await runMigrations(migratorConfig);
    assert.deepEqual((await migrationPool.query('SELECT * FROM public.schema_migrations ORDER BY version')).rows, first.rows);
    await empty();
    for (const [org, project, role] of [[a, pa, 'owner'], [b, pb, 'member']] as const) {
      await withTenant(fixtures, org, async (c) => {
        await c.query('INSERT INTO organizations(id,name,slug) VALUES ($1,$2,$2)', [org, `org-${org}`]);
        if (org === a) await c.query('INSERT INTO users(id,email) VALUES ($1,$2)', [user, `${user}@example.test`]);
        await c.query('INSERT INTO memberships(org_id,user_id,role) VALUES ($1,$2,$3)', [org, user, role]);
      });
      await withTenant(pool, org, c => c.query('INSERT INTO projects(id,org_id,name) VALUES ($1,$2,$3)', [project, org, 'project']));
    }
    await withTenant(pool, a, async (c) => {
      for (const table of ['organizations', 'memberships', 'projects']) {
        const column = table === 'organizations' ? 'id' : 'org_id';
        assert.equal((await c.query(`SELECT * FROM ${table} WHERE ${column}=$1`, [b])).rowCount, 0);
        if (table === 'projects') assert.equal((await c.query(`UPDATE ${table} SET ${column}=$1 WHERE ${column}=$1`, [b])).rowCount, 0);
        if (table === 'projects') assert.equal((await c.query(`DELETE FROM ${table} WHERE ${column}=$1`, [b])).rowCount, 0);
      }
      assert.deepEqual((await c.query('SELECT role FROM memberships WHERE user_id=$1', [user])).rows, [{ role: 'owner' }]);
      assert.equal((await c.query('SELECT * FROM users WHERE id=$1', [user])).rowCount, 1);
    });
    for (const table of ['organizations', 'users', 'memberships']) {
      const column = table === 'memberships' ? 'org_id' : 'id';
      for (const sql of [`INSERT INTO ${table} DEFAULT VALUES`, `UPDATE ${table} SET ${column}=${column}`, `DELETE FROM ${table}`]) {
        await assert.rejects(withTenant(pool, a, c => c.query(sql)), { code: '42501' });
      }
    }
    for (const operation of ['INSERT INTO projects(id,org_id,name) VALUES ($1,$2,\'project\')', 'UPDATE projects SET org_id=$2 WHERE id=$1']) {
      await assert.rejects(withTenant(pool, a, (c) => c.query(operation, [pa, b])), { code: '42501' });
    }
    for (const input of ['', 'x', "' OR '1'='1", "'; DROP TABLE projects; --", [], [a], null, undefined, 3, {}]) {
      let touched = false;
      const fake = { connect: () => { touched = true; throw new Error('Database touched'); } } as unknown as Pool;
      await assert.rejects(withTenant(fake, input, async () => {}), { message: 'Invalid tenant identifier' });
      assert.equal(touched, false);
    }
    await withTenant(pool, a, async () => {});
    await empty();
    await assert.rejects(withTenant(pool, a, async () => { throw new Error('synthetic rollback'); }));
    await empty();
    const roles = await pool.query("SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit FROM pg_roles WHERE rolname IN ('productops_app','productops_migrator')");
    assert.equal(roles.rowCount, 2);
    for (const role of roles.rows) {
      for (const field of ['rolsuper', 'rolbypassrls', 'rolcreatedb', 'rolcreaterole']) assert.equal(role[field], false);
      if (role.rolname === 'productops_app') assert.equal(role.rolinherit, false);
    }
    const security = await pool.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='public' AND c.relname=ANY($1::text[])", [tables]);
    assert.equal(security.rowCount, 4);
    for (const row of security.rows) {
      assert.equal(row.relrowsecurity, true);
      assert.equal(row.relforcerowsecurity, true);
      assert.equal(row.rolname, 'productops_migrator');
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname='productops_app') AND relkind IN ('r','p')")).rows[0].n, 0);
    for (const sql of [
      'CREATE TABLE public.forbidden_table(id int)',
      'ALTER TABLE projects DISABLE ROW LEVEL SECURITY', 'DROP TABLE projects', 'TRUNCATE projects',
      'SET ROLE productops_migrator', 'SET ROLE productops',
      "INSERT INTO schema_migrations(version,checksum) VALUES ('forbidden','forbidden')",
      "UPDATE schema_migrations SET checksum='forbidden'",
      'UPDATE users SET id=id', 'DELETE FROM users',
    ]) await assert.rejects(pool.query(sql), { code: '42501' });
    // Honest limitation: anyone controlling app SQL can select another tenant context.
    await withTenant(pool, a, async (c) => {
      await c.query("SELECT set_config('productops.org_id',$1,true)", [b]);
      assert.deepEqual((await c.query('SELECT id FROM organizations')).rows, [{ id: b }]);
      assert.deepEqual((await c.query('SELECT role FROM memberships WHERE user_id=$1', [user])).rows, [{ role: 'member' }]);
    });
    await empty();
  } finally {
    try {
      for (const org of [a, b]) await fixtures.query('DELETE FROM organizations WHERE id=$1', [org]);
      await fixtures.query('DELETE FROM users WHERE id=$1', [user]);
    } finally { await Promise.all([pool.end(), migrationPool.end(), fixtures.end()]); }
  }
});
