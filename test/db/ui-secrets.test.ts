import { testKeys } from '../fixtures/auth-keys.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { SEED_TENANTS } from '../../src/db/seed-data.js';

test('UI files and served bytes exclude configured secrets and demo identities', async (t) => {
  // The DB test runner supplies the environment. This test never opens its source file.
  for (const name of ['PRODUCTOPS_AUTH_TEST_DB_URL', 'PRODUCTOPS_TEST_DB_URL', 'PRODUCTOPS_DEMO_PASSWORD']) {
    assert.ok(process.env[name], `${name} is required for the DB secret scan`);
  }
  const secrets = new Set(SEED_TENANTS.flatMap(({ slug, users }) => [slug, ...users.map(({ email }) => email)]));
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || !/^PRODUCTOPS_.*(?:PASSWORD|SECRET|DB_URL)$/u.test(name)) continue;
    secrets.add(value);
    if (name.endsWith('DB_URL')) {
      const password = new URL(value).password;
      if (password) {
        secrets.add(password);
        secrets.add(decodeURIComponent(password));
      }
    }
  }
  const keys = testKeys();
  secrets.add(keys.privatePem);
  secrets.add(keys.env.PRODUCTOPS_REQUEST_DIGEST_SECRET);
  const app = buildApp(keys.env);
  t.after(() => app.close());
  for (const [path, file] of [['/ui', 'index.html'], ['/ui/', 'index.html'],
    ['/ui/app.js', 'app.js'], ['/ui/style.css', 'style.css']] as const) {
    const response = await app.inject(path);
    assert.equal(response.statusCode, 200);
    for (const bytes of [readFileSync(`ui/${file}`), response.rawPayload]) {
      for (const secret of secrets) assert.ok(!bytes.includes(secret), `Unexpected sensitive value in ${file}`);
    }
  }
});
