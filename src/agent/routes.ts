import type { VerificationKeys } from '../auth/jwt.js';
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { authenticate } from '../auth/guard.js';
import { AuthError } from '../auth/jwt.js';
import { can } from '../auth/permissions.js';
import { recordAudit } from '../tools/audit.js';
import { executeTool, type Identity } from '../tools/gateway.js';
import { ToolLimiter, type LimitResult } from '../tools/limiter.js';
import { lookupTool, registry as defaultRegistry } from '../tools/registry.js';
import type { ToolRegistry } from '../tools/types.js';
import { MockAdapter } from './mock/rule.js';
import { runAgent, type ExecuteFn, type RunLimits } from './orchestrator.js';
import { beginRun, finishRun, type StoredResponse } from './store.js';
import type { ModelAdapter, RunOutcome, RunStatus } from './types.js';

export interface AgentRouteDeps {
  pool: Pool;
  verificationKeys: VerificationKeys;
  requestDigestSecret: Uint8Array;
  adapter?: ModelAdapter;
  limiter?: ToolLimiter;
  registry?: ToolRegistry;
  limits?: Partial<RunLimits>;
  execute?: ExecuteFn;
  /** Maximum simultaneously running agent runs per actor. */
  maxConcurrentRuns?: number;
  /** Maximum simultaneously running agent runs in this process (protects the shared connection pool). */
  maxGlobalRuns?: number;
  storeTimeoutMs?: number;
}

const HTTP_STATUS: Record<RunStatus, number> = {
  completed: 200, unverified: 200, refused: 200, budget_exceeded: 422, rejected_tool_call: 422,
  invalid_model_output: 502, model_error: 502, forbidden: 403, timeout: 504, error: 500,
};
async function waitForStore<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Run record deadline exceeded')), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

const KEY = /^[A-Za-z0-9_-]{8,64}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
export const MAX_REQUEST_CHARS = 500;

const fail = (reply: FastifyReply, code: number, errorCode: string, traceId = randomUUID()) =>
  reply.code(code).send({ traceId, status: 'error', errorCode });

function normalise(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'request') return undefined;
  const value = (body as { request?: unknown }).request;
  if (typeof value !== 'string' || CONTROL.test(value)) return undefined;
  const text = value.replace(/\s+/gu, ' ').trim();
  return text.length >= 1 && text.length <= MAX_REQUEST_CHARS ? text : undefined;
}

/** `POST /agent/runs` — the only agent endpoint. Identity comes from the T2 JWT service; tools run through the T3 gateway. */
export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  const limiter = deps.limiter ?? new ToolLimiter(Date.now, 10, 60);
  const adapter = deps.adapter ?? new MockAdapter();
  const registry = deps.registry ?? defaultRegistry;
  const requestDigestKey = createHmac('sha256', deps.requestDigestSecret).update('productops-agent-run-request-v1').digest();
  const execute = deps.execute ?? executeTool;
  const maxConcurrent = deps.maxConcurrentRuns ?? 2;
  const maxGlobal = deps.maxGlobalRuns ?? 4;
  const storeTimeoutMs = deps.storeTimeoutMs ?? 5000;
  let globalInflight = 0;
  const identities = new WeakMap<FastifyRequest, Identity>();
  const budgets = new WeakMap<FastifyRequest, LimitResult>();
  const inflight = new Map<string, number>();

  app.register(async (scope) => {
    scope.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
      const identity = await authenticate(request, deps.verificationKeys);
      identities.set(request, identity);
      budgets.set(request, limiter.consume(`${identity.org}|${identity.sub}`, request.ip));
    });
    scope.setErrorHandler(async (error, request, reply) => {
      if (error instanceof AuthError) return reply.header('WWW-Authenticate', 'Bearer').code(401).send({ error: 'Unauthorized' });
      const status = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
      const budget = budgets.get(request);
      if (budget && !budget.allowed) return reply.header('Retry-After', budget.retryAfter).code(429).send({ traceId: randomUUID(), status: 'error', errorCode: 'RATE_LIMITED' });
      if (status === 400 || status === 413 || status === 415) return fail(reply, 400, 'INVALID_REQUEST');
      return reply.code(500).send({ traceId: randomUUID(), status: 'error', errorCode: 'INTERNAL_ERROR' });
    });

    scope.post('/agent/runs', { bodyLimit: 2048 }, async (request, reply) => {
      const identity = identities.get(request)!;
      const budget = budgets.get(request)!;
      if (!budget.allowed) return reply.header('Retry-After', budget.retryAfter).code(429).send({ traceId: randomUUID(), status: 'error', errorCode: 'RATE_LIMITED' });

      const text = normalise(request.body);
      const rawKey = request.headers['idempotency-key'];
      if (!text || (rawKey !== undefined && (typeof rawKey !== 'string' || !KEY.test(rawKey)))) return fail(reply, 400, 'INVALID_REQUEST');
      const key = typeof rawKey === 'string' ? rawKey : null;
      const requestHash = createHmac('sha256', requestDigestKey).update(text).digest('hex');
      // Identifiers are always server generated; client-supplied trace/request ids are never read.
      const runId = randomUUID();
      const traceId = randomUUID();

      const actorKey = `${identity.org}|${identity.sub}`;
      if (globalInflight >= maxGlobal || (inflight.get(actorKey) ?? 0) >= maxConcurrent) return fail(reply, 429, 'TOO_MANY_RUNS', traceId);
      inflight.set(actorKey, (inflight.get(actorKey) ?? 0) + 1);
      globalInflight++;
      try {
        let begin;
        try {
          begin = await waitForStore(beginRun(deps.pool, identity, { runId, traceId, key, requestHash }, (role, toolNames) =>
            toolNames.every((name) => {
              const entry = lookupTool(registry, name);
              return entry !== undefined && can(role, entry.permission);
            })), storeTimeoutMs);
        } catch { return fail(reply, 500, 'RUN_RECORD_UNAVAILABLE', traceId); }
        if (begin.kind === 'forbidden') return fail(reply, 403, 'FORBIDDEN', traceId);
        if (begin.kind === 'conflict') return fail(reply, 422, 'IDEMPOTENCY_KEY_REUSED', traceId);
        if (begin.kind === 'in_progress') return fail(reply, 409, 'RUN_IN_PROGRESS', traceId);
        if (begin.kind === 'replay') return reply.header('Idempotent-Replay', 'true').code(begin.response.httpStatus).send(begin.response.body);

        let outcome: RunOutcome;
        try {
          outcome = await runAgent({
            adapter, execute, tools: Object.keys(registry),
            gateway: { pool: deps.pool, registry },
            audit: (event) => recordAudit(deps.pool, event),
            ...(deps.limits ? { limits: deps.limits } : {}),
          }, identity, { request: text, runId, traceId });
        } catch {
          outcome = { status: 'error', errorCode: 'INTERNAL_ERROR', answer: null, sources: [], facts: [], executedTools: [], toolCalls: 0, durationMs: 0 };
        }
        const httpStatus = HTTP_STATUS[outcome.status];
        const body: Record<string, unknown> = {
          runId, traceId, status: outcome.status, answer: outcome.answer, sources: outcome.sources,
          executedTools: outcome.executedTools, ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        };
        const response: StoredResponse = { httpStatus, body };
        try { await waitForStore(finishRun(deps.pool, identity, runId, outcome, response), storeTimeoutMs); } catch {
          // Fail closed: an unrecorded run never returns its answer.
          return fail(reply, 500, 'RUN_RECORD_UNAVAILABLE', traceId);
        }
        return reply.code(httpStatus).send(body);
      } finally {
        globalInflight--;
        const left = (inflight.get(actorKey) ?? 1) - 1;
        if (left <= 0) inflight.delete(actorKey); else inflight.set(actorKey, left);
      }
    });
  });
}
