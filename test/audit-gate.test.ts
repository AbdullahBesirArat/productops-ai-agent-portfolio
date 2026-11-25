import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateAudit, runAudit } from '../scripts/audit-gate.js';

type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

const excepted = 'GHSA-fc5q-39xc-vjpf';
const additional = 'GHSA-2222-3333-4444';
const now = new Date('2026-11-18T12:00:00Z');
const policy = {
  version: 1,
  exceptions: [
    {
      id: "GHSA-fc5q-39xc-vjpf",
      cve: "CVE-2026-112366",
      package: "picomatch",
      scope: "development",
      chain: ["typescript-eslint", "@typescript-eslint/typescript-estree", "tinyglobby", "fdir", "picomatch"],
      decided: "2026-11-17",
      reviewBy: "2026-12-17",
      reason: "High-severity ReDoS through single-branch repeated extglobs affects the development-only ESLint toolchain. No patched picomatch release is available. CI limits both jobs to 15 minutes and checks production dependencies separately.",
      endsWhen: "A patched picomatch release exists and the lockfile resolves to it, or the dev chain no longer includes picomatch; the advisory then disappears from `npm audit` and this entry must be deleted."
    }
  ]
};

function advisory(name: string, id: string, severity: Severity, source = 1100000) {
  return { source, name, dependency: name, title: 'Fixture advisory', url: `https://github.com/advisories/${id}`,
    severity, cwe: ['CWE-1333'], cvss: { score: 7.5, vectorString: null }, range: '<=4.0.7' };
}

function finding(name: string, severity: Severity, via: (string | ReturnType<typeof advisory>)[]) {
  return { name, severity, isDirect: name === 'typescript-eslint', via, effects: [], range: '*',
    nodes: [`node_modules/${name}`], fixAvailable: false };
}

function report(...findings: ReturnType<typeof finding>[]) {
  const vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: findings.length };
  for (const entry of findings) vulnerabilities[entry.severity]++;
  return {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(findings.map((entry) => [entry.name, entry])),
    metadata: { vulnerabilities, dependencies: { prod: 76, dev: 115, optional: 0, peer: 0, peerOptional: 0, total: 191 } },
  };
}

const clean = report();
const picomatch = finding('picomatch', 'high', [advisory('picomatch', excepted, 'high')]);
const chain = [
  finding('typescript-eslint', 'high', ['@typescript-eslint/parser', '@typescript-eslint/eslint-plugin', '@typescript-eslint/typescript-estree']),
  finding('@typescript-eslint/eslint-plugin', 'high', ['@typescript-eslint/type-utils', '@typescript-eslint/utils']),
  finding('@typescript-eslint/parser', 'high', ['@typescript-eslint/typescript-estree']),
  finding('@typescript-eslint/type-utils', 'high', ['@typescript-eslint/typescript-estree', '@typescript-eslint/utils']),
  finding('@typescript-eslint/utils', 'high', ['@typescript-eslint/typescript-estree']),
  finding('@typescript-eslint/typescript-estree', 'high', ['tinyglobby']),
  finding('tinyglobby', 'high', ['picomatch', 'fdir']),
  finding('fdir', 'high', ['picomatch']),
  picomatch,
];

function check(overrides: Partial<Parameters<typeof evaluateAudit>[0]> = {}) {
  return evaluateAudit({ full: report(...chain), production: clean, exceptions: policy, now, ...overrides });
}

function withException(fields: Record<string, unknown>) {
  return { ...policy, exceptions: [{ ...policy.exceptions[0], ...fields }] };
}

test('the nine-node dev chain yields one unique excepted advisory', () => {
  const result = check({ full: JSON.stringify(report(...chain)) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.advisories, [
    { id: excepted, package: 'picomatch', severity: 'high', scope: 'development', status: 'excepted' },
  ]);
});

test('additional high advisories fail for a new package and for picomatch', () => {
  const anotherPackage = finding('other-package', 'high', [advisory('other-package', additional, 'high', 1100001)]);
  const samePackage = finding('picomatch', 'high', [...picomatch.via, advisory('picomatch', additional, 'high', 1100001)]);
  for (const full of [report(...chain, anotherPackage), report(...chain.slice(0, -1), samePackage)]) {
    const result = check({ full });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), new RegExp(additional, 'u'));
    assert.equal(result.advisories.find((row) => row.id === additional)?.status, 'blocked');
  }
});

test('an unexcepted critical advisory fails', () => {
  const critical = finding('other-package', 'critical', [advisory('other-package', additional, 'critical')]);
  assert.equal(check({ full: report(...chain, critical) }).ok, false);
});

test('a matching development exception cannot authorize a critical advisory', () => {
  const critical = finding('picomatch', 'critical', [advisory('picomatch', excepted, 'critical')]);
  const result = check({ full: report(critical) });
  assert.equal(result.ok, false);
  assert.equal(result.advisories[0]?.status, 'blocked');
  assert.match(result.errors.join(' '), /Critical advisory .* cannot be excepted/u);
});

test('an exception with a future decision date is invalid', () => {
  const result = check({ exceptions: withException({ decided: '2026-11-19' }) });
  assert.equal(result.ok, false);
  assert.equal(result.advisories[0]?.status, 'blocked');
  assert.match(result.errors.join(' '), /future decision date/u);
});

test('audit subprocess timeouts and unsuccessful runs with invalid JSON fail closed', () => {
  for (const scope of ['full', 'production'] as const) {
    assert.throws(() => runAudit(scope, (_command, _args, options) => {
      assert.equal(options.timeout, 120_000);
      return { stdout: JSON.stringify(clean), status: null, error: Object.assign(new Error(), { code: 'ETIMEDOUT' }) };
    }), /command could not complete/u);
    assert.throws(() => runAudit(scope, () => ({ stdout: '{', status: 1 })), /did not contain valid JSON/u);
  }
});

test('review date is inclusive in UTC and exceptions fail after that date', () => {
  assert.equal(check({ now: new Date('2026-12-17T23:59:59Z') }).ok, true);
  const result = check({ now: new Date('2026-12-18T00:00:00Z') });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /expired/u);
});

test('an exception cannot exceed the 30-day review window', () => {
  const result = check({ exceptions: withException({ reviewBy: '2026-12-19' }) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /30-day/u);
});

test('a stale exception directs the maintainer to delete it', () => {
  const result = check({ full: clean });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /Stale exception.*Delete it/u);
});

test('an exception is forbidden in production even at moderate severity', () => {
  const moderate = finding('picomatch', 'moderate', [advisory('picomatch', excepted, 'moderate')]);
  for (const entry of [picomatch, moderate]) {
    const result = check({ full: report(entry), production: report(entry) });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /Exception advisory .* appears in the production audit/u);
  }
});

test('any high production vulnerability blocks the gate', () => {
  const high = finding('other-package', 'high', [advisory('other-package', additional, 'high')]);
  const result = check({ full: report(...chain, high), production: report(high) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /Production audit contains high or critical/u);
});

test('malformed, empty, error-shaped and unexpected input fails closed', () => {
  for (const input of ['', '{', 'registry returned a private token', '{}', null, undefined,
    { ...clean, error: { detail: 'private token' } },
    report(finding('orphan', 'high', ['missing-package'])),
    report(finding('circular', 'high', ['circular'])),
  ]) {
    for (const field of ['full', 'production', 'exceptions']) {
      const result = check({ [field]: input });
      assert.equal(result.ok, false);
      assert.ok(result.errors.length > 0);
      assert.doesNotMatch(result.errors.join(' '), /private token/u);
    }
  }
});

test('moderate findings are reported and pass in both scopes', () => {
  const moderate = finding('other-package', 'moderate', [advisory('other-package', additional, 'moderate')]);
  const full = report(moderate);
  for (const production of [clean, full]) {
    const result = check({ full, production, exceptions: { version: 1, exceptions: [] } });
    assert.equal(result.ok, true);
    assert.equal(result.advisories[0]?.status, 'reported');
    assert.equal(result.advisories[0]?.scope, production === clean ? 'development' : 'production');
  }
});

test('malformed exception fields and unknown scopes fail', () => {
  for (const key of Object.keys(policy.exceptions[0] ?? {})) {
    assert.equal(check({ exceptions: withException({ [key]: undefined }) }).ok, false, key);
  }
  for (const fields of [{ scope: 'production' }, { decided: '2026-02-30' }, { chain: ['typescript-eslint'] }]) {
    assert.equal(check({ exceptions: withException(fields) }).ok, false);
  }
});

test('an exception with the right GHSA but a different package fails', () => {
  assert.equal(check({ exceptions: withException({ package: 'fdir', chain: ['tinyglobby', 'fdir'] }) }).ok, false);
});
