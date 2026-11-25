import Fastify, { LogController } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { registerAuthRoutes } from './auth/routes.js';
import { AuthError, loadVerificationKeys } from './auth/jwt.js';
import { Forbidden } from './auth/guard.js';
import { LoginLimiter, RateLimitError } from './auth/rate-limit.js';
import { registerToolRoutes } from './tools/routes.js';
import { registerAgentRoutes, type AgentRouteDeps } from './agent/routes.js';
import { registerSupportRoutes, type SupportRouteDeps } from './support/routes.js';
import { registerReviewRoutes, reviewNotFound, type ReviewRouteDeps } from './support/review-routes.js';
import type { ToolLimiter } from './tools/limiter.js';
import type { ToolRegistry } from './tools/types.js';
import { registerUiRoutes, rewriteUiTarget } from './ui/routes.js';

export function buildApp(env: NodeJS.ProcessEnv = process.env, deps: { pool?: Pool; now?: () => number; limiter?: LoginLimiter; toolLimiter?: ToolLimiter; toolRegistry?: ToolRegistry; toolTimeoutMs?: number; toolMaxInflight?: number; agent?: Partial<Omit<AgentRouteDeps, 'pool' | 'verificationKeys' | 'requestDigestSecret'>>; support?: Partial<Omit<SupportRouteDeps, 'pool' | 'verificationKeys'>>; review?: Partial<Omit<ReviewRouteDeps, 'pool' | 'verificationKeys'>> } = {}) {
  const config = loadConfig(env);
  const app = Fastify({ logger: { level: 'silent' }, requestIdHeader: false,
    logController: new LogController({ disableRequestLogging: true }),
    rewriteUrl: rewriteUiTarget,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  registerUiRoutes(app);
  app.addHook('onRequest', async (request, reply) => {
    if (!request.is404 || !request.url.startsWith('/support/')) return;
    if (/^\/support\/reviews(?:[/?]|$)/u.test(request.url)) return reviewNotFound(reply);
    return reply.code(404).send({ error: 'Not found' });
  });
  const keyConfig = env.PRODUCTOPS_JWT_PUBLIC_KEYS;
  const verificationKeys = keyConfig === undefined ? undefined : loadVerificationKeys(keyConfig);
  if ((deps.pool || config.database) && !verificationKeys) throw new Error('JWT verification configuration is required');
  if (verificationKeys && (deps.pool || config.database)) {
    const digestSecret = env.PRODUCTOPS_REQUEST_DIGEST_SECRET;
    if (!digestSecret || !/^[a-fA-F0-9]{64}$/u.test(digestSecret)) throw new Error('Invalid request digest configuration');
    const pool = deps.pool ?? createPool(config.database!);
    if (!deps.pool) app.addHook('onClose', async () => { await pool.end(); });
    registerAuthRoutes(app, { pool, verificationKeys, authPort: config.authPort, limiter: deps.limiter ?? new LoginLimiter(deps.now) });
    registerToolRoutes(app, {
      pool, verificationKeys,
      ...(deps.toolLimiter ? { limiter: deps.toolLimiter } : {}),
      ...(deps.toolRegistry ? { registry: deps.toolRegistry } : {}),
      ...(deps.toolTimeoutMs ? { timeoutMs: deps.toolTimeoutMs } : {}),
      ...(deps.toolMaxInflight !== undefined ? { maxInflight: deps.toolMaxInflight } : {}),
    });
    // The model adapter is always the deterministic mock (loadConfig rejects any other MODEL_ADAPTER value).
    registerAgentRoutes(app, {
      pool, verificationKeys, requestDigestSecret: Buffer.from(digestSecret, 'hex'),
      ...(deps.toolRegistry ? { registry: deps.toolRegistry } : {}),
      ...(deps.toolTimeoutMs ? { limits: { toolTimeoutMs: deps.toolTimeoutMs } } : {}),
      ...deps.agent,
    });
    registerSupportRoutes(app, {
      pool, verificationKeys,
      ...(deps.toolRegistry ? { registry: deps.toolRegistry } : {}),
      ...(deps.toolTimeoutMs ? { limits: { toolTimeoutMs: deps.toolTimeoutMs } } : {}),
      ...deps.support,
    });
    registerReviewRoutes(app, {
      pool, verificationKeys,
      ...(deps.toolRegistry ? { registry: deps.toolRegistry } : {}),
      ...(deps.toolTimeoutMs ? { limits: { toolTimeoutMs: deps.toolTimeoutMs } } : {}),
      ...deps.review,
    });
  }
  app.get('/health', async () => ({ status: 'ok', service: 'productops-ai-agent' }));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthError) return reply.header('WWW-Authenticate', 'Bearer').code(401).send({ error: 'Unauthorized' });
    if (error instanceof Forbidden) return reply.code(403).send({ error: 'Forbidden' });
    if (error instanceof RateLimitError) return reply.header('Retry-After', error.retryAfter).code(429).send({ error: 'Too many requests' });
    if (request.routeOptions.url === '/auth/login' && typeof error === 'object' && error !== null && 'statusCode' in error &&
        (error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415)) return reply.code(400).send({ error: 'Invalid request' });
    void reply.code(500).send({ error: 'Internal server error' });
  });
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: 'Not found' });
  });
  return app;
}
