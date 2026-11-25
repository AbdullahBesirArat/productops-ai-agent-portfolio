import { testKeys } from './fixtures/auth-keys.js';
import { issueAccessToken } from '../src/auth/signing.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeJwt, generateKeyPair, SignJWT } from 'jose';
import { AuthError, loadVerificationKeys, verifyAccessToken } from '../src/auth/jwt.js';
import { can, isRole, PERMISSION_MATRIX } from '../src/auth/permissions.js';
const keys = testKeys();
const secret = keys.signing;
const identity = { sub: '00000001-0000-4000-8000-000000000100', org: '00000001-0000-4000-8000-000000000001' };
test('JWT round trip and hostile tokens produce only generic errors', async () => {
  const token = await issueAccessToken(identity, secret);
  assert.deepEqual(await verifyAccessToken(token, keys.keys), identity);
  assert.equal(decodeJwt(token).role, undefined);
  assert.equal(decodeJwt(token).exp! - decodeJwt(token).iat!, 900);
  const base = { ...identity, iss: 'productops-local', aud: 'productops-api', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 };
  const signed = (payload: Record<string, unknown>, alg = 'EdDSA', kid = secret.kid) => new SignJWT(payload).setProtectedHeader({ alg, kid }).sign(alg === 'EdDSA' ? secret.key : Buffer.from(keys.pem));
  const rsa = await generateKeyPair('RS256');
  const bad = ['garbage', 'a'.repeat(4097), `${token.split('.')[0]}.${Buffer.from(JSON.stringify({ ...base, org: identity.sub })).toString('base64url')}.${token.split('.')[2]}`,
    `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(base)).toString('base64url')}.`,
    await issueAccessToken(identity, testKeys().signing), await issueAccessToken(identity, secret, -60),
    await signed(base, 'HS256'), await signed(base, 'HS512'), await signed(base, 'EdDSA', 'retired'), await new SignJWT(base).setProtectedHeader({ alg: 'RS256' }).sign(rsa.privateKey), await signed({ ...base, iss: 'wrong' }), await signed({ ...base, aud: 'wrong' }),
    await signed({ ...base, sub: 'invalid' }), await signed({ ...base, org: [] }), await signed({ ...base, iat: 'invalid' })];
  for (const claim of ['sub', 'org', 'exp', 'iat']) {
    const payload: Record<string, unknown> = { ...base }; delete payload[claim]; bad.push(await signed(payload));
  }
  for (const candidate of bad) await assert.rejects(verifyAccessToken(candidate, keys.keys), error => {
    assert.ok(error instanceof AuthError); assert.equal(error.message, 'Unauthorized');
    assert.ok(!error.message.includes(candidate)); return true;
  });
});
test('permission matrix is exact, frozen and rejects unknown strings', () => {
  const permissions = ['catalog:read', 'order_status:read', 'policy:read', 'message:classify', 'draft:create', 'draft:decide', 'audit:read'];
  for (const role of ['owner', 'member', 'viewer'] as const) {
    assert.ok(isRole(role)); assert.ok(Object.isFrozen(PERMISSION_MATRIX[role]));
    for (const [index, permission] of permissions.entries()) assert.equal(can(role, permission), index < 3 || (index < 6 && role !== 'viewer') || role === 'owner');
  }
  assert.ok(Object.isFrozen(PERMISSION_MATRIX));
  assert.equal(can('unknown', 'catalog:read'), false); assert.equal(can('owner', 'unknown'), false);
  assert.equal(can('__proto__', 'catalog:read'), false); assert.equal(isRole(null), false);
});

test('key rotation trusts only configured public keys and cannot sign with them', async () => {
  const next = testKeys('next');
  const entry = (fixture: typeof keys) => ({ kid: fixture.signing.kid, pem: fixture.pem });
  const overlap = loadVerificationKeys(JSON.stringify([entry(keys), entry(next)]));
  const oldToken = await issueAccessToken(identity, keys.signing);
  const newToken = await issueAccessToken(identity, next.signing);
  assert.deepEqual(await verifyAccessToken(oldToken, overlap), identity);
  assert.deepEqual(await verifyAccessToken(newToken, overlap), identity);
  await assert.rejects(verifyAccessToken(oldToken, next.keys), AuthError);
  await assert.rejects(issueAccessToken(identity, { kid: next.signing.kid, key: next.keys.get(next.signing.kid)! }), AuthError);
  for (const bad of [[entry(keys), entry(keys)], [{ kid: keys.signing.kid, pem: keys.privatePem }], [{ kid: keys.signing.kid, pem: keys.pem + keys.privatePem }]]) {
    assert.throws(() => loadVerificationKeys(JSON.stringify(bad)), { message: 'Invalid JWT verification keys' });
  }
});
