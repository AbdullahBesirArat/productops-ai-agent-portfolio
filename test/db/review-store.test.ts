import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { loadDatabaseConfig } from '../../src/config.js';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runSeed } from '../../src/db/seed.js';
import { SEED_TENANTS } from '../../src/db/seed-data.js';
import { withTenant } from '../../src/db/tenant.js';
import { canTransition, REVIEW_STATES, type ReviewState } from '../../src/support/review-states.js';
import {
  approveReview, createReview, editReview, getReview, listReviews, rejectReview,
  type DraftReview, type ReviewArtifact, type ReviewResult,
} from '../../src/support/review-store.js';
import { createSupportService } from '../../src/support/service.js';
import type { Identity } from '../../src/tools/gateway.js';

const runtime = loadDatabaseConfig(process.env.PRODUCTOPS_TEST_DB_URL, 'productops_app');
const migrator = loadDatabaseConfig(process.env.PRODUCTOPS_MIGRATOR_TEST_DB_URL, 'productops_migrator');
const bootstrap = loadDatabaseConfig(process.env.PRODUCTOPS_BOOTSTRAP_TEST_DB_URL, 'productops_bootstrap');
for (const config of [runtime, migrator, bootstrap]) assert.equal(config.database, 'productops_test');
const password = process.env.PRODUCTOPS_DEMO_PASSWORD;
assert.ok(password);

const A = SEED_TENANTS[0]!;
const B = SEED_TENANTS[1]!;
function actor(tenant: typeof A, role: string): Identity {
  return { org: tenant.id, sub: tenant.users.find((user) => user.role === role)!.id };
}
const owner = actor(A, 'owner');
const member = actor(A, 'member');
const viewer = actor(A, 'viewer');
const outsider = actor(B, 'owner');
const third = { org: A.id, sub: randomUUID() };
const marker = 'SYNTHETIC_RAW_CUSTOMER_MESSAGE_MARKER';
const safe = 'Our team will be in touch.';
let pool: Pool;
let admin: Pool;
let startedAt: Date;
let artifact: ReviewArtifact;

function value<T>(result: ReviewResult<T> | { code: 'idempotent'; value: T }): T {
  assert.equal(result.code, 'ok');
  return result.value;
}

before(async () => {
  startedAt = new Date();
  await runMigrations(migrator);
  await runSeed(bootstrap, password);
  pool = createPool(runtime);
  admin = createPool(bootstrap);
  await admin.query('INSERT INTO public.users (id, email) VALUES ($1,$2)', [third.sub, third.sub + '@example.test']);
  await admin.query("INSERT INTO public.memberships (org_id, user_id, role) VALUES ($1,$2,'member')", [third.org, third.sub]);
  const result = await createSupportService({ pool })({
    message: marker, identity: owner, language: 'en', runId: randomUUID(), traceId: randomUUID(),
  });
  assert.equal(result.ok, true);
  artifact = result;
});

after(async () => {
  if (admin) {
    await admin.query("DELETE FROM public.draft_reviews WHERE org_id IN ($1,$2) AND created_at >= $3::timestamptz - interval '10 minutes'",
      [A.id, B.id, startedAt]);
    await admin.query('DELETE FROM public.users WHERE id=$1', [third.sub]);
  }
  await Promise.all([pool?.end(), admin?.end()]);
});

async function newReview(identity = owner) {
  return value(await createReview(pool, identity, artifact));
}

const edit = (review: DraftReview, identity = member, text = safe) =>
  editReview(pool, identity, review.id, { expectedVersion: review.version, text });
const approve = (review: DraftReview, identity = member) =>
  approveReview(pool, identity, review.id, { expectedVersion: review.version });
const reject = (review: DraftReview, identity = owner) =>
  rejectReview(pool, identity, review.id, { expectedVersion: review.version, reason: 'other' });
const detail = async (review: DraftReview) => value(await getReview(pool, owner, review.id));
const withActor = <T>(db: Pool, identity: Identity, operation: (client: PoolClient) => Promise<T>) =>
  withTenant(db, identity.org, operation, { actorId: identity.sub, statementTimeoutMs: 3000 });

async function revisionSQL(client: PoolClient, review: DraftReview, revision: number, author: string, status: 'passed' | 'blocked' = 'passed') {
  return client.query(
    "INSERT INTO public.draft_revisions (review_id, org_id, revision, author_id, kind, customer_text, text_sha256, check_status) VALUES ($1,$2,$3,$4,'operator',$5,$6,$7)",
    [review.id, review.org_id, revision, author, safe, createHash('sha256').update(safe).digest('hex'), status]);
}

function transitionSQL(client: PoolClient, review: DraftReview, target: ReviewState, actorId: string,
  revision = target === 'edited' || target === 'blocked' ? review.current_revision + 1 : review.current_revision,
  approvedRevision = revision, version = review.version + 1) {
  const terminal = target === 'approved_internal' || target === 'rejected';
  return client.query(
    'UPDATE public.draft_reviews SET state=$2, version=$3, current_revision=$4, approved_revision=$5, decided_by=$6, decided_at=CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END, decision_reason_code=$7 WHERE id=$1',
    [review.id, target, version, revision, target === 'approved_internal' ? approvedRevision : null,
      terminal ? actorId : null, target === 'rejected' ? 'other' : null]);
}

async function reviewInState(state: ReviewState): Promise<DraftReview> {
  const draft = await newReview();
  switch (state) {
    case 'edited': return value(await edit(draft));
    case 'blocked': return value(await edit(draft, member, 'Shipped.'));
    case 'approved_internal': return value(await approve(draft));
    case 'rejected': return value(await reject(draft));
    case 'pending_review': return draft;
  }
}

test('create, edit, approve, and reject record ordered immutable revisions and redacted events', async () => {
  const initial = await newReview();
  const edited = value(await edit(initial));
  const approved = value(await approve(edited, third));
  assert.deepEqual([approved.state, approved.version, approved.approved_revision, approved.send_enabled],
    ['approved_internal', 3, 2, false]);
  const stored = await detail(approved);
  assert.deepEqual(stored.revisions.map(({ revision, kind, author_id, check_status }) => [revision, kind, author_id, check_status]),
    [[1, 'system', owner.sub, 'passed'], [2, 'operator', member.sub, 'passed']]);
  assert.deepEqual(stored.events.map(({ event_type, from_state, to_state, review_version, revision }) =>
    [event_type, from_state, to_state, review_version, revision]), [
    ['created', null, 'pending_review', 1, 1], ['edited', 'pending_review', 'edited', 2, 2],
    ['approved_internal', 'edited', 'approved_internal', 3, 2],
  ]);
  assert.equal(stored.revisions[1]?.text_sha256, createHash('sha256').update(safe).digest('hex'));
  assert.ok(!JSON.stringify(stored).includes(marker));
  const replay = await approve(edited, third);
  assert.equal(replay.code, 'idempotent');
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.value, approved);
  assert.equal((await approve(edited, member)).code, 'illegal_transition');
  assert.equal((await approve(initial, third)).code, 'illegal_transition');
  const rejection = await newReview();
  const rejected = value(await reject(rejection));
  assert.equal(rejected.decision_reason_code, 'other');
  const rejectReplay = await reject(rejection);
  assert.equal(rejectReplay.code, 'idempotent');
  assert.deepEqual(rejectReplay.value, rejected);
  assert.equal((await reject(rejection, member)).code, 'illegal_transition');
  assert.equal((await detail(rejected)).events.length, 2);
  assert.equal((await detail(approved)).events.length, 3);
});

test('each state pair agrees with the real transition trigger and the available store operations', async () => {
  for (const from of REVIEW_STATES) {
    for (const to of REVIEW_STATES) {
      const allowed = canTransition(from, to);
      const label = from + ' -> ' + to;
      const draft = await reviewInState(from);
      const raw = () => withActor(admin, third, async (client) => {
        if (allowed && (to === 'edited' || to === 'blocked')) {
          await revisionSQL(client, draft, draft.current_revision + 1, third.sub, to === 'edited' ? 'passed' : 'blocked');
        }
        return transitionSQL(client, draft, to, third.sub);
      });
      if (allowed) {
        assert.equal((await raw()).rowCount, 1, label);
      } else {
        await assert.rejects(raw(), { code: 'P0001', message: 'illegal_transition' }, label);
      }

      const atStore = await reviewInState(from);
      if (to === 'pending_review') {
        // Creation always allocates a different review. There is no reset operation.
        assert.notEqual((await newReview()).id, atStore.id, label);
        assert.equal((await detail(atStore)).review.state, from, label);
        continue;
      }
      const result = to === 'edited' ? await edit(atStore, third)
        : to === 'blocked' ? await edit(atStore, third, 'Shipped.')
          : to === 'approved_internal' ? await approve(atStore, third) : await reject(atStore, third);
      const expected = from === 'blocked' && to === 'approved_internal' ? 'blocked_for_customer_use' : 'illegal_transition';
      assert.equal(result.code, allowed ? 'ok' : expected, label);
      assert.equal((await detail(atStore)).review.state, allowed ? to : from, label);
    }
  }
});

test('separation of duties, stale versions, and the current approved revision are enforced', async () => {
  const draft = await newReview();
  assert.equal((await approve(draft, owner)).code, 'self_approval_forbidden');
  await assert.rejects(withActor(pool, owner, (client) => transitionSQL(client, draft, 'approved_internal', owner.sub)),
    { code: 'P0001', message: 'self_approval' });
  const edited = value(await edit(draft));
  assert.equal((await approve(edited, member)).code, 'self_approval_forbidden');
  await assert.rejects(withActor(pool, member, (client) => transitionSQL(client, edited, 'approved_internal', member.sub)),
    { code: 'P0001', message: 'self_approval' });
  assert.equal((await approve(draft, third)).code, 'stale_version');
  assert.equal((await edit(draft, third)).code, 'stale_version');
  assert.equal((await reject(draft)).code, 'stale_version');
  await assert.rejects(withActor(pool, third, (client) => transitionSQL(client, edited, 'approved_internal', third.sub, 2, 1)),
    { code: 'P0001', message: 'invalid_revision' });
  await assert.rejects(withActor(pool, third, (client) => transitionSQL(client, edited, 'approved_internal', third.sub, 2, 2, 99)),
    { code: 'P0001', message: 'stale_version' });
  assert.equal(value(await approve(edited, third)).approved_revision, 2);
  assert.equal((await edit(edited)).code, 'illegal_transition');
});

test('competing approvers, editors, and approve-vs-edit operations each have one winner', async () => {
  const cases = [
    { run: (draft: DraftReview) => Promise.all([approve(draft), approve(draft, third)]), events: ['approved_internal'] },
    { run: (draft: DraftReview) => Promise.all([edit(draft), edit(draft, third)]), events: ['edited'] },
    { run: (draft: DraftReview) => Promise.all([approve(draft), edit(draft, third)]), events: ['approved_internal', 'edited'] },
  ];
  for (const { run, events } of cases) {
    const draft = await newReview();
    const results = await run(draft);
    assert.equal(results.filter((result) => result.code === 'ok').length, 1);
    assert.equal(results.filter((result) => ['stale_version', 'illegal_transition'].includes(result.code)).length, 1);
    const stored = await detail(draft);
    assert.equal(stored.review.version, 2);
    assert.equal(stored.events.length, 2);
    assert.ok(events.includes(stored.events[1]!.event_type));
    assert.equal(stored.revisions.length, stored.review.state === 'edited' ? 2 : 1);
  }
});

test('current membership gates every store operation and tenant scoping hides foreign IDs', async () => {
  const draft = await newReview();
  async function assertDenied(identity: Identity) {
    const results = await Promise.all([createReview(pool, identity, artifact), getReview(pool, identity, draft.id),
      listReviews(pool, identity), edit(draft, identity), approve(draft, identity), reject(draft, identity)]);
    assert.ok(results.every(({ code }) => code === 'forbidden'), JSON.stringify(results));
  }
  await assertDenied(viewer);
  try {
    await admin.query("UPDATE public.memberships SET role='viewer' WHERE org_id=$1 AND user_id=$2", [third.org, third.sub]);
    await assertDenied(third);
    await admin.query('DELETE FROM public.memberships WHERE org_id=$1 AND user_id=$2', [third.org, third.sub]);
    await assertDenied(third);
  } finally {
    await admin.query("INSERT INTO public.memberships (org_id,user_id,role) VALUES ($1,$2,'member') ON CONFLICT (org_id,user_id) DO UPDATE SET role=excluded.role",
      [third.org, third.sub]);
  }
  for (const result of await Promise.all([getReview(pool, outsider, draft.id), edit(draft, outsider),
    approve(draft, outsider), reject(draft, outsider), getReview(pool, owner, randomUUID())])) {
    assert.deepEqual(result, { code: 'not_found' });
  }
  assert.equal((await detail(draft)).events.length, 1);
  assert.equal(value(await listReviews(pool, outsider)).some((entry) => entry.id === draft.id), false);
});

test('list filters and pages deterministically within the tenant', async () => {
  const early = await newReview();
  const first = await newReview();
  value(await reject(first));
  const late = await newReview();
  const page = value(await listReviews(pool, owner, { state: 'pending_review', limit: 1 }));
  assert.equal(page[0]?.id, late.id);
  const next = value(await listReviews(pool, owner, { state: 'pending_review', limit: 1, before: late.id }));
  assert.equal(next.length, 1);
  assert.equal(next[0]?.id, early.id);
  assert.equal(next[0]?.state, 'pending_review');
  assert.ok(value(await listReviews(pool, owner, { state: 'rejected', limit: 1 })).some((entry) => entry.id === first.id));
});

test('runtime SQL cannot mutate immutable data or forge actor and organization provenance', async () => {
  const draft = await newReview();
  for (const sql of [
    'UPDATE public.draft_reviews SET internal_evidence=internal_evidence WHERE id=$1',
    'UPDATE public.draft_reviews SET send_enabled=true WHERE id=$1',
    'DELETE FROM public.draft_reviews WHERE id=$1',
    'UPDATE public.draft_revisions SET customer_text=customer_text WHERE review_id=$1',
    'DELETE FROM public.draft_revisions WHERE review_id=$1',
    'UPDATE public.draft_review_events SET actor_id=actor_id WHERE review_id=$1',
    'DELETE FROM public.draft_review_events WHERE review_id=$1',
  ]) {
    await assert.rejects(withActor(pool, owner, (client) => client.query(sql, [draft.id])), { code: '42501' });
  }
  await assert.rejects(withActor(pool, owner, (client) => revisionSQL(client, draft, 2, member.sub)), { code: '42501' });
  await assert.rejects(withActor(pool, owner, (client) => revisionSQL(client, draft, 3, owner.sub)),
    { code: 'P0001', message: 'invalid_revision' });
  await assert.rejects(withActor(pool, outsider, (client) => revisionSQL(client, draft, 2, outsider.sub)),
    { code: 'P0001', message: 'illegal_transition' });
  const event = "INSERT INTO public.draft_review_events (review_id,org_id,actor_id,event_type,to_state,revision,review_version) VALUES ($1,$2,$3,'created','pending_review',1,1)";
  await assert.rejects(withActor(pool, owner, (client) => client.query(event, [draft.id, A.id, member.sub])), { code: '42501' });
  await withTenant(pool, A.id, async (client) => {
    for (const sql of ['SELECT id FROM public.draft_reviews WHERE id=$1', 'SELECT id FROM public.draft_revisions WHERE review_id=$1',
      'SELECT id FROM public.draft_review_events WHERE review_id=$1']) {
      assert.equal((await client.query(sql, [draft.id])).rowCount, 0);
    }
  });
  await assert.rejects(withTenant(pool, A.id, (client) => client.query(event, [draft.id, A.id, owner.sub])), { code: '42501' });
  const insertReview = "INSERT INTO public.draft_reviews (org_id,created_by,intent,language,evidence_status,state,internal_evidence,disclosure) VALUES ($1,$2,'unknown','en','not_required','pending_review','[]','{}')";
  await assert.rejects(withTenant(pool, A.id, (client) => client.query(insertReview, [A.id, owner.sub])), { code: '42501' });
  await assert.rejects(withTenant(pool, A.id, (client) => revisionSQL(client, draft, 2, owner.sub)),
    { code: 'P0001', message: 'illegal_transition' });
  assert.equal((await detail(draft)).events.length, 1);
});

test('bootstrap cannot defeat fixed disclosure fields or change immutable review columns', async () => {
  for (const sql of [
    "INSERT INTO public.draft_reviews (org_id,created_by,intent,language,evidence_status,state,internal_evidence,disclosure,send_enabled) VALUES ($1,$2,'unknown','en','not_required','pending_review','[]','{}',true)",
    "INSERT INTO public.draft_reviews (org_id,created_by,intent,language,evidence_status,state,internal_evidence,disclosure,ownership_status) VALUES ($1,$2,'unknown','en','not_required','pending_review','[]','{}','verified')",
    "INSERT INTO public.draft_reviews (org_id,created_by,intent,language,evidence_status,state,internal_evidence,disclosure,customer_specific_details_allowed) VALUES ($1,$2,'unknown','en','not_required','pending_review','[]','{}',true)",
  ]) {
    await assert.rejects(admin.query(sql, [A.id, owner.sub]), { code: '23514' });
  }
  const draft = await newReview();
  for (const sql of [
    'UPDATE public.draft_reviews SET send_enabled=true WHERE id=$1',
    "UPDATE public.draft_reviews SET ownership_status='verified' WHERE id=$1",
    'UPDATE public.draft_reviews SET customer_specific_details_allowed=true WHERE id=$1',
  ]) {
    await assert.rejects(admin.query(sql, [draft.id]), { code: 'P0001', message: 'immutable_review' });
  }
});

test('disclosure failures retain codes, allow a safe correction, and are rechecked before approval', async () => {
  let review = await newReview();
  for (const [text, code] of [
    ['Shipped.', 'order_status'], ['SKU-WIDGET', 'sku'], ['Available stock is 4.', 'unverified_number'],
    ['OR\u200bD-1001', 'order_code'], ['<b>Information</b>', 'markup_or_contact'], ['a@example.test', 'markup_or_contact'],
  ] as const) {
    review = value(await edit(review, member, text));
    assert.equal(review.state, 'blocked');
    const latest = (await detail(review)).revisions.at(-1)!;
    assert.equal(latest.check_status, 'blocked');
    assert.ok(latest.check_codes.includes(code));
    assert.ok(!latest.customer_text.includes(text));
    assert.equal((await approve(review, third)).code, 'blocked_for_customer_use');
  }
  const clean = value(await edit(review));
  assert.equal(clean.state, 'edited');
  assert.equal(value(await approve(clean, third)).state, 'approved_internal');

  const compromised = await newReview();
  await admin.query("UPDATE public.draft_revisions SET customer_text='Shipped.' WHERE review_id=$1", [compromised.id]);
  const failure = await approve(compromised);
  assert.equal(failure.code, 'blocked_for_customer_use');
  assert.equal(failure.errorCode, 'BLOCKED_FOR_CUSTOMER_USE');
  const stored = await detail(compromised);
  assert.deepEqual([stored.review.state, stored.review.version, stored.review.current_revision], ['blocked', 2, 2]);
  assert.equal(stored.events.at(-1)?.event_type, 'edit_blocked');
  assert.ok(stored.revisions.at(-1)?.check_codes.includes('order_status'));
});

test('an event write failure rolls back creation, revision insertion, state and decision changes', async () => {
  const failingPool = { connect: async () => {
    const client = await pool.connect();
    return {
      query: async (sql: string, args?: unknown[]) => {
        if (sql.startsWith('INSERT INTO public.draft_review_events')) throw new Error('private synthetic SQL failure');
        return client.query(sql, args);
      },
      release: (discard?: boolean) => client.release(discard),
    };
  } } as unknown as Pool;
  const draft = await newReview();
  const beforeDetail = await detail(draft);
  const count = async () => (await admin.query('SELECT count(*)::int AS n FROM public.draft_reviews WHERE org_id=$1', [A.id])).rows[0].n;
  const beforeCount = await count();
  const error = { message: 'Draft review transaction failed' };
  await assert.rejects(createReview(failingPool, owner, artifact), error);
  await assert.rejects(editReview(failingPool, member, draft.id, { expectedVersion: 1, text: safe }), error);
  await assert.rejects(approveReview(failingPool, member, draft.id, { expectedVersion: 1 }), error);
  await assert.rejects(rejectReview(failingPool, owner, draft.id, { expectedVersion: 1, reason: 'other' }), error);
  assert.deepEqual(await detail(draft), beforeDetail);
  assert.equal(await count(), beforeCount);
});

test('a reused connection clears tenant, actor and statement timeout after review transactions', async () => {
  const single = createPool(runtime);
  single.options.max = 1;
  const context = "SELECT public.app_current_org() AS org, public.app_current_actor() AS actor, current_setting('statement_timeout') AS timeout, pg_backend_pid() AS pid";
  try {
    const baseline = (await single.query(context)).rows[0];
    assert.deepEqual([baseline.org, baseline.actor], [null, null]);
    const draft = value(await createReview(single, outsider, artifact));
    assert.equal((await getReview(single, owner, draft.id)).code, 'not_found');
    assert.equal((await getReview(single, outsider, draft.id)).code, 'ok');
    assert.deepEqual((await single.query(context)).rows[0], baseline);
    assert.equal((await single.query('SELECT id FROM public.draft_reviews WHERE id=$1', [draft.id])).rowCount, 0);
  } finally {
    await single.end();
  }
});
