import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { login, InvalidCredentials } from './auth/login.js';
import { LOGIN_OPTIONS } from './auth/login-schema.js';
import { LoginLimiter, RateLimitError } from './auth/rate-limit.js';
import { ACCESS_TOKEN_SECONDS } from './auth/jwt.js';
import { loadSigningKey, type SigningKey } from './auth/signing.js';
import { loadDatabaseConfig } from './config.js';
import { createPool } from './db/pool.js';

export function buildAuthService(pool: Pool, signing: SigningKey, limiter = new LoginLimiter()) {
  const app = Fastify({ logger: { level: 'silent' }, requestIdHeader: false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
  });
  app.post('/auth/login', LOGIN_OPTIONS, async request => ({
    access_token: await login(pool, signing, request.body, { limiter, ip: request.ip }),
    token_type: 'Bearer', expires_in: ACCESS_TOKEN_SECONDS,
  }));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof InvalidCredentials) return reply.code(401).send({ error: 'Invalid credentials' });
    if (error instanceof RateLimitError) return reply.header('Retry-After', error.retryAfter).code(429).send({ error: 'Too many requests' });
    if (typeof error === 'object' && error !== null && 'statusCode' in error &&
        (error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415)) return reply.code(400).send({ error: 'Invalid request' });
    return reply.code(500).send({ error: 'Internal server error' });
  });
  return app;
}

async function main() {
  try {
    const env = process.env;
    for (const name of Object.keys(env)) {
      if (name.startsWith('PRODUCTOPS_') &&
          !['PRODUCTOPS_AUTH_DB_URL', 'PRODUCTOPS_JWT_KID', 'PRODUCTOPS_JWT_PRIVATE_KEY', 'PRODUCTOPS_AUTH_PORT'].includes(name)) {
        throw new Error('Unexpected configuration in authentication process');
      }
    }
    const port = env.PRODUCTOPS_AUTH_PORT ?? '3109';
    if (!(port === '0' && process.send) && (!/^[1-9][0-9]{0,4}$/u.test(port) || Number(port) > 65535)) throw new Error('Invalid auth port');
    const signing = loadSigningKey(env.PRODUCTOPS_JWT_KID, env.PRODUCTOPS_JWT_PRIVATE_KEY);
    const pool = createPool(loadDatabaseConfig(env.PRODUCTOPS_AUTH_DB_URL, 'productops_authsvc'), 4);
    const app = buildAuthService(pool, signing);
    app.addHook('onClose', async () => { await pool.end(); });
    try { await app.listen({ host: '127.0.0.1', port: Number(port) }); }
    catch (error) { await app.close(); throw error; }
    const address = app.server.address();
    if (address && typeof address === 'object') process.send?.({ port: address.port });
  } catch {
    process.stderr.write('ProductOps authentication startup failed; check isolated configuration.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
