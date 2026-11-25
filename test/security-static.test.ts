import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { loadConfig, loadDatabaseConfig, ConfigurationError } from '../src/config.js';
import { runSeed } from '../src/db/seed.js';

test('auth, tenant, and review SQL calls use literal first arguments without concatenation', () => {
  const files = [...readdirSync('src/auth').filter(f => f.endsWith('.ts')).map(f => `src/auth/${f}`),
    'src/db/tenant.ts', 'src/support/review-store.ts'];
  let calls = 0;
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'query') {
        calls++;
        const first = node.arguments[0];
        assert.ok(first && ts.isStringLiteral(first), `${file}: query must start with a string literal`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(calls >= 7);
  // This checks syntax of direct .query calls, not arbitrary wrappers or data flow.
});

test('config loaders reject privileged runtime roles and unsafe bootstrap targets privately', () => {
  const urls = ['productops_bootstrap', 'productops_migrator', 'productops', 'postgres'].map(role =>
    ({ raw: `postgres://${role}:synthetic-private@127.0.0.1:54329/productops_test`, role: 'productops_app' as const }));
  for (const suffix of ['productops', 'postgres', 'productops_test?sslmode=require', 'productops_test#fragment']) {
    urls.push({ raw: `postgres://productops_bootstrap:synthetic-private@127.0.0.1:54329/${suffix}`, role: 'productops_app' });
  }
  const bootstrapUrls = ['postgres', 'productops', 'productops_test?x=y', 'productops_test#x'].map(db =>
    `postgres://productops_bootstrap:synthetic-private@127.0.0.1:54329/${db}`);
  bootstrapUrls.push('postgres://productops_bootstrap:synthetic-private@remote.example:54329/productops_test');
  for (const { raw, role } of urls) for (const action of [() => loadDatabaseConfig(raw, role), () => loadConfig({ PRODUCTOPS_DB_URL: raw })]) {
    assert.throws(action, privateError(raw));
  }
  for (const raw of bootstrapUrls) for (const action of [() => loadDatabaseConfig(raw, 'productops_bootstrap'), () => loadConfig({ PRODUCTOPS_BOOTSTRAP_DB_URL: raw })]) {
    assert.throws(action, privateError(raw));
  }
});
function privateError(raw: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ConfigurationError);
    for (const output of [String(error), error.stack!, JSON.stringify(error)]) {
      assert.equal(output.includes(raw), false);
      assert.equal(output.includes('synthetic-private'), false);
    }
    return true;
  };
}

test('seed rejects wrong database and non-loopback configs before connecting', async () => {
  const config = loadDatabaseConfig('postgres://productops_bootstrap:synthetic@127.0.0.1:54329/productops_test', 'productops_bootstrap');
  for (const invalid of [{ ...config, database: 'postgres' }, { ...config, database: 'productops' }, { ...config, host: 'remote.example' }, { ...config, host: 'productops-db' }]) {
    await assert.rejects(runSeed(invalid as typeof config, 'synthetic'), { message: 'Invalid bootstrap database' });
  }
});
