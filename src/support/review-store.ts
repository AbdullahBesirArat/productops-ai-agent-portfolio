import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { can, isRole, type Permission } from '../auth/permissions.js';
import { withTenant } from '../db/tenant.js';
import type { Identity } from '../tools/gateway.js';
import { validateCustomerText, type DisclosureDecision, type InternalEvidence, type Language } from './disclosure.js';
import { canTransition, isRejectReason, isReviewState, isTerminal, type RejectReason, type ReviewState } from './review-states.js';
import type { createSupportService } from './service.js';

type Preview = Extract<Awaited<ReturnType<ReturnType<typeof createSupportService>>>, { ok: true }>;
export type ReviewArtifact = Pick<Preview, 'classification' | 'customerDraft' | 'evidenceStatus' | 'internalEvidence' | 'operatorNotes' | 'disclosure'>;

export interface DraftReview {
  id: string;
  org_id: string;
  created_by: string;
  intent: Preview['classification']['intent'];
  language: Language;
  evidence_status: Preview['evidenceStatus'];
  state: ReviewState;
  version: number;
  current_revision: number;
  approved_revision: number | null;
  ownership_status: 'unverified';
  customer_specific_details_allowed: false;
  send_enabled: false;
  internal_evidence: InternalEvidence[];
  internal_operator_notes: string[];
  disclosure: DisclosureDecision;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason_code: RejectReason | null;
  created_at: Date;
  updated_at: Date;
}

export interface DraftRevision {
  id: string;
  review_id: string;
  org_id: string;
  revision: number;
  author_id: string;
  kind: 'system' | 'operator';
  customer_text: string;
  text_sha256: string;
  check_status: 'passed' | 'blocked';
  check_codes: string[];
  created_at: Date;
}

type EventType = 'created' | 'edited' | 'edit_blocked' | 'approved_internal' | 'rejected';
export interface DraftReviewEvent {
  id: string;
  review_id: string;
  org_id: string;
  actor_id: string;
  event_type: EventType;
  from_state: ReviewState | null;
  to_state: ReviewState;
  revision: number;
  review_version: number;
  reason_code: RejectReason | null;
  created_at: Date;
}

export interface ReviewDetail {
  review: DraftReview;
  revisions: DraftRevision[];
  events: DraftReviewEvent[];
}

export type ReviewError =
  | { code: 'not_found' | 'forbidden' | 'stale_version' | 'illegal_transition' | 'self_approval_forbidden' | 'invalid_input' }
  | { code: 'blocked_for_customer_use'; errorCode: 'BLOCKED_FOR_CUSTOMER_USE'; checkCodes?: string[]; review?: DraftReview };
export type ReviewResult<T> = { code: 'ok'; value: T } | ReviewError;
export type DecisionResult = ReviewResult<DraftReview> | { code: 'idempotent'; idempotent: true; value: DraftReview };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const isVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2147483647;
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 1500 && value.trim().length > 0 && !value.includes('\u0000');
const blocked = (checkCodes?: string[], review?: DraftReview): ReviewError => ({
  code: 'blocked_for_customer_use', errorCode: 'BLOCKED_FOR_CUSTOMER_USE',
  ...(checkCodes ? { checkCodes } : {}), ...(review ? { review } : {}),
});

export function mapReviewDatabaseError(error: unknown): ReviewError | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'P0001' || !('message' in error)) {
    return undefined;
  }
  switch (error.message) {
    case 'stale_version': return { code: 'stale_version' };
    case 'self_approval': return { code: 'self_approval_forbidden' };
    case 'blocked_for_customer_use': return blocked();
    case 'illegal_transition':
    case 'immutable_review':
    case 'invalid_revision':
    case 'invalid_decision': return { code: 'illegal_transition' };
    default: return undefined;
  }
}

async function transact<T>(pool: Pool, identity: Identity, permission: Permission, operation: (client: PoolClient) => Promise<T>): Promise<T | ReviewError> {
  try {
    return await withTenant(pool, identity.org, async (client) => {
      const { rows } = await client.query<{ role: unknown }>(
        'SELECT role FROM public.memberships WHERE org_id=$1 AND user_id=$2', [identity.org, identity.sub]);
      const role = rows[0]?.role;
      if (!isRole(role) || !can(role, permission)) return { code: 'forbidden' };
      return operation(client);
    }, { actorId: identity.sub, statementTimeoutMs: 3000 });
  } catch (error) {
    if (error instanceof EditConflict) return error.result;
    const mapped = mapReviewDatabaseError(error);
    if (mapped) return mapped;
    throw new Error('Draft review transaction failed');
  }
}

async function appendRevision(
  client: PoolClient, review: DraftReview, actor: string, revision: number, kind: DraftRevision['kind'],
  text: string, check: ReturnType<typeof validateCustomerText>,
): Promise<void> {
  // Keep the failed check and codes in history while withholding the unsafe text.
  const storedText = check.ok ? text : '[Content withheld]';
  const digest = createHash('sha256').update(storedText).digest('hex');
  await client.query(
    'INSERT INTO public.draft_revisions (review_id, org_id, revision, author_id, kind, customer_text, text_sha256, check_status, check_codes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [review.id, review.org_id, revision, actor, kind, storedText, digest, check.ok ? 'passed' : 'blocked', check.ok ? [] : check.codes]);
}

async function appendEvent(client: PoolClient, review: DraftReview, actor: string, type: EventType, from: ReviewState | null): Promise<void> {
  await client.query(
    'INSERT INTO public.draft_review_events (review_id, org_id, actor_id, event_type, from_state, to_state, revision, review_version, reason_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [review.id, review.org_id, actor, type, from, review.state, review.current_revision, review.version, review.decision_reason_code]);
}

async function readReview(client: PoolClient, id: string): Promise<DraftReview | undefined> {
  return (await client.query<DraftReview>('SELECT * FROM public.draft_reviews WHERE id=$1', [id])).rows[0];
}

async function lockReview(client: PoolClient, id: string): Promise<DraftReview | undefined> {
  const { rows } = await client.query<DraftReview>(
    "SELECT * FROM public.draft_reviews WHERE id=$1 AND state IN ('pending_review','edited','blocked') FOR NO KEY UPDATE", [id]);
  return rows[0] ?? readReview(client, id);
}

export function createReview(pool: Pool, identity: Identity, artifact: ReviewArtifact): Promise<ReviewResult<DraftReview>>;
export function createReview(pool: Pool, identity: Identity, artifact: ReviewArtifact, detail: true): Promise<ReviewResult<ReviewDetail>>;
export async function createReview(pool: Pool, identity: Identity, artifact: ReviewArtifact, detail = false): Promise<ReviewResult<DraftReview | ReviewDetail>> {
  return transact(pool, identity, 'draft:create', async (client): Promise<ReviewResult<DraftReview | ReviewDetail>> => {
    const { classification, customerDraft, evidenceStatus, internalEvidence, operatorNotes, disclosure } = artifact;
    const { text, language } = customerDraft;
    if (!isText(text)) return { code: 'invalid_input' };
    const check = validateCustomerText(text, internalEvidence, language);
    if (!check.ok) return blocked(check.codes);
    const { rows } = await client.query<DraftReview>(
      "INSERT INTO public.draft_reviews (org_id, created_by, intent, language, evidence_status, state, internal_evidence, internal_operator_notes, disclosure) VALUES ($1,$2,$3,$4,$5,'pending_review',$6,$7,$8) RETURNING *",
      [identity.org, identity.sub, classification.intent, language, evidenceStatus, JSON.stringify(internalEvidence), operatorNotes, JSON.stringify(disclosure)]);
    const review = rows[0]!;
    await appendRevision(client, review, identity.sub, 1, 'system', text, check);
    await appendEvent(client, review, identity.sub, 'created', null);
    return { code: 'ok', value: detail ? await readDetail(client, review) : review };
  });
}

async function readDetail(client: PoolClient, review: DraftReview): Promise<ReviewDetail> {
  const revisions = await client.query<DraftRevision>(
    'SELECT * FROM public.draft_revisions WHERE review_id=$1 AND revision <= $2 ORDER BY revision',
    [review.id, review.current_revision]);
  const events = await client.query<DraftReviewEvent>(
    'SELECT * FROM public.draft_review_events WHERE review_id=$1 AND review_version <= $2 ORDER BY review_version, created_at, id',
    [review.id, review.version]);
  return { review, revisions: revisions.rows, events: events.rows };
}

export async function getReview(pool: Pool, identity: Identity, id: string): Promise<ReviewResult<ReviewDetail>> {
  return transact(pool, identity, 'draft:create', async (client): Promise<ReviewResult<ReviewDetail>> => {
    if (!isId(id)) return { code: 'invalid_input' };
    const review = await readReview(client, id);
    if (!review) return { code: 'not_found' };
    return { code: 'ok', value: await readDetail(client, review) };
  });
}

export interface ReviewListOptions {
  state?: ReviewState;
  limit?: number;
  /** ID of the last review in the preceding page, or an exclusive ISO timestamp. */
  before?: string;
}

export function isReviewTimestamp(value: string): boolean {
  const date = value.slice(0, 10);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,6})?(?:Z|[+-](?:0[0-9]|1[0-5]):[0-5][0-9])$/u.test(value)
    || date.startsWith('0000-') || !Number.isFinite(Date.parse(value))) return false;
  return new Date(date).toISOString().startsWith(date);
}

export async function listReviews(pool: Pool, identity: Identity, options: ReviewListOptions = {}): Promise<ReviewResult<DraftReview[]>> {
  return transact(pool, identity, 'draft:create', async (client): Promise<ReviewResult<DraftReview[]>> => {
    if (!options) return { code: 'invalid_input' };
    const { state, limit = 50, before } = options;
    if ((state !== undefined && !isReviewState(state)) || !Number.isInteger(limit) || limit < 1 || limit > 50
      || (before !== undefined && (typeof before !== 'string' || (!isId(before) && !isReviewTimestamp(before))))) {
      return { code: 'invalid_input' };
    }
    const cursor = isId(before) ? before : null;
    const timestamp = cursor === null ? before ?? null : null;
    const { rows } = await client.query<DraftReview>(
      'SELECT r.* FROM public.draft_reviews r LEFT JOIN public.draft_reviews cursor_row ON cursor_row.id=$2 WHERE ($1::text IS NULL OR r.state=$1) AND ($2::uuid IS NULL OR r.created_at < cursor_row.created_at OR (r.created_at=cursor_row.created_at AND r.id > cursor_row.id)) AND ($4::timestamptz IS NULL OR r.created_at < $4) ORDER BY r.created_at DESC, r.id LIMIT $3',
      [state ?? null, cursor, limit, timestamp]);
    return { code: 'ok', value: rows };
  });
}

async function updateReview(
  client: PoolClient, review: DraftReview, expectedVersion: number, actor: string, state: ReviewState,
  currentRevision: number, reason: RejectReason | null = null,
): Promise<ReviewResult<DraftReview>> {
  const { rows } = await client.query<DraftReview>(
    'UPDATE public.draft_reviews SET state=$3, version=version+1, current_revision=$4, approved_revision=$5, decided_by=$6, decided_at=CASE WHEN $6::uuid IS NULL THEN NULL ELSE statement_timestamp() END, decision_reason_code=$7, updated_at=statement_timestamp() WHERE id=$1 AND version=$2 RETURNING *',
    [review.id, expectedVersion, state, currentRevision, state === 'approved_internal' ? currentRevision : null,
      isTerminal(state) ? actor : null, reason]);
  if (rows[0]) return { code: 'ok', value: rows[0] };
  const latest = await readReview(client, review.id);
  if (!latest) return { code: 'not_found' };
  if (!canTransition(latest.state, state)) return { code: 'illegal_transition' };
  return { code: 'stale_version' };
}

async function recordEdit(
  client: PoolClient, review: DraftReview, actor: string, expectedVersion: number, text: string,
  check: ReturnType<typeof validateCustomerText>,
): Promise<ReviewResult<DraftReview>> {
  const state = check.ok ? 'edited' : 'blocked';
  const revision = review.current_revision + 1;
  await appendRevision(client, review, actor, revision, 'operator', text, check);
  const result = await updateReview(client, review, expectedVersion, actor, state, revision);
  // The row is locked. An unexpected update failure must roll back the inserted revision.
  if (result.code !== 'ok') throw new EditConflict(result);
  await appendEvent(client, result.value, actor, check.ok ? 'edited' : 'edit_blocked', review.state);
  return result;
}

class EditConflict extends Error {
  constructor(readonly result: ReviewError) { super('Draft review update conflict'); }
}

type EditInput = { expectedVersion: unknown; text: unknown };

export function editReview(pool: Pool, identity: Identity, id: string, input: EditInput): Promise<ReviewResult<DraftReview>>;
export function editReview(pool: Pool, identity: Identity, id: string, input: EditInput, detail: true): Promise<ReviewResult<ReviewDetail>>;
export async function editReview(pool: Pool, identity: Identity, id: string, input: EditInput, detail = false): Promise<ReviewResult<DraftReview | ReviewDetail>> {
  return transact(pool, identity, 'draft:create', async (client): Promise<ReviewResult<DraftReview | ReviewDetail>> => {
    if (!isId(id) || !isVersion(input?.expectedVersion) || !isText(input?.text)) return { code: 'invalid_input' };
    const review = await lockReview(client, id);
    if (!review) return { code: 'not_found' };
    if (isTerminal(review.state)) return { code: 'illegal_transition' };
    if (review.version !== input.expectedVersion) return { code: 'stale_version' };
    const check = validateCustomerText(input.text, review.internal_evidence, review.language);
    if (!canTransition(review.state, check.ok ? 'edited' : 'blocked')) return { code: 'illegal_transition' };
    const result = await recordEdit(client, review, identity.sub, input.expectedVersion, input.text, check);
    return detail && result.code === 'ok' ? { code: 'ok', value: await readDetail(client, result.value) } : result;
  });
}

type Decision = { state: 'approved_internal' } | { state: 'rejected'; reason: RejectReason };

async function decide(
  client: PoolClient, actor: string, id: string, expectedVersion: number, decision: Decision,
): Promise<DecisionResult> {
  const review = await lockReview(client, id);
  if (!review) return { code: 'not_found' };
  if (isTerminal(review.state)) {
    // A retry carries the version at which the terminal revision was decided.
    if (review.state === decision.state && review.decided_by === actor.toLowerCase() && review.version === expectedVersion + 1) {
      return { code: 'idempotent', idempotent: true, value: review };
    }
    return { code: 'illegal_transition' };
  }
  if (review.version !== expectedVersion) return { code: 'stale_version' };
  if (!canTransition(review.state, decision.state)) {
    return review.state === 'blocked' && decision.state === 'approved_internal' ? blocked() : { code: 'illegal_transition' };
  }

  if (decision.state === 'approved_internal') {
    const { rows } = await client.query<DraftRevision>(
      'SELECT * FROM public.draft_revisions WHERE review_id=$1 AND revision=$2', [id, review.current_revision]);
    const revision = rows[0];
    if (!revision) return { code: 'illegal_transition' };
    if (review.created_by === actor.toLowerCase() || revision.author_id === actor.toLowerCase()) return { code: 'self_approval_forbidden' };
    const check = validateCustomerText(revision.customer_text, review.internal_evidence, review.language);
    if (!check.ok) {
      const updated = await recordEdit(client, review, actor, expectedVersion, revision.customer_text, check);
      return updated.code === 'ok' ? blocked(check.codes, updated.value) : updated;
    }
    if (revision.check_status !== 'passed') return blocked();
  }

  const result = await updateReview(client, review, expectedVersion, actor, decision.state, review.current_revision,
    decision.state === 'rejected' ? decision.reason : null);
  if (result.code === 'ok') await appendEvent(client, result.value, actor, decision.state, review.state);
  return result;
}

export async function approveReview(pool: Pool, identity: Identity, id: string, input: { expectedVersion: unknown }): Promise<DecisionResult> {
  return transact(pool, identity, 'draft:decide', async (client): Promise<DecisionResult> => {
    if (!isId(id) || !isVersion(input?.expectedVersion)) return { code: 'invalid_input' };
    return decide(client, identity.sub, id, input.expectedVersion, { state: 'approved_internal' });
  });
}

export async function rejectReview(pool: Pool, identity: Identity, id: string, input: { expectedVersion: unknown; reason: unknown }): Promise<DecisionResult> {
  return transact(pool, identity, 'draft:decide', async (client): Promise<DecisionResult> => {
    if (!isId(id) || !isVersion(input?.expectedVersion) || !isRejectReason(input?.reason)) return { code: 'invalid_input' };
    return decide(client, identity.sub, id, input.expectedVersion, { state: 'rejected', reason: input.reason });
  });
}
