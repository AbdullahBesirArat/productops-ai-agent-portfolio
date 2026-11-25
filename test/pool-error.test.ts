import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPool } from '../src/db/pool.js';

// This tests the idle-client error listener only, without opening a database connection.
test('an error emitted on the pool (idle client failure) is absorbed instead of crashing the process', async () => {
  const pool = createPool({
    protocol: 'postgres:', host: '127.0.0.1', port: 54329, database: 'productops_test',
    username: 'productops_app', password: 'unused-no-connection-is-made',
  });
  try {
    assert.ok(pool.listenerCount('error') >= 1);
    assert.doesNotThrow(() => pool.emit('error', new Error('simulated idle client failure')));
  } finally { await pool.end(); }
});
