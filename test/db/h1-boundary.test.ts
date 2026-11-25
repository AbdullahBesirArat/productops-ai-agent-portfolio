import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEED_TENANTS } from '../../src/db/seed-data.js';
import { loadDatabaseConfig } from '../../src/config.js';
import { createPool } from '../../src/db/pool.js';
import { authFixture, serviceFixture, testKeys } from '../fixtures/auth-keys.js';

test('OS processes serve login through the API and fail closed when the auth service stops', async t => {
  const keys = testKeys();
  const auth = await authFixture(keys);
  t.after(() => auth.close());
  const apiEnv = { ...auth.env, PORT: '0', PRODUCTOPS_DB_URL: process.env.PRODUCTOPS_TEST_DB_URL };
  const api = await serviceFixture('server', apiEnv);
  t.after(() => api.close());
  assert.ok(api.pid && auth.pid && api.pid !== auth.pid && api.pid !== process.pid);
  await assert.rejects(serviceFixture('server', { ...apiEnv, PRODUCTOPS_JWT_PRIVATE_KEY: keys.privatePem }), /exited before readiness/u);
  await assert.rejects(serviceFixture('auth-server', { PRODUCTOPS_DB_URL: process.env.PRODUCTOPS_TEST_DB_URL }), /exited before readiness/u);

  const tenant = SEED_TENANTS[0]!;
  const user = tenant.users[0]!;
  const credentials = { org_slug: tenant.slug, email: user.email, password: process.env.PRODUCTOPS_DEMO_PASSWORD };
  const post = (origin: string, route: string, body: unknown) => fetch(origin + route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  for (const origin of [api.origin, auth.origin]) {
    assert.equal((await post(origin, '/auth/sign', { sub: user.id, org: tenant.id })).status, 404);
    const invalid = await post(origin, '/auth/login', { ...credentials, sub: user.id, org: tenant.id });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: 'Invalid request' });
  }
  const response = await post(api.origin, '/auth/login', credentials);
  assert.equal(response.status, 200);
  const { access_token: token } = await response.json() as { access_token: string };
  const me = () => fetch(api.origin + '/auth/me', { headers: { authorization: 'Bearer ' + token } });
  assert.equal((await me()).status, 200);
  await auth.close();
  const unavailable = await post(api.origin, '/auth/login', credentials);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'Authentication unavailable' });
  assert.equal((await me()).status, 200);
});

test('the runtime EXECUTE regression is detected and the test grant is rolled back', async () => {
  const migrator = createPool(loadDatabaseConfig(process.env.PRODUCTOPS_MIGRATOR_TEST_DB_URL, 'productops_migrator'));
  const client = await migrator.connect();
  try {
    const canExecute = async () => (await client.query<{ allowed: boolean }>(
      "SELECT has_function_privilege('productops_app','public.auth_login_lookup(text,text)','EXECUTE') AS allowed")).rows[0]?.allowed;
    assert.equal(await canExecute(), false);
    await client.query('BEGIN');
    try {
      await client.query('GRANT EXECUTE ON FUNCTION public.auth_login_lookup(text,text) TO productops_app');
      assert.equal(await canExecute(), true);
    } finally { await client.query('ROLLBACK'); }
    assert.equal(await canExecute(), false);
  } finally {
    client.release();
    await migrator.end();
  }
});
