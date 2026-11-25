import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { LoginLimiter, loginKey, RateLimitError } from '../src/auth/rate-limit.js';
test('scrypt verifies, uses unique salts and rejects malformed storage', async () => {
  const a = await hashPassword('synthetic password'), b = await hashPassword('synthetic password');
  assert.notEqual(a, b); assert.ok(await verifyPassword(a, 'synthetic password'));
  assert.equal(await verifyPassword(a, 'wrong'), false);
  for (const stored of ['', 'broken', a + '$extra']) assert.equal(await verifyPassword(stored, 'synthetic password'), false);
});
test('limiter hashes identities, enforces both budgets, resets and evicts', () => {
  let now = 0;
  const limiter = new LoginLimiter(() => now, 100);
  assert.match(loginKey('127.0.0.1', 'tenant-a', 'owner@example.test'), /^127\.0\.0\.1\|[a-f0-9]{64}$/u);
  for (let i = 0; i < 10; i++) limiter.consume('ip', 'slug', 'email');
  assert.throws(() => limiter.consume('ip', 'slug', 'email'), RateLimitError);
  now = 60000; limiter.consume('ip', 'slug', 'email');
  const ipLimiter = new LoginLimiter(() => now);
  for (let i = 0; i < 30; i++) ipLimiter.consume('ip', 'slug', String(i));
  assert.throws(() => ipLimiter.consume('ip', 'slug', 'new'), RateLimitError);
  const bounded = new LoginLimiter(() => now, 4);
  for (let i = 0; i < 20; i++) bounded.consume(String(i), 'slug', 'email');
  assert.equal(bounded.size, 4);
});

test('account-key churn leaves denied IP buckets intact until the window expires', () => {
  let now = 0;
  const limiter = new LoginLimiter(() => now, 4, 2, 6, 1000);
  limiter.consume('blocked', 'slug', 'first');
  limiter.consume('blocked', 'slug', 'first');
  assert.throws(() => limiter.consume('blocked', 'slug', 'first'), RateLimitError);
  for (let index = 0; index < 3; index++) limiter.consume('blocked', 'slug', String(index));
  for (let index = 0; index < 6; index++) limiter.consume('other', 'slug', `other-${index}`);
  assert.equal(limiter.size, 4);
  for (let index = 0; index < 40; index++) {
    assert.throws(() => limiter.consume('blocked', 'slug', `denied-${index}`), RateLimitError);
    assert.ok(limiter.size <= 4);
  }
  now = 999;
  assert.throws(() => limiter.consume('blocked', 'slug', 'late'), RateLimitError);
  now = 1000;
  limiter.consume('blocked', 'slug', 'first');
  limiter.consume('blocked', 'slug', 'first');
  assert.throws(() => limiter.consume('blocked', 'slug', 'first'), RateLimitError);
});
