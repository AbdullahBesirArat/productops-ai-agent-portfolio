import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, loadDatabaseConfig } from '../src/config.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../src/auth/password.js';
test('bootstrap URLs and runtime identity remain restricted without leaking input', () => {
  for (const raw of ['postgres://productops_bootstrap:x@prod.example.com/productops_dev', 'postgres://productops_bootstrap:x@127.0.0.1/productops']) {
    assert.throws(() => loadDatabaseConfig(raw, 'productops_bootstrap'), error => error instanceof Error && !error.message.includes(raw));
  }
  for (const role of ['productops_bootstrap', 'productops_migrator', 'productops', 'postgres']) {
    assert.throws(() => loadConfig({ PRODUCTOPS_DB_URL: `postgres://${role}:x@127.0.0.1/productops_dev` }));
  }
  for (const name of ['PRODUCTOPS_AUTH_DB_URL', 'PRODUCTOPS_AUTH_TEST_DB_URL', 'PRODUCTOPS_AUTH_PASSWORD', 'PRODUCTOPS_JWT_PRIVATE_KEY', 'PRODUCTOPS_JWT_SECRET']) {
    assert.throws(() => loadConfig({ [name]: 'synthetic' }));
  }
});
test('scrypt verifies safely and rejects malformed hashes and invalid lengths', async () => {
  const hash = await hashPassword('synthetic-test');
  assert.match(hash, /^scrypt\$32768\$8\$1\$/u);
  assert.equal(await verifyPassword(hash, 'synthetic-test'), true);
  assert.equal(await verifyPassword(hash, 'wrong'), false);
  assert.equal(await verifyPassword(DUMMY_HASH, ''), false);
  for (const bad of ['', 'scrypt$1$1$1$AA==$AA==', hash + '$extra']) assert.equal(await verifyPassword(bad, 'synthetic-test'), false);
  await assert.rejects(hashPassword(''));
  await assert.rejects(hashPassword('a'.repeat(257)));
});
