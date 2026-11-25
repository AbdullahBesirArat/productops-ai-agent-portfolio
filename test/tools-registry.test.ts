import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { PERMISSION_MATRIX } from '../src/auth/permissions.js';
import { runTool } from '../src/tools/gateway.js';
import { lookupTool, registry } from '../src/tools/registry.js';
import { ToolLimiter } from '../src/tools/limiter.js';
import type { ToolRegistry } from '../src/tools/types.js';

// A client that fails the test if any SQL is attempted: invalid input must never reach the database.
const noDb = { query: async () => { throw new Error('Database touched'); } } as unknown as PoolClient;
const run = (name: string, args: unknown) => runTool(registry, name, args, { client: noDb });

test('exactly the three approved read-only tools are registered', () => {
  assert.deepEqual(Object.keys(registry).sort(), ['get_order_status', 'get_policy_snippet', 'list_low_stock_products']);
  assert.ok(Object.isFrozen(registry));
  for (const entry of Object.values(registry)) assert.ok(Object.isFrozen(entry));
  assert.deepEqual(Object.values(registry).map((entry) => entry.permission).sort(), ['catalog:read', 'order_status:read', 'policy:read']);
  // Every tool maps to its own permission (a swap would pass the sorted comparison above).
  assert.deepEqual(Object.fromEntries(Object.entries(registry).map(([name, entry]) => [name, entry.permission])), {
    get_order_status: 'order_status:read', get_policy_snippet: 'policy:read', list_low_stock_products: 'catalog:read',
  });
});

test('unknown, prototype-like and malformed tool names are rejected without database access', async () => {
  const names = ['', 'drop_tables', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'LIST_LOW_STOCK_PRODUCTS',
    ' get_order_status', 'get_order_status ', 'get_order_status\u0000', 'x'.repeat(10000), 'run_sql', 'shell', 'refund_order', 'update_stock'];
  for (const name of names) {
    assert.equal(lookupTool(registry, name), undefined, `lookup ${JSON.stringify(name.slice(0, 20))}`);
    assert.deepEqual(await run(name, {}), { status: 'unknown_tool', code: 'UNKNOWN_TOOL', message: 'Unknown tool' });
  }
});

const invalidCases: [string, unknown][] = [
  ['list_low_stock_products', { extra: 1 }],
  ['list_low_stock_products', { threshold: '5' }],
  ['list_low_stock_products', { threshold: 5.5 }],
  ['list_low_stock_products', { threshold: -1 }],
  ['list_low_stock_products', { threshold: 51 }],
  ['list_low_stock_products', { limit: 0 }],
  ['list_low_stock_products', { limit: 51 }],
  ['list_low_stock_products', { limit: 1e9 }],
  ['list_low_stock_products', { limit: null }],
  ['list_low_stock_products', { limit: [5] }],
  ['list_low_stock_products', { limit: Number.NaN }],
  ['list_low_stock_products', []],
  ['list_low_stock_products', null],
  ['list_low_stock_products', 'threshold=5'],
  ['list_low_stock_products', 5],
  ['get_order_status', {}],
  ['get_order_status', { orderCode: '' }],
  ['get_order_status', { orderCode: 5 }],
  ['get_order_status', { orderCode: ['ORD-1001'] }],
  ['get_order_status', { orderCode: 'ORD-1001', extra: true }],
  ['get_order_status', { orderCode: 'a'.repeat(33) }],
  ['get_order_status', { orderCode: '-ORD' }],
  ['get_order_status', { orderCode: "ORD-1' OR '1'='1" }],
  ['get_order_status', { orderCode: "'; DROP TABLE orders; --" }],
  ['get_order_status', { orderCode: 'ORD-1001\u0000' }],
  ['get_order_status', { orderCode: 'ORD-1001\n' }],
  ['get_order_status', { orderCode: 'ORD%2D1001' }],
  ['get_order_status', { orderCode: 'ＯＲＤ-1001' }],
  ['get_policy_snippet', {}],
  ['get_policy_snippet', { topic: 'refunds' }],
  ['get_policy_snippet', { topic: 'Returns' }],
  ['get_policy_snippet', { topic: ['returns'] }],
  ['get_policy_snippet', { topic: 'returns', extra: 1 }],
  ['get_policy_snippet', { topic: "returns' OR '1'='1" }],
];
test('invalid, extra, mistyped, over-limit and SQL-like arguments are rejected (never coerced or stripped)', async () => {
  for (const [name, args] of invalidCases) {
    const outcome = await run(name, args);
    assert.equal(outcome.status, 'invalid_input', `${name} ${JSON.stringify(args)}`);
  }
});

test('tenant, organization, user and role override fields are rejected with a dedicated code', async () => {
  const keys = ['tenantId', 'tenant_id', 'organizationId', 'orgId', 'org_id', 'userId', 'user_id', 'role', 'sub', 'TENANTID', 'OrgId'];
  for (const name of Object.keys(registry)) {
    for (const key of keys) {
      const valid = name === 'get_order_status' ? { orderCode: 'ORD-1001' } : name === 'get_policy_snippet' ? { topic: 'returns' } : {};
      const outcome = await run(name, { ...valid, [key]: '00000002-0000-4000-8000-000000000001' });
      assert.deepEqual(outcome, { status: 'invalid_input', code: 'FORBIDDEN_ARGUMENT', message: 'Invalid tool arguments' }, `${name}.${key}`);
    }
  }
});

test('prototype-pollution payloads are rejected and do not pollute Object.prototype', async () => {
  const payloads = ['{"__proto__":{"polluted":true}}', '{"orderCode":"ORD-1001","__proto__":{"x":1}}',
    '{"constructor":{"prototype":{"polluted":true}}}', '{"threshold":5,"nested":{"__proto__":{"p":1}}}'];
  for (const text of payloads) {
    for (const name of Object.keys(registry)) {
      const outcome = await run(name, JSON.parse(text));
      assert.equal(outcome.status, 'invalid_input');
    }
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

test('valid arguments are normalised with documented defaults only', () => {
  const lowStock = registry.list_low_stock_products!;
  assert.deepEqual(lowStock.validate({}), { valid: true, args: { threshold: 5, limit: 20 } });
  assert.deepEqual(lowStock.validate({ threshold: 0, limit: 50 }), { valid: true, args: { threshold: 0, limit: 50 } });
  assert.deepEqual(registry.get_order_status!.validate({ orderCode: 'ORD-1001' }), { valid: true, args: { orderCode: 'ORD-1001' } });
  for (const topic of ['shipping_delay', 'returns', 'warranty']) {
    assert.deepEqual(registry.get_policy_snippet!.validate({ topic }), { valid: true, args: { topic } });
  }
});

test('no payment, refund, SQL, shell, admin or write capability exists in registry or permission matrix', () => {
  const forbidden = /(pay|refund|sql|shell|exec|admin|write|delete|update|mutat|send|file|stock_adjust)/iu;
  for (const name of Object.keys(registry)) assert.doesNotMatch(name, forbidden);
  for (const permissions of Object.values(PERMISSION_MATRIX)) {
    for (const permission of permissions) assert.doesNotMatch(permission, /(pay|refund|sql|shell|exec|admin|write|delete)/iu);
  }
});

function sources(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((file) => file.isFile() && file.name.endsWith('.ts'))
    .map((file) => resolve(file.parentPath, file.name));
}

test('tool sources have no dynamic loading, filesystem, process, network or write SQL', () => {
  for (const file of sources('src/tools')) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /child_process|node:fs|from 'fs'|\beval\s*\(|new Function|\bimport\s*\(|\brequire\s*\(|\bfetch\s*\(|node:net|node:http|node:dgram|node:worker_threads|node:vm/u, file);
    if (!file.endsWith('audit.ts')) {
      assert.doesNotMatch(text, /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT)\b\s/u, `${file} contains write SQL`);
    }
    for (const match of text.matchAll(/\.query(?:<[^>]*>)?\(\s*([^,)\s][^,)]*)/gu)) {
      assert.match(match[1]!.trim(), /^['"`]/u, `${file}: query must start with a string literal`);
      assert.doesNotMatch(match[1]!, /[$][{]/u, `${file}: no interpolation inside SQL text`);
    }
  }
  // Only the audit writer may insert, and only into the append-only audit table.
  const audit = readFileSync('src/tools/audit.ts', 'utf8');
  assert.equal([...audit.matchAll(/\bINSERT INTO ([a-z_.]+)/gu)].map((match) => match[1]).join(','), 'public.tool_audit_events');
});

test('tool handlers receive only a database client, never the registry, pool or gateway', () => {
  const types = readFileSync('src/tools/types.ts', 'utf8');
  assert.match(types, /interface ToolContext \{ client: PoolClient \}/u);
});

test('tool limiter enforces per-actor and per-ip windows with bounded memory and one audited denial per window', () => {
  let now = 1000;
  const limiter = new ToolLimiter(() => now, 2, 5, 1000, 4);
  assert.deepEqual(limiter.consume('a', '1.1.1.1'), { allowed: true });
  assert.deepEqual(limiter.consume('a', '1.1.1.1'), { allowed: true });
  const denied = limiter.consume('a', '1.1.1.1');
  assert.equal(denied.allowed, false);
  assert.ok(!denied.allowed && denied.firstDenial && denied.retryAfter >= 1);
  const again = limiter.consume('a', '1.1.1.1');
  assert.ok(!again.allowed && !again.firstDenial);
  assert.deepEqual(limiter.consume('b', '1.1.1.1'), { allowed: true });
  now += 1001;
  assert.deepEqual(limiter.consume('a', '1.1.1.1'), { allowed: true });
  for (let i = 0; i < 50; i++) limiter.consume(`k${i}`, `10.0.0.${i}`);
  assert.ok(limiter.size <= 4);
});

test('tool lookup is own-property only, also for registries that have a prototype chain', () => {
  const plain: ToolRegistry = { get_order_status: registry.get_order_status! };
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
    assert.equal(lookupTool(plain, name), undefined, name);
  }
  assert.equal(lookupTool(plain, 'get_order_status')?.name, 'get_order_status');
});

test('an exhausted actor budget does not consume the shared address budget', () => {
  const limiter = new ToolLimiter(() => 1000, 2, 4, 1000, 100);
  for (let i = 0; i < 20; i++) limiter.consume('noisy', '9.9.9.9');
  assert.deepEqual(limiter.consume('other-1', '9.9.9.9'), { allowed: true });
  assert.deepEqual(limiter.consume('other-2', '9.9.9.9'), { allowed: true });
  assert.equal(limiter.consume('other-3', '9.9.9.9').allowed, false);
});
