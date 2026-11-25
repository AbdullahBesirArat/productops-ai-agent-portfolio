import { authFixture, testKeys } from '../fixtures/auth-keys.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignJWT, decodeJwt } from 'jose';
import { buildApp } from '../../src/app.js';
import { loadDatabaseConfig } from '../../src/config.js';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runSeed } from '../../src/db/seed.js';
import { SEED_TENANTS } from '../../src/db/seed-data.js';
import { issueAccessToken } from '../../src/auth/signing.js';
import { LoginLimiter } from '../../src/auth/rate-limit.js';
import type { Pool } from 'pg';
const runtime = loadDatabaseConfig(process.env.PRODUCTOPS_TEST_DB_URL, 'productops_app');
const migrator = loadDatabaseConfig(process.env.PRODUCTOPS_MIGRATOR_TEST_DB_URL, 'productops_migrator');
const bootstrap = loadDatabaseConfig(process.env.PRODUCTOPS_BOOTSTRAP_TEST_DB_URL, 'productops_bootstrap');
const keys = testKeys();
const secret = keys.signing;
const password = process.env.PRODUCTOPS_DEMO_PASSWORD;
assert.ok(password, 'PRODUCTOPS_DEMO_PASSWORD is required');
for (const config of [runtime, migrator, bootstrap]) assert.equal(config.database, 'productops_test');
test('real DB auth HTTP, tenant boundaries and immediate membership changes', async () => {
  await runMigrations(migrator); await runSeed(bootstrap, password);
  const pool = createPool(runtime), admin = createPool(bootstrap);
  const auth = await authFixture(keys);
  const app = buildApp(auth.env, { pool });
  const a = SEED_TENANTS[0]!, b = SEED_TENANTS[1]!, owner = a.users[0]!, viewer = a.users[2]!;
  const tokens = new Map<string, string>();
  const me = (token?: string, extras: Record<string, string> = {}) => app.inject({ method: 'GET', url: '/auth/me?org=' + b.id,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extras } });
  const login = (slug: string, email: string, candidate = password) => app.inject({ method: 'POST', url: '/auth/login', payload: { org_slug: slug, email, password: candidate } });
  try {
    for (const tenant of SEED_TENANTS) for (const user of tenant.users) {
      const response = await login(tenant.slug, user.email); assert.equal(response.statusCode, 200);
      const token = response.json().access_token as string; tokens.set(user.id, token);
      assert.equal(decodeJwt(token).role, undefined);
      const profile = await me(token, { 'x-org-id': tenant === a ? b.id : a.id });
      assert.equal(profile.statusCode, 200);
      assert.deepEqual({ ...profile.json<Record<string, unknown>>(), permissions: undefined }, { user_id: user.id, org_id: tenant.id, org_name: tenant.name, role: user.role, permissions: undefined });
      assert.equal(profile.headers['cache-control'], 'no-store'); assert.equal(profile.headers['x-content-type-options'], 'nosniff');
      for (const sensitive of [password!, token, keys.privatePem]) assert.ok(!profile.body.includes(sensitive));
    }
    for (const [slug, email, candidate] of [[a.slug, owner.email, 'wrong'], [a.slug, 'unknown@example.test', password], ['unknown', owner.email, password], [a.slug, b.users[0]!.email, password]]) {
      const response = await login(slug!, email!, candidate); assert.equal(response.statusCode, 401); assert.deepEqual(response.json(), { error: 'Invalid credentials' });
    }
    const ownerToken = tokens.get(owner.id)!;
    const bodyOverride = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${ownerToken}`, 'x-org-id': b.id }, payload: { org: b.id, org_id: b.id } });
    assert.equal(bodyOverride.statusCode, 200); assert.equal(bodyOverride.json().org_id, a.id);
    const payload = decodeJwt(ownerToken);
    const forged = await new SignJWT({ ...decodeJwt(tokens.get(viewer.id)!), role: 'owner' }).setProtectedHeader({ alg: 'EdDSA', kid: secret.kid }).sign(secret.key);
    assert.equal((await me(forged)).json().role, 'viewer');
    const edited = ownerToken.split('.'); edited[1] = Buffer.from(JSON.stringify({ ...payload, org: b.id })).toString('base64url');
    for (const token of [undefined, 'garbage', ownerToken.slice(0, -4) + 'aaaa', edited.join('.'),
      await issueAccessToken({ sub: owner.id, org: a.id }, secret, -60),
      await issueAccessToken({ sub: owner.id, org: a.id }, testKeys().signing)]) {
      const response = await me(token); assert.equal(response.statusCode, 401); assert.deepEqual(response.json(), { error: 'Unauthorized' }); assert.equal(response.headers['www-authenticate'], 'Bearer');
    }
    assert.equal((await me(await issueAccessToken({ sub: owner.id, org: b.id }, secret))).statusCode, 403);
    const lock = await admin.connect();
    try {
      await lock.query('SELECT pg_advisory_lock(78423102)');
      try {
        await lock.query('DELETE FROM memberships WHERE org_id=$1 AND user_id=$2', [a.id, viewer.id]);
        assert.equal((await me(tokens.get(viewer.id))).statusCode, 403);
        assert.equal((await login(a.slug, viewer.email)).statusCode, 401);
      } finally { await lock.query('INSERT INTO memberships(org_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT (org_id,user_id) DO UPDATE SET role=EXCLUDED.role', [a.id, viewer.id, 'viewer']); }
      try {
        await lock.query("UPDATE memberships SET role='viewer' WHERE org_id=$1 AND user_id=$2", [a.id, owner.id]);
        const response = await me(ownerToken); assert.equal(response.json().role, 'viewer'); assert.equal(response.json().permissions.length, 3);
      } finally { await lock.query("UPDATE memberships SET role='owner' WHERE org_id=$1 AND user_id=$2", [a.id, owner.id]); }
    } finally { await lock.query('SELECT pg_advisory_unlock(78423102)'); lock.release(); }
    const limited = buildApp(auth.env, { pool, limiter: new LoginLimiter(Date.now, 100, 1) });
    try {
      const options = { method: 'POST' as const, url: '/auth/login', payload: { org_slug: a.slug, email: owner.email, password: 'wrong' } };
      assert.equal((await limited.inject(options)).statusCode, 401);
      const response = await limited.inject(options); assert.equal(response.statusCode, 429); assert.ok(response.headers['retry-after']);
    } finally { await limited.close(); }
    // Delegate to a real runtime connection, then fail after the tenant context is set.
    let released = false;
    const statements: string[] = [];
    const failingPool = { connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          statements.push(sql);
          if (sql.startsWith('SELECT role')) throw new Error('Synthetic private database failure');
          return client.query(sql, values);
        },
        release: (discard: boolean) => { released = true; client.release(discard); },
      };
    } } as unknown as Pool;
    const failingApp = buildApp(auth.env, { pool: failingPool });
    try {
      const failure = await failingApp.inject({ url: '/auth/me', headers: { authorization: `Bearer ${ownerToken}` } });
      assert.equal(failure.statusCode, 500); assert.deepEqual(failure.json(), { error: 'Internal server error' });
      assert.ok(statements.includes('ROLLBACK')); assert.ok(released); assert.ok(pool.idleCount > 0);
    } finally { await failingApp.close(); }
    assert.equal(pool.waitingCount, 0);
  } finally { await app.close(); await Promise.all([pool.end(), admin.end(), auth.close()]); }
});
