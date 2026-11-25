import type { VerificationKeys } from '../auth/jwt.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from '../auth/guard.js';
import { AuthError } from '../auth/jwt.js';
import { can, isRole } from '../auth/permissions.js';
import { withTenant } from '../db/tenant.js';
import type { Identity } from '../tools/gateway.js';
import { ToolLimiter } from '../tools/limiter.js';
import { normalizeMessage } from './normalize.js';
import { createSupportService, type SupportServiceDeps } from './service.js';

export interface SupportRouteDeps extends SupportServiceDeps {
  verificationKeys: VerificationKeys;
  limiter?: ToolLimiter;
  maxConcurrent?: number;
  maxGlobal?: number;
}

export const SUPPORT_ERROR_STATUS = {
  forbidden: 403, timeout: 504, rejected_tool_call: 422, budget_exceeded: 422,
  invalid_model_output: 502, model_error: 502, refused: 502, error: 500,
} as const;

const fail = (reply: FastifyReply, code: number, errorCode: string, traceId = randomUUID()) =>
  reply.code(code).send({ traceId, status: 'error', errorCode });

export function parseSupportBody(body: unknown): { message: unknown; language?: 'tr' | 'en' } | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'message')) return undefined;
  if (Object.keys(body).some((key) => key !== 'message' && key !== 'language')) return undefined;
  const { message, language } = body as Record<string, unknown>;
  if (Object.hasOwn(body, 'language')) {
    if (language !== 'tr' && language !== 'en') return undefined;
    return { message, language };
  }
  return { message };
}

export function createSupportRunCap({ maxConcurrent = 2, maxGlobal = 4 }: Pick<SupportRouteDeps, 'maxConcurrent' | 'maxGlobal'>) {
  let globalInflight = 0;
  const inflight = new Map<string, number>();
  return (actorKey: string) => {
    const active = inflight.get(actorKey) ?? 0;
    if (globalInflight >= maxGlobal || active >= maxConcurrent) return undefined;
    inflight.set(actorKey, active + 1);
    globalInflight++;
    return () => {
      globalInflight--;
      const left = inflight.get(actorKey)! - 1;
      if (left === 0) inflight.delete(actorKey); else inflight.set(actorKey, left);
    };
  };
}

export function canCreateDraft(pool: SupportRouteDeps['pool'], identity: Identity): Promise<boolean> {
  return withTenant(pool, identity.org, async (client) => {
    const result = await client.query<{ role: unknown }>(
      'SELECT role FROM public.memberships WHERE org_id=$1 AND user_id=$2', [identity.org, identity.sub]);
    const role = result.rows[0]?.role;
    return isRole(role) && can(role, 'draft:create');
  }, { actorId: identity.sub, readOnly: true, statementTimeoutMs: 3000 });
}

export function registerSupportRoutes(app: FastifyInstance, deps: SupportRouteDeps): void {
  const enterRun = createSupportRunCap(deps);
  const limiter = deps.limiter ?? new ToolLimiter(Date.now, 10, 60);
  const preview = createSupportService(deps);
  const identities = new WeakMap<FastifyRequest, Identity>();

  app.register(async (scope) => {
    scope.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
      const identity = await authenticate(request, deps.verificationKeys);
      identities.set(request, identity);
      const budget = limiter.consume(`${identity.org}|${identity.sub}`, request.ip);
      if (!budget.allowed) return fail(reply.header('Retry-After', budget.retryAfter), 429, 'RATE_LIMITED');
    });
    scope.setErrorHandler(async (error, _request, reply) => {
      if (error instanceof AuthError) return fail(reply.header('WWW-Authenticate', 'Bearer'), 401, 'UNAUTHORIZED');
      const status = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
      if (status === 400 || status === 413 || status === 415) return fail(reply, 400, 'INVALID_REQUEST');
      return fail(reply, 500, 'INTERNAL_ERROR');
    });

    scope.post('/support/drafts/preview', { bodyLimit: 8192 }, async (request, reply) => {
      const traceId = randomUUID();
      const body = parseSupportBody(request.body);
      if (!body) return fail(reply, 400, 'INVALID_REQUEST', traceId);
      const normalized = normalizeMessage(body.message);
      if (!normalized.ok) return fail(reply, 400, normalized.code, traceId);
      const identity = identities.get(request)!;
      const release = enterRun(`${identity.org}|${identity.sub}`);
      if (!release) return fail(reply, 429, 'TOO_MANY_RUNS', traceId);
      try {
        if (!(await canCreateDraft(deps.pool, identity))) return fail(reply, 403, 'FORBIDDEN', traceId);

        const previewId = randomUUID();
        const result = await preview({
          message: normalized.text, ...(body.language ? { language: body.language } : {}),
          identity, runId: previewId, traceId,
        });
        if (!result.ok) return fail(reply, SUPPORT_ERROR_STATUS[result.status], result.errorCode, traceId);

        const { classification, disclosure } = result;
        return reply.send({
          schema_version: 2, previewId, traceId, status: result.status,
          draft_only: true, requires_human_review: true, send_enabled: disclosure.send_enabled,
          ownership_status: disclosure.ownership_status,
          customer_specific_details_allowed: disclosure.customer_specific_details_allowed,
          classification: {
            intent: classification.intent, entities: classification.entities, ambiguous: classification.ambiguous,
            candidate_intents: classification.candidateIntents, needs_information: classification.needsInformation,
            rule_id: classification.ruleId, flags: classification.flags,
          },
          evidence_status: result.evidenceStatus,
          internal_evidence: { entries: result.internalEvidence, sources: result.sources },
          internal_operator_notes: result.operatorNotes, customer_safe_draft: result.customerDraft,
          disclosure_decision: disclosure, executed_tools: result.executedTools, review_notes: result.reviewNotes,
        });
      } finally {
        release();
      }
    });
  });
}
