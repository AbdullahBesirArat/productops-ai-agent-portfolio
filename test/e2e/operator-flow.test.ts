import assert from 'node:assert/strict';
import { readdir, readFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page, Response } from 'playwright-core';
import type { InternalEvidence } from '../../src/support/disclosure.js';
import { SEED_TENANTS } from '../../src/db/seed-data.js';
import {
  containsCredential, emptyTenant, foreignOrder, hasText, login, marker, openBrowser,
  pathIs, previewPath, responseIs, reviews, screenshotDir, seedUser, settled, signInView, tenant, typeMemberLogin, visible,
} from './harness.js';

const order = tenant.orders[0]!;
const turkishOrder = 'Sipari\u015f durumu ' + order.code + '?';
const safe = 'Our team will review your request.';
const safeTr = 'Ekibimiz talebinizi inceleyecek.';
const previewPanel = '#preview-result';
const detailPanel = '#review-content';
const empty = 'No reviews match these filters.';
const events = '#review-content > ol:last-of-type';
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

async function preview(page: Page, message = turkishOrder, language: 'en' | 'tr' = 'tr') {
  await page.locator('#message').fill(message + ' ' + marker);
  await page.locator('#language').selectOption(language);
  await page.locator('#preview').click();
  await hasText(page, '#status', 'Draft preview ready.');
  await settled(page);
}

async function create(page: Page) {
  const response = page.waitForResponse(responseIs(new URL(page.url()).origin, reviews, 'POST'));
  await page.locator('#submit-review').click();
  const result = await response;
  assert.equal(result.status(), 201);
  const { review } = await result.json() as { review: { id: string; created_at: string } };
  await badge(page, 'pending_review', 1);
  await hasText(page, detailPanel, 'Revision 1');
  await hasText(page, '#status', 'Draft added to the human review queue.');
  await settled(page);
  return review;
}

async function badge(page: Page, state: string, version: number) {
  const expected = state + ' | Version ' + version;
  await hasText(page, '#review-state', expected);
  assert.equal(await page.locator('#review-state').textContent(), expected);
}

async function edit(page: Page, value: string) {
  const input = page.locator('#edit-text');
  await input.fill(value);
  assert.ok(await input.inputValue() === value, 'Draft text was entered into the edit control');
  await page.locator('#save').click();
  await hasText(page, '#status', 'Edit saved.');
  await settled(page);
}

async function evidence(page: Page, panel = previewPanel): Promise<InternalEvidence[]> {
  return JSON.parse((await page.locator(panel + ' .internal pre').first().textContent())!);
}

async function checkDisclosure(page: Page, entries: InternalEvidence[]) {
  const customer = (await page.locator(previewPanel + ' .customer').textContent())!;
  const values = entries.flatMap((entry) => {
    if (entry.kind === 'order_status') return [entry.order_code, entry.status, entry.status_updated_date];
    if (entry.kind === 'low_stock') return entry.items.flatMap((item) => [item.sku, item.name, item.available_stock]);
    return [];
  });
  assert.ok(values.length > 0);
  for (const value of values) {
    if (typeof value === 'number') assert.ok(!customer.match(/\d+/gu)?.includes(String(value)), 'Inventory quantity in customer panel');
    else assert.ok(value && !customer.toLowerCase().includes(value.toLowerCase()), 'Evidence value in customer panel');
  }
}

test('Full operator flow shows Turkish customer text and records an internal approval with separate actors', async (t) => {
  const session = await openBrowser(t);
  const { page } = session;
  const document = await signInView(session);
  assert.equal(document.headers()['content-security-policy'], csp);
  await hasText(page, '.banner', 'LOCAL DEMO \u2014 synthetic data only. Drafts are never sent.');
  await login(session);
  await preview(page);
  await hasText(page, previewPanel + ' .customer', 'Language: tr');
  assert.equal(await page.locator(previewPanel + ' .draft-text').textContent(),
    'Sipariş sorguları için kimlik doğrulaması gerekir. Ekibimizden biri sizinle iletişime geçecek.');
  await hasText(page, previewPanel + ' > pre', '"intent": "order_status"');
  await hasText(page, previewPanel + ' > pre', '"rule_id": "rule.order_status.v1"');
  await hasText(page, previewPanel + ' .internal h4', 'operators only');
  const entries = await evidence(page);
  assert.ok(entries.some((entry) => entry.kind === 'order_status' && entry.status === order.status));
  await checkDisclosure(page, entries);

  const review = await create(page);
  await hasText(page, '#queue', 'order_status | pending_review | v1 | ' + review.created_at);
  await edit(page, safeTr);
  await badge(page, 'edited', 2);
  assert.equal(await page.locator(detailPanel + ' .draft-text').textContent(), safeTr);
  const approvePath = reviews + '/' + review.id + '/approve';
  session.expectHttp(approvePath, 403);
  const refused = page.waitForResponse(responseIs(new URL(page.url()).origin, approvePath, 'POST'));
  await page.locator('#approve').click();
  assert.equal((await refused).status(), 403);
  await hasText(page, '#status', 'A different operator must approve this draft.');
  await badge(page, 'edited', 2);
  await settled(page);
  await page.locator('#sign-out').click();
  await login(session, 'owner');
  await page.locator('#queue button').filter({ hasText: 'order_status | edited | v2 | ' + review.created_at }).click();
  await badge(page, 'edited', 2);
  await page.locator('#approve').click();
  await hasText(page, '#status', 'Internal decision recorded.');
  await badge(page, 'approved_internal', 3);
  await hasText(page, '#detail .decision p', 'Approve records an internal decision. It does NOT send anything.');
  await hasText(page, '.banner', 'nothing leaves this system.');
  const history = await page.locator(events + ' li').allTextContents();
  assert.equal(history.length, 3);
  assert.ok(history[0]?.includes('created | Initial \u2192 pending_review | Revision 1 | Actor ' + seedUser('member').id));
  assert.ok(history[1]?.includes('edited | pending_review \u2192 edited | Revision 2 | Actor ' + seedUser('member').id));
  assert.ok(history[2]?.includes('approved_internal | edited \u2192 approved_internal | Revision 2 | Actor ' + seedUser('owner').id));
  assert.ok(!history.some((row) => [turkishOrder, order.code, marker, safe, safeTr].some((value) => row.includes(value))));
});

test('Reject and blocked flows display distinct states and validation codes', async (t) => {
  const session = await openBrowser(t);
  const { page } = session;
  await signInView(session);
  await login(session);
  for (const reason of ['inaccurate', 'unsafe_disclosure']) {
    await preview(page);
    await create(page);
    await page.locator('#reason').selectOption(reason);
    await page.locator('#reject').click();
    await hasText(page, '#status', 'Internal decision recorded.');
    await badge(page, 'rejected', 2);
    await hasText(page, events, 'Reason ' + reason);
  }
  await preview(page, 'Order status ' + order.code, 'en');
  await create(page);
  await edit(page, safe);
  await badge(page, 'edited', 2);
  await edit(page, order.status + ' ' + order.code + ' https://example.test/');
  await badge(page, 'blocked', 3);
  for (const code of ['order_status', 'order_code', 'markup_or_contact']) await hasText(page, detailPanel + ' .customer', code);
  assert.ok(await page.locator('#approve').isDisabled());
});

function loginResponse(page: Page) {
  let resolve!: (response: Response) => void;
  const received = new Promise<Response>((done) => { resolve = done; });
  const listener = (response: Response) => {
    if (responseIs(new URL(page.url()).origin, '/auth/login', 'POST')(response)) {
      page.off('response', listener);
      resolve(response);
    }
  };
  page.on('response', listener);
  return received;
}

async function tokenFrom(response: Response) {
  assert.equal(response.status(), 200, 'Sign-in response status');
  try {
    const { access_token } = await response.json() as { access_token?: string };
    if (typeof access_token === 'string' && access_token.length > 0) return access_token;
  } catch { /* Never report contents of sign-in responses. */ }
  throw new Error('No access token in sign-in response');
}

test('Viewer is denied in the UI and on all six review operations', async (t) => {
  const session = await openBrowser(t);
  const { page } = session;
  await signInView(session);
  await login(session);
  await preview(page);
  const { id } = await create(page);
  await page.locator('#sign-out').click();
  const received = loginResponse(page);
  await login(session, 'viewer');
  const token = await tokenFrom(await received);
  await hasText(page, '#status', 'Access denied. Your role may be read-only or lack review access.');
  assert.ok(await page.locator('#preview').isDisabled());
  const detail = reviews + '/' + id;
  const operations = [
    { method: 'POST', path: reviews, body: { message: turkishOrder + ' ' + marker } },
    { method: 'GET', path: reviews },
    { method: 'GET', path: detail },
    { method: 'PATCH', path: detail, body: { expected_version: 1, customer_text: safeTr } },
    { method: 'POST', path: detail + '/approve', body: { expected_version: 1 } },
    { method: 'POST', path: detail + '/reject', body: { expected_version: 1, reason_code: 'other' } },
  ];
  for (const operation of operations) {
    session.expectHttp(operation.path, 403);
    const result = await page.evaluate(async ({ operation, token }) => {
      const response = await fetch(operation.path, {
        method: operation.method, credentials: 'omit', redirect: 'error',
        headers: { Authorization: 'Bearer ' + token },
        ...(operation.body ? { body: new Blob([JSON.stringify(operation.body)], { type: 'application/json' }) } : {}),
      });
      return { status: response.status, forbidden: (await response.json()).errorCode === 'FORBIDDEN' };
    }, { operation, token }).catch(() => { throw new Error('Viewer request failed in the browser'); });
    assert.deepEqual(result, { status: 403, forbidden: true }, operation.method + ' ' + operation.path);
  }
});

async function noTokenInPage(page: Page, token: string) {
  const found = await page.evaluate((token) => [
    location.href, JSON.stringify(localStorage), JSON.stringify(sessionStorage),
    document.cookie, document.documentElement.textContent ?? '',
  ].some((value) => value.includes(token)), token).catch(() => { throw new Error('Could not inspect session storage surfaces'); });
  assert.ok(!found, 'Token was exposed in a page surface');
}

test('A tampered token receives a genuine 401 and reload discards sessions', async (t) => {
  const session = await openBrowser(t);
  const { page } = session;
  await signInView(session);
  let received = loginResponse(page);
  await login(session);
  const firstToken = await tokenFrom(await received);
  await noTokenInPage(page, firstToken);

  await page.reload();
  await visible(page, '#login');
  assert.ok(await page.locator('#workspace').isHidden());
  await noTokenInPage(page, firstToken);
  received = loginResponse(page);
  await login(session);
  const token = await tokenFrom(await received);
  await noTokenInPage(page, token);
  session.expectHttp(reviews + '?limit=20', 401);
  let usedSessionToken = false;
  let unauthorized = false;
  await page.route(pathIs(new URL(page.url()).origin, reviews), async (route) => {
    const headers = await route.request().allHeaders();
    usedSessionToken = headers.authorization === 'Bearer ' + token;
    const response = await route.fetch({
      headers: { ...headers, authorization: 'Bearer ' + token + '.invalid' }, maxRedirects: 0,
    });
    const body = await response.json() as { errorCode?: string };
    unauthorized = response.status() === 401 && body.errorCode === 'UNAUTHORIZED';
    await route.fulfill({ status: response.status(), json: body });
  }, { times: 1 });
  const rejected = page.waitForResponse(responseIs(new URL(page.url()).origin, reviews, 'GET'));
  await page.locator('#refresh').click();
  assert.equal((await rejected).status(), 401);
  await visible(page, '#login');
  assert.ok(usedSessionToken && unauthorized, 'The real review endpoint must reject the tampered token');
  assert.ok(await page.locator('#workspace').isHidden());
  assert.equal(await page.locator('#status').textContent(), 'Sign in to continue.');
  assert.ok(await page.locator('#password').inputValue() === '', 'Password field must be cleared');
  await noTokenInPage(page, token);
  const nextLogin = page.waitForRequest((request) =>
    pathIs(new URL(page.url()).origin, '/auth/login')(new URL(request.url())) && request.method() === 'POST');
  await login(session);
  assert.ok(!(await (await nextLogin).allHeaders()).authorization, 'Cleared token must not authorize the next login');
  await page.reload();
  await visible(page, '#login');
  assert.ok(await page.locator('#workspace').isHidden());
  await noTokenInPage(page, token);
});

const hostile = '<img src=x onerror="window.__xss++;alert(1)"> <script>window.__xss++;alert(1)</script> ' +
  'javascript:window.__xss++ \u202e\u200b';
const longHostile = hostile + ' X'.repeat(12) + 'Z'.repeat(16000);

async function noInjection(page: Page) {
  const result = await page.evaluate(() => ({
    counter: (window as Window & { __xss?: number }).__xss,
    elements: document.querySelectorAll('img[src="x"], script:not([src]), [href^="javascript:"]').length,
  }));
  assert.deepEqual(result, { counter: 0, elements: 0 });
}

async function checkLayout(page: Page) {
  const layout = await page.evaluate(() => {
    const { clientWidth, scrollWidth } = document.documentElement;
    const visible = [...document.querySelectorAll('body *')].filter((node) => node.getClientRects().length > 0);
    const controls = visible.filter((node) => node.matches('button, input, select, textarea'));
    return {
      fits: scrollWidth <= clientWidth,
      contentFits: visible.every((node) => node.getBoundingClientRect().width <= clientWidth),
      controlsFit: controls.every((node) => {
        const rect = node.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= clientWidth && rect.width > 0 && rect.height > 0;
      }),
      wraps: visible.filter((node) => node.matches('.data, .draft-text, #review-content li'))
        .every((node) => node.scrollWidth <= node.clientWidth),
      labels: controls.every((node) => node.matches('button')
        ? Boolean(node.textContent?.trim())
        : Boolean((node as HTMLInputElement).labels?.length)),
      headings: document.querySelectorAll('h1').length,
    };
  });
  assert.deepEqual(layout, { fits: true, contentFits: true, controlsFit: true, wraps: true, labels: true, headings: 1 });
}

test('Hostile API content stays literal and real submissions stay inert', async (t) => {
  const session = await openBrowser(t, { viewport: { width: 375, height: 812 } });
  const { page } = session;
  await page.addInitScript(() => { (window as Window & { __xss?: number }).__xss = 0; });
  await signInView(session);
  await login(session);
  const neutral = 'The request could not be completed.';
  for (const reply of [
    { status: 200, body: '{invalid JSON}' },
    { status: 200, body: '{"classification":{"intent":"order_' },
    { status: 500, body: JSON.stringify({ errorCode: hostile, error: longHostile }) },
  ]) {
    if (reply.status === 500) session.expectHttp(previewPath, 500);
    await page.route(pathIs(new URL(page.url()).origin, previewPath), (route) => route.fulfill({ ...reply, contentType: 'application/json' }), { times: 1 });
    await page.locator('#message').fill('Synthetic message');
    const response = page.waitForResponse(responseIs(new URL(page.url()).origin, previewPath, 'POST'));
    await page.locator('#preview').click();
    assert.equal((await response).status(), reply.status);
    await hasText(page, '#status', neutral);
    await settled(page);
    assert.equal(await page.locator('#status').textContent(), neutral);
    assert.ok(await page.locator('#submit-review').isDisabled());
    await noInjection(page);
  }

  const draft = { language: 'en', text: longHostile };
  const content = {
    classification: { intent: longHostile }, internal_evidence: { entries: [{ quote: longHostile }] },
    internal_operator_notes: [longHostile], customer_safe_draft: draft,
  };
  await page.route(pathIs(new URL(page.url()).origin, previewPath), (route) => route.fulfill({ json: content }), { times: 1 });
  await preview(page);
  await hasText(page, previewPanel + ' .internal pre', JSON.stringify(longHostile));
  await hasText(page, previewPanel + ' .draft-text', longHostile);
  await checkLayout(page);
  await noInjection(page);

  await preview(page, turkishOrder + ' ' + hostile);
  // Compose normalization drops bidi and zero-width controls. The original input
  // remains in the textarea; the generated preview does not echo it.
  assert.ok((await page.locator('#message').inputValue()).includes(hostile));
  assert.ok(!(await page.locator(previewPanel).textContent())!.includes('\u202e'));
  await hasText(page, previewPanel + ' > pre', '"intent": "order_status"');
  const { id, created_at } = await create(page);
  await page.route(pathIs(new URL(page.url()).origin, reviews + '/' + id), (route) => route.fulfill({
    json: { review: { ...content, id, version: 1, state: 'pending_review',
      events: [{ event_type: longHostile, actor_id: longHostile }] } },
  }), { times: 1 });
  await page.locator('#queue button').filter({ hasText: created_at }).click();
  await hasText(page, detailPanel + ' .draft-text', longHostile);
  await hasText(page, detailPanel + ' .internal pre', JSON.stringify(longHostile));
  await hasText(page, events, longHostile);
  await checkLayout(page);
  await noInjection(page);

  // The submitted string is plain textarea text. The server withholds the
  // unsafe revision text and returns only a placeholder and its check codes.
  await page.locator('#edit-text').fill(hostile);
  assert.ok((await page.locator('#edit-text').inputValue()) === hostile);
  await noInjection(page);
  await edit(page, hostile);
  await badge(page, 'blocked', 2);
  assert.equal(await page.locator('#edit-text').inputValue(), '[Content withheld]');
  await hasText(page, detailPanel + ' .customer', 'unsafe_characters');
  await hasText(page, detailPanel + ' .customer', 'markup_or_contact');
  await hasText(page, detailPanel + ' .customer', 'No customer-safe text is available.');
  assert.ok(!(await page.locator(events).textContent())!.includes(hostile));
  await noInjection(page);
});

test('A fresh tenant has explicit unfiltered and filtered empty states', async (t) => {
  const slug = await emptyTenant();
  const session = await openBrowser(t);
  const { page } = session;
  await signInView(session);
  await login(session, 'member', slug);
  assert.deepEqual(await page.locator('#queue li').allTextContents(), [empty]);
  await page.locator('#state').selectOption('rejected');
  const response = page.waitForResponse(responseIs(new URL(page.url()).origin, reviews, 'GET'));
  await page.locator('#refresh').click();
  assert.equal(new URL((await response).url()).searchParams.get('state'), 'rejected');
  await hasText(page, '#status', 'Review queue refreshed.');
  assert.deepEqual(await page.locator('#queue li').allTextContents(), [empty]);
});

test('Customer draft excludes S1/S2 evidence and blocks an evidence paste', async (t) => {
  const foreign = await foreignOrder();
  const session = await openBrowser(t);
  const { page } = session;
  await signInView(session);
  await login(session);
  for (const [message, language] of [['Check low stock', 'en'], ['D\u00fc\u015f\u00fck stok var m\u0131?', 'tr']] as const) {
    await preview(page, message, language);
    await hasText(page, previewPanel + ' > pre', '"intent": "low_stock"');
    await hasText(page, previewPanel + ' .customer', 'Language: ' + language);
    const entries = await evidence(page);
    assert.ok(entries.some((entry) => entry.kind === 'low_stock' && entry.items.some((item) => item.sku === tenant.products[0]!.sku)));
    await checkDisclosure(page, entries);
  }

  await preview(page, 'Order status ' + order.code, 'en');
  const entries = await evidence(page);
  await checkDisclosure(page, entries);
  const customer = await page.locator(previewPanel + ' .customer .draft-text').textContent();
  for (const code of [foreign, 'ORD-MISSING-' + marker.slice(4, 12)]) {
    await preview(page, 'Order status ' + code, 'en');
    await hasText(page, previewPanel, 'Evidence status: not_found');
    assert.deepEqual(await evidence(page), []);
    assert.equal(await page.locator(previewPanel + ' .customer .draft-text').textContent(), customer);
    assert.ok(!(await page.locator(previewPanel + ' .customer').textContent())?.includes(code));
  }

  await preview(page, 'Order status ' + order.code, 'en');
  await create(page);
  assert.deepEqual(await evidence(page, detailPanel), entries);
  const copied = (await page.locator(detailPanel + ' .internal pre').first().textContent())!;
  assert.ok(copied.includes(order.code), 'Copied detail contains the order code');
  assert.ok(copied.length > 0 && copied.length <= 1500, 'Evidence paste fits the edit control');
  // The validator is heuristic. Humans can still manually retype evidence outside validated patterns.
  await edit(page, copied);
  await badge(page, 'blocked', 2);
  for (const code of ['order_code', 'order_status']) await hasText(page, detailPanel + ' .customer', code);
  assert.ok(await page.locator('#approve').isDisabled());
});

async function checkContrast(page: Page, button: string) {
  const ratios = await page.evaluate((button) => {
    return [document.body, document.querySelector(button)!].map((element) => {
      const style = getComputedStyle(element);
      const luminances = [style.color, style.backgroundColor].map((color) =>
        color.match(/\d+/g)!.slice(0, 3).reduce((sum, raw, index) => {
          const value = Number(raw) / 255;
          const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
        }, 0));
      return (Math.max(...luminances) + 0.05) / (Math.min(...luminances) + 0.05);
    });
  }, button);
  assert.ok(ratios.every((ratio) => ratio >= 4.5), 'Dark-mode body and primary button require 4.5:1 contrast');
}

async function active(page: Page, id: string) {
  await page.waitForFunction((id) => document.activeElement?.id === id, id, { timeout: 8000 });
}

test('Responsive layouts, keyboard flow, labels and dark contrast hold at three widths', async (t) => {
  for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    const session = await openBrowser(t, { viewport, colorScheme: 'dark' });
    const { page } = session;
    await signInView(session);
    await checkLayout(page);
    await checkContrast(page, '#login');
    await typeMemberLogin(page);
    await page.keyboard.press('Tab');
    await active(page, 'login');
    const loginResult = page.waitForResponse(responseIs(new URL(page.url()).origin, '/auth/login', 'POST'));
    await page.keyboard.press('Enter');
    assert.equal((await loginResult).status(), 200, 'Keyboard login response');
    await visible(page, '#message');
    await settled(page);
    await active(page, 'compose-heading');
    await page.keyboard.press('Tab');
    await active(page, 'message');
    await page.keyboard.insertText(turkishOrder + ' ' + marker);
    await page.keyboard.press('Tab');
    await active(page, 'language');
    await page.keyboard.press('Tab');
    await active(page, 'preview');
    await page.keyboard.press('Space');
    await hasText(page, '#status', 'Draft preview ready.');
    await settled(page);
    await checkContrast(page, '#preview');
    // The preview completion focuses the status region, so Tab resumes at the compose form.
    for (const id of ['message', 'language', 'preview', 'submit-review']) {
      await page.keyboard.press('Tab');
      await active(page, id);
    }
    const response = page.waitForResponse(responseIs(new URL(page.url()).origin, reviews, 'POST'));
    await page.keyboard.press('Enter');
    assert.equal((await response).status(), 201);
    await badge(page, 'pending_review', 1);
    await settled(page);
    await checkLayout(page);
    await checkContrast(page, '#approve');
  }
});

const screenshotNames = [
  '01-desktop-login.png', '02-desktop-dashboard.png', '03-classification-preview.png',
  '04-internal-vs-customer-safe.png', '05-review-workflow.png', '06-mobile-view.png',
];

async function screenshot(page: Page, name: string, selector?: string) {
  const emails = SEED_TENANTS.flatMap((seed) => seed.users.map(({ email }) => email));
  const surface = await page.evaluate((emails) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeValue) {
        node.nodeValue = emails.reduce((text, email) => text.replaceAll(email, '[synthetic email]'), node.nodeValue);
      }
    }
    const values = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].map((input) => {
      if (input instanceof HTMLInputElement && input.type === 'password') input.value = '';
      else if (emails.includes(input.value)) input.value = '';
      return input.value;
    });
    return [document.body.innerText, ...values].join('\n');
  }, emails);
  assert.ok(!containsCredential(surface), 'Credential detected in screenshot surface');
  assert.ok(!/[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu.test(surface), 'Email detected in screenshot surface');
  const path = join(screenshotDir, name);
  if (selector) await page.locator(selector).screenshot({ path });
  else await page.screenshot({ path, fullPage: true });
}

test('Optional screenshots capture six credential-checked browser views', async (t) => {
  if (process.env.PRODUCTOPS_E2E_SCREENSHOTS !== '1') {
    t.skip('Set PRODUCTOPS_E2E_SCREENSHOTS=1 to capture PNGs');
    return;
  }
  await mkdir(screenshotDir, { recursive: true });
  const session = await openBrowser(t, { colorScheme: 'light' });
  const { page } = session;
  await signInView(session);
  await screenshot(page, screenshotNames[0]!);
  await login(session);
  await screenshot(page, screenshotNames[1]!);
  await preview(page);
  await screenshot(page, screenshotNames[2]!, previewPanel + ' > pre');
  await screenshot(page, screenshotNames[3]!, previewPanel);
  await create(page);
  await edit(page, safeTr);
  await badge(page, 'edited', 2);
  await hasText(page, detailPanel + ' .customer', 'Language: tr');
  assert.equal(await page.locator(detailPanel + ' .draft-text').textContent(), safeTr);
  await screenshot(page, screenshotNames[4]!, '#detail');
  await page.setViewportSize({ width: 375, height: 812 });
  await screenshot(page, screenshotNames[5]!);
  for (const name of screenshotNames) {
    const size = (await stat(join(screenshotDir, name))).size;
    assert.ok(size > 0);
    t.diagnostic(name + ' (' + size + ' bytes)');
  }
});

test('E2E source, matrix and screenshot filenames contain no credentials', async () => {
  const e2eFiles = await readdir('test/e2e');
  for (const name of e2eFiles) {
    assert.ok(!containsCredential(name), 'Credential detected in E2E filename');
  }
  for (const path of [
    ...e2eFiles.map((name) => join('test/e2e', name)),
    'docs/portfolio/ENGINEERING_EVIDENCE.md', 'package.json', 'ui/app.js',
  ]) {
    const source = await readFile(path, 'utf8');
    assert.ok(!containsCredential(source), 'Credential detected in checked source');
    assert.ok(!/\p{Cf}/u.test(source), 'Raw format control detected in checked source');
  }
  const names = await readdir(screenshotDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.ok(names.every((name) => !containsCredential(name)), 'Credential detected in screenshot filename');
});
