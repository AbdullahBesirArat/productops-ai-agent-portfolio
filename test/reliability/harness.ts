import { authFixture, testKeys } from '../fixtures/auth-keys.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import pg, { type Pool, type PoolClient, type PoolConfig } from 'pg';
import { buildApp } from '../../src/app.js';
import { issueAccessToken } from '../../src/auth/signing.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadDatabaseConfig } from '../../src/config.js';
import { SEED_TENANTS } from '../../src/db/seed-data.js';
import { ToolLimiter } from '../../src/tools/limiter.js';
import { RequestMetrics } from './metrics.js';

export function testPool(role: 'app' | 'bootstrap', overrides: Pick<PoolConfig, 'max' | 'port'> = {}) {
  const url = role === 'app' ? process.env.PRODUCTOPS_TEST_DB_URL : process.env.PRODUCTOPS_BOOTSTRAP_TEST_DB_URL;
  const config = loadDatabaseConfig(url, `productops_${role}`);
  assert.equal(config.database, 'productops_test');
  assert.ok(['localhost', '127.0.0.1'].includes(config.host));
  const pool = new pg.Pool({
    host: config.host, port: config.port, database: config.database, user: config.username,
    password: config.password, ssl: false, max: 4, connectionTimeoutMillis: 2000,
    statement_timeout: 3000, query_timeout: 4000, idle_in_transaction_session_timeout: 5000, ...overrides,
  });
  pool.on('error', () => undefined);
  return pool;
}

export function assertIdle(pool: Pool) {
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.totalCount, pool.idleCount);
}

const outputLeak = /synthetic-private-fault|postgres(?:ql)?:\/\/|\b(?:SELECT|INSERT INTO|UPDATE public|PGPASSWORD)\b|"(?:stack|password_hash)"\s*:|(?:\n|\\n)\s+at\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./u;
export function assertSafe(text: string, secrets: readonly string[] = []) {
  assert.ok(!outputLeak.test(text) && secrets.every((secret) => !text.includes(secret)), 'Response or output leaked private details');
}

export const reviewRoot = '/support/reviews';
export const orderMessage = 'Where is my order ORD-1001?';

export function send(app: FastifyInstance, token: string, method: HTTPMethods, url: string, body?: unknown,
  headers: Record<string, string> = {}, metrics = new RequestMetrics()) {
  return metrics.record(() => app.inject({
    method, url, headers: { authorization: `Bearer ${token}`, ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { payload: typeof body === 'string' ? body : JSON.stringify(body) }),
  }));
}

export function interceptQueries(pool: Pool, hook: (client: PoolClient, sql: string) => Promise<void>): Pool {
  return new Proxy(pool, {
    get(target, key) {
      if (key === 'connect') return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(connection, property) {
            if (property === 'query') return async (sql: string, params?: unknown[]) => {
              await hook(connection, sql);
              return connection.query(sql, params);
            };
            const value: unknown = Reflect.get(connection, property);
            return typeof value === 'function' ? value.bind(connection) : value;
          },
        });
      };
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function syntheticTenant(seed: (typeof SEED_TENANTS)[number]) {
  const id = randomUUID();
  const withId = <T extends { id: string }>(row: T) => ({ ...row, id: randomUUID() });
  return { ...seed, id, slug: 'g-' + id, users: [...seed.users, seed.users[1]!].map((row) => {
    const sub = randomUUID();
    return { ...row, id: sub, sub, org: id, email: sub + '@example.test' };
  }), products: seed.products.map(withId), orders: seed.orders.map(withId), policies: seed.policies.map(withId) };
}

export class Harness {
  readonly keys = testKeys();
  private auth: Awaited<ReturnType<typeof authFixture>> | undefined;
  readonly password = randomBytes(24).toString('hex');
  readonly tenants = [syntheticTenant(SEED_TENANTS[0]!), syntheticTenant(SEED_TENANTS[1]!)] as const;
  readonly admin = testPool('bootstrap');
  readonly pool = testPool('app');
  readonly apps = new Set<FastifyInstance>();
  private seeded = false;

  token(actor = this.tenants[0].users[0]!, seconds?: number) {
    return issueAccessToken(actor, this.keys.signing, seconds);
  }

  app(deps: NonNullable<Parameters<typeof buildApp>[1]> = {}) {
    const instance = buildApp(this.auth?.env ?? this.keys.env, {
      pool: this.pool, ...deps,
      review: { limiter: new ToolLimiter(() => 0, 1000, 1000), ...deps.review },
    });
    this.apps.add(instance);
    return instance;
  }

  async seed() {
    this.auth ??= await authFixture(this.keys);
    const passwordHash = await hashPassword(this.password);
    const client = await this.admin.connect();
    try {
      await client.query('BEGIN');
      for (const tenant of this.tenants) {
        await client.query('INSERT INTO public.organizations(id,name,slug) VALUES($1,$2,$3)', [tenant.id, tenant.name, tenant.slug]);
        for (const user of tenant.users) {
          await client.query('INSERT INTO public.users(id,email) VALUES($1,$2)', [user.id, user.email]);
          await client.query('INSERT INTO public.memberships(org_id,user_id,role) VALUES($1,$2,$3)', [tenant.id, user.id, user.role]);
          await client.query('INSERT INTO public.user_credentials(user_id,password_hash) VALUES($1,$2)', [user.id, passwordHash]);
        }
        for (const { id, sku, name, stock, reorderLevel } of tenant.products) {
          await client.query('INSERT INTO public.products(id,org_id,sku,name,stock,reorder_level) VALUES($1,$2,$3,$4,$5,$6)',
            [id, tenant.id, sku, name, stock, reorderLevel]);
        }
        for (const { id, code, customerRef, status } of tenant.orders) {
          await client.query('INSERT INTO public.orders(id,org_id,order_code,customer_ref,status) VALUES($1,$2,$3,$4,$5)',
            [id, tenant.id, code, customerRef, status]);
        }
        for (const { id, slug, title, body, topic, version } of tenant.policies) {
          await client.query('INSERT INTO public.policy_snippets(id,org_id,slug,title,body,topic,version) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [id, tenant.id, slug, title, body, topic, version]);
        }
      }
      await client.query('COMMIT');
      this.seeded = true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async counts() {
    const ids = this.tenants.map(({ id }) => id);
    const tables = ['draft_reviews', 'draft_revisions', 'draft_review_events', 'agent_runs', 'tool_audit_events'] as const;
    return Object.fromEntries(await Promise.all(tables.map(async (table) => [table,
      (await this.admin.query<{ count: number }>(`SELECT count(*)::int AS count FROM public.${table} WHERE org_id = ANY($1::uuid[])`, [ids])).rows[0]!.count])));
  }

  async close() {
    await this.auth?.close();
    try {
      await Promise.all([...this.apps].map((app) => app.close()));
      assertIdle(this.pool);
      if (this.seeded) {
        for (const { id, users } of this.tenants) {
          for (const table of ['draft_reviews', 'tool_audit_events', 'agent_runs'] as const) {
            await this.admin.query(`DELETE FROM public.${table} WHERE org_id=$1`, [id]);
          }
          assert.equal((await this.admin.query('DELETE FROM public.organizations WHERE id=$1', [id])).rowCount, 1);
          for (const user of users) {
            assert.equal((await this.admin.query('DELETE FROM public.users WHERE id=$1', [user.id])).rowCount, 1);
          }
        }
        assert.ok(Object.values(await this.counts()).every((count) => count === 0), 'Test tenant rows survived cleanup');
      }
    } finally {
      await Promise.all([this.pool.end(), this.admin.end()]);
      assert.equal(this.pool.totalCount + this.admin.totalCount, 0);
      assertIdle(this.pool);
      assertIdle(this.admin);
    }
  }
}
