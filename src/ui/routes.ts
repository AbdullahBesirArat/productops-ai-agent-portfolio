import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

const UI_PREFIX = /^\/ui(?:[/\\?#]|%2f|%5c|$)/iu;
const INDEX = ['/ui', '/ui/'] as const;
const SCRIPT = '/ui/app.js';
const STYLE = '/ui/style.css';
const ALLOWED = new Set<string>([...INDEX, SCRIPT, STYLE]);

export function rewriteUiTarget(request: { url?: string | undefined }): string {
  const target = request.url ?? '';
  // The router can reject malformed percent escapes before the request hook.
  return UI_PREFIX.test(target) && !ALLOWED.has(target) ? '/ui/!' : target;
}

export function registerUiRoutes(app: FastifyInstance): void {
  const index = readFileSync(new URL('../../ui/index.html', import.meta.url));
  const assets = new Map([
    ...INDEX.map((path) => [path, { body: index, type: 'text/html' }] as const),
    [SCRIPT, { body: readFileSync(new URL('../../ui/app.js', import.meta.url)), type: 'text/javascript' }],
    [STYLE, { body: readFileSync(new URL('../../ui/style.css', import.meta.url)), type: 'text/css' }],
  ]);

  app.addHook('onRequest', async (request, reply) => {
    const target = request.raw.url ?? '';
    if (!UI_PREFIX.test(target)) return;
    reply.headers({
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    if (!ALLOWED.has(target) || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return reply.code(404).type('text/plain; charset=utf-8').send(request.method === 'HEAD' ? undefined : 'Not found');
    }
  });

  for (const [url, { body, type }] of assets) {
    app.route({
      method: ['GET', 'HEAD'], url, exposeHeadRoute: false,
      async handler(request, reply) {
        reply.type(`${type}; charset=utf-8`).header('Content-Length', body.length);
        return reply.send(request.method === 'HEAD' ? undefined : body);
      },
    });
  }
}
