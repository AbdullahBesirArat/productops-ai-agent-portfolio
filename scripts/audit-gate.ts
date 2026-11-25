import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const severities = ['info', 'low', 'moderate', 'high', 'critical'] as const;
type Severity = typeof severities[number];
type Advisory = { id: string; package: string; severity: Severity };
type AuditRow = Advisory & { scope: 'development' | 'production'; status: string };
type Exception = { id: string; package: string; decided: number; reviewBy: number };

const ghsa = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/u;
const packageName = /^(?:@[a-z0-9_~.-]+\/)?[a-z0-9_~.-]+$/u;
const day = 86_400_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSeverity(value: unknown): value is Severity {
  return severities.some((severity) => severity === value);
}

function isPackage(value: unknown): value is string {
  return typeof value === 'string' && packageName.test(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBlocking(severity: Severity): boolean {
  return severity === 'high' || severity === 'critical';
}

function parseInput(input: unknown, label: string): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new Error(`${label} did not contain valid JSON.`);
  }
}

function parseAudit(input: unknown, label: string) {
  const report = parseInput(input, label);
  const invalid = () => new Error(`${label} has an unexpected npm audit report structure.`);
  if (!isRecord(report) || report.auditReportVersion !== 2 || 'error' in report
    || !isRecord(report.vulnerabilities) || !isRecord(report.metadata)
    || !isRecord(report.metadata.vulnerabilities)) throw invalid();

  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  const advisories = new Map<string, Advisory>();
  const propagated = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    if (!isPackage(name) || !isRecord(entry) || entry.name !== name
      || !isSeverity(entry.severity) || !Array.isArray(entry.via) || entry.via.length === 0) throw invalid();
    counts[entry.severity]++;
    counts.total++;
    const sources: string[] = [];
    let hasAdvisory = false;
    for (const via of entry.via as unknown[]) {
      if (typeof via === 'string') {
        if (!Object.hasOwn(report.vulnerabilities, via)) throw invalid();
        sources.push(via);
        continue;
      }
      if (!isRecord(via) || via.name !== name || !isSeverity(via.severity) || typeof via.url !== 'string') {
        throw invalid();
      }
      const id = /^https:\/\/github\.com\/advisories\/([^/?#]+)\/?$/u.exec(via.url)?.[1];
      if (!id || !ghsa.test(id)) throw invalid();
      const previous = advisories.get(id);
      if (previous && (previous.package !== name || previous.severity !== via.severity)) throw invalid();
      advisories.set(id, { id, package: name, severity: via.severity });
      hasAdvisory = true;
    }
    if (!hasAdvisory) propagated.set(name, sources);
  }
  for (const [key, count] of Object.entries(counts)) {
    if (report.metadata.vulnerabilities[key] !== count) throw invalid();
  }

  // Every propagated finding must lead to a direct advisory.
  const explained = new Set([...advisories.values()].map((advisory) => advisory.package));
  while (propagated.size > 0) {
    const before = propagated.size;
    for (const [name, sources] of propagated) {
      if (!sources.some((source) => explained.has(source))) continue;
      explained.add(name);
      propagated.delete(name);
    }
    if (propagated.size === before) throw invalid();
  }
  return { advisories, counts };
}

function parseDate(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : NaN;
}

function parseExceptions(input: unknown): Map<string, Exception> {
  const policy = parseInput(input, 'Exception policy');
  if (!isRecord(policy) || policy.version !== 1 || !Array.isArray(policy.exceptions)) {
    throw new Error('Exception policy must contain a version 1 exceptions array.');
  }

  const exceptions = new Map<string, Exception>();
  for (const [index, entry] of (policy.exceptions as unknown[]).entries()) {
    const invalid = () => new Error(`Exception entry ${index + 1} has missing or malformed fields or an unknown scope.`);
    if (!isRecord(entry) || typeof entry.id !== 'string' || !ghsa.test(entry.id)
      || typeof entry.cve !== 'string' || !/^CVE-\d{4}-\d{4,}$/u.test(entry.cve)
      || !isPackage(entry.package) || entry.scope !== 'development'
      || !Array.isArray(entry.chain) || entry.chain.length < 2 || !entry.chain.every(isPackage)
      || entry.chain.at(-1) !== entry.package || !isText(entry.reason) || !isText(entry.endsWhen)) throw invalid();
    const decided = parseDate(entry.decided);
    const reviewBy = parseDate(entry.reviewBy);
    if (!Number.isFinite(decided) || !Number.isFinite(reviewBy) || reviewBy < decided) throw invalid();
    if (exceptions.has(entry.id)) throw new Error(`Duplicate exception for ${entry.id}.`);
    exceptions.set(entry.id, { id: entry.id, package: entry.package, decided, reviewBy });
  }
  return exceptions;
}

export function evaluateAudit({ full, production, exceptions, now }: {
  full: unknown;
  production: unknown;
  exceptions: unknown;
  now: Date;
}): { ok: boolean; advisories: AuditRow[]; errors: string[] } {
  const advisories: AuditRow[] = [];
  const errors: string[] = [];
  try {
    const fullReport = parseAudit(full, 'Full audit');
    const productionReport = parseAudit(production, 'Production audit');
    const policy = parseExceptions(exceptions);
    const today = Math.floor(now.getTime() / day) * day;
    if (!Number.isFinite(today)) throw new Error('Audit evaluation date is invalid.');

    const invalidExceptions = new Set<string>();
    for (const entry of policy.values()) {
      const advisory = fullReport.advisories.get(entry.id);
      if (advisory?.package !== entry.package) {
        errors.push(`Stale exception for ${entry.id}. Delete it from security/audit-exceptions.json.`);
        invalidExceptions.add(entry.id);
      }
      if (entry.reviewBy - entry.decided > 30 * day) {
        errors.push(`Exception for ${entry.id} exceeds the 30-day review window.`);
        invalidExceptions.add(entry.id);
      }
      if (entry.decided > today) {
        errors.push(`Exception for ${entry.id} has a future decision date.`);
        invalidExceptions.add(entry.id);
      }
      if (today > entry.reviewBy) {
        errors.push(`Exception for ${entry.id} has expired.`);
        invalidExceptions.add(entry.id);
      }
      if (productionReport.advisories.has(entry.id)) {
        errors.push(`Exception advisory ${entry.id} appears in the production audit.`);
        invalidExceptions.add(entry.id);
      }
    }

    if (productionReport.counts.high + productionReport.counts.critical > 0
      || [...productionReport.advisories.values()].some((advisory) => isBlocking(advisory.severity))) {
      errors.push('Production audit contains high or critical vulnerabilities.');
    }
    const allAdvisories = new Map([...fullReport.advisories, ...productionReport.advisories]);
    for (const advisory of allAdvisories.values()) {
      const fromFull = fullReport.advisories.get(advisory.id);
      const fromProduction = productionReport.advisories.get(advisory.id);
      if (fromFull && fromProduction
        && (fromFull.package !== fromProduction.package || fromFull.severity !== fromProduction.severity)) {
        throw new Error('Full and production audit reports disagree on an advisory.');
      }
      const scope = fromProduction ? 'production' : 'development';
      let status = 'reported';
      if (advisory.severity === 'critical') {
        status = 'blocked';
        errors.push(`Critical advisory ${advisory.id} cannot be excepted.`);
      } else if (fromProduction && (policy.has(advisory.id) || isBlocking(advisory.severity))) {
        status = 'blocked';
      } else if (isBlocking(advisory.severity)) {
        const exception = policy.get(advisory.id);
        if (exception?.package === advisory.package && !invalidExceptions.has(advisory.id)) {
          status = 'excepted';
        } else {
          status = 'blocked';
          errors.push(`No valid development exception for ${advisory.id}.`);
        }
      }
      advisories.push({ ...advisory, scope, status });
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Unexpected audit evaluation failure.');
  }
  return { ok: errors.length === 0, advisories, errors };
}

type AuditRunner = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) =>
  Pick<SpawnSyncReturns<string>, 'stdout' | 'status' | 'error'>;

export function runAudit(scope: 'full' | 'production', run: AuditRunner = spawnSync): unknown {
  const args = scope === 'production' ? ['--omit=dev'] : [];
  const label = scope === 'production' ? 'Production audit' : 'Full audit';
  const windows = process.platform === 'win32';
  // Windows needs a shell for npm.cmd. All arguments come from the fixed calls below.
  const result = run(windows ? 'npm.cmd' : 'npm', ['audit', ...args, '--json'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8',
    shell: windows,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`${label} command could not complete.`);
  }
  const output = parseInput(result.stdout, label);
  if (result.status === 1 && parseAudit(output, label).counts.total === 0) {
    throw new Error(`${label} command failed with a clean report.`);
  }
  return output;
}

function main() {
  try {
    const full = runAudit('full');
    const production = runAudit('production');
    const exceptions = readFileSync(new URL('../security/audit-exceptions.json', import.meta.url), 'utf8');
    const result = evaluateAudit({ full, production, exceptions, now: new Date() });
    console.table(result.advisories, ['id', 'package', 'severity', 'scope', 'status']);
    for (const message of result.errors) console.error(message);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    // Do not print subprocess output or filesystem error details.
    console.error(error instanceof Error && !('code' in error) ? error.message : 'Could not run the dependency audit gate.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
