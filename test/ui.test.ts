import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Duplex } from 'node:stream';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildApp } from '../src/app.js';
import { SEED_TENANTS } from '../src/db/seed-data.js';

const assets = [
  ['/ui', 'index.html', 'text/html'],
  ['/ui/', 'index.html', 'text/html'],
  ['/ui/app.js', 'app.js', 'text/javascript'],
  ['/ui/style.css', 'style.css', 'text/css'],
] as const;
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const headers = {
  'content-security-policy': csp,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
};

test('UI serves exact bytes and security headers for GET and HEAD without a DB', async (t) => {
  const app = buildApp({});
  t.after(() => app.close());
  for (const [url, file, type] of assets) {
    const bytes = readFileSync(`ui/${file}`);
    for (const method of ['GET', 'HEAD'] as const) {
      const response = await app.inject({ method, url });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], `${type}; charset=utf-8`);
      assert.equal(response.headers['content-length'], String(bytes.length));
      for (const [name, value] of Object.entries(headers)) assert.equal(response.headers[name], value);
      assert.deepEqual(response.rawPayload, method === 'GET' ? bytes : Buffer.alloc(0));
    }
  }
  for (const method of ['POST', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
    const response = await app.inject({ method, url: '/ui/app.js', payload: 'ignored' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body, 'Not found');
    assert.equal(response.headers['content-security-policy'], csp);
  }
});

function rawGet(app: ReturnType<typeof buildApp>, url: string): Promise<string> {
  // Injection normalizes dot segments, backslashes and empty queries via WHATWG URL.
  // Feed the same HTTP server an in-memory stream to preserve the original target.
  return new Promise((resolve, reject) => {
    let wire = '';
    const socket = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, done) {
        wire += chunk.toString('utf8');
        done();
      },
    });
    socket.once('error', reject);
    socket.once('finish', () => resolve(wire));
    app.server.emit('connection', socket);
    socket.push(`GET ${url} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    socket.push(null);
  });
}

test('UI allowlist rejects traversal, alternate separators, malformed targets and queries', { timeout: 5000 }, async (t) => {
  const app = buildApp({});
  t.after(() => app.close());
  for (const url of ['/ui/%2e%2e%2fpackage.json', '/ui//app.js', '/ui/app.js/', '/ui/index.html',
    '/ui/unknown', '/ui/app.js?file=style.css', '/ui/?path=/ui/app.js', '/ui/%ZZ', '/ui/%61pp.js', '/ui%2fapp.js']) {
    const response = await app.inject({ url });
    assert.equal(response.statusCode, 404, url);
    assert.equal(response.body, 'Not found');
    for (const [name, value] of Object.entries(headers)) assert.equal(response.headers[name], value);
  }
  for (const url of ['/ui/../package.json', '/ui/%2e%2e/package.json', '/ui/./app.js',
    '/ui\\app.js', '/ui/..\\package.json', '/ui/%5capp.js', '/ui/app.js?']) {
    const response = await rawGet(app, url);
    assert.match(response, /^HTTP\/1\.1 404 /u, url);
    assert.ok(response.includes(csp), url);
    assert.ok(response.endsWith('\r\n\r\nNot found'), url);
  }
});

test('UI sources use local assets, safe DOM APIs and accessible controls', () => {
  const forbidden = /innerHTML|outerHTML|insertAdjacentHTML|document\s*\.\s*write|\beval\s*\(|new\s+Function|(?:setTimeout|setInterval)\s*\(\s*['"`]|javascript\s*:|localStorage|sessionStorage|document\s*\.\s*cookie|window\s*\.\s*open|postMessage|XMLHttpRequest|WebSocket|EventSource|\bimport\s*\(|(?:https?:)?\/\/[\w.\[]/iu;
  for (const file of new Set(assets.map((asset) => asset[1]))) {
    const source = readFileSync(`ui/${file}`, 'utf8');
    assert.doesNotMatch(source, forbidden);
    assert.doesNotMatch(source, /\p{Cf}/u);
    assert.doesNotMatch(source, /['"](?:inner|outer|insertAdjacent)['"]\s*\+/iu);
    assert.doesNotMatch(source, /process\.env|PRODUCTOPS_|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b[0-9a-f]{64}\b/iu);
    for (const tenant of SEED_TENANTS) {
      assert.ok(!source.includes(tenant.slug));
      for (const user of tenant.users) assert.ok(!source.includes(user.email));
    }
  }
  const html = readFileSync('ui/index.html', 'utf8');
  assert.match(html, /LOCAL DEMO — synthetic data only\. Drafts are never sent\. Approving only records an internal decision; nothing leaves this system\./u);
  assert.match(html, /does NOT send anything/u);
  assert.match(html, /<html lang="en">/u);
  assert.equal([...html.matchAll(/<h1\b/giu)].length, 1);
  for (const element of ['header', 'main', 'footer']) assert.match(html, new RegExp(`<${element}\\b`, 'u'));
  assert.match(html, /aria-live="polite"/u);
  assert.doesNotMatch(html, /<style\b|\s(?:style|on[\w-]+)\s*=/iu);
  assert.deepEqual([...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/giu)].map(([tag]) => tag),
    ['<script type="module" src="/ui/app.js"></script>']);
  assert.deepEqual([...html.matchAll(/\b(?:src|href)="([^"]*)"/gu)].map((match) => match[1]), ['/ui/style.css', '/ui/app.js']);
  for (const [tag] of html.matchAll(/<(?:input|textarea|select)\b[^>]*>/giu)) {
    const id = tag.match(/\bid="([\w-]+)"/u)?.[1];
    assert.ok(id && html.includes(`<label for="${id}">`), tag);
  }
  for (const [tag] of html.matchAll(/<button\b[^>]*>/giu)) assert.match(tag, /type="button"/u);
});

test('UI renders hostile replies as text and restricts authenticated requests and decision payloads', async () => {
  const writes: string[] = [];
  class Element {
    children: Element[] = [];
    handlers = new Map<string, () => unknown>();
    hidden = false;
    disabled = false;
    #text = '';
    #value = '';
    get textContent() { return this.#text; }
    set textContent(value: string) { writes.push(value); this.#text = value; }
    get value() { return this.#value; }
    set value(value: string) { writes.push(value); this.#value = value; }
    append(node: Element) { this.children.push(node); }
    replaceChildren() { this.children = []; this.#text = ''; }
    setAttribute(name: string, value: string) {
      assert.ok(['class', 'type'].includes(name));
      writes.push(value);
    }
    focus() {}
    reportValidity() { return true; }
    addEventListener(event: string, handler: () => unknown) { this.handlers.set(event, handler); }
  }
  for (const name of ['innerHTML', 'outerHTML', 'insertAdjacentHTML']) {
    const forbidden = () => assert.fail(`Unsafe DOM access: ${name}`);
    Object.defineProperty(Element.prototype, name, { get: forbidden, set: forbidden });
  }
  const nodes = new Map<string, Element>();
  const element = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id)!;
  };
  element('limit').value = '20';
  element('message').value = 'Synthetic request';
  element('language').value = 'en';
  element('reason').value = 'other';
  const id = 'beed5605-1263-461d-a590-78afc69971aa';
  const secret = 'synthetic-bearer-sentinel';
  const hostile = '<img src=x onerror=attack()> <script>attack()</script> javascript:attack() \u202e\u200b ' + 'X'.repeat(10_000);
  const evidence = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}') as Record<string, unknown>;
  evidence.quote = hostile;
  const preview = {
    classification: { intent: hostile }, internal_evidence: { entries: [evidence], sources: [hostile] },
    internal_operator_notes: [hostile], customer_safe_draft: { language: 'en', text: hostile },
    disclosure_decision: { restricted_fields: [{ field: hostile, reason: hostile }] }, review_notes: [hostile],
  };
  const detail = { ...preview, id, state: 'edited', version: 3, events: [{ event_type: hostile }], revisions: [{ author_id: hostile }] };
  const pending: Array<{ status: number; data: unknown }> = [];
  const requests: Array<{ path: string; method: string; body: unknown; auth?: string }> = [];
  runInNewContext(readFileSync('ui/app.js', 'utf8'), {
    document: {
      getElementById: element,
      createElement(tag: string) {
        assert.ok(['section', 'h3', 'h4', 'h5', 'pre', 'p', 'li', 'ol', 'button'].includes(tag));
        return new Element();
      },
    },
    Blob, URLSearchParams,
    async fetch(path: string, options: RequestInit) {
      assert.match(path, /^\/(?:auth\/login|support\/drafts\/preview|support\/reviews(?:\?(?:state=[a-z_]+&)?limit=20|\/[0-9a-f-]{36}(?:\/(?:approve|reject))?)?)$/u);
      assert.ok(!path.includes(secret));
      assert.equal(options.credentials, 'omit');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error');
      const headers = new Headers(options.headers);
      assert.deepEqual([...headers.keys()], path === '/auth/login' ? [] : ['authorization']);
      const auth = headers.get('Authorization');
      if (path !== '/auth/login') assert.equal(auth, `Bearer ${secret}`);
      const body = options.body;
      if (body) assert.ok(body instanceof Blob && body.type === 'application/json');
      requests.push({ path, method: options.method!, body: body instanceof Blob ? JSON.parse(await body.text()) : undefined, ...(auth ? { auth } : {}) });
      const response = pending.shift();
      assert.ok(response, `Unexpected request ${path}`);
      return { ok: response.status < 400, status: response.status, json: async () => JSON.parse(JSON.stringify(response.data)) };
    },
  });
  const queue = { reviews: [{ id: '../../send' }, { id }] };
  const click = async (node: Element, ...responses: Array<[number, unknown]>) => {
    pending.push(...responses.map(([status, data]) => ({ status, data })));
    await node.handlers.get('click')!();
    assert.equal(pending.length, 0);
  };
  await click(element('login'), [200, { access_token: secret }], [200, queue]);
  assert.equal(element('queue').children.length, 1);
  await click(element('preview'), [200, preview]);
  assert.ok(writes.includes(hostile));
  assert.ok(writes.some((value) => value.includes('"__proto__"') && value.includes(hostile)));
  assert.equal(Object.getOwnPropertyDescriptor(Object.prototype, 'polluted'), undefined);
  await click(element('submit-review'), [201, { review: detail }], [200, queue]);
  assert.deepEqual(requests.find(({ path }) => path === '/support/reviews')?.body, { message: 'Synthetic request', language: 'en' });
  assert.equal(element('edit-text').value, hostile);
  assert.ok(writes.some((value) => value.startsWith(hostile + ' |')));
  await click(element('approve'), [403, { errorCode: 'SELF_APPROVAL_FORBIDDEN', error: hostile }]);
  assert.equal(element('status').textContent, 'A different operator must approve this draft.');
  assert.deepEqual(requests.at(-1)?.body, { expected_version: 3 });
  await click(element('approve'), [422, { errorCode: 'BLOCKED_FOR_CUSTOMER_USE', check_codes: ['unsafe_characters', hostile] }]);
  assert.equal(element('status').textContent, 'This draft is blocked for customer use. Checks: unsafe_characters.');
  element('edit-text').value = 'Synthetic revision';
  await click(element('save'), [409, { errorCode: 'STALE_VERSION' }]);
  assert.match(element('status').textContent, /Someone changed this draft/u);
  assert.deepEqual(requests.at(-1)?.body, { expected_version: 3, customer_text: 'Synthetic revision' });
  await click(element('reject'), [200, { review: { id, state: 'rejected', version: 4 } }],
    [200, { review: { ...detail, state: 'rejected', version: 4 } }], [200, queue]);
  assert.deepEqual(requests.find(({ path }) => path.endsWith('/reject'))?.body, { expected_version: 3, reason_code: 'other' });
  assert.equal(element('approve').disabled, true);
  assert.equal(element('save').disabled, true);
  await click(element('queue').children[0]!.children[0]!, [200, { review: detail }]);
  await click(element('approve'), [422, { errorCode: 'BLOCKED_FOR_CUSTOMER_USE' }],
    [200, { review: { ...detail, state: 'blocked', version: 4, check_codes: ['order_code'] } }]);
  assert.match(element('status').textContent, /Checks: order_code/u);
  assert.equal(element('approve').disabled, true);
  await click(element('refresh'), [401, { error: hostile }]);
  assert.equal(element('sign-in').hidden, false);
  assert.equal(element('workspace').hidden, true);
  assert.equal(element('status').textContent, 'Sign in to continue.');
  assert.equal(element('edit-text').value, '');
  await click(element('login'), [200, { access_token: secret }], [403, { errorCode: 'FORBIDDEN', error: hostile }]);
  assert.match(element('status').textContent, /Access denied.*read-only/u);
  assert.equal(element('preview').disabled, true);
  assert.ok(writes.every((value) => !value.includes(secret)));
  assert.ok(requests.every(({ path }) => !path.includes('send')));
});
