import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from '../auth/guard.js';
import { AuthError } from '../auth/jwt.js';
import type { Identity } from '../tools/gateway.js';
import { ToolLimiter } from '../tools/limiter.js';
import { normalizeMessage } from './normalize.js';
import { isRejectReason, isReviewState } from './review-states.js';
import * as reviewStore from './review-store.js';
import type { DecisionResult, DraftReview, ReviewDetail, ReviewError, ReviewListOptions, ReviewResult } from './review-store.js';
import { canCreateDraft, createSupportRunCap, parseSupportBody, SUPPORT_ERROR_STATUS, type SupportRouteDeps } from './routes.js';
import { createSupportService } from './service.js';

type Store = Pick<typeof reviewStore, 'listReviews' | 'getReview' | 'approveReview' | 'rejectReview'> & {
  createReview: (...args: Parameters<typeof reviewStore.createReview>) => Promise<ReviewResult<ReviewDetail>>;
  editReview: (...args: Parameters<typeof reviewStore.editReview>) => Promise<ReviewResult<ReviewDetail>>;
};
type ListQuery = { Querystring: Record<string, unknown> };

export interface ReviewRouteDeps extends SupportRouteDeps {
  store?: Partial<Store>;
  service?: ReturnType<typeof createSupportService>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const BODY_LIMIT = 8192;
const FLAGS = { send_enabled: false } as const;
const DECISION_FLAGS = { external_effect: 'none' } as const;
const STORE_ERRORS = {
  invalid_input: [400, 'INVALID_REQUEST'],
  forbidden: [403, 'FORBIDDEN'],
  self_approval_forbidden: [403, 'SELF_APPROVAL_FORBIDDEN'],
  not_found: [404, 'NOT_FOUND'],
  stale_version: [409, 'STALE_VERSION'],
  illegal_transition: [409, 'ILLEGAL_TRANSITION'],
  blocked_for_customer_use: [422, 'BLOCKED_FOR_CUSTOMER_USE'],
} as const satisfies Record<ReviewError['code'], readonly [number, string]>;

function securityHeaders(reply: FastifyReply) {
  return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
}

function fail(reply: FastifyReply, status: number, errorCode: string, traceId = randomUUID(), decision = false) {
  return reply.code(status).send({ traceId, status: 'error', errorCode, ...FLAGS, ...(decision ? DECISION_FLAGS : {}) });
}

export function reviewNotFound(reply: FastifyReply) {
  return fail(securityHeaders(reply), 404, 'NOT_FOUND');
}

function storeFailure(reply: FastifyReply, error: ReviewError, decision = false, traceId = randomUUID()) {
  const [status, code] = STORE_ERRORS[error.code];
  return fail(reply, status, code, traceId, decision);
}

function exactBody(body: unknown, keys: readonly string[]): body is Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === keys.length && keys.every((key) => Object.hasOwn(body, key));
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2147483647;
}

function isCustomerText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1500 && value.trim().length > 0
    && !value.includes('\u0000') && (value as string & { isWellFormed(): boolean }).isWellFormed();
}

function listOptions(query: Record<string, unknown>): ReviewListOptions | undefined {
  if (Object.keys(query).some((key) => key !== 'state' && key !== 'limit' && key !== 'before')) return undefined;
  const { state, limit, before } = query;
  if (state !== undefined && !isReviewState(state)) return undefined;
  if (limit !== undefined && (typeof limit !== 'string' || !/^(?:[1-9]|[1-4][0-9]|50)$/u.test(limit))) return undefined;
  if (before !== undefined && (typeof before !== 'string' || (!UUID.test(before) && !reviewStore.isReviewTimestamp(before)))) return undefined;
  return {
    ...(state === undefined ? {} : { state }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
    ...(before === undefined ? {} : { before }),
  };
}

function summary({ id, state, version, current_revision, intent, language, evidence_status, created_by, created_at, updated_at }: DraftReview) {
  return { id, state, version, current_revision, intent, language, evidence_status, created_by, created_at, updated_at };
}

function reviewFields(review: DraftReview) {
  return {
    ...summary(review), org_id: review.org_id, approved_revision: review.approved_revision,
    ownership_status: review.ownership_status, customer_specific_details_allowed: review.customer_specific_details_allowed,
    internal_evidence: review.internal_evidence, internal_operator_notes: review.internal_operator_notes,
    disclosure_decision: review.disclosure, decided_by: review.decided_by, decided_at: review.decided_at,
    decision_reason_code: review.decision_reason_code, ...FLAGS,
  };
}

function reviewView({ review, revisions, events }: ReviewDetail) {
  const current = revisions.at(-1);
  return {
    ...reviewFields(review),
    customer_safe_draft: current?.check_status === 'passed' ? { language: review.language, text: current.customer_text } : null,
    check_codes: current?.check_codes ?? [],
    revisions: revisions.map(({ revision, author_id, kind, customer_text, check_status, check_codes, created_at }) =>
      ({ revision, author_id, kind, customer_text, check_status, check_codes, created_at })),
    events: events.map(({ event_type, from_state, to_state, revision, review_version, actor_id, reason_code, created_at }) =>
      ({ event_type, from_state, to_state, revision, review_version, actor_id, reason_code, created_at })),
  };
}

function decisionResponse(reply: FastifyReply, result: DecisionResult) {
  if (result.code !== 'ok' && result.code !== 'idempotent') return storeFailure(reply, result, true);
  return reply.send({
    review: reviewFields(result.value), ...FLAGS, ...DECISION_FLAGS,
    ...(result.code === 'idempotent' ? { idempotent: true } : {}),
  });
}

function isDecision(request: FastifyRequest) {
  const path = request.routeOptions.url;
  return path === '/support/reviews/:id/approve' || path === '/support/reviews/:id/reject';
}

function hasBody(request: FastifyRequest) {
  const { headers } = request;
  return headers['transfer-encoding'] !== undefined
    || (headers['content-length'] !== undefined && headers['content-length'] !== '0');
}

export function registerReviewRoutes(app: FastifyInstance, deps: ReviewRouteDeps): void {
  const store: Store = { ...reviewStore, ...deps.store };
  const service = deps.service ?? createSupportService(deps);
  const limiter = deps.limiter ?? new ToolLimiter();
  const enterRun = createSupportRunCap(deps);
  const identities = new WeakMap<FastifyRequest, Identity>();

  app.register(async (scope) => {
    scope.addHook('onRequest', async (request, reply) => {
      securityHeaders(reply);
      const { org, sub } = await authenticate(request, deps.verificationKeys);
      const identity = { org: org.toLowerCase(), sub: sub.toLowerCase() };
      identities.set(request, identity);
      const budget = limiter.consume(`${identity.org}|${identity.sub}`, request.ip);
      if (!budget.allowed) {
        return fail(reply.header('Retry-After', budget.retryAfter), 429, 'RATE_LIMITED', undefined, isDecision(request));
      }
      const query = request.query as Record<string, unknown>;
      const list = request.method === 'GET' && request.routeOptions.url === '/support/reviews';
      if ((!list && Object.keys(query).length > 0) || (request.method === 'GET' && hasBody(request))) {
        return fail(reply, 400, 'INVALID_REQUEST', undefined, isDecision(request));
      }
    });
    scope.setErrorHandler(async (error, request, reply) => {
      const decision = isDecision(request);
      if (error instanceof AuthError) {
        return fail(reply.header('WWW-Authenticate', 'Bearer'), 401, 'UNAUTHORIZED', undefined, decision);
      }
      const status = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
      if (status === 400 || status === 413 || status === 415) return fail(reply, 400, 'INVALID_REQUEST', undefined, decision);
      return fail(reply, 500, 'INTERNAL_ERROR', undefined, decision);
    });

    scope.post('/support/reviews', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
      const traceId = randomUUID();
      const body = parseSupportBody(request.body);
      const normalized = normalizeMessage(body?.message);
      if (!body || !normalized.ok) return fail(reply, 400, 'INVALID_REQUEST', traceId);
      const identity = identities.get(request)!;
      const release = enterRun(`${identity.org}|${identity.sub}`);
      if (!release) return fail(reply.header('Retry-After', 1), 429, 'TOO_MANY_RUNS', traceId);
      try {
        if (!(await canCreateDraft(deps.pool, identity))) return fail(reply, 403, 'FORBIDDEN', traceId);
        const artifact = await service({
          message: normalized.text, ...(body.language ? { language: body.language } : {}),
          identity, runId: randomUUID(), traceId,
        });
        if (!artifact.ok) return fail(reply, SUPPORT_ERROR_STATUS[artifact.status], artifact.errorCode, traceId);
        const result = await store.createReview(deps.pool, identity, artifact, true);
        if (result.code !== 'ok') return storeFailure(reply, result, false, traceId);
        return reply.code(201).send({ schema_version: 2, review: reviewView(result.value), ...FLAGS });
      } finally {
        release();
      }
    });

    scope.get<ListQuery>('/support/reviews', { bodyLimit: BODY_LIMIT, exposeHeadRoute: false }, async (request, reply) => {
      const options = listOptions(request.query);
      if (!options) return fail(reply, 400, 'INVALID_REQUEST');
      const result = await store.listReviews(deps.pool, identities.get(request)!, options);
      if (result.code !== 'ok') return storeFailure(reply, result);
      return reply.send({ reviews: result.value.map(summary), ...FLAGS });
    });

    type Params = { Params: { id: string } };
    scope.get<Params>('/support/reviews/:id', { bodyLimit: BODY_LIMIT, exposeHeadRoute: false }, async (request, reply) => {
      const { id } = request.params;
      if (!UUID.test(id)) return fail(reply, 400, 'INVALID_REQUEST');
      const result = await store.getReview(deps.pool, identities.get(request)!, id);
      if (result.code !== 'ok') return storeFailure(reply, result);
      return reply.send({ review: reviewView(result.value), ...FLAGS });
    });

    scope.patch<Params>('/support/reviews/:id', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
      const { body, params: { id } } = request;
      if (!UUID.test(id) || !exactBody(body, ['expected_version', 'customer_text'])
        || !isVersion(body.expected_version) || !isCustomerText(body.customer_text)) {
        return fail(reply, 400, 'INVALID_REQUEST');
      }
      const result = await store.editReview(deps.pool, identities.get(request)!, id, { expectedVersion: body.expected_version, text: body.customer_text }, true);
      if (result.code !== 'ok') return storeFailure(reply, result);
      return reply.send({ review: reviewView(result.value), ...FLAGS });
    });

    scope.post<Params>('/support/reviews/:id/approve', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
      const { body, params: { id } } = request;
      if (!UUID.test(id) || !exactBody(body, ['expected_version']) || !isVersion(body.expected_version)) {
        return fail(reply, 400, 'INVALID_REQUEST', undefined, true);
      }
      return decisionResponse(reply, await store.approveReview(deps.pool, identities.get(request)!, id, { expectedVersion: body.expected_version }));
    });

    scope.post<Params>('/support/reviews/:id/reject', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
      const { body, params: { id } } = request;
      if (!UUID.test(id) || !exactBody(body, ['expected_version', 'reason_code'])
        || !isVersion(body.expected_version) || !isRejectReason(body.reason_code)) {
        return fail(reply, 400, 'INVALID_REQUEST', undefined, true);
      }
      return decisionResponse(reply, await store.rejectReview(deps.pool, identities.get(request)!, id, { expectedVersion: body.expected_version, reason: body.reason_code }));
    });
  });
}
