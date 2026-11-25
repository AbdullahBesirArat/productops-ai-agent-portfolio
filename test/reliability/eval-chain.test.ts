import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftLeaks, evaluateChain, evidenceValuesForTest } from '../../scripts/eval-chain.js';

test('review chain hard invariants and deterministic outcomes', { timeout: 55_000 }, async () => {
  const first = await evaluateChain();
  const second = await evaluateChain();
  assert.equal(first.metadata.sha256, second.metadata.sha256);
  assert.deepEqual(first.deterministic, second.deterministic);
  assert.equal(first.deterministic.classification.length, first.metadata.itemCount);
  for (const check of ['disclosure', 'tenantIsolation', 'approvalEnforcement', 'noSend']) {
    assert.ok(first.deterministic.metrics[check]?.total, `Missing hard check ${check}`);
  }
  assert.deepEqual(first.hardFailures, [], 'Review chain violated a hard invariant');
});

test('disclosure checker flags order and stock leaks but allows policy text', () => {
  const order = evidenceValuesForTest({ kind: 'order_status', order_code: 'ORD-9001', status: 'shipped', status_updated_date: '2026-11-17', source: { kind: 'postgres', entity: 'order', id: 'id-1' } } as never);
  const stock = evidenceValuesForTest({ kind: 'low_stock', count: 1, threshold_applied: 5, omitted_count: 0, items: [{ sku: 'SKU-AB1', name: 'Blue Lamp', available_stock: 3, source: { kind: 'postgres', entity: 'product', id: 'id-2' } }] } as never);
  const policy = evidenceValuesForTest({ kind: 'policy', topic: 'returns', version: 2, quote: 'Returns are accepted within 14 days.', truncated: false, source: { kind: 'postgres', entity: 'policy_snippet', id: 'id-3' } } as never);
  for (const text of ['Your order ORD-9001 is on its way', 'It has shipped', 'Updated 2026-11-17', 'We have SKU-AB1', 'Blue Lamp is low', 'Only 3 left']) {
    assert.equal(draftLeaks(text, [...order, ...stock]), true, text);
  }
  assert.equal(draftLeaks('Returns are accepted within 14 days. (policy version 2)', policy), false);
  assert.equal(draftLeaks('A team member will follow up.', [...order, ...stock]), false);
});
