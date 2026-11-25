import { testKeys } from '../fixtures/auth-keys.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { decodeJwt } from 'jose';
import type { Pool } from 'pg';
import { ScriptedMockAdapter } from '../../src/agent/mock/scripted.js';
import { buildApp } from '../../src/app.js';
import { issueAccessToken } from '../../src/auth/signing.js';
import type { Identity } from '../../src/auth/jwt.js';
import { loadDatabaseConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { runSeed } from '../../src/db/seed.js';
import { SEED_TENANTS } from '../../src/db/seed-data.js';
import type { InternalEvidence } from '../../src/support/disclosure.js';
import { foldForMatching } from '../../src/support/normalize.js';
import { REJECT_REASONS } from '../../src/support/review-states.js';
import { ToolLimiter } from '../../src/tools/limiter.js';
import { registry } from '../../src/tools/registry.js';

const runtime = loadDatabaseConfig(process.env.PRODUCTOPS_TEST_DB_URL, 'productops_app');
const migrator = loadDatabaseConfig(process.env.PRODUCTOPS_MIGRATOR_TEST_DB_URL, 'productops_migrator');
const bootstrap = loadDatabaseConfig(process.env.PRODUCTOPS_BOOTSTRAP_TEST_DB_URL, 'productops_bootstrap');
for (const config of [runtime, migrator, bootstrap]) assert.equal(config.database, 'productops_test');
const password = process.env.PRODUCTOPS_DEMO_PASSWORD;
assert.ok(password);
const keys = testKeys();
const secret = keys.signing;
const secretText = keys.privatePem;

type Tenant = (typeof SEED_TENANTS)[number];
type Role = Tenant['users'][number]['role'];
type Overrides = NonNullable<NonNullable<Parameters<typeof buildApp>[1]>['review']>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const [A, B] = [SEED_TENANTS[0]!, SEED_TENANTS[1]!];
const actor = (tenant: Tenant, role: Role): Identity => ({ org: tenant.id, sub: tenant.users.find((user) => user.role === role)!.id });
const owner = actor(A, 'owner');
const member = actor(A, 'member');
const viewer = actor(A, 'viewer');
const outsider = actor(B, 'owner');
const third = { org: A.id, sub: randomUUID() };
const tokens = new Map<string, string>();
const token = (identity = owner) => tokens.get(identity.sub)!;
const root = '/support/reviews';
const order = 'Where is my order ORD-1001?';
const safe = 'Our team will review your request.';
const apps: FastifyInstance[] = [];
const tables = ['draft_reviews', 'draft_revisions', 'draft_review_events', 'tool_audit_events', 'agent_runs'] as const;
let pool: Pool;
let admin: Pool;
let startedAt: Date;
let app: FastifyInstance;

function appWith(review: Overrides = {}, db = pool) {
  const instance = buildApp(keys.env, {
    pool: db, review: { limiter: new ToolLimiter(Date.now, 10000, 10000), ...review },
  });
  apps.push(instance);
  return instance;
}

before(async () => {
  await runMigrations(migrator);
  await runSeed(bootstrap, password);
  pool = createPool(runtime);
  admin = createPool(bootstrap);
  startedAt = (await admin.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  await admin.query('INSERT INTO public.users (id, email) VALUES ($1,$2)', [third.sub, third.sub + '@example.test']);
  await admin.query("INSERT INTO public.memberships (org_id,user_id,role) VALUES ($1,$2,'member')", [third.org, third.sub]);
  for (const identity of [third, ...[A, B].flatMap((tenant) => tenant.users.map(({ id }) => ({ org: tenant.id, sub: id })))]) {
    tokens.set(identity.sub, await issueAccessToken(identity, secret));
  }
  app = appWith();
});

after(async () => {
  try {
    await Promise.all(apps.map((instance) => instance.close()));
    if (admin && startedAt) {
      for (const table of ['draft_reviews', 'tool_audit_events', 'agent_runs'] as const) {
        await admin.query(`DELETE FROM public.${table} WHERE org_id IN ($1,$2) AND created_at >= $3`, [A.id, B.id, startedAt]);
      }
      await admin.query('DELETE FROM public.users WHERE id=$1', [third.sub]);
    }
  } finally {
    await Promise.all([pool?.end(), admin?.end()]);
  }
});

async function request(method: HTTPMethods, url: string, payload?: unknown, auth: string | null = token(), instance = app,
  headers: Record<string, string> = {}) {
  const response = await instance.inject({
    method, url,
    headers: { ...(auth === null ? {} : { authorization: 'Bearer ' + auth }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(payload === undefined ? {} : { payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
  });
  return { status: response.statusCode, json: response.payload ? response.json<Json>() : {}, raw: response.payload, headers: response.headers };
}

type Response = Awaited<ReturnType<typeof request>>;
const path = (id: string) => root + '/' + id;
const get = (id: string, auth = token()) => request('GET', path(id), undefined, auth);
const post = (message = order, auth = token(), instance = app) => request('POST', root, { message, language: 'en' }, auth, instance);
const edit = (id: string, version: number, text = safe, auth = token(member), instance = app) =>
  request('PATCH', path(id), { expected_version: version, customer_text: text }, auth, instance);
const approve = (id: string, version: number, auth = token(member), instance = app) =>
  request('POST', path(id) + '/approve', { expected_version: version }, auth, instance);
const reject = (id: string, version: number, reason = 'other', auth = token(member), instance = app) =>
  request('POST', path(id) + '/reject', { expected_version: version, reason_code: reason }, auth, instance);

function envelope(response: Response, status: number, decision = false) {
  assert.equal(response.status, status, response.raw);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.match(String(response.headers['content-type']), /^application\/json\b/u);
  assert.equal(response.json.send_enabled, false);
  if (decision) assert.equal(response.json.external_effect, 'none');
}

function error(response: Response, status: number, errorCode: string, decision = false) {
  envelope(response, status, decision);
  const { traceId, ...body } = response.json;
  assert.match(traceId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(body, { status: 'error', errorCode, send_enabled: false, ...(decision ? { external_effect: 'none' } : {}) });
  return body;
}

function created(response: Response) {
  envelope(response, 201);
  assert.equal(response.json.schema_version, 2);
  const review = response.json.review as Json;
  assert.match(review.id, /^[0-9a-f-]{36}$/u);
  assert.deepEqual([review.state, review.version, review.current_revision, review.ownership_status, review.send_enabled],
    ['pending_review', 1, 1, 'unverified', false]);
  assert.equal(review.customer_specific_details_allowed, false);
  return review;
}

async function detail(id: string, auth = token()) {
  const response = await get(id, auth);
  envelope(response, 200);
  return response.json.review as Json;
}

function calls(id: string): [HTTPMethods, string, unknown?, boolean?][] {
  return [
    ['POST', root, { message: order }], ['GET', root], ['GET', path(id)],
    ['PATCH', path(id), { expected_version: 1, customer_text: safe }],
    ['POST', path(id) + '/approve', { expected_version: 1 }, true],
    ['POST', path(id) + '/reject', { expected_version: 1, reason_code: 'other' }, true],
  ];
}

const counts = () => Promise.all(tables.map(async (table) =>
  (await admin.query(`SELECT count(*)::int AS count FROM public.${table}`)).rows[0].count as number));

test('all six routes authenticate before budgeting, parsing, or writing', async () => {
  const review = created(await post());
  const beforeCounts = await counts();
  const [header, payload, signature] = token().split('.');
  const forged = (signature![0] === 'A' ? 'B' : 'A') + signature!.slice(1);
  const tampered = Buffer.from(JSON.stringify({ ...decodeJwt(token()), org: B.id })).toString('base64url');
  for (const auth of [null, 'malformed', await issueAccessToken(owner, secret, -60), [header, payload, forged].join('.'),
    await issueAccessToken(owner, testKeys().signing), [header, tampered, signature].join('.')]) {
    for (const [method, url, payload, decision] of calls(review.id)) {
      const response = await request(method, url, payload, auth);
      error(response, 401, 'UNAUTHORIZED', decision);
      assert.equal(response.headers['www-authenticate'], 'Bearer');
    }
  }
  error(await request('POST', root, '{', null), 401, 'UNAUTHORIZED');
  assert.deepEqual(await counts(), beforeCounts);
  assert.deepEqual(await detail(review.id), review);
});

test('current membership gates every route and gates create before classification or tool work', async () => {
  const review = created(await post(order, token(member)));
  const beforeCounts = await counts();
  const target = appWith({ classifier: { name: 'denied', classify() { assert.fail('classification ran'); } },
    execute: async () => assert.fail('tool ran') });
  for (const [method, url, payload, decision] of calls(review.id)) {
    error(await request(method, url, payload, token(viewer), target), 403, 'FORBIDDEN', decision);
  }
  for (const sql of [
    "UPDATE public.memberships SET role='viewer' WHERE org_id=$1 AND user_id=$2",
    'DELETE FROM public.memberships WHERE org_id=$1 AND user_id=$2',
  ]) {
    assert.equal((await admin.query(sql, [owner.org, owner.sub])).rowCount, 1);
    try {
      for (const [method, url, payload, decision] of calls(review.id)) {
        error(await request(method, url, payload, token(), target), 403, 'FORBIDDEN', decision);
      }
      assert.deepEqual(await detail(review.id, token(member)), review);
    } finally {
      await admin.query("INSERT INTO public.memberships(org_id,user_id,role) VALUES ($1,$2,'owner') ON CONFLICT (org_id,user_id) DO UPDATE SET role=EXCLUDED.role",
        [owner.org, owner.sub]);
    }
  }
  assert.deepEqual(await counts(), beforeCounts);
  const edited = await edit(review.id, 1, safe, token());
  envelope(edited, 200);
  assert.equal(edited.json.review.revisions.at(-1).author_id, owner.sub);
  error(await approve(review.id, 2, token()), 403, 'SELF_APPROVAL_FORBIDDEN', true);
  error(await approve(review.id, 2, token(member)), 403, 'SELF_APPROVAL_FORBIDDEN', true);
  envelope(await approve(review.id, 2, token(third)), 200, true);
  for (const [creator, approver] of [[owner, member], [member, owner]] as const) {
    const draft = created(await post(order, token(creator)));
    error(await approve(draft.id, 1, token(creator)), 403, 'SELF_APPROVAL_FORBIDDEN', true);
    const response = await approve(draft.id, 1, token(approver));
    envelope(response, 200, true);
    assert.equal(response.json.review.decided_by, approver.sub);
  }
});

test('tenant isolation, redacted summaries, and deterministic cursor and timestamp pagination', async () => {
  const first = created(await post());
  const latest = created(await request('POST', root, { message: order }, token(), app, {
    'x-org-id': B.id, 'x-tenant-id': B.id, 'x-actor-id': outsider.sub, 'x-role': 'viewer', 'x-request-id': first.id,
  }));
  assert.equal(latest.org_id, A.id);
  assert.equal(latest.created_by, owner.sub);
  assert.notEqual(latest.id, first.id);
  const foreign = created(await post(order, token(outsider)));
  const query = '?state=pending_review&limit=1';
  const summaries = ['created_at', 'created_by', 'current_revision', 'evidence_status', 'id', 'intent', 'language', 'state', 'updated_at', 'version'];
  for (const auth of [token(), token(member)]) {
    const page = await request('GET', root + query, undefined, auth);
    envelope(page, 200);
    assert.deepEqual(page.json.reviews.map(({ id }: Json) => id), [latest.id]);
    assert.deepEqual(Object.keys(page.json.reviews[0]).sort(), summaries);
    const next = await request('GET', root + query + '&before=' + latest.id, undefined, auth);
    assert.deepEqual(next.json.reviews.map(({ id }: Json) => id), [first.id]);
    const timestamp = (await admin.query<{ value: string }>(
      "SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value FROM public.draft_reviews WHERE id=$1",
      [latest.id])).rows[0]!.value;
    const dated = await request('GET', root + query + '&before=' + timestamp, undefined, auth);
    assert.deepEqual(dated.json.reviews.map(({ id }: Json) => id), [first.id]);
  }
  const tenantB = await request('GET', root + query, undefined, token(outsider));
  envelope(tenantB, 200);
  assert.deepEqual(tenantB.json.reviews.map(({ id }: Json) => id), [foreign.id]);
  const foreignCursor = await request('GET', root + query + '&before=' + first.id, undefined, token(outsider));
  assert.deepEqual(foreignCursor.json.reviews, []);
  const missing = randomUUID();
  const beforeCounts = await counts();
  for (const [method, url, payload, decision] of calls(first.id).slice(2)) {
    const cross = await request(method, url, payload, token(outsider), app, { 'x-org-id': A.id });
    const absent = await request(method, url.replace(first.id, missing), payload, token(outsider));
    assert.deepEqual(error(cross, 404, 'NOT_FOUND', decision), error(absent, 404, 'NOT_FOUND', decision));
  }
  assert.deepEqual(await detail(first.id), first);
  assert.deepEqual(await counts(), beforeCounts);
});

test('edits and internal decisions enforce transitions, versions, and idempotent approval', async () => {
  const { id } = created(await post());
  const edited = await edit(id, 1);
  envelope(edited, 200);
  assert.deepEqual([edited.json.review.state, edited.json.review.version, edited.json.review.current_revision], ['edited', 2, 2]);
  error(await edit(id, 1), 409, 'STALE_VERSION');
  error(await approve(id, 1, token(third)), 409, 'STALE_VERSION', true);
  const decision = await approve(id, 2, token(third));
  envelope(decision, 200, true);
  assert.deepEqual([decision.json.review.state, decision.json.review.approved_revision], ['approved_internal', 2]);
  const replay = await approve(id, 2, token(third));
  envelope(replay, 200, true);
  assert.equal(replay.json.idempotent, true);
  assert.deepEqual(replay.json.review, decision.json.review);
  error(await approve(id, 2), 409, 'ILLEGAL_TRANSITION', true);
  error(await edit(id, 3), 409, 'ILLEGAL_TRANSITION');
  error(await reject(id, 3), 409, 'ILLEGAL_TRANSITION', true);
  const review = await detail(id);
  assert.deepEqual(review.events.map(({ event_type }: Json) => event_type), ['created', 'edited', 'approved_internal']);
  assert.deepEqual(review.events.at(-1), {
    event_type: 'approved_internal', from_state: 'edited', to_state: 'approved_internal', revision: 2, review_version: 3,
    actor_id: third.sub, reason_code: null, created_at: review.events.at(-1).created_at,
  });
  for (const reason of REJECT_REASONS) {
    const rejectedId = created(await post()).id;
    const result = await reject(rejectedId, 1, reason);
    envelope(result, 200, true);
    assert.deepEqual([result.json.review.state, result.json.review.decision_reason_code], ['rejected', reason]);
    error(await approve(rejectedId, 2), 409, 'ILLEGAL_TRANSITION', true);
    assert.equal((await detail(rejectedId)).events.at(-1).reason_code, reason);
  }
});

test('competing approval and edit requests commit only one matching version', async () => {
  const approved = created(await post()).id;
  const approvals = await Promise.all([approve(approved, 1), approve(approved, 1, token(third))]);
  assert.deepEqual(approvals.map(({ status }) => status).sort(), [200, 409]);
  error(approvals.find(({ status }) => status === 409)!, 409, 'ILLEGAL_TRANSITION', true);
  assert.equal((await detail(approved)).events.filter(({ event_type }: Json) => event_type === 'approved_internal').length, 1);

  const edited = created(await post()).id;
  const edits = await Promise.all([edit(edited, 1), edit(edited, 1, 'Thank you for your patience.', token(third))]);
  assert.deepEqual(edits.map(({ status }) => status).sort(), [200, 409]);
  error(edits.find(({ status }) => status === 409)!, 409, 'STALE_VERSION');
  const saved = await detail(edited);
  assert.deepEqual(saved, edits.find(({ status }) => status === 200)!.json.review);
  assert.equal(saved.revisions.length, 2);

  const mixed = created(await post()).id;
  const [approval, revision] = await Promise.all([approve(mixed, 1), edit(mixed, 1, safe, token(third))]);
  assert.deepEqual([approval.status, revision.status].sort(), [200, 409]);
  const winner = await detail(mixed);
  assert.equal(winner.version, 2);
  assert.equal(winner.events.length, 2);
  if (approval.status === 200) {
    error(revision, 409, 'ILLEGAL_TRANSITION');
    assert.deepEqual([winner.state, winner.approved_revision, winner.revisions.length], ['approved_internal', 1, 1]);
  } else {
    error(approval, 409, 'STALE_VERSION', true);
    assert.deepEqual([winner.state, winner.approved_revision, winner.revisions.length], ['edited', null, 2]);
    error(await approve(mixed, 1), 409, 'STALE_VERSION', true);
  }
});

test('unsafe edits are withheld with check codes and require a clean revision before approval', async () => {
  const { id } = created(await post());
  let version = 1;
  for (const [text, code] of [
    ['Shipped.', 'order_status'], ['SKU-WIDGET', 'sku'], ['Available stock is 4.', 'unverified_number'],
    ['<script>example()</script>', 'markup_or_contact'], ['example@example.test', 'markup_or_contact'],
    ['https://example.test', 'markup_or_contact'], ['OR\u200bD-1001', 'order_code'], ['Review\u0007 soon.', 'unsafe_characters'],
  ] as const) {
    const response = await edit(id, version++, text);
    envelope(response, 200);
    const review = response.json.review;
    assert.deepEqual([review.state, review.customer_safe_draft], ['blocked', null]);
    assert.ok(review.check_codes.includes(code));
    assert.deepEqual(review, await detail(id));
    assert.equal(review.revisions.at(-1).customer_text, '[Content withheld]');
    assert.ok(!response.raw.includes(text));
    error(await approve(id, version, token(third)), 422, 'BLOCKED_FOR_CUSTOMER_USE', true);
  }
  envelope(await edit(id, version++, safe), 200);
  envelope(await approve(id, version, token(third)), 200, true);
  assert.equal((await detail(id)).state, 'approved_internal');
});

test('strict schemas reject client authority, extra fields, bad cursors, malformed JSON, and oversized input', async () => {
  const { id } = created(await post());
  const beforeCounts = await counts();
  for (const key of ['id', 'review_id', 'org', 'org_id', 'tenant', 'tenant_id', 'user', 'user_id', 'role', 'permission',
    'tool', 'source', 'sources', 'verified', 'ownership', 'ownership_status', 'internal_evidence', 'evidence', 'send',
    'send_enabled', 'state', 'version', 'version_override']) {
    for (const [method, url, body, decision] of calls(id)) {
      if (method === 'GET') error(await request(method, url + '?' + key + '=true'), 400, 'INVALID_REQUEST', decision);
      else error(await request(method, url, { ...body as Json, [key]: true }), 400, 'INVALID_REQUEST', decision);
    }
  }
  for (const query of ['limit=0', 'limit=51', 'limit=1.0', 'limit=01', 'limit=1&limit=2', 'state=approved', 'state=',
    'before=', 'before=2026-02-30T00:00:00Z', 'before=2026-11-18T24:00:00Z', "before='drop", 'before=%ZZ']) {
    error(await request('GET', root + '?' + query), 400, 'INVALID_REQUEST');
  }
  for (const [method, url, body, decision] of calls(id).slice(2)) {
    error(await request(method, url.replace(id, 'not-a-uuid'), body), 400, 'INVALID_REQUEST', decision);
    error(await request(method, url + '?limit=1', body), 400, 'INVALID_REQUEST', decision);
  }
  for (const body of ['{', 'null', '[]', '{}', '{"message":"hello","__proto__":true}', { message: 'x'.repeat(9000) },
    { message: 'x'.repeat(1001) }, { message: '\u200b\u0007' }, { message: '\ud800' }, { message: order, language: 'de' }]) {
    error(await request('POST', root, body), 400, 'INVALID_REQUEST');
  }
  for (const version of [0, -1, 1.5, '1', 2147483648]) {
    error(await request('POST', path(id) + '/approve', { expected_version: version }), 400, 'INVALID_REQUEST', true);
  }
  for (const text of ['', ' '.repeat(10), 'x'.repeat(1501), '\u0000', '\ud800']) {
    error(await edit(id, 1, text), 400, 'INVALID_REQUEST');
  }
  error(await reject(id, 1, 'unsafe'), 400, 'INVALID_REQUEST', true);
  error(await request('GET', path(id), { send: true }), 400, 'INVALID_REQUEST');
  assert.deepEqual(await counts(), beforeCounts);

  const sqlLike = "'; SELECT * FROM synthetic_marker; --";
  const hostile = '<script>syntheticMarker()</script>';
  for (const text of [sqlLike, hostile]) {
    const response = await post(order + ' ' + text);
    created(response);
    assert.ok(!response.raw.includes(text));
  }
  const edited = await edit(id, 1, sqlLike);
  envelope(edited, 200);
  assert.equal(edited.json.review.revisions.at(-1).customer_text, sqlLike);
  assert.equal((await detail(id)).customer_safe_draft.text, sqlLike);
});

test('the default actor and IP budgets count malformed bodies before parsing and ignore forwarding headers', async () => {
  const target = appWith({ limiter: new ToolLimiter(() => 0) });
  const beforeCounts = await counts();
  for (let i = 0; i < 30; i++) error(await request('POST', root, '{', token(), target), 400, 'INVALID_REQUEST');
  const casing = await issueAccessToken({ sub: owner.sub.toUpperCase(), org: owner.org.toUpperCase() }, secret);
  const actorLimited = await request('POST', root, { message: 'x'.repeat(9000) }, casing, target);
  error(actorLimited, 429, 'RATE_LIMITED');
  assert.equal(actorLimited.headers['retry-after'], '60');
  for (const identity of [member, third, outsider]) {
    for (let i = 0; i < 30; i++) envelope(await request('GET', root, undefined, token(identity), target), 200);
  }
  const ipLimited = await request('GET', root, undefined, token(viewer), target, { 'x-forwarded-for': '192.0.2.12' });
  error(ipLimited, 429, 'RATE_LIMITED');
  assert.equal(ipLimited.headers['retry-after'], '60');
  assert.deepEqual(await counts(), beforeCounts);
});

test('review creation enforces both concurrency caps and fails closed on a tool timeout', async () => {
  const entry = registry.get_order_status!;
  let release!: () => void;
  let enteredFirst!: () => void;
  let enteredSecond!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
  const secondEntered = new Promise<void>((resolve) => { enteredSecond = resolve; });
  let entered = 0;
  const target = appWith({
    maxConcurrent: 1, maxGlobal: 2, limits: { toolTimeoutMs: 5000, totalTimeoutMs: 8000 },
    registry: { ...registry, get_order_status: { ...entry, async handler(context, args) {
      if (++entered === 1) enteredFirst();
      if (entered === 2) enteredSecond();
      await gate;
      return entry.handler(context, args);
    } } },
  });
  const active = [post(order, token(), target)];
  try {
    await Promise.race([firstEntered, active[0]!.then(() => assert.fail('first review finished before entering the tool'))]);
    const actorLimited = await post(order, token(), target);
    error(actorLimited, 429, 'TOO_MANY_RUNS');
    assert.equal(actorLimited.headers['retry-after'], '1');
    const second = post(order, token(member), target);
    active.push(second);
    await Promise.race([secondEntered, second.then(() => assert.fail('second review finished before entering the tool'))]);
    const globalLimited = await post(order, token(third), target);
    error(globalLimited, 429, 'TOO_MANY_RUNS');
    assert.equal(globalLimited.headers['retry-after'], '1');
    created(await post(order, token(), appWith({ maxConcurrent: 1, maxGlobal: 1 })));
  } finally {
    release();
    const responses = await Promise.all(active);
    for (const response of responses) created(response);
  }
  created(await post(order, token(), target));

  const timeout = appWith({
    limits: { toolTimeoutMs: 150 },
    registry: { ...registry, get_order_status: { ...entry, async handler(context, args) {
      await context.client.query('SELECT pg_sleep(1)');
      return entry.handler(context, args);
    } } },
  });
  const beforeCounts = await counts();
  error(await post(order, token(), timeout), 504, 'TOOL_TIMEOUT');
  assert.deepEqual((await counts()).slice(0, 3), beforeCounts.slice(0, 3));
});

function failingPool(table: 'draft_review_events' | 'tool_audit_events'): Pool {
  return { async connect() {
    const client = await pool.connect();
    return {
      async query(sql: string, args?: unknown[]) {
        if (sql.startsWith(`INSERT INTO public.${table}`)) throw new Error('synthetic private SQL failure');
        return client.query(sql, args);
      },
      release: (discard?: boolean) => client.release(discard),
    };
  } } as unknown as Pool;
}

test('event write failures roll back every mutation and a tool audit failure prevents creation', async () => {
  const review = created(await post());
  const eventsFail = appWith({}, failingPool('draft_review_events'));
  const auditsFail = appWith({}, failingPool('tool_audit_events'));
  const beforeCounts = await counts();
  error(await post('Hello', token(), eventsFail), 500, 'INTERNAL_ERROR');
  error(await edit(review.id, 1, safe, token(member), eventsFail), 500, 'INTERNAL_ERROR');
  error(await approve(review.id, 1, token(member), eventsFail), 500, 'INTERNAL_ERROR', true);
  error(await reject(review.id, 1, 'other', token(member), eventsFail), 500, 'INTERNAL_ERROR', true);
  error(await post(order, token(), auditsFail), 500, 'AUDIT_UNAVAILABLE');
  assert.deepEqual(await detail(review.id), review);
  assert.deepEqual(await counts(), beforeCounts);
});

test('classification, tool and evidence errors match preview without persisting a review', async () => {
  const orderCall = { kind: 'tool_call', tool: 'get_order_status', arguments: { orderCode: 'ORD-1001' } };
  const entry = registry.get_order_status!;
  const cases: Array<[Overrides, number, string]> = [
    [{ classifier: { name: 'invalid', classify: () => ({ org_id: B.id }) } }, 502, 'CLASSIFIER_ERROR'],
    [{ registry: { ...registry, get_order_status: { ...entry, permission: 'audit:read' } } }, 403, 'FORBIDDEN'],
    [{ adapterFactory: () => new ScriptedMockAdapter([{ output: { ...orderCall, tool: 'unknown_tool' } }]) }, 422, 'UNKNOWN_TOOL'],
    [{ adapterFactory: () => new ScriptedMockAdapter([
      { output: orderCall }, { output: { kind: 'final_answer', template: 'summarize_verified', sourceIds: [B.orders[0]!.id] } },
    ]) }, 502, 'SOURCE_NOT_VERIFIED'],
  ];
  const beforeCounts = await counts();
  for (const [overrides, status, code] of cases) {
    const target = buildApp(keys.env, { pool, review: overrides, support: overrides });
    apps.push(target);
    error(await post(order, token(member), target), status, code);
    const preview = await request('POST', '/support/drafts/preview', { message: order }, token(member), target);
    assert.equal(preview.status, status);
    assert.deepEqual(Object.keys(preview.json).sort(), ['errorCode', 'status', 'traceId']);
    assert.equal(preview.json.errorCode, code);
  }
  assert.deepEqual((await counts()).slice(0, 3), beforeCounts.slice(0, 3));
});

function assertCustomerDisclosure(text: string, evidence: InternalEvidence[], intent: string, label: string) {
  const folded = foldForMatching(text);
  if (intent === 'order_status' || intent === 'low_stock') {
    assert.doesNotMatch(folded, /\d|pending|paid|shipped|cancelled|beklemede|odendi|kargoya verildi|iptal edildi/u, label);
  }
  for (const entry of evidence) {
    const values = entry.kind === 'order_status'
      ? [entry.order_code, entry.status, entry.status_updated_date, entry.source.id]
      : entry.kind === 'low_stock' ? entry.items.flatMap(({ sku, name, source }) => [sku, name, source.id]) : [entry.source.id];
    for (const value of values) assert.ok(!folded.includes(foldForMatching(value)), label);
  }
}

test('all eval-v1 cases retain customer-safe disclosure through creation and persisted revisions', async () => {
  const { items } = JSON.parse(readFileSync('test/fixtures/support/eval-v1.json', 'utf8')) as { items: {
    id: string; language: 'en' | 'tr'; message: string; tenant?: 'A' | 'B'; role?: Role;
    expected: { intent: string; evidence: string };
  }[] };
  assert.equal(items.length, 63);
  for (const { id, language, message, tenant, role = 'owner', expected } of items) {
    const auth = token(actor(tenant === 'B' ? B : A, role));
    const response = await request('POST', root, { language, message }, auth);
    assert.equal(response.status, 201, id + ' ' + response.raw);
    const review = created(response);
    assert.equal(review.language, language, id);
    assert.equal(review.intent, expected.intent, id);
    assert.equal(review.disclosure_decision.ownership_status, 'unverified', id);
    if (['order_lookup', 'low_stock'].includes(expected.evidence) && id !== 'support-03' && id !== 'support-05') {
      assert.ok(review.internal_evidence.length > 0, id);
    }
    assert.deepEqual(await detail(review.id, auth), review);
    assertCustomerDisclosure(review.customer_safe_draft.text, review.internal_evidence, review.intent, id);
    for (const revision of review.revisions) {
      assert.equal(revision.check_status, 'passed', id);
      assertCustomerDisclosure(revision.customer_text, review.internal_evidence, review.intent, id);
    }
  }
});

test('review and tool audit writes and process logs omit raw messages and credentials', async (t) => {
  const marker = 'SyntheticPrivateReview-' + randomUUID();
  const email = 'private-review@example.test';
  const neverRecord = [marker, email, password, secretText, ...tokens.values(),
    ...[A, B].flatMap((tenant) => tenant.users.map((user) => user.email))];
  const stdout = t.mock.method(process.stdout, 'write', () => true);
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  const logged: string[] = [];
  try {
    for (const tenant of [A, B]) for (const role of ['owner', 'member'] as const) {
      for (const message of [order, 'Return policy', 'Check stock']) {
        const auth = token(actor(tenant, role));
        const response = await post([message, marker, email].join(' '), auth);
        const review = created(response);
        const read = await detail(review.id, auth);
        for (const value of neverRecord) {
          assert.ok(!response.raw.includes(value));
          assert.ok(!JSON.stringify(read).includes(value));
        }
      }
    }
  } finally {
    for (const spy of [stdout, stderr]) {
      for (const { arguments: [chunk] } of spy.mock.calls) {
        logged.push(chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk));
      }
      spy.mock.restore();
    }
  }
  for (const value of neverRecord) assert.ok(!logged.join('').includes(value));
  for (const table of tables) {
    const { rows } = await admin.query<{ entry: string }>(`SELECT to_jsonb(t)::text AS entry FROM public.${table} t WHERE created_at >= $1`, [startedAt]);
    for (const { entry } of rows) for (const value of neverRecord) assert.ok(!entry.includes(value), table);
  }
  const { rows } = await admin.query('SELECT e.* FROM public.draft_review_events e WHERE created_at >= $1', [startedAt]);
  assert.ok(rows.length >= 12);
  for (const event of rows) {
    assert.deepEqual(Object.keys(event).sort(), ['actor_id', 'created_at', 'event_type', 'from_state', 'id', 'org_id', 'reason_code',
      'review_id', 'review_version', 'revision', 'to_state']);
    assert.ok([A.id, B.id].includes(event.org_id));
    assert.ok(tokens.has(event.actor_id));
  }
});

test('preview retains its v2 disclosure behavior and review routes expose no delivery surface', async () => {
  const preview = await request('POST', '/support/drafts/preview', { message: order, language: 'en' });
  envelope(preview, 200);
  assert.equal(preview.json.schema_version, 2);
  assertCustomerDisclosure(preview.json.customer_safe_draft.text, preview.json.internal_evidence.entries, 'order_status', 'preview');
  const { id } = created(await post());
  const beforeCounts = await counts();
  for (const url of [path(id) + '/send', '/support/send', path(id) + '/publish']) {
    for (const method of ['POST', 'GET'] as const) assert.equal((await request(method, url)).status, 404);
    assert.equal((await request('POST', url, '{')).status, 404);
  }
  assert.equal((await request('POST', path(id), '{')).status, 404);
  for (const [method, url] of [['HEAD', root], ['HEAD', path(id)], ['PUT', root], ['DELETE', path(id)],
    ['GET', path(id) + '/approve'], ['PATCH', path(id) + '/reject'], ['POST', path(id)]] as const) {
    assert.ok([404, 405].includes((await request(method, url)).status), method + ' ' + url);
  }
  assert.deepEqual(await counts(), beforeCounts);
  assert.deepEqual((await detail(id)).events.map(({ event_type }: Json) => event_type), ['created']);
  assert.doesNotMatch(app.printRoutes({ commonPrefix: false }), /\/support\/.*(?:send|dispatch|publish|webhook|email|sms)/iu);
  for (const name of readdirSync('src', { recursive: true, withFileTypes: true })) {
    if (!name.isFile() || !name.name.endsWith('.ts')) continue;
    const file = name.parentPath + '/' + name.name;
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*(?:nodemailer|sendgrid|twilio|mailgun|postmark|client-ses|client-sns|webhook)[^'"]*['"]/iu, file);
    assert.doesNotMatch(source, /['"]\/support\/(?:[^'"]*\/)?(?:send|dispatch|publish|webhook|email|sms)(?:[/'"])/iu, file);
  }
});
