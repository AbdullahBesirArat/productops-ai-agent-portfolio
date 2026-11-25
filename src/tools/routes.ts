import type { VerificationKeys } from '../auth/jwt.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { AuthError } from '../auth/jwt.js';
import { authenticate } from '../auth/guard.js';
import { recordAudit } from './audit.js';
import { executeTool, type Identity } from './gateway.js';
import { ToolLimiter, type LimitResult } from './limiter.js';
import type { ToolRegistry } from './types.js';

export interface ToolRouteDeps {
  pool: Pool;
  verificationKeys: VerificationKeys;
  limiter?: ToolLimiter;
  registry?: ToolRegistry;
  timeoutMs?: number;
  maxInflight?: number;
}

let inflight = 0;

const AUDIT_FAILURE = { status: 'error', error: { code: 'AUDIT_UNAVAILABLE', message: 'Internal error' } };

/** `POST /tools/execute` is the only tool endpoint. Auth is the T2 JWT service; there is no alternative identity path. */
export function registerToolRoutes(app: FastifyInstance, deps: ToolRouteDeps): void {
  const limiter = deps.limiter ?? new ToolLimiter();
  const maxInflight = deps.maxInflight ?? 4;
  async function admit(reply: FastifyReply, work: () => Promise<FastifyReply>): Promise<FastifyReply> {
    if (inflight >= maxInflight) {
      return reply.header('Retry-After', '1').code(429)
        .send({ trace_id: randomUUID(), status: 'error', error: { code: 'BUSY', message: 'Too many requests' } });
    }
    inflight++;
    try { return await work(); } finally { inflight--; }
  }
  const identities = new WeakMap<FastifyRequest, Identity>();
  const budgets = new WeakMap<FastifyRequest, LimitResult>();
  app.register(async (scope) => {
    scope.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
      const identity = await authenticate(request, deps.verificationKeys);
      identities.set(request, identity);
      // Every authenticated request (including malformed ones that never reach the handler) consumes the budget
      // before any body parsing or database work.
      budgets.set(request, limiter.consume(`${identity.org}|${identity.sub}`, request.ip));
    });
    scope.setErrorHandler(async (error, request, reply) => {
      if (error instanceof AuthError) return reply.header('WWW-Authenticate', 'Bearer').code(401).send({ error: 'Unauthorized' });
      return admit(reply, async () => {
        const identity = identities.get(request);
        const status = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
        const budget = budgets.get(request);
        if (identity && budget && !budget.allowed) {
          // Over budget: audit only the first denial per window, then answer without touching the database.
          const traceId = randomUUID();
          if (budget.firstDenial) {
            try {
              await recordAudit(deps.pool, {
                traceId, orgId: identity.org, actorId: identity.sub, toolName: null, decision: 'allowed',
                status: 'rate_limited', errorCode: 'RATE_LIMITED', durationMs: 0,
              });
            } catch { return reply.code(500).send({ trace_id: traceId, ...AUDIT_FAILURE }); }
          }
          return reply.header('Retry-After', budget.retryAfter).code(429)
            .send({ trace_id: traceId, status: 'error', error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
        }
        if (identity && (status === 400 || status === 413 || status === 415)) {
          // Malformed JSON / wrong content type / oversized body from an authenticated caller: record and answer safely.
          const traceId = randomUUID();
          try {
            await recordAudit(deps.pool, {
              traceId, orgId: identity.org, actorId: identity.sub, toolName: null, decision: 'allowed',
              status: 'invalid_input', errorCode: 'MALFORMED_REQUEST', durationMs: 0,
            });
          } catch { return reply.code(500).send({ trace_id: traceId, ...AUDIT_FAILURE }); }
          return reply.code(400).send({ trace_id: traceId, status: 'error', error: { code: 'MALFORMED_REQUEST', message: 'Invalid request' } });
        }
        return reply.code(500).send({ error: 'Internal server error' });
      });
    });
    scope.post('/tools/execute', { bodyLimit: 4096 }, async (request, reply) => {
      return admit(reply, async () => {
        const identity = identities.get(request)!;
        const result = await executeTool({
          pool: deps.pool,
          ...(deps.registry ? { registry: deps.registry } : {}),
          ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
        }, identity, budgets.get(request)!, request.body);
        if (result.audit) {
          try { await recordAudit(deps.pool, result.audit); } catch {
            // Fail closed: no tool data is returned when its audit record cannot be written.
            return reply.code(500).send({ trace_id: result.audit.traceId, ...AUDIT_FAILURE });
          }
        }
        if (result.retryAfter) reply.header('Retry-After', result.retryAfter);
        return reply.code(result.httpStatus).send(result.body);
      });
    });
  });
}
