import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { buildCustomerSafeDraft, validateCustomerText, type InternalEvidence } from '../src/support/disclosure.js';
import { canTransition, isRejectReason, isReviewState, REVIEW_STATES } from '../src/support/review-states.js';
import { approveReview, editReview, getReview, listReviews, mapReviewDatabaseError, rejectReview } from '../src/support/review-store.js';

test('every review state pair has the prescribed outcome', () => {
  const expected = ['01111', '01111', '01101', '00000', '00000'];
  for (const [index, from] of REVIEW_STATES.entries()) {
    assert.equal(REVIEW_STATES.map((to) => Number(canTransition(from, to))).join(''), expected[index], from);
    assert.ok(isReviewState(from));
  }
  assert.equal(isReviewState('approved'), false);
  assert.equal(isRejectReason('unsafe_disclosure'), true);
  assert.equal(isRejectReason('arbitrary text'), false);
});

test('invalid inputs and viewer denials stop after the current membership query', async () => {
  const id = '00000000-0000-0000-0000-000000000001';
  const identity = { org: id, sub: id };
  let role = 'member';
  let membershipReads = 0;
  const pool = { connect: async () => ({
    query: async (sql: string) => {
      if (sql.startsWith('SELECT role FROM public.memberships')) {
        membershipReads++;
        return { rows: [{ role }] };
      }
      assert.match(sql, /^(?:BEGIN$|COMMIT$|SELECT set_config\()/u);
      return { rows: [] };
    },
    release: () => undefined,
  }) } as unknown as Pool;

  assert.equal((await getReview(pool, identity, 'invalid')).code, 'invalid_input');
  for (const text of ['', '    ', 1, 'x'.repeat(1501), 'before\u0000after']) {
    assert.equal((await editReview(pool, identity, id, { expectedVersion: 1, text })).code, 'invalid_input');
  }
  for (const expectedVersion of [0, -1, 1.5, Infinity, 2147483648, '1', null]) {
    assert.equal((await approveReview(pool, identity, id, { expectedVersion })).code, 'invalid_input');
  }
  assert.equal((await rejectReview(pool, identity, id, { expectedVersion: 1, reason: 'free text' })).code, 'invalid_input');
  for (const options of [{ limit: 51 }, { limit: 0 }, { limit: 1.5 }, { before: 'invalid' }]) {
    assert.equal((await listReviews(pool, identity, options)).code, 'invalid_input');
  }
  role = 'viewer';
  assert.equal((await getReview(pool, identity, 'invalid')).code, 'forbidden');
  assert.equal(membershipReads, 19);
});

test('only known database trigger messages map to stable public errors', () => {
  const expected = {
    stale_version: 'stale_version', self_approval: 'self_approval_forbidden',
    illegal_transition: 'illegal_transition', immutable_review: 'illegal_transition',
    invalid_revision: 'illegal_transition', invalid_decision: 'illegal_transition',
    blocked_for_customer_use: 'blocked_for_customer_use',
  };
  for (const [message, code] of Object.entries(expected)) {
    assert.equal(mapReviewDatabaseError({ code: 'P0001', message, detail: 'private' })?.code, code);
  }
  assert.equal(mapReviewDatabaseError({ code: '42501', message: 'self_approval' }), undefined);
  assert.equal(mapReviewDatabaseError({ code: 'P0001', message: 'unknown SQL detail' }), undefined);
  assert.equal(mapReviewDatabaseError(null), undefined);
});

test('current policy drafts and previously stored Turkish quotes pass disclosure validation', () => {
  const evidence: InternalEvidence[] = [{ kind: 'policy', topic: 'returns', version: 42, quote: 'Contact our team.',
    truncated: false, source: { kind: 'postgres', entity: 'policy_snippet', id: 'fixture' } }];
  const classification = { intent: 'returns', ambiguous: false } as Parameters<typeof buildCustomerSafeDraft>[0]['classification'];
  for (const language of ['en', 'tr'] as const) {
    const draft = buildCustomerSafeDraft({ language, classification, evidenceStatus: 'verified', internalEvidence: evidence });
    assert.deepEqual(validateCustomerText(draft.text, evidence, language), { ok: true });
    const quoted = language === 'tr' ? 'Doğrulanan politika metni (sürüm 42): “Contact our team.”' : draft.text;
    assert.deepEqual(validateCustomerText(quoted, evidence, language), { ok: true });
    assert.deepEqual(validateCustomerText(quoted.replace('42', '43'), evidence, language),
      { ok: false, codes: ['unverified_number'] });
  }
});

test('operator text may differ from the review language and still must pass disclosure checks', () => {
  assert.deepEqual(validateCustomerText('Our team will review your request.', [], 'tr'), { ok: true });
  assert.deepEqual(validateCustomerText('Ekibimiz talebinizi inceleyecek.', [], 'en'), { ok: true });
  assert.deepEqual(validateCustomerText('Shipped', [], 'tr'), { ok: false, codes: ['order_status'] });
});
