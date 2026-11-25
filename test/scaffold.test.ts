import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

const gitEnv = {
  ...process.env,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'safe.directory',
  GIT_CONFIG_VALUE_0: process.cwd().replace(/\\/gu, '/'),
};

test('auth scaffold uses jose and includes the central modules', () => {
  assert.ok(JSON.parse(readFileSync('package.json', 'utf8')).dependencies.jose);
  for (const name of ['jwt', 'permissions', 'login', 'rate-limit', 'guard', 'routes']) {
    assert.ok(readFileSync(`src/auth/${name}.ts`, 'utf8').length > 0);
  }
  const jwt = readFileSync('src/auth/jwt.ts', 'utf8');
  assert.match(jwt, /from 'jose'/u);
  assert.doesNotMatch(jwt, /createHmac|createSign|createVerify|subtle/u);
});

test('real env and npm cache ignored, env example trackable without creating env', () => {
  const ignored = execFileSync('git', ['check-ignore', '--no-index', '--', '.env', '.env.local', '.npm-cache/write-probe.txt', '.env.example'], { encoding: 'utf8', env: gitEnv }).trim().split(/\r?\n/u);
  assert.deepEqual(ignored, ['.env', '.env.local', '.npm-cache/write-probe.txt']);
});

test('CI is Node 24 read-only and has required local verification commands', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /^permissions:\r?\n  contents: read$/mu);
  assert.match(ci, /node-version: '24'/u);
  for (const command of ['npm ci', 'npm run lint', 'npm run typecheck', 'npm test', 'npm run build', 'npm run db:migrate', 'npm run db:bootstrap', 'npm run db:seed', 'npm run test:db']) {
    assert.ok(ci.includes(`run: ${command}`));
  }
  const checks = ci.split(/^  db-tests:\r?$/mu)[0] ?? '';
  assert.match(checks, /^      - name: Production dependency audit\r?\n        run: npm audit --omit=dev --audit-level=high\r?$/mu);
  assert.match(checks, /^      - name: Full dependency report gate \(scoped, expiring exception\)\r?\n        run: npm run audit:gate\r?$/mu);
  assert.doesNotMatch(ci, /\|\|\s*true\b|continue-on-error/u);
  for (const job of ['checks', 'db-tests']) {
    assert.match(ci, new RegExp(`^  ${job}:\\r?\\n    runs-on: ubuntu-latest\\r?\\n    timeout-minutes: 15\\r?$`, 'mu'));
  }
  assert.doesNotMatch(ci, /secrets\.|deploy|(?:docker\s+push|push-to-registry)|--privileged|pull_request_target/iu);
  assert.match(ci, /db-tests:/u);
  assert.match(ci, /openssl rand -hex/u);
  assert.match(ci, /::add-mask::/u);
  assert.match(ci, /if: always\(\)/u);
  assert.ok(ci.includes('docker compose --env-file .env.local down -v'));
  const hosts = [...ci.matchAll(/postgres(?:ql)?:\/\/[^@\s]+@([^/\s]+)/gu)].map(match => match[1]);
  assert.ok(hosts.length >= 6);
  for (const host of hosts) assert.equal(host, '127.0.0.1:54329');
});

test('Compose is a local Postgres 16 template requiring an external secret', () => {
  const compose = readFileSync('docker-compose.yml', 'utf8');
  assert.match(compose, /productops-db:/u);
  assert.match(compose, /image: postgres:16\s/u);
  assert.ok(compose.includes('127.0.0.1:${PRODUCTOPS_DB_PORT:-54329}:5432'));
  assert.ok(compose.includes('${PRODUCTOPS_DB_PASSWORD:?PRODUCTOPS_DB_PASSWORD is required}'));
  const passwordLines = compose.split(/\r?\n/u).filter((line) => /password\s*:/iu.test(line));
  assert.deepEqual(passwordLines.map((line) => line.trim()), [
    'POSTGRES_PASSWORD: ${PRODUCTOPS_DB_PASSWORD:?PRODUCTOPS_DB_PASSWORD is required}',
    'PRODUCTOPS_MIGRATOR_PASSWORD: ${PRODUCTOPS_MIGRATOR_PASSWORD:?required}',
    'PRODUCTOPS_BOOTSTRAP_PASSWORD: ${PRODUCTOPS_BOOTSTRAP_PASSWORD:?required}',
    'PRODUCTOPS_APP_PASSWORD: ${PRODUCTOPS_APP_PASSWORD:?required}',
    'PRODUCTOPS_AUTH_PASSWORD: ${PRODUCTOPS_AUTH_PASSWORD:?required}',
  ]);
  for (const line of compose.split(/\r?\n/u).filter((line) => /PASSWORD/u.test(line))) assert.match(line, /:\s*\$\{[A-Z_]+:\?[^}]+\}$/u);
  const ports = compose.match(/\n\s+ports:\s*\r?\n((?:[ \t]+-.*\r?\n?)+)/u);
  assert.ok(ports);
  assert.deepEqual(ports[1]?.trim().split(/\r?\n/u).map((line) => line.trim()), ['- "127.0.0.1:${PRODUCTOPS_DB_PORT:-54329}:5432"']);
  assert.equal((compose.match(/\bports\s*:/gu) ?? []).length, 1);
});

test('env example has only empty values and source reads the namespaced database URL', () => {
  const entries = readFileSync('.env.example', 'utf8').split(/\r?\n/u)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  assert.ok(entries.length > 0);
  for (const entry of entries) assert.match(entry, /^[A-Z_][A-Z0-9_]*=$/u);
  for (const file of readdirSync('src', { recursive: true, withFileTypes: true })) {
    if (file.isFile()) {
      assert.doesNotMatch(readFileSync(resolve(file.parentPath, file.name), 'utf8'), /DATABASE_URL/u);
    }
  }
  assert.match(readFileSync('src/config.ts', 'utf8'), /env\.PRODUCTOPS_DB_URL/u);
});

test('server enforces the API env allowlist and listens once on the configured loopback host', () => {
  const server = readFileSync('src/server.ts', 'utf8');
  const gate = /for \(const name of Object\.keys\(process\.env\)\)\s*\{\s*if \(name\.startsWith\('PRODUCTOPS_'\) && !\[([^\]]+)\]\.includes\(name\)\)\s*\{\s*throw new Error\(/u.exec(server);
  assert.ok(gate);
  assert.deepEqual(gate[1]!.split(/,\s*/u).map(value => value.trim()), [
    "'PRODUCTOPS_DB_URL'", "'PRODUCTOPS_AUTH_PORT'", "'PRODUCTOPS_JWT_PUBLIC_KEYS'", "'PRODUCTOPS_REQUEST_DIGEST_SECRET'",
  ]);
  assert.ok(gate.index < server.indexOf('const config = loadConfig(env);'));
  assert.match(server, /const ephemeral = process\.env\.PORT === '0' && process\.send !== undefined;/u);
  assert.match(server, /const env = ephemeral \? \{ \.\.\.process\.env, PORT: undefined \} : process\.env;/u);
  assert.match(server, /await app\.listen\(\{ host: config\.host, port: ephemeral \? 0 : config\.port \}\);/u);
  assert.equal((server.match(/\.listen\s*\(/gu) ?? []).length, 1);
  assert.equal(loadConfig({}).host, '127.0.0.1');
  assert.equal(loadConfig({ HOST: 'localhost' }).host, 'localhost');
  assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), /Unsupported application host/u);
});

test('README documents reproducible Windows installation and every CI verification script', () => {
  const readme = readFileSync('README.md', 'utf8');
  for (const command of ['npm.cmd ci', 'npm.cmd run lint', 'npm.cmd run typecheck', 'npm.cmd test', 'npm.cmd run build']) {
    assert.ok(readme.includes(command), `README missing ${command}`);
  }
});

test('tracked and unignored files exclude local secrets, dependencies, caches and build output', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8', env: gitEnv,
  }).trim().split(/\r?\n/u).filter(Boolean);
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.doesNotMatch(file, /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]*)?|node_modules|\.npm-cache|dist)(?:\/|$)/u);
  }
});
