import { LOGIN_OPTIONS, type LoginBody } from './login-schema.js';
import type { FastifyInstance } from 'fastify';
import { withAuthorizedTenant, type AuthDeps } from './guard.js';
import { ACCESS_TOKEN_SECONDS, verifyAccessToken } from './jwt.js';
import { LoginLimiter } from './rate-limit.js';
import { PERMISSION_MATRIX } from './permissions.js';

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps & { limiter?: LoginLimiter; authPort: number }): void {
  const limiter = deps.limiter ?? new LoginLimiter();
  const endpoint = 'http://127.0.0.1:' + deps.authPort + '/auth/login';
  app.register(async scope => {
    scope.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    });
    scope.post<{ Body: LoginBody }>('/auth/login', LOGIN_OPTIONS, async (request, reply) => {
      const { org_slug, email, password } = request.body;
      limiter.consume(request.ip, org_slug, email.trim().toLowerCase());
      try {
        const response = await fetch(endpoint, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ org_slug, email, password }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 401) return reply.code(401).send({ error: 'Invalid credentials' });
          if (response.status === 400) return reply.code(400).send({ error: 'Invalid request' });
          if (response.status === 429) {
            const retry = response.headers.get('retry-after') ?? '';
            return reply.header('Retry-After', /^[1-9][0-9]?$/u.test(retry) ? retry : '60')
              .code(429).send({ error: 'Too many requests' });
          }
          if (response.status === 500) return reply.code(500).send({ error: 'Internal server error' });
          throw new Error();
        }
        const body = await response.json() as { access_token?: unknown };
        if (typeof body.access_token !== 'string') throw new Error();
        await verifyAccessToken(body.access_token, deps.verificationKeys);
        return { access_token: body.access_token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_SECONDS };
      } catch {
        return reply.code(503).send({ error: 'Authentication unavailable' });
      }
    });
    scope.get('/auth/me', async request => withAuthorizedTenant(deps, request, undefined, async ({ client, sub, org, role }) => {
      const organizations = await client.query<{ name: string }>('SELECT name FROM organizations');
      if (organizations.rows.length !== 1) throw new Error('Organization unavailable');
      return { user_id: sub, org_id: org, org_name: organizations.rows[0]!.name, role, permissions: PERMISSION_MATRIX[role] };
    }));
  });
}
