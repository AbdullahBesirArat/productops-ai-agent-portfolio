import { testKeys } from './fixtures/auth-keys.js';
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';

test('health and server import perform no TCP connect or listen; no external env read', async (t) => {
  let connections = 0;
  let listeners = 0;
  t.mock.method(net.Socket.prototype, 'connect', () => { connections++; throw new Error('Forbidden network'); });
  t.mock.method(net.Server.prototype, 'listen', () => { listeners++; throw new Error('Forbidden listener'); });
  await import('../src/server.js');
  const env = new Proxy<NodeJS.ProcessEnv>({}, {
    get(target, key: string) {
      if (key === 'DATABASE_URL' || key.startsWith('PG')) throw new Error('Forbidden environment read');
      return target[key];
    },
  });
  for (const config of [env, { DATABASE_URL: 'postgres://remote.example/production' },
    { PRODUCTOPS_DB_URL: 'postgres://productops_app:synthetic-only@localhost:54329/productops_test' }]) {
    const app = buildApp({ ...testKeys().env, ...config });
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { status: 'ok', service: 'productops-ai-agent' });
    } finally { await app.close(); }
  }
  assert.equal(connections, 0);
  assert.equal(listeners, 0);
});

test('client request IDs and unknown paths are not reflected or logged', async () => {
  const app = buildApp({});
  let logs = 0;
  app.setChildLoggerFactory((logger, bindings, options) => {
    const child = logger.child(bindings, options);
    child.info = () => { logs++; };
    return child;
  });
  const marker = 'untrusted-client-marker';
  try {
    for (const url of ['/health', `/missing-${marker}`]) {
      const response = await app.inject({ method: 'GET', url,
        headers: { 'x-request-id': marker, 'x-correlation-id': marker, traceparent: marker } });
      assert.equal((response.body + JSON.stringify(response.headers)).includes(marker), false);
    }
    assert.equal(app.log.level, 'silent');
    assert.equal(logs, 0);
  } finally { await app.close(); }
});
