import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigurationError, loadConfig, loadDatabaseConfig } from '../src/config.js';

test('database roles are explicit and configuration errors do not leak input', () => {
  for (const role of ['productops', 'postgres', 'other', 'productops_migrator']) {
    const raw = `postgres://${role}:synthetic-only@127.0.0.1:54329/productops_dev`;
    assert.throws(() => loadConfig({ PRODUCTOPS_DB_URL: raw }), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(String(error).includes(raw), false);
      assert.equal(String(error).includes('synthetic-only'), false);
      return true;
    });
  }
  for (const key of ['PRODUCTOPS_MIGRATOR_DB_URL', 'PRODUCTOPS_TEST_DB_URL', 'PRODUCTOPS_MIGRATOR_TEST_DB_URL']) {
    assert.throws(() => loadConfig({ [key]: 'postgres://postgres:synthetic-only@localhost/productops_test' }), ConfigurationError);
  }
  assert.equal(loadDatabaseConfig('postgres://productops_migrator:synthetic-only@localhost/productops_dev', 'productops_migrator').username, 'productops_migrator');
});
