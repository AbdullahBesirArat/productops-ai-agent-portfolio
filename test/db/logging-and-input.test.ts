import { authFixture, testKeys } from '../fixtures/auth-keys.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { format } from 'node:util';
import { buildApp } from '../../src/app.js';
import { loadDatabaseConfig } from '../../src/config.js';
import { createPool } from '../../src/db/pool.js';
import { SEED_TENANTS } from '../../src/db/seed-data.js';

// Deliberately fail collection instead of skipping an unconfigured security test.
const runtime = loadDatabaseConfig(process.env.PRODUCTOPS_TEST_DB_URL, 'productops_app');
assert.equal(runtime.database, 'productops_test');
assert.equal(runtime.host, '127.0.0.1');
assert.ok([54329, 54330].includes(runtime.port));
const password = process.env.PRODUCTOPS_DEMO_PASSWORD;
assert.ok(password, 'PRODUCTOPS_DEMO_PASSWORD is required');

test('real DB HTTP logs contain no secrets and hostile inputs return generic 400 or 401', async t => {
  const pool = createPool(runtime);
  const keys = testKeys();
  const auth = await authFixture(keys);
  const app = buildApp(auth.env, { pool });
  const tenant = SEED_TENANTS[0]!, owner = tenant.users[0]!;
  const captured: string[] = [], tokens: string[] = [];
  // Boot first so infrastructure warnings are outside the request logging assertion.
  await app.ready();
  const stdout = t.mock.method(process.stdout, 'write', (...args: unknown[]) => { captured.push(String(args[0])); return true; });
  const stderr = t.mock.method(process.stderr, 'write', (...args: unknown[]) => { captured.push(String(args[0])); return true; });
  const consoles = (['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table', 'assert', 'dirxml', 'count', 'countReset', 'group', 'groupCollapsed', 'groupEnd', 'time', 'timeLog', 'timeEnd', 'clear'] as const)
    .map(method => t.mock.method(console, method, (...args: unknown[]) => { captured.push(format(...args)); }));
  const body = { org_slug: tenant.slug, email: owner.email, password };
  const login = (payload: unknown) => app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  const generic = (response: { statusCode: number; json: () => unknown }) => {
    assert.ok([400, 401].includes(response.statusCode));
    assert.deepEqual(response.json(), { error: response.statusCode === 400 ? 'Invalid request' : 'Invalid credentials' });
  };
  try {
    const success = await login(body);
    assert.equal(success.statusCode, 200);
    const token = success.json().access_token as string;
    assert.equal(typeof token, 'string'); tokens.push(token);
    assert.equal((await app.inject({ url: '/auth/me', headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
    for (const payload of [null, 'non-object', [], { ...body, password: 123 }, { ...body, email: false }, { ...body, org_slug: {} },
      { ...body, password: 'x'.repeat(10 * 1024) }, { ...body, unexpected: 'private-input' },
      { ...body, org_slug: "tenant-a' OR 1=1--" }, { ...body, email: "x' OR 1=1--@example.test" },
      { ...body, email: 'üñîçødé@example.test' }, { ...body, email: 'owner\u0000@example.test' },
      { ...body, password: 'wrong-password' }, { ...body, email: 'absent@example.test' }]) generic(await login(payload));
    for (const authorization of ['Bearer ' + 'a'.repeat(100 * 1024), [`Bearer ${token}`, `Bearer ${token}`], `Basic ${token}`, `bearer ${token}`, 'Bearer invalid']) {
      const response = await app.inject({ url: '/auth/me', headers: { authorization } as unknown as Record<string, string> });
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: 'Unauthorized' });
    }
    const missing = await app.inject({ url: '/auth/me' });
    assert.equal(missing.statusCode, 401); assert.deepEqual(missing.json(), { error: 'Unauthorized' });
  } finally {
    await app.close(); await pool.end(); await auth.close();
    stdout.mock.restore(); stderr.mock.restore();
    for (const spy of consoles) spy.mock.restore();
  }
  const output = captured.join('\n');
  const forbidden = [password, keys.privatePem, runtime.password, ...tokens,
    ...Object.entries(process.env).filter(([name]) => /^PRODUCTOPS_.*(?:DB_URL|PASSWORD)$/u.test(name)).map(([, value]) => value!)];
  for (const value of forbidden) if (value) assert.equal(output.includes(value), false, 'Sensitive value appeared in request output');
});
