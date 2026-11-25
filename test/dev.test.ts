import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { assertPortAvailable } from '../scripts/dev.js';

test('development port preflight reports an occupied loopback port and accepts it after release', async () => {
  const host = '127.0.0.1';
  const server = createServer();
  const listening = once(server, 'listening');
  server.listen(0, host);
  await listening;
  const address = server.address();
  try {
    assert.ok(address && typeof address === 'object');
    await assert.rejects(assertPortAvailable(host, address.port, 'API (PORT)'), {
      message: `API (PORT) port ${address.port} is already in use.`,
    });
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  await assertPortAvailable(host, address.port, 'API (PORT)');
});
