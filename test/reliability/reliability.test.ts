import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, before, test, type TestContext } from 'node:test';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { MockAdapter } from '../../src/agent/mock/rule.js';
import { registry } from '../../src/tools/registry.js';
import { ToolLimiter } from '../../src/tools/limiter.js';
import type { ToolRegistry } from '../../src/tools/types.js';
import { assertIdle, assertSafe, Harness, interceptQueries, orderMessage, reviewRoot, send, testPool } from './harness.js';
import { RequestMetrics, writeEvidence } from './metrics.js';

let harness: Harness;
let app: FastifyInstance;
let owner: string;
let member: string;
let third: string;
let foreign: string;
let metrics: RequestMetrics;
const evidence: Record<string, ReturnType<RequestMetrics['summary']>> = {};
const tool = { name: 'get_order_status', arguments: { orderCode: 'ORD-1001' } };
const agent = { request: orderMessage };
const draft = { message: orderMessage, language: 'en' };
const editBody = { expected_version: 1, customer_text: 'Our team will follow up.' };
const fault = 'synthetic-private-fault';

before(async () => {
  harness = new Harness();
  await harness.seed();
  const [a, b] = harness.tenants;
  [owner, member, third, foreign] = await Promise.all([
    harness.token(a.users[0]), harness.token(a.users[1]), harness.token(a.users[3]), harness.token(b.users[0]),
  ]);
  app = harness.app();
});

after(async () => {
  await harness?.close();
  if (process.env.PRODUCTOPS_WRITE_EVIDENCE === '1') await writeEvidence('reliability.json', { scenarios: evidence });
});

function scenario(name: string, run: (t: TestContext) => Promise<void>) {
  test(name, { timeout: 55_000 }, async (t) => {
    metrics = new RequestMetrics();
    const output: string[] = [];
    // Preserve the node:test runner's serialized stdout reporting channel.
    const write = process.stdout.write.bind(process.stdout);
    const stdout = t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
      if (ArrayBuffer.isView(chunk) && chunk[0] === 0xff) return write(chunk);
      output.push(String(chunk));
      return true;
    });
    const stderr = t.mock.method(process.stderr, 'write', (chunk: unknown) => { output.push(String(chunk)); return true; });
    try {
      await run(t);
    } finally {
      stdout.mock.restore();
      stderr.mock.restore();
      assertSafe(output.join(''), [harness.password, harness.keys.privatePem]);
      assertIdle(harness.pool);
      assertIdle(harness.admin);
      evidence[name] = metrics.summary();
    }
  });
}

async function call(method: HTTPMethods, url: string, payload?: unknown, token = owner, target = app,
  headers: Record<string, string> = {}) {
  const response = await send(target, token, method, url, payload, headers, metrics);
  assertSafe(response.payload, [harness.password, harness.keys.privatePem]);
  return response;
}

type Response = Awaited<ReturnType<typeof call>>;
type Review = { id: string; version: number; current_revision: number; approved_revision: number | null;
  state: string; events: { event_type: string; actor_id: string }[] };

function expect(response: Response, status: number, code?: string) {
  assert.equal(response.statusCode, status);
  const body = response.json<{ errorCode?: string; error?: { code: string }; answer?: unknown; sources?: unknown[] }>();
  if (code) assert.equal(body.errorCode ?? body.error?.code, code);
  if (status >= 400) {
    assert.equal(Object.hasOwn(body, 'review'), false);
    assert.equal(Object.hasOwn(body, 'result'), false);
    assert.equal(Object.hasOwn(body, 'customer_safe_draft'), false);
    assert.ok(body.answer == null);
    assert.ok(!body.sources?.length);
  }
}

const path = (id: string) => reviewRoot + '/' + id;
async function create(target = app, token = owner) {
  const response = await call('POST', reviewRoot, draft, token, target);
  expect(response, 201);
  return response.json<{ review: Review }>().review;
}
async function detail(id: string, target = app) {
  const response = await call('GET', path(id), undefined, owner, target);
  expect(response, 200);
  return response.json<{ review: Review }>().review;
}
const approve = (id: string, token = member, version = 1, target = app) =>
  call('POST', path(id) + '/approve', { expected_version: version }, token, target);
const reject = (id: string, version = 1) =>
  call('POST', path(id) + '/reject', { expected_version: version, reason_code: 'other' }, member);
const health = async (target = app) => expect(await call('GET', '/health', undefined, owner, target), 200);

async function closedPort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

scenario('database unavailable, drained pool, and recovery', async () => {
  const review = await create();
  const refused = testPool('app', { port: await closedPort() });
  const drained = testPool('app');
  let ending: Promise<void> | undefined;
  const drainRegistry: ToolRegistry = { ...registry, get_order_status: { ...registry.get_order_status!, async handler(context, args) {
    const result = await registry.get_order_status!.handler(context, args);
    ending = drained.end();
    return result;
  } } };
  const drainApp = harness.app({ pool: drained, toolRegistry: drainRegistry });
  try {
    const beforeCounts = await harness.counts();
    expect(await call('POST', '/tools/execute', tool, owner, drainApp), 500, 'AUDIT_UNAVAILABLE');
    await ending;
    const routes: [HTTPMethods, string, unknown, string | undefined][] = [
      ['GET', '/auth/me', undefined, undefined],
      ['POST', '/tools/execute', tool, 'AUDIT_UNAVAILABLE'],
      ['POST', '/agent/runs', agent, 'RUN_RECORD_UNAVAILABLE'],
      ['POST', '/support/drafts/preview', draft, 'INTERNAL_ERROR'],
      ['GET', reviewRoot, undefined, 'INTERNAL_ERROR'],
      ['POST', reviewRoot, draft, 'INTERNAL_ERROR'],
      ['GET', path(review.id), undefined, 'INTERNAL_ERROR'],
      ['PATCH', path(review.id), editBody, 'INTERNAL_ERROR'],
      ['POST', path(review.id) + '/approve', { expected_version: 1 }, 'INTERNAL_ERROR'],
      ['POST', path(review.id) + '/reject', { expected_version: 1, reason_code: 'other' }, 'INTERNAL_ERROR'],
    ];
    for (const pool of [refused, drained]) {
      const target = harness.app({ pool });
      for (const [method, url, payload, code] of routes) {
        const response = await call(method, url, payload, owner, target);
        expect(response, 500, code);
        if (!code) assert.deepEqual(response.json(), { error: 'Internal server error' });
      }
      await health(target);
      assertIdle(pool);
      assert.equal(pool.totalCount, 0);
    }
    assert.deepEqual(await harness.counts(), beforeCounts);
    const recovered = harness.app();
    assert.deepEqual(await detail(review.id, recovered), review);
    expect(await call('POST', '/tools/execute', tool, owner, recovered), 200);
  } finally {
    await Promise.all([refused.end(), ending ?? drained.end()]);
  }
});

scenario('two-client pool saturation and server-side tool timeout', async () => {
  const pool = testPool('app', { max: 2 });
  let active = 0;
  let peak = 0;
  let peakWaiters = 0;
  const slow: ToolRegistry = { ...registry, get_order_status: { ...registry.get_order_status!, async handler(context, args) {
    peak = Math.max(peak, ++active);
    peakWaiters = Math.max(peakWaiters, pool.waitingCount);
    try {
      await context.client.query('SELECT pg_sleep(0.1)');
      return await registry.get_order_status!.handler(context, args);
    } finally {
      active--;
    }
  } } };
  try {
    const target = harness.app({ pool, toolRegistry: slow, toolMaxInflight: 6 });
    const batch = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/tools/execute', tool, owner, target)));
    assert.equal(peak, 2);
    assert.ok(peakWaiters > 0 && peakWaiters <= 4);
    assert.ok(batch.some((response) => response.statusCode === 200));
    assert.ok(batch.some((response) => response.statusCode === 429));
    for (const response of batch) {
      if (response.statusCode === 429) {
        expect(response, 429, 'BUSY');
        assert.equal(response.headers['retry-after'], '1');
      } else expect(response, 200);
    }
    assertIdle(pool);
    const timeout = harness.app({ pool, toolRegistry: slow, toolTimeoutMs: 20 });
    expect(await call('POST', '/tools/execute', tool, owner, timeout), 504, 'TIMEOUT');
    expect(await call('POST', '/tools/execute', tool, owner, target), 200);
    assertIdle(pool);
  } finally {
    await pool.end();
  }
});

function failingPool(table: string) {
  return interceptQueries(harness.pool, async (_client, sql) => {
    if (sql.startsWith(`INSERT INTO public.${table}`)) throw new Error(fault);
  });
}

scenario('audit failures, model failures, and unexpected service exceptions', async () => {
  const beforeCounts = await harness.counts();
  const audit = harness.app({ pool: failingPool('tool_audit_events') });
  expect(await call('POST', '/tools/execute', tool, owner, audit), 500, 'AUDIT_UNAVAILABLE');
  expect(await call('POST', reviewRoot, draft, owner, audit), 500, 'AUDIT_UNAVAILABLE');
  expect(await call('POST', '/support/drafts/preview', draft, owner, audit), 500, 'AUDIT_UNAVAILABLE');
  for (const { plan, status, code } of [
    { plan: async () => { throw new Error(fault); }, status: 502, code: 'MODEL_ERROR' },
    { plan: async () => ({ garbage: fault }), status: 502, code: 'INVALID_MODEL_OUTPUT' },
    { plan: () => new Promise<never>(() => undefined), status: 504, code: 'RUN_TIMEOUT' },
  ]) {
    const target = harness.app({ review: { adapterFactory: () => ({ name: 'fault', plan }), limits: { totalTimeoutMs: 200 } } });
    expect(await call('POST', reviewRoot, draft, owner, target), status, code);
  }
  const target = harness.app({ review: { async service() { throw new Error(fault); } } });
  const response = await call('POST', reviewRoot, draft, owner, target);
  expect(response, 500, 'INTERNAL_ERROR');
  const { traceId, ...body } = response.json<Record<string, unknown>>();
  assert.equal(typeof traceId, 'string');
  assert.deepEqual(body, { status: 'error', errorCode: 'INTERNAL_ERROR', send_enabled: false });
  assert.deepEqual(await harness.counts(), beforeCounts);
});

scenario('sequential and in-progress idempotency, conflict, and scoped reuse', async () => {
  const mock = new MockAdapter();
  let executions = 0;
  let entered!: () => void;
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const beforeCounts = await harness.counts();
  const target = harness.app({ agent: { adapter: { name: 'gated-mock', async plan(context) {
    if (context.step === 0 && ++executions === 1) {
      entered();
      await gate;
    }
    return mock.plan(context);
  } } } });
  const headers = { 'Idempotency-Key': 'reliability-key' };
  const run = (token = owner, payload = agent) => call('POST', '/agent/runs', payload, token, target, headers);
  const first = run();
  try {
    await Promise.race([started, first.then(() => assert.fail('Initial run returned before entering adapter'))]);
    expect(await run(), 409, 'RUN_IN_PROGRESS');
  } finally {
    resume();
    await first;
  }
  const original = await first;
  expect(original, 200);
  const replay = await run();
  expect(replay, 200);
  assert.equal(replay.headers['idempotent-replay'], 'true');
  assert.deepEqual(replay.json(), original.json());
  expect(await run(owner, { request: 'Returns policy?' }), 422, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(executions, 1);
  for (const token of [member, foreign]) {
    const independent = await run(token);
    expect(independent, 200);
    assert.notEqual(independent.json<{ runId: string }>().runId, original.json<{ runId: string }>().runId);
  }
  assert.equal(executions, 3);
  const afterCounts = await harness.counts();
  assert.equal(afterCounts.agent_runs! - beforeCounts.agent_runs!, executions);
  assert.equal(afterCounts.tool_audit_events! - beforeCounts.tool_audit_events!, executions);
});

scenario('body size boundary, 200 malformed bodies, throttling and recovery', async () => {
  let now = 0;
  const target = harness.app({ review: { limiter: new ToolLimiter(() => now, 30, 30) } });
  const valid = JSON.stringify(draft).padEnd(8192, ' ');
  expect(await call('POST', reviewRoot, valid, owner, target), 201);
  const beforeCounts = await harness.counts();
  expect(await call('POST', reviewRoot, valid + ' ', owner, target), 400, 'INVALID_REQUEST');
  for (let offset = 0; offset < 200; offset += 8) {
    const batch = await Promise.all(Array.from({ length: 8 }, () => call('POST', reviewRoot, '{', owner, target)));
    for (const response of batch) {
      if (response.statusCode === 429) {
        expect(response, 429, 'RATE_LIMITED');
        assert.ok(Number(response.headers['retry-after']) > 0);
      } else expect(response, 400, 'INVALID_REQUEST');
    }
  }
  const histogram = metrics.summary().statusHistogram;
  assert.equal(histogram[400], 29);
  assert.equal(histogram[429], 172);
  assert.deepEqual(await harness.counts(), beforeCounts);
  await health(target);
  now += 61_000;
  await create(target);
});

scenario('competing decisions, stale versions, and current membership', async () => {
  const { id } = await create();
  const results = await Promise.all([approve(id), approve(id, third)]);
  assert.deepEqual(results.map(({ statusCode }) => statusCode).sort(), [200, 409]);
  const winner = results[0]!.statusCode === 200 ? member : third;
  expect(results.find(({ statusCode }) => statusCode === 409)!, 409, 'ILLEGAL_TRANSITION');
  const repeated = await approve(id, winner);
  expect(repeated, 200);
  assert.equal(repeated.json<{ idempotent: boolean }>().idempotent, true);
  expect(await reject(id, 2), 409, 'ILLEGAL_TRANSITION');
  assert.deepEqual((await detail(id)).events.map(({ event_type }) => event_type), ['created', 'approved_internal']);

  const mixed = await create();
  const [decision, edit] = await Promise.all([approve(mixed.id), call('PATCH', path(mixed.id), editBody, third)]);
  assert.deepEqual([decision.statusCode, edit.statusCode].sort(), [200, 409]);
  if (decision.statusCode === 200) expect(edit, 409, 'ILLEGAL_TRANSITION');
  else expect(decision, 409, 'STALE_VERSION');
  const saved = await detail(mixed.id);
  assert.equal(saved.version, 2);
  assert.equal(saved.events.length, 2);
  assert.equal(saved.state, decision.statusCode === 200 ? 'approved_internal' : 'edited');

  const pending = await create();
  const beforeCounts = await harness.counts();
  expect(await approve(pending.id, foreign), 404, 'NOT_FOUND');
  expect(await approve(pending.id, member, 2), 409, 'STALE_VERSION');
  for (const invalid of [0, -1, 1.5, 2147483648]) expect(await approve(pending.id, member, invalid), 400, 'INVALID_REQUEST');
  const actor = harness.tenants[0].users[1]!;
  const identity = [actor.org, actor.sub];
  await harness.admin.query("UPDATE public.memberships SET role='viewer' WHERE org_id=$1 AND user_id=$2", identity);
  expect(await approve(pending.id), 403, 'FORBIDDEN');
  await harness.admin.query('DELETE FROM public.memberships WHERE org_id=$1 AND user_id=$2', identity);
  expect(await approve(pending.id), 403, 'FORBIDDEN');
  await harness.admin.query("INSERT INTO public.memberships(org_id,user_id,role) VALUES ($1,$2,'member')", identity);
  assert.deepEqual(await detail(pending.id), pending);
  assert.deepEqual(await harness.counts(), beforeCounts);
  expect(await reject(pending.id), 200);
  expect(await reject(pending.id, 2), 409, 'ILLEGAL_TRANSITION');
});

scenario('review transaction rollback on write fault and backend loss', async () => {
  const original = await create();
  const beforeCounts = await harness.counts();
  for (const table of ['draft_review_events', 'tool_audit_events']) {
    const target = harness.app({ pool: failingPool(table) });
    expect(await call('POST', reviewRoot, table === 'draft_review_events' ? { message: 'Hello' } : draft, owner, target), 500,
      table === 'tool_audit_events' ? 'AUDIT_UNAVAILABLE' : 'INTERNAL_ERROR');
    if (table === 'draft_review_events') expect(await approve(original.id, member, 1, target), 500, 'INTERNAL_ERROR');
  }
  assert.deepEqual(await harness.counts(), beforeCounts);
  const interruptor = testPool('app', { max: 1 });
  let interrupted = false;
  try {
    const interruptedPool = interceptQueries(harness.pool, async (client, sql) => {
      if (interrupted || !sql.startsWith('INSERT INTO public.draft_review_events')) return;
      const { pid } = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!;
      client.once('error', () => undefined);
      const result = await interruptor.query<{ terminated: boolean }>('SELECT pg_terminate_backend($1) AS terminated', [pid]);
      interrupted = result.rows[0]!.terminated;
    });
    const target = harness.app({ pool: interruptedPool });
    expect(await approve(original.id, member, 1, target), 500, 'INTERNAL_ERROR');
    assert.equal(interrupted, true);
    assert.deepEqual(await detail(original.id), original);
    assert.deepEqual(await harness.counts(), beforeCounts);
    expect(await approve(original.id, member, 1, target), 200);
    assertIdle(interruptor);
  } finally {
    await interruptor.end();
  }
});

scenario('review survives an app and connection pool restart', async () => {
  const firstPool = testPool('app');
  const secondPool = testPool('app');
  try {
    const first = harness.app({ pool: firstPool });
    const { id } = await create(first);
    await first.close();
    harness.apps.delete(first);
    assertIdle(firstPool);
    const second = harness.app({ pool: secondPool });
    expect(await approve(id, member, 1, second), 200);
    const saved = await detail(id, second);
    assert.deepEqual([saved.state, saved.version, saved.current_revision, saved.approved_revision], ['approved_internal', 2, 1, 1]);
    assert.deepEqual(saved.events.map(({ event_type }) => event_type), ['created', 'approved_internal']);
    assert.equal(saved.events[1]!.actor_id, harness.tenants[0].users[1]!.id);
    assertIdle(secondPool);
  } finally {
    await Promise.all([firstPool.end(), secondPool.end()]);
  }
});

scenario('JWT expiry between review creation and decision, then fresh login', async (t) => {
  const [a] = harness.tenants;
  const login = async (actor: typeof a.users[number]) => {
    const response = await send(app, '', 'POST', '/auth/login',
      { org_slug: a.slug, email: actor.email, password: harness.password }, {}, metrics);
    assert.equal(response.statusCode, 200);
    const { access_token, ...body } = response.json<{ access_token: string }>();
    assertSafe(JSON.stringify(body), [harness.password, harness.keys.privatePem]);
    return access_token;
  };
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const shortOwner = await harness.token(a.users[0], 10);
  const shortMember = await harness.token(a.users[1], 10);
  const original = await create(app, shortOwner);
  const beforeCounts = await harness.counts();
  try {
    t.mock.timers.tick(15_000);
    expect(await call('PATCH', path(original.id), editBody, shortOwner), 401, 'UNAUTHORIZED');
    expect(await approve(original.id, shortMember), 401, 'UNAUTHORIZED');
    assert.deepEqual(await detail(original.id), original);
    assert.deepEqual(await harness.counts(), beforeCounts);
    expect(await approve(original.id, await login(a.users[1]!)), 200);
  } finally {
    t.mock.timers.reset();
  }
});
