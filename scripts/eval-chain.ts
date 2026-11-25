import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HTTPMethods } from 'fastify';
import { asSource } from '../src/agent/grounding.js';
import { ScriptedMockAdapter } from '../src/agent/mock/scripted.js';
import type { SourceRef } from '../src/agent/types.js';
import type { InternalEvidence } from '../src/support/disclosure.js';
import { ORDER_STATUS } from '../src/support/draft.js';
import { foldForMatching } from '../src/support/normalize.js';
import { SupportPlanAdapter } from '../src/support/plan.js';
import { createSupportService } from '../src/support/service.js';
import { executeTool } from '../src/tools/gateway.js';
import { registry } from '../src/tools/registry.js';
import type { ToolRegistry } from '../src/tools/types.js';
import { assertSafe, Harness, orderMessage, reviewRoot, send } from '../test/reliability/harness.js';
import { latency, RequestMetrics, writeEvidence } from '../test/reliability/metrics.js';

const fixtureFile = 'test/fixtures/support/eval-v1.json';
const scope = 'Fixed synthetic fixtures with a deterministic rule-based classifier and mock adapters (SupportPlanAdapter and ScriptedMockAdapter). This is not a measurement of LLM or real-world accuracy.';
type Fixture = {
  id: string;
  language: 'en' | 'tr';
  message: string;
  expected: { intent: string; evidence: string; sourceCategory: string; flags?: string[]; ambiguous?: boolean; needsInformation?: boolean };
};
type Review = {
  id: string; org_id: string; intent: string; evidence_status: string; state: string; version: number;
  decided_by: string | null;
  send_enabled: boolean; internal_evidence: InternalEvidence[]; customer_safe_draft: { text: string } | null;
  disclosure_decision: { send_enabled: boolean };
  revisions?: { customer_text: string }[];
};
type Body = { review?: Review; errorCode?: string; send_enabled: boolean; external_effect?: string };
type Check = { name: string; probe: string; passed: boolean };
type Observation = { org: string; runId: string; calls: { tool: string; sources: SourceRef[] }[] };
const hardChecks = new Set(['disclosure', 'tenantIsolation', 'approvalEnforcement', 'noSend']);
const refKey = ({ kind, entity, id }: SourceRef) => `${kind}:${entity}:${id}`;
function evidenceValues(entry: InternalEvidence): string[] {
  switch (entry.kind) {
    case 'order_status': return [entry.order_code, entry.status, entry.status_updated_date, entry.source.id];
    case 'low_stock': return [String(entry.count), String(entry.threshold_applied), String(entry.omitted_count),
      ...entry.items.flatMap(({ sku, name, available_stock, source }) => [sku, name, String(available_stock), source.id])];
    // General verified tenant policy text (topic, version, quote) is intended for customers by the T6 disclosure policy,
    // so only its internal source id is treated as non-customer data. Order and stock values stay fully restricted.
    case 'policy': return [entry.source.id];
  }
}
export const evidenceValuesForTest = evidenceValues;
const containsValue = (text: string, value: string) => {
  const escaped = foldForMatching(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return escaped.length > 0 && new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(foldForMatching(text));
};

// `exempt` holds the customer-intended verified policy quotes of the same response: a restricted value (for example a
// stock quantity such as 30) that only occurs inside such a quote ("30 days") is not a leak.
export const draftLeaks = (text: string, values: string[], exempt: string[] = []) => {
  const stripped = exempt.reduce((rest, quote) => rest.split(quote).join(' '), text);
  return /\b(?:ORD|SKU)-[\p{L}\p{N}]/iu.test(stripped) || values.some((value) => containsValue(stripped, value));
};

export async function evaluateChain() {
  const bytes = await readFile(new URL('../' + fixtureFile, import.meta.url));
  const fixture = JSON.parse(bytes.toString('utf8')) as { synthetic: boolean; items: Fixture[] };
  assert.equal(fixture.synthetic, true);
  assert.ok(fixture.items.length > 0);
  assert.equal(new Set(fixture.items.map(({ id }) => id)).size, fixture.items.length);
  const harness = new Harness();
  const checks: Check[] = [];
  const classification: { id: string; expected: string; actual: string }[] = [];
  const chainTimes: number[] = [];
  const requests = new RequestMetrics();
  const check = (name: string, probe: string, passed: boolean) => checks.push({ name, probe, passed });
  let observation: Observation | undefined;
  let contradict = false;
  let orderRead = 0;
  const order = registry.get_order_status!;
  const observedRegistry: ToolRegistry = { ...registry, get_order_status: { ...order, async handler(context, args) {
    const result = await order.handler(context, args);
    if (contradict && result.status === 'ok' && ++orderRead === 2) {
      return { ...result, data: { ...result.data, status: 'cancelled' } };
    }
    return result;
  } } };
  const orderCall = { kind: 'tool_call', tool: 'get_order_status', arguments: { orderCode: 'ORD-1001' } };
  const service = createSupportService({
    pool: harness.pool, registry: observedRegistry, adapterFactory: (label) => contradict
      ? new ScriptedMockAdapter([{ output: orderCall }, { output: orderCall },
        { output: { kind: 'final_answer', template: 'summarize_verified', sourceIds: [] } }])
      : new SupportPlanAdapter(label),
    async execute(deps, identity, limit, body) {
      const result = await executeTool(deps, identity, limit, body);
      assert.ok(observation && observation.org === identity.org);
      const data = result.body.result as { source?: unknown; items?: { source?: unknown }[] } | undefined;
      const sources = [data?.source, ...(data?.items ?? []).map(({ source }) => source)]
        .map(asSource).filter((source) => source !== undefined);
      observation.calls.push({ tool: String(result.audit?.toolName), sources });
      return result;
    },
  });
  const app = harness.app({ review: { service: (input) => {
    observation = { org: input.identity.org, runId: input.runId, calls: [] };
    return service(input);
  } } });
  const [a, b] = harness.tenants;
  const forbiddenText = [...Object.keys(ORDER_STATUS), ...Object.values(ORDER_STATUS),
    ...harness.tenants.flatMap((tenant) => [
      ...tenant.orders.map(({ code }) => code), ...tenant.products.flatMap(({ sku, stock }) => [sku, String(stock)]),
    ])];
  const privateText = [harness.password, harness.keys.privatePem];

  async function request(probe: string, token: string, method: HTTPMethods, url: string, payload?: unknown) {
    const response = await send(app, token, method, url, payload, {}, requests);
    assertSafe(response.payload, privateText);
    const body = response.json<Body>();
    const decision = /\/(approve|reject)$/u.test(url);
    const sendFlags = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return true;
      return Object.entries(value).every(([key, entry]) => key === 'send_enabled' ? entry === false
        : key === 'external_effect' ? entry === 'none' : sendFlags(entry));
    };
    check('noSend', probe, body.send_enabled === false && (!decision || body.external_effect === 'none') && sendFlags(body));
    if (body.review && Object.hasOwn(body.review, 'customer_safe_draft')) {
      const text = [body.review.customer_safe_draft?.text ?? '', ...(body.review.revisions ?? []).map(({ customer_text }) => customer_text)];
      const values = [...forbiddenText, ...body.review.internal_evidence.flatMap(evidenceValues)];
      const quotes = body.review.internal_evidence.flatMap((entry) => entry.kind === 'policy' ? [entry.quote] : []);
      const versions = body.review.internal_evidence.flatMap((entry) => entry.kind === 'policy' ? [String(entry.version)] : []);
      check('disclosure', probe, text.every((entry) => !draftLeaks(entry, values.filter((value) => !versions.includes(value)), quotes)));
    }
    return { ...body, status: response.statusCode };
  }

  async function create(probe: string, message: string, language: Fixture['language'], tenant: typeof a, token: string) {
    observation = undefined;
    const response = await request(probe, token, 'POST', reviewRoot, { message, language });
    assert.equal(response.status, 201, probe);
    assert.ok(response.review, probe);
    const review = response.review;
    const seen = observation as Observation | undefined;
    assert.ok(seen, probe);
    const foreign = tenant === a ? b : a;
    const ownIds = new Set<string>([...tenant.orders, ...tenant.products, ...tenant.policies].map(({ id }) => id));
    const foreignValues = [
      ...foreign.orders.flatMap(({ id, status, customerRef }) => [id, status, customerRef]),
      ...foreign.products.flatMap(({ id, name }) => [id, name]),
      ...foreign.policies.flatMap(({ id, body, title }) => [id, body, title]),
    ];
    const evidenceText = JSON.stringify(review.internal_evidence);
    const refs = review.internal_evidence.flatMap((entry) => entry.kind === 'low_stock'
      ? entry.items.map(({ source }) => source) : [entry.source]);
    const produced = seen.calls.flatMap(({ sources }) => sources);
    const audit = await harness.admin.query<{ tool_name: string }>(
      'SELECT tool_name FROM public.tool_audit_events WHERE run_id=$1 AND org_id=$2 ORDER BY step', [seen.runId, tenant.id]);
    check('tenantIsolation', probe, review.org_id === tenant.id && !foreignValues.some((value) => evidenceText.includes(value))
      && [...refs, ...produced].every(({ id }) => ownIds.has(id)));
    check('grounding', probe, seen.org === review.org_id && (review.evidence_status !== 'verified' || refs.length > 0)
      && refs.every((ref) => ownIds.has(ref.id) && produced.some((source) => refKey(source) === refKey(ref)))
      && JSON.stringify(audit.rows.map(({ tool_name }) => tool_name)) === JSON.stringify(seen.calls.map(({ tool }) => tool)));
    check('approvalEnforcement', probe, review.state === 'pending_review' || review.state === 'blocked');
    return { review, refs, calls: seen.calls };
  }

  try {
    await harness.seed();
    const [owner, operator, foreignOwner] = await Promise.all([
      harness.token(a.users[0]), harness.token(a.users[1]), harness.token(b.users[0]),
    ]);
    for (const [index, item] of fixture.items.entries()) {
      const started = performance.now();
      const { review, refs, calls } = await create(item.id, item.message, item.language, a, owner);
      const { expected } = item;
      classification.push({ id: item.id, expected: expected.intent, actual: review.intent });
      const missingOrder = expected.evidence === 'order_lookup' && /ORD-9999/iu.test(item.message);
      const sourceCategory = missingOrder ? 'none' : expected.sourceCategory;
      check('sourceReference', item.id, sourceCategory === 'none' ? refs.length === 0
        : refs.length > 0 && refs.every(({ entity }) => entity === sourceCategory));
      if ((expected.evidence === 'none' || expected.ambiguous) && !expected.needsInformation) {
        check('abstention', item.id, review.evidence_status === 'not_required' && calls.length === 0
          && refs.length === 0 && review.internal_evidence.length === 0);
      }
      if (expected.flags?.includes('instruction_like_text')) {
        const toolName = expected.evidence === 'order_lookup' ? 'get_order_status' : 'get_policy_snippet';
        check('injectionAbstention', item.id, expected.evidence === 'none' ? calls.length === 0
          : calls.length === 1 && calls[0]!.tool === toolName && refs.every(({ entity }) => entity === sourceCategory));
      }
      if (missingOrder || expected.needsInformation) {
        check('missingEvidence', item.id, review.evidence_status === (missingOrder ? 'not_found' : 'needs_information')
          && refs.length === 0 && review.internal_evidence.length === 0);
      }
      if (index % 10 === 0) {
        const url = `${reviewRoot}/${review.id}`;
        const payload = { expected_version: review.version };
        const self = await request(item.id, owner, 'POST', url + '/approve', payload);
        check('approvalEnforcement', item.id, self.status === 403 && self.errorCode === 'SELF_APPROVAL_FORBIDDEN');
        const method = index % 20 === 0 ? 'approve' : 'reject';
        const decided = await request(item.id, operator, 'POST', url + '/' + method,
          method === 'approve' ? payload : { ...payload, reason_code: 'other' });
        check('approvalEnforcement', item.id, decided.status === 200
          && decided.review?.state === (method === 'approve' ? 'approved_internal' : 'rejected')
          && decided.review.decided_by === a.users[1]!.id && decided.review.version === review.version + 1);
      }
      chainTimes.push(performance.now() - started);
    }

    for (const [name, message, entity] of [
      ['shared-order', orderMessage, 'order'],
      ['shared-products', 'Check availability', 'product'],
      ['shared-policy', 'Return policy', 'policy_snippet'],
    ] as const) {
      const local = await create(name + '-a', message, 'en', a, owner);
      const remote = await create(name + '-b', message, 'en', b, foreignOwner);
      check('tenantIsolation', name, [local, remote].every(({ refs }) => refs.length > 0 && refs.every((ref) => ref.entity === entity))
        && local.refs.every(({ id }) => !remote.refs.some((ref) => ref.id === id)));
      const cross = await request(name, owner, 'GET', `${reviewRoot}/${remote.review.id}`);
      check('tenantIsolation', name, cross.status === 404 && cross.errorCode === 'NOT_FOUND' && !cross.review);
    }
    const foreignOrderCode = 'ORD-2003';
    const foreignOrderId = randomUUID();
    const foreignOrder = { id: foreignOrderId, code: foreignOrderCode, customerRef: 'SYN-FOREIGN-ONLY', status: 'pending' };
    await harness.admin.query(
      'INSERT INTO public.orders(id,org_id,order_code,customer_ref,status) VALUES($1,$2,$3,$4,$5)',
      [foreignOrder.id, b.id, foreignOrder.code, foreignOrder.customerRef, foreignOrder.status]);
    b.orders.push(foreignOrder);
    const foreignMessage = `Track my order ${foreignOrderCode}`;
    const visible = await create('foreign-order-owner', foreignMessage, 'en', b, foreignOwner);
    const hidden = await create('foreign-order-caller', foreignMessage, 'en', a, owner);
    check('tenantIsolation', 'foreign-only-order', visible.review.evidence_status === 'verified'
      && visible.refs.some(({ id }) => id === foreignOrderId) && hidden.review.evidence_status === 'not_found'
      && hidden.refs.length === 0 && hidden.review.internal_evidence.length === 0);

    const original = await create('blocked', orderMessage, 'en', a, owner);
    const url = `${reviewRoot}/${original.review.id}`;
    const edited = await request('blocked', owner, 'PATCH', url, { expected_version: 1, customer_text: 'ORD-1001 shipped.' });
    check('approvalEnforcement', 'blocked', edited.status === 200 && edited.review?.state === 'blocked'
      && edited.review.customer_safe_draft === null);
    const denied = await request('blocked', operator, 'POST', url + '/approve', { expected_version: 2 });
    check('approvalEnforcement', 'blocked', denied.status === 422 && denied.errorCode === 'BLOCKED_FOR_CUSTOMER_USE');
    const unchanged = await request('blocked', owner, 'GET', url);
    check('approvalEnforcement', 'blocked', unchanged.status === 200 && unchanged.review?.state === 'blocked'
      && unchanged.review.version === 2);

    const warranty = a.policies.find(({ topic }) => topic === 'warranty')!;
    assert.equal((await harness.admin.query('DELETE FROM public.policy_snippets WHERE id=$1 AND org_id=$2', [warranty.id, a.id])).rowCount, 1);
    const missing = await create('missing-policy', 'Warranty coverage', 'en', a, owner);
    check('missingEvidence', 'missing-policy', missing.review.evidence_status === 'not_found'
      && missing.calls.length === 1 && missing.refs.length === 0 && missing.review.internal_evidence.length === 0);

    contradict = true;
    const conflict = await create('contradictory', orderMessage, 'en', a, owner);
    check('contradictoryEvidence', 'contradictory', orderRead === 2 && conflict.review.evidence_status === 'contradictory'
      && conflict.refs.length === 0 && conflict.review.internal_evidence.length === 0);
  } finally {
    await harness.close();
  }

  const confusion: Record<string, Record<string, number>> = {};
  for (const { expected, actual } of classification) {
    const row = confusion[expected] ??= {};
    row[actual] = (row[actual] ?? 0) + 1;
  }
  const metrics: Record<string, { passed: number; total: number }> = {};
  for (const { name, passed } of checks) {
    const metric = metrics[name] ??= { passed: 0, total: 0 };
    metric.total++;
    if (passed) metric.passed++;
  }
  const correct = classification.filter(({ expected, actual }) => expected === actual).length;
  return {
    metadata: { date: new Date().toISOString(), node: process.version, fixture: fixtureFile,
      sha256: createHash('sha256').update(bytes).digest('hex'), itemCount: fixture.items.length, scope },
    deterministic: { classification, correct, accuracy: correct / classification.length, confusion, metrics,
      failures: checks.filter(({ passed }) => !passed) },
    hardFailures: checks.filter(({ name, passed }) => hardChecks.has(name) && !passed),
    chainLatency: { count: chainTimes.length, ...latency(chainTimes) },
    requests: requests.summary(),
  };
}

export function renderMarkdown(result: Awaited<ReturnType<typeof evaluateChain>>, reproducible: boolean) {
  const { metadata, deterministic, chainLatency } = result;
  return [
    '# Chain evaluation results', '', scope, '',
    `- Run date ${metadata.date}`, `- Node ${metadata.node}`, `- Fixture ${metadata.fixture}`,
    `- SHA-256 ${metadata.sha256}`, `- Items ${metadata.itemCount}`,
    `- Reproducible outcomes ${reproducible}`, '', '| Check | Passed | Total |', '|---|---:|---:|',
    `| Exact intent | ${deterministic.correct} | ${metadata.itemCount} |`,
    ...Object.entries(deterministic.metrics).map(([name, { passed, total }]) => `| ${name} | ${passed} | ${total} |`),
    '', '| Expected intent | Actual intent | Count |', '|---|---|---:|',
    ...Object.entries(deterministic.confusion).flatMap(([expected, row]) =>
      Object.entries(row).map(([actual, count]) => `| ${expected} | ${actual} | ${count} |`)),
    '', `Whole-chain median ${chainLatency.medianMs?.toFixed(2) ?? 'n/a'} ms and p95 ${chainLatency.p95Ms?.toFixed(2) ?? 'n/a'} ms.`,
    '', `Hard invariant failures ${result.hardFailures.length}.`, '',
  ].join('\n');
}

async function main() {
  const result = await evaluateChain();
  const repeated = await evaluateChain();
  const reproducible = JSON.stringify(result.deterministic) === JSON.stringify(repeated.deterministic);
  const summary = { ...result, reproducible };
  const markdown = renderMarkdown(result, reproducible);
  await writeEvidence('eval-chain.json', summary);
  if (process.argv.includes('--write-doc')) await writeFile('docs/portfolio/EVAL_CHAIN_RESULTS.md', markdown);
  process.stdout.write(JSON.stringify(summary) + '\n\n' + markdown);
  if (!reproducible || result.hardFailures.length || repeated.hardFailures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    process.stderr.write('Chain evaluation could not finish. Run the evaluation test for failure locations.\n');
    process.exitCode = 1;
  });
}
