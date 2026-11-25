import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { loadDatabaseConfig } from '../../src/config.js';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runBootstrap } from '../../src/db/bootstrap.js';
import { runSeed } from '../../src/db/seed.js';
import { SEED_TABLES, SEED_TENANTS, SHARED_SKU, SHARED_ORDER_CODE } from '../../src/db/seed-data.js';
import { withTenant } from '../../src/db/tenant.js';
const bs = loadDatabaseConfig(process.env.PRODUCTOPS_BOOTSTRAP_TEST_DB_URL, 'productops_bootstrap');
const mig = loadDatabaseConfig(process.env.PRODUCTOPS_MIGRATOR_TEST_DB_URL, 'productops_migrator');
const app = loadDatabaseConfig(process.env.PRODUCTOPS_TEST_DB_URL, 'productops_app');
for (const c of [bs, mig, app]) {
  assert.equal(c.database, 'productops_test');
  assert.equal(c.host, '127.0.0.1');
}
const password = process.env.PRODUCTOPS_DEMO_PASSWORD;
assert.ok(password, 'PRODUCTOPS_DEMO_PASSWORD is required');
const fixtures = createPool(bs), pool = createPool(app);
before(async () => {
  await runMigrations(mig);
  await runMigrations(mig);
  await runBootstrap(bs, password);
  await runBootstrap(bs, password);
  assert.equal((await fixtures.query("SELECT count(*)::int n FROM organizations WHERE slug='tenant-a'")).rows[0].n, 1);
  assert.equal((await fixtures.query("SELECT count(*)::int n FROM memberships m JOIN organizations o ON o.id=m.org_id WHERE o.slug='tenant-a' AND m.role='owner'")).rows[0].n, 1);
  await runSeed(bs, password);
});
after(async () => { await Promise.all([fixtures.end(), pool.end()]); });
test('seed is idempotent for every table and supplies all three roles', async () => {
  const snapshot = async () => {
    const counts: Record<string, number> = {};
    for (const t of SEED_TABLES) counts[t] = (await fixtures.query(`SELECT count(*)::int n FROM public.${t}`)).rows[0].n;
    return counts;
  };
  const first = await snapshot();
  await runSeed(bs, password);
  assert.deepEqual(await snapshot(), first);
  for (const t of SEED_TENANTS) {
    assert.deepEqual((await fixtures.query('SELECT role FROM memberships WHERE org_id=$1 ORDER BY role', [t.id])).rows.map(x => x.role), ['member', 'owner', 'viewer']);
  }
});
test('app sees distinct tenant data and nothing without context', async () => {
  for (const table of SEED_TABLES.filter(t => t !== 'user_credentials')) assert.equal((await pool.query(`SELECT * FROM public.${table}`)).rowCount, 0);
  await assert.rejects(pool.query('SELECT * FROM public.user_credentials'), { code: '42501' });
  const results = [];
  for (const t of SEED_TENANTS) results.push(await withTenant(pool, t.id, async c => ({
    product: (await c.query('SELECT name,stock FROM products WHERE sku=$1', [SHARED_SKU])).rows,
    order: (await c.query('SELECT status FROM orders WHERE order_code=$1', [SHARED_ORDER_CODE])).rows,
  })));
  assert.notDeepEqual(results[0]?.product, results[1]?.product);
  assert.notDeepEqual(results[0]?.order, results[1]?.order);
});
test('runtime cannot assume privileged roles or write memberships', async () => {
  const role = (await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND relkind IN ('r','p')")).rows[0].n, 0);
  for (const name of ['productops_bootstrap', 'productops_auth', 'productops_migrator', 'productops_authsvc']) await assert.rejects(pool.query(`SET ROLE ${name}`), { code: '42501' });
  for (const sql of ['INSERT INTO memberships DEFAULT VALUES', 'UPDATE memberships SET role=role', 'DELETE FROM memberships']) await assert.rejects(pool.query(sql), { code: '42501' });
  const functions = await pool.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE')`);
  assert.deepEqual(functions.rows, []);
  for (const statement of ['SELECT * FROM public.auth_login_lookup(NULL,NULL)', 'SELECT public.auth_membership_exists(NULL,NULL)', 'SELECT password_hash FROM public.user_credentials']) {
    await assert.rejects(pool.query(statement), { code: '42501' });
  }
});
test('login lookup validates the exact tenant membership and exposes minimal output', async t => {
  const auth = createPool(loadDatabaseConfig(process.env.PRODUCTOPS_AUTH_TEST_DB_URL, 'productops_authsvc'));
  t.after(() => auth.end());
  const grants = await auth.query(`SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace
    AND relkind IN ('r','p') AND has_table_privilege(current_user,oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`);
  assert.deepEqual(grants.rows, []);
  const allowed = await auth.query(`SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND has_function_privilege(current_user,oid,'EXECUTE') ORDER BY proname`);
  assert.deepEqual(allowed.rows.map(row => row.proname), ['auth_login_lookup', 'auth_membership_exists']);
  const roles = await auth.query(`SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
    (SELECT count(*)::int FROM pg_auth_members WHERE member=pg_roles.oid) AS memberships
    FROM pg_roles WHERE rolname=current_user`);
  assert.deepEqual(roles.rows, [{ rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, memberships: 0 }]);
  for (const sql of ['SELECT * FROM public.memberships', 'SELECT * FROM public.user_credentials', 'UPDATE public.orders SET status=status', 'CREATE TABLE public.auth_boundary_probe (id int)']) {
    await assert.rejects(auth.query(sql), { code: '42501' });
  }
  const a = SEED_TENANTS[0]!, b = SEED_TENANTS[1]!;
  const lookup = (slug: string, email: string) => auth.query('SELECT * FROM public.auth_login_lookup($1,$2)', [slug, email]);
  for (const t of [a, b]) {
    const result = await lookup(t.slug, t.users[0]!.email);
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].org_id, t.id);
    assert.equal(result.rows[0].user_id, t.users[0]!.id);
    assert.equal(result.rows[0].role, 'owner');
    assert.match(result.rows[0].password_hash, /^scrypt\$/u);
    assert.deepEqual(Object.keys(result.rows[0]).sort(), ['org_id', 'password_hash', 'role', 'user_id']);
  }
  for (const [slug, email] of [[a.slug, b.users[0]!.email], [a.slug, 'unknown@example.test'], ['absent', a.users[0]!.email], [a.slug, a.users[0]!.email.toUpperCase()]] as const) assert.equal((await lookup(slug, email)).rowCount, 0);
});
test('login function has a restricted definer and no PUBLIC execute', async () => {
  const row = (await pool.query(`SELECT p.prosecdef,p.proconfig,r.rolname,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.auth_login_lookup(text,text)'::regprocedure`)).rows[0];
  assert.equal(row.prosecdef, true);
  assert.equal(row.rolname, 'productops_auth');
  assert.ok(row.proconfig.includes('search_path=pg_catalog, pg_temp'));
  assert.equal(row.public_execute, false);
});

test('seed products are confined to their exact tenant', async () => {
  for (const tenant of SEED_TENANTS) {
    await withTenant(pool, tenant.id, async client => {
      const rows = await client.query('SELECT id,org_id FROM products');
      assert.equal(rows.rowCount, tenant.products.length);
      for (const row of rows.rows) assert.equal(row.org_id, tenant.id);
      assert.deepEqual(rows.rows.map(row => row.id).sort(), tenant.products.map(product => product.id).sort());
    });
  }
});
