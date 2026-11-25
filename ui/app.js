/* global document, fetch, Blob, URLSearchParams */

const byId = (id) => document.getElementById(id);
const reviewsPath = '/support/reviews';
const states = ['pending_review', 'edited', 'blocked', 'approved_internal', 'rejected'];
const rejectionReasons = ['inaccurate', 'unsafe_disclosure', 'out_of_scope', 'duplicate', 'other'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = (id) => typeof id === 'string' && id.length === 36 && uuid.test(id);
const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : 'Unavailable';
const messages = new Map([
  ['STALE_VERSION', 'Someone changed this draft; reload it from the queue.'],
  ['SELF_APPROVAL_FORBIDDEN', 'A different operator must approve this draft.'],
  ['BLOCKED_FOR_CUSTOMER_USE', 'This draft is blocked for customer use.'],
  ['ILLEGAL_TRANSITION', 'This action is unavailable in the current review state.'],
  ['INVALID_REQUEST', 'Check the submitted fields and try again.'],
  ['INVALID_MESSAGE', 'Enter a valid synthetic message.'],
  ['MESSAGE_TOO_LONG', 'Use at most 1000 characters.'],
  ['NOT_FOUND', 'This review is unavailable. Refresh the queue.'],
  ['RATE_LIMITED', 'Too many requests. Try again shortly.'],
  ['TOO_MANY_RUNS', 'The review desk is busy. Try again shortly.'],
]);
const denied = 'Access denied. Your role may be read-only or lack review access.';
const knownCheckCodes = new Set(['text_too_long', 'text_empty', 'unsafe_characters', 'markup_or_contact',
  'order_code', 'sku', 'order_status', 'internal_value', 'unverified_number']);

let token = '';
let session = 0;
let busy = false;
let readOnly = false;
let previewed;
let review;

function status(message) {
  const node = byId('status');
  node.textContent = message;
  node.focus();
}

function clearSession(message) {
  token = '';
  session++;
  readOnly = false;
  previewed = undefined;
  review = undefined;
  for (const id of ['slug', 'email', 'password', 'message', 'edit-text']) byId(id).value = '';
  for (const id of ['preview-result', 'queue', 'review-content', 'review-state']) byId(id).replaceChildren();
  byId('detail').hidden = true;
  byId('workspace').hidden = true;
  byId('sign-out').hidden = true;
  byId('sign-in').hidden = false;
  status(message);
}

async function request(path, method = 'GET', payload) {
  const before = session;
  const response = await fetch(path, {
    method, credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    // Fetch sets the JSON media type from the body without another explicit header.
    ...(payload === undefined ? {} : { body: new Blob([JSON.stringify(payload)], { type: 'application/json' }) }),
  });
  if (before !== session) return;
  if (response.status === 401) {
    clearSession('Sign in to continue.');
    return;
  }
  const data = await response.json().catch(() => null);
  if (before !== session) return;
  if (response.ok && data) return data;

  if (response.status === 403 && data?.errorCode === 'FORBIDDEN') {
    readOnly = true;
  }
  let message = messages.get(data?.errorCode) ?? (response.status === 403 ? denied : 'The request could not be completed.');
  if (data?.errorCode === 'BLOCKED_FOR_CUSTOMER_USE') {
    let codes = list(data.check_codes);
    const id = review?.id;
    // Approval can move a review to blocked. The detail response carries the checks.
    if (!codes.length && validId(id) && path === `${reviewsPath}/${id}/approve`) {
      const updated = await request(`${reviewsPath}/${id}`);
      if (before !== session) return;
      if (updated?.review?.id === id) {
        renderReview(updated.review);
        nextFocus = undefined;
      }
      codes = list(review?.check_codes);
    }
    codes = codes.filter((code) => knownCheckCodes.has(code));
    if (codes.length) message += ` Checks: ${codes.join(', ')}.`;
  }
  status(message);
}

function append(parent, tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.setAttribute('class', className);
  parent.append(node);
  return node;
}

function dataBlock(parent, label, value, heading = 'h5') {
  append(parent, heading, label);
  append(parent, 'pre', value === undefined ? 'Unavailable' : JSON.stringify(value, null, 2), 'data');
}

function showDraft(parent, data) {
  const evidence = append(parent, 'section', undefined, 'panel internal');
  append(evidence, 'h4', 'Internal evidence \u2014 operators only, NOT for customers');
  const entries = data.internal_evidence;
  dataBlock(evidence, 'Entries', Array.isArray(entries) ? entries : entries?.entries ?? entries);
  dataBlock(evidence, 'Sources', entries?.sources ?? list(entries).flatMap((entry) =>
    [entry?.source, ...list(entry?.items).map((item) => item?.source)].filter(Boolean)));
  dataBlock(evidence, 'Operator notes', data.internal_operator_notes);
  dataBlock(evidence, 'Disclosure decision and restricted fields', data.disclosure_decision);

  const customer = append(parent, 'section', undefined, 'panel customer');
  append(customer, 'h4', 'Customer-safe draft \u2014 not sent');
  const draft = data.customer_safe_draft;
  append(customer, 'p', draft ? `Language: ${text(draft.language)}` : 'No customer-safe text is available.');
  if (draft) append(customer, 'p', text(draft.text), 'draft-text');
  if (data.review_notes) dataBlock(customer, 'Review notes', data.review_notes);
  if (list(data.check_codes).length) dataBlock(customer, 'Check codes', data.check_codes);
}

function composeInput() {
  const language = byId('language').value;
  return {
    message: byId('message').value,
    ...(['tr', 'en'].includes(language) ? { language } : {}),
  };
}

function controls() {
  byId('login').disabled = busy;
  byId('workspace').inert = busy;
  byId('preview').disabled = readOnly;
  byId('refresh').disabled = readOnly;
  byId('submit-review').disabled = readOnly || !previewed;
  const editable = !readOnly && !!review && ['pending_review', 'edited', 'blocked'].includes(review.state);
  for (const id of ['edit-text', 'save', 'reject', 'reason']) byId(id).disabled = !editable;
  byId('approve').disabled = !editable || review.state === 'blocked';
}

async function run(action) {
  if (busy) return;
  const before = session;
  busy = true;
  controls();
  try {
    await action();
  } catch {
    if (before === session) status('The request could not be completed.');
  } finally {
    busy = false;
    controls();
    const focus = nextFocus;
    nextFocus = undefined;
    if (focus && token) byId(focus).focus();
  }
}

let nextFocus;
function action(id, handler) {
  byId(id).addEventListener('click', () => run(handler));
}

async function signIn() {
  if (!byId('login-form').reportValidity()) return;
  const payload = { org_slug: byId('slug').value, email: byId('email').value, password: byId('password').value };
  byId('password').value = '';
  const data = await request('/auth/login', 'POST', payload);
  if (typeof data?.access_token !== 'string' || !data.access_token) return;
  token = data.access_token;
  byId('sign-in').hidden = true;
  byId('workspace').hidden = false;
  byId('sign-out').hidden = false;
  byId('status').textContent = '';
  if (await refresh()) nextFocus = 'compose-heading';
}

async function refresh() {
  const params = new URLSearchParams();
  const state = byId('state').value;
  if (states.includes(state)) params.set('state', state);
  const limit = byId('limit').value;
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit)) {
    status('Enter a result limit from 1 to 50.');
    return false;
  }
  params.set('limit', limit);
  const data = await request(`${reviewsPath}?${params}`);
  if (!data) return false;
  const queue = byId('queue');
  queue.replaceChildren();
  const rows = list(data.reviews).filter((row) => validId(row?.id));
  for (const row of rows) {
    const item = append(queue, 'li');
    const button = append(item, 'button', `${text(row.intent)} | ${text(row.state)} | v${text(row.version)} | ${text(row.created_at)}`);
    button.setAttribute('type', 'button');
    button.addEventListener('click', () => run(() => openReview(row.id)));
  }
  if (!rows.length) append(queue, 'li', 'No reviews match these filters.');
  return true;
}

function renderReview(item) {
  if (!validId(item?.id) || !Number.isInteger(item.version) || item.version < 1 || item.version > 2147483647) return;
  review = item;
  byId('detail').hidden = false;
  byId('review-state').textContent = `${text(item.state)} | Version ${item.version}`;
  const body = byId('review-content');
  body.replaceChildren();
  append(body, 'p', `Evidence status: ${text(item.evidence_status)}`);
  showDraft(body, item);
  const revisions = list(item.revisions);
  append(body, 'h4', 'Revisions');
  const revisionList = append(body, 'ol');
  for (const entry of revisions) {
    append(revisionList, 'li', `Revision ${text(entry?.revision)} | Author ${text(entry?.author_id)} | ${text(entry?.kind)} | ${text(entry?.check_status)} | ${list(entry?.check_codes).map(text).join(', ') || 'No check codes'}`);
  }
  append(body, 'h4', 'Event history');
  const events = append(body, 'ol');
  for (const event of list(item.events)) {
    append(events, 'li', `${text(event?.event_type)} | ${event?.from_state == null ? 'Initial' : text(event.from_state)} \u2192 ${text(event?.to_state)} | Revision ${text(event?.revision)} | Actor ${text(event?.actor_id)} | ${text(event?.created_at)} | Reason ${event?.reason_code == null ? 'None' : text(event.reason_code)}`);
  }
  const current = item.customer_safe_draft?.text ?? revisions.at(-1)?.customer_text;
  byId('edit-text').value = typeof current === 'string' ? current : '';
  nextFocus = 'detail-heading';
}

async function openReview(id) {
  if (!validId(id)) return;
  const data = await request(`${reviewsPath}/${id}`);
  if (data?.review?.id === id) {
    byId('status').textContent = '';
    renderReview(data.review);
  }
}

async function mutate(kind) {
  if (!review || readOnly || !validId(review.id) || !['pending_review', 'edited', 'blocked'].includes(review.state)) return;
  if (kind === 'approve' && review.state === 'blocked') return;
  const { id, version } = review;
  const path = `${reviewsPath}/${id}`;
  const payload = { expected_version: version };
  if (kind === 'edit') {
    const input = byId('edit-text');
    if (!input.value.trim() || input.value.length > 1500) {
      status('Enter customer draft text from 1 to 1500 characters.');
      return;
    }
    payload.customer_text = input.value;
    const data = await request(path, 'PATCH', payload);
    if (!data) return;
    if (data.review?.id === id) renderReview(data.review);
  } else {
    if (kind === 'reject') {
      const reason = byId('reason').value;
      if (!rejectionReasons.includes(reason)) {
        status('Choose a rejection reason.');
        return;
      }
      payload.reason_code = reason;
    }
    const data = await request(kind === 'approve' ? `${path}/approve` : `${path}/reject`, 'POST', payload);
    if (!data) return;
    // A decision returns a summary. Keep its terminal state even if reloading fails.
    if (data.review?.id === id) renderReview({ ...review, ...data.review });
    await openReview(id);
  }
  if (token && await refresh()) {
    nextFocus = undefined;
    status(kind === 'edit' ? 'Edit saved.' : 'Internal decision recorded.');
  }
}

function invalidatePreview() {
  previewed = undefined;
  byId('preview-result').replaceChildren();
  controls();
}

action('login', signIn);
byId('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  return run(signIn);
});
byId('password').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  return run(signIn);
});
byId('sign-out').addEventListener('click', () => clearSession('Signed out.'));
byId('message').addEventListener('input', invalidatePreview);
byId('language').addEventListener('change', invalidatePreview);
action('preview', async () => {
  invalidatePreview();
  const payload = composeInput();
  if (!payload.message.trim() || payload.message.length > 1000) {
    status('Enter a synthetic message from 1 to 1000 characters.');
    return;
  }
  const data = await request('/support/drafts/preview', 'POST', payload);
  if (!data) return;
  previewed = payload;
  const result = byId('preview-result');
  append(result, 'h3', 'Draft preview');
  dataBlock(result, 'Classification', data.classification, 'h4');
  append(result, 'p', `Evidence status: ${text(data.evidence_status)}`);
  showDraft(result, data);
  status('Draft preview ready.');
});
action('submit-review', async () => {
  if (!previewed || readOnly) return;
  const data = await request(reviewsPath, 'POST', previewed);
  if (!data) return;
  invalidatePreview();
  renderReview(data.review);
  if (await refresh()) {
    nextFocus = undefined;
    status('Draft added to the human review queue.');
  }
});
action('refresh', async () => {
  if (await refresh()) status('Review queue refreshed.');
});
action('save', () => mutate('edit'));
action('approve', () => mutate('approve'));
action('reject', () => mutate('reject'));
controls();
