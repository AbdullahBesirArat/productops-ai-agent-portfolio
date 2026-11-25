import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { ConfigurationError, loadConfig, validateDatabaseUrl } from '../src/config.js';

test('defaults and mock-only adapter', () => {
  assert.deepEqual(loadConfig({}), { host: '127.0.0.1', port: 3108, authPort: 3109, modelAdapter: 'mock', database: undefined });
  for (const model of ['', 'mock']) assert.equal(loadConfig({ MODEL_ADAPTER: model }).modelAdapter, 'mock');
  for (const model of ['openai', 'paid', 'Mock', ' mock ']) {
    assert.throws(() => loadConfig({ MODEL_ADAPTER: model }), ConfigurationError);
  }
});

test('only explicit loopback hosts and valid application ports', () => {
  for (const host of ['127.0.0.1', 'localhost']) assert.equal(loadConfig({ HOST: host }).host, host);
  for (const host of ['0.0.0.0', '::', '::1', '192.168.1.1', 'localhost.', 'localhost:3108']) {
    assert.throws(() => loadConfig({ HOST: host }), ConfigurationError);
  }
  for (const port of ['0', '-1', '65536', '3108.0', ' 3108', '03108']) {
    assert.throws(() => loadConfig({ PORT: port }), ConfigurationError);
  }
});

test('valid database URLs return explicit fields only', () => {
  for (const protocol of ['postgres', 'postgresql']) {
    for (const host of ['localhost', '127.0.0.1', 'productops-db']) {
      for (const db of ['productops_dev', 'productops_test']) {
        for (const port of ['', host === 'productops-db' ? ':5432' : ':54329']) {
          const config = validateDatabaseUrl(`${protocol}://${host}${port}/${db}`);
          assert.equal(config.host, host);
          assert.equal(config.database, db);
          assert.equal(config.port, host === 'productops-db' ? 5432 : 54329);
          assert.deepEqual(Object.keys(config).sort(), ['database', 'host', 'password', 'port', 'protocol', 'username']);
        }
      }
    }
  }
});

const rejected = [
  'postgresql://localhost/productops_dev?host=prod.example.com',
  'postgres://prod.example.com/productops_dev',
  'postgres://localhost./productops_dev',
  'postgres://sub.localhost/productops_dev',
  'postgres://localhost,prod.example.com/productops_dev',
  'postgres://localhost:5432/productops_dev',
  'postgres://productops-db:54329/productops_dev',
  'https://localhost/productops_dev',
  'postgres://localhost/production',
  'postgres://localhost/panelya',
  'postgres://localhost/productops_dev?sslmode=require',
  'postgres://localhost/productops_dev?db=production',
  'postgres://localhost/productops_dev?',
  'postgres://localhost/productops_dev#fragment',
  'postgres://localhost/productops_dev#',
  'postgres:///productops_dev',
  'postgres://%2Fvar%2Frun%2Fpostgresql/productops_dev',
  'postgres://[::1]/productops_dev',
  'postgres://127.1/productops_dev',
  'postgres://localhost/productops_dev/extra',
  'postgres://localhost/../productops_dev',
  'postgres://localhost/%70roductops_dev',
  'postgres://localhost:/productops_dev',
  'postgres://localhost:054329/productops_dev',
  'postgres://@localhost/productops_dev',
  'postgres://:password@localhost/productops_dev',
  'postgres://user@other@localhost/productops_dev',
  'postgres://bad%20user@localhost/productops_dev',
  'postgres://user:%GG@localhost/productops_dev',
  'postgres://user:%00@localhost/productops_dev',
  ' postgres://localhost/productops_dev',
  'postgres://local\nhost/productops_dev',
  'postgres://localhost\\evil/productops_dev',
  '',
];
for (const [index, raw] of rejected.entries()) {
  test(`reject unsafe database URL case ${index + 1}`, () => {
    assert.throws(() => validateDatabaseUrl(raw), ConfigurationError);
  });
}

test('invalid URL exceptions never expose credentials, URL, or parser cause', () => {
  const secret = ['synthetic', 'credential', 'only'].join('-');
  const raw = `postgres://user:${secret}@remote.example/productops_dev`;
  let caught: unknown;
  try { validateDatabaseUrl(raw); } catch (error) { caught = error; }
  assert.ok(caught instanceof ConfigurationError);
  assert.equal(caught.cause, undefined);
  for (const output of [String(caught), inspect(caught), JSON.stringify(caught)]) {
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes(raw), false);
  }
});

test('encoded valid credentials are decoded once', () => {
  const config = validateDatabaseUrl('postgres://productops:fake%40placeholder@localhost/productops_test');
  assert.equal(config.username, 'productops');
  assert.equal(config.password, 'fake@placeholder');
});
