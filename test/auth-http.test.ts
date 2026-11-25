import { authFixture, testKeys } from './fixtures/auth-keys.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { issueAccessToken } from '../src/auth/signing.js';
const keys = testKeys();
const env = keys.env;
test('auth parsing is generic and DB failures rollback and release clients', async () => {
  for (const mode of ['connect', 'query', 'login'] as const) {
    const queries: string[] = []; let released = false;
    const pool = { connect: async () => {
      if (mode === 'connect') throw new Error('sensitive connection error');
      return { query: async (sql: string) => { queries.push(sql); if (sql.startsWith('SELECT role')) throw new Error('sensitive query error'); return { rows: [] }; }, release: () => { released = true; } };
    }, query: async () => { throw new Error('sensitive lookup error'); } } as unknown as Pool;
    const auth = await authFixture(keys, pool);
    const app = buildApp(auth.env, { pool });
    try {
      const token = await issueAccessToken({ sub: '00000001-0000-4000-8000-000000000100', org: '00000001-0000-4000-8000-000000000001' }, keys.signing);
      const response = mode === 'login' ? await app.inject({ method: 'POST', url: '/auth/login', payload: { org_slug: 'tenant-a', email: 'owner@example.test', password: 'synthetic' } }) : await app.inject({ url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.statusCode, 500); assert.deepEqual(response.json(), { error: 'Internal server error' });
      if (mode === 'query') { assert.ok(queries.includes('ROLLBACK')); assert.ok(released); }
      for (const payload of [[], { org_slug: 'tenant-a', email: 'a@b', password: 'secret', extra: 'echo' }, { org_slug: 123, email: 'a@b', password: 'secret' }]) {
        const bad = await app.inject({ method: 'POST', url: '/auth/login', payload });
        assert.equal(bad.statusCode, 400); assert.deepEqual(bad.json(), { error: 'Invalid request' });
      }
      for (const authorization of [`bearer ${token}`, `Bearer  ${token}`, `Bearer ${token} `, `Bearer ${token}, Bearer ${token}`]) {
        const bad = await app.inject({ url: '/auth/me', headers: { authorization } });
        assert.equal(bad.statusCode, 401); assert.deepEqual(bad.json(), { error: 'Unauthorized' });
      }
      for (const payload of ['{"password":', JSON.stringify({ password: 'x'.repeat(2100) })]) {
        const bad = await app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload });
        assert.equal(bad.statusCode, 400); assert.deepEqual(bad.json(), { error: 'Invalid request' });
        assert.equal(bad.headers['cache-control'], 'no-store');
      }
    } finally { await app.close(); await auth.close(); }
  }
});

test('wrong issuer audience and algorithm return HTTP 401', async () => {
  const { SignJWT } = await import('jose');
  const app = buildApp(env, { pool: {} as Pool });
  const base = { sub: '00000001-0000-4000-8000-000000000100', org: '00000001-0000-4000-8000-000000000001',
    iss: 'productops-local', aud: 'productops-api', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 };
  try {
    for (const [claims, alg] of [[{ ...base, iss: 'wrong' }, 'EdDSA'], [{ ...base, aud: 'wrong' }, 'EdDSA'], [base, 'HS256']] as const) {
      const token = await new SignJWT(claims).setProtectedHeader({ alg, kid: keys.signing.kid }).sign(alg === 'EdDSA' ? keys.signing.key : Buffer.from(keys.pem));
      const response = await app.inject({ url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.statusCode, 401); assert.deepEqual(response.json(), { error: 'Unauthorized' });
    }
  } finally { await app.close(); }
});

test('null byte email is rejected before a database query', async () => {
  let queried = false;
  const pool = { query: async () => { queried = true; throw new Error('Must not query'); } } as unknown as Pool;
  const auth = await authFixture(keys, pool);
  const app = buildApp(auth.env, { pool });
  try {
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: {
      org_slug: 'tenant-a', email: 'owner\u0000@example.test', password: 'synthetic',
    } });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'Invalid credentials' });
    assert.equal(queried, false);
  } finally { await app.close(); await auth.close(); }
});
