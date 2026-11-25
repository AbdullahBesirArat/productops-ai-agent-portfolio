import { authFixture } from '../fixtures/auth-keys.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, type TestContext } from 'node:test';
import { chromium, type Browser, type BrowserContextOptions, type Page, type Request, type Response } from 'playwright-core';
import { buildApp } from '../../src/app.js';
import { loadDatabaseConfig } from '../../src/config.js';
import { createPool } from '../../src/db/pool.js';
import { SEED_TENANTS } from '../../src/db/seed-data.js';
import { runSeed } from '../../src/db/seed.js';
import { ToolLimiter } from '../../src/tools/limiter.js';

export const tenant = SEED_TENANTS[0]!;
export const otherTenant = SEED_TENANTS[1]!;
export const seedUser = (role: 'owner' | 'member' | 'viewer') => tenant.users.find((user) => user.role === role)!;
export const reviews = '/support/reviews';
export const previewPath = '/support/drafts/preview';
export const screenshotDir = 'docs/portfolio/screenshots';
export const marker = 'e2e-' + randomUUID();
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const delivery = /send|dispatch|publish|webhook/iu;
const jwt = /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/u;
const dbUrl = /postgres(?:ql)?:\/\//iu;
let admin: ReturnType<typeof createPool> | undefined;
let browser: Browser;
let password: string;
const reviewIds = new Set<string>();
const orgFixtures = new Set<string>();
const orderFixtures = new Set<string>();

export function containsCredential(value: string) {
  if (jwt.test(value) || dbUrl.test(value)) return true;
  for (const [key, secret] of Object.entries(process.env)) {
    if (!secret || !/^PRODUCTOPS_/u.test(key) || !/URL|PASSWORD|SECRET|TOKEN|KEY/u.test(key)) continue;
    if (value.includes(secret)) return true;
    if (dbUrl.test(secret)) {
      try {
        const credential = decodeURIComponent(new URL(secret).password);
        if (credential && value.includes(credential)) return true;
      } catch { /* The full value was already checked. */ }
    }
  }
  return false;
}

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: 'chrome', timeout: 15000 });
  } catch {
    const cache = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright');
    const folders = cache ? await readdir(cache).catch(() => []) : [];
    for (const folder of folders.filter((name) => /^chromium-\d+$/u.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      try {
        return await chromium.launch({ executablePath: join(cache!, folder, 'chrome-win64', 'chrome.exe'), timeout: 15000 });
      } catch { /* Try the next cached revision. */ }
    }
    throw new Error('Chrome and cached bundled Chromium could not be launched.');
  }
}

before(async () => {
  try {
    const runtime = loadDatabaseConfig(process.env.PRODUCTOPS_TEST_DB_URL, 'productops_app');
    const bootstrap = loadDatabaseConfig(process.env.PRODUCTOPS_BOOTSTRAP_TEST_DB_URL, 'productops_bootstrap');
    for (const config of [runtime, bootstrap]) {
      assert.ok(['localhost', '127.0.0.1'].includes(config.host) && config.database === 'productops_test');
    }
    assert.ok(process.env.PRODUCTOPS_DEMO_PASSWORD);
    password = process.env.PRODUCTOPS_DEMO_PASSWORD;
    await runSeed(bootstrap, password);
    admin = createPool(bootstrap);
  } catch {
    throw new Error('E2E app setup failed. Check loopback productops_test configuration, migrations and bootstrap access.');
  }
  browser = await launch();
  console.log('E2E Chromium version ' + browser.version());
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    try {
      if (reviewIds.size) await admin!.query('DELETE FROM public.draft_reviews WHERE id = ANY($1::uuid[])', [[...reviewIds]]);
      for (const id of orderFixtures) await admin!.query('DELETE FROM public.orders WHERE id = $1', [id]);
      for (const id of orgFixtures) await admin!.query('DELETE FROM public.organizations WHERE id = $1', [id]);
    } catch {
      throw new Error('E2E fixture cleanup failed.');
    } finally {
      await admin?.end();
    }
  }
});

export async function emptyTenant() {
  const id = randomUUID();
  try {
    await admin!.query('INSERT INTO public.organizations(id,name,slug) VALUES($1,$2,$2)', [id, marker]);
    orgFixtures.add(id);
    await admin!.query("INSERT INTO public.memberships(org_id,user_id,role) VALUES($1,$2,'member')", [id, seedUser('member').id]);
  } catch { throw new Error('Could not create the empty tenant fixture.'); }
  return marker;
}

export async function foreignOrder() {
  const id = randomUUID();
  const code = 'ORD-' + id.slice(0, 12).toUpperCase();
  try {
    await admin!.query("INSERT INTO public.orders(id,org_id,order_code,customer_ref,status) VALUES($1,$2,$3,$4,'cancelled')",
      [id, otherTenant.id, code, marker]);
    orderFixtures.add(id);
  } catch { throw new Error('Could not create the foreign order fixture.'); }
  return code;
}

export const pathIs = (origin: string, path: string) => (url: URL) => url.origin === origin && url.pathname === path;
export const responseIs = (origin: string, path: string, method: string) => (response: Response) =>
  pathIs(origin, path)(new URL(response.url())) && response.request().method() === method;

export async function openBrowser(t: TestContext, options: BrowserContextOptions = {}) {
  const auth = await authFixture();
  t.after(() => auth.close());
  const budget = () => new ToolLimiter(Date.now, 1000, 1000);
  const app = buildApp({
    ...auth.env,
    PRODUCTOPS_DB_URL: process.env.PRODUCTOPS_TEST_DB_URL,
  }, {
    review: { limiter: budget() },
    support: { limiter: budget() },
  });
  t.after(() => app.close());
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', ...options,
  });
  const messages: Array<{ type: string; text: string; url: string }> = [];
  const expectedHttp = new Map<string, number>();
  const foreign = new Set<object>();
  const sendLike = new Set<object>();
  const failures: Request[] = [];
  const redirects: number[] = [];
  const pending: Promise<void>[] = [];
  let errors = 0;
  let dialogs = 0;
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) foreign.add(request);
    if (delivery.test(url.pathname)) sendLike.add(request);
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (foreign.has(request) || sendLike.has(request)) await route.abort('blockedbyclient');
    else await route.continue();
  });
  context.on('requestfailed', (request) => failures.push(request));
  context.on('console', (message) => messages.push({
    type: message.type(), text: message.text(), url: message.location().url,
  }));
  context.on('weberror', () => { errors++; });
  context.on('dialog', (dialog) => { dialogs++; void dialog.dismiss().catch(() => undefined); });
  let invalidReview = false;
  context.on('response', (response) => {
    if (response.status() >= 300 && response.status() < 400) redirects.push(response.status());
    if (response.status() !== 201 || !responseIs(origin, reviews, 'POST')(response)) return;
    const payload = response.request().postDataJSON() as { message?: string };
    if (!payload.message?.includes(marker)) return;
    pending.push(response.json().then((body: { review?: { id?: string } }) => {
      if (body.review?.id && uuid.test(body.review.id)) reviewIds.add(body.review.id);
      else invalidReview = true;
    }).catch(() => { invalidReview = true; }));
  });
  t.after(async () => {
    try {
      await Promise.all(pending);
      assert.ok(!invalidReview, 'Could not record created review for cleanup');
      // Consume only Chromium HTTP resource diagnostics for explicitly expected responses.
      for (const message of messages.filter(({ type }) => type === 'error')) {
        const status = /^Failed to load resource: the server responded with a status of (\d{3})\b/u.exec(message.text)?.[1];
        const key = status && message.url ? message.url + '|' + status : '';
        const count = expectedHttp.get(key) ?? 0;
        assert.ok(count > 0, 'Unexpected browser console.error event');
        expectedHttp.set(key, count - 1);
      }
      assert.equal(errors, 0, 'Browser page errors');
      assert.equal(dialogs, 0, 'Browser dialogs');
      assert.equal(foreign.size, 0, 'Foreign requests');
      assert.equal(sendLike.size, 0, 'Delivery-like request paths');
      assert.equal(failures.length, 0, 'Failed browser requests: ' + failures.map((request) => {
        const path = new URL(request.url()).pathname;
        const label = /^\/(?:ui(?:\/app\.js|\/style\.css)?|support\/reviews|auth\/login)$/u.test(path) ? path : '[other path]';
        const code = request.failure()?.errorText;
        return label + ' ' + (/^net::ERR_[A-Z_]+$/u.test(code ?? '') ? code : '[unknown]');
      }).join(', '));
      assert.equal(redirects.length, 0, 'Browser redirects');
    } finally {
      await context.close();
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  return {
    page, origin,
    expectHttp(pathAndQuery: string, status: number, count = 1) {
      const key = origin + pathAndQuery + '|' + status;
      expectedHttp.set(key, (expectedHttp.get(key) ?? 0) + count);
    },
  };
}

export type Session = Awaited<ReturnType<typeof openBrowser>>;
export const visible = (page: Page, selector: string) => page.locator(selector).waitFor({ state: 'visible' });

export async function hasText(page: Page, selector: string, substring: string) {
  await page.waitForFunction(({ selector, substring }) => document.querySelector(selector)?.textContent?.includes(substring),
    { selector, substring }, { timeout: 8000 });
}

export async function fillLogin(page: Page, role: 'owner' | 'member' | 'viewer', slug = tenant.slug) {
  try {
    await page.locator('#slug').fill(slug);
    await page.locator('#email').fill(seedUser(role).email);
    await page.locator('#password').fill(password);
  } catch { throw new Error('Could not fill the sign-in controls.'); }
}

export async function typeMemberLogin(page: Page) {
  for (const [id, value] of [['slug', tenant.slug], ['email', seedUser('member').email], ['password', password]] as const) {
    await page.keyboard.press('Tab');
    await page.waitForFunction((id) => document.activeElement?.id === id, id, { timeout: 8000 });
    const focus = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement!);
      return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
    });
    assert.ok(focus, 'Keyboard focus has a visible outline');
    try {
      await page.keyboard.insertText(value);
    } catch { throw new Error('Could not type into the keyboard-focused sign-in control.'); }
  }
}

export async function login(session: Session, role: 'owner' | 'member' | 'viewer' = 'member', slug = tenant.slug) {
  const { page } = session;
  if (role === 'viewer') session.expectHttp(reviews + '?limit=20', 403);
  await fillLogin(page, role, slug);
  const queue = page.waitForResponse(responseIs(session.origin, reviews, 'GET'));
  await page.locator('#login').click();
  assert.equal((await queue).status(), role === 'viewer' ? 403 : 200);
  await settled(page);
}

export const settled = (page: Page) =>
  page.waitForFunction(() => !document.querySelector('#workspace')?.hasAttribute('inert'), undefined, { timeout: 8000 });

export async function signInView(session: Session) {
  const response = await session.page.goto(session.origin + '/ui');
  assert.equal(response?.status(), 200);
  await visible(session.page, '#login');
  return response!;
}
