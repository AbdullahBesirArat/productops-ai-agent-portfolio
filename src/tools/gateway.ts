import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { can, isRole } from '../auth/permissions.js';
import { withTenant } from '../db/tenant.js';
import type { AuditEvent, AuditStatus } from './audit.js';
import type { LimitResult } from './limiter.js';
import { lookupTool, registry as defaultRegistry } from './registry.js';
import type { ToolContext, ToolOutcome, ToolRegistry } from './types.js';

export type { ToolContext, ToolOutcome, ToolRegistry } from './types.js';

/** Pure core: allowlist lookup -> strict validation -> handler. Authorization is the caller's job (see executeTool). */
export async function runTool(registry: ToolRegistry, name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const entry = lookupTool(registry, name);
  if (!entry) return { status: 'unknown_tool', code: 'UNKNOWN_TOOL', message: 'Unknown tool' };
  const validation = entry.validate(rawArgs);
  if (!validation.valid) return { status: 'invalid_input', code: validation.code, message: 'Invalid tool arguments' };
  return entry.handler({ client: ctx.client }, validation.args);
}

export interface GatewayDeps {
  pool: Pool;
  registry?: ToolRegistry;
  /** Server-side statement timeout for the tool transaction (1..10000 ms). */
  timeoutMs?: number;
}
export interface Identity { sub: string; org: string }
export interface GatewayResult {
  httpStatus: number;
  body: Record<string, unknown>;
  audit: AuditEvent | null;
  retryAfter?: number;
}

const MESSAGES: Record<string, string> = {
  INVALID_REQUEST: 'Invalid request', UNKNOWN_TOOL: 'Unknown tool', INVALID_ARGUMENT: 'Invalid tool arguments',
  FORBIDDEN_ARGUMENT: 'Invalid tool arguments', FORBIDDEN: 'Forbidden', RATE_LIMITED: 'Too many requests',
  TIMEOUT: 'Tool timed out', INTERNAL_ERROR: 'Internal error', ORDER_NOT_FOUND: 'Order not found', POLICY_NOT_FOUND: 'Policy not found',
};
const HTTP: Record<AuditStatus, number> = {
  ok: 200, not_found: 404, invalid_input: 400, unknown_tool: 400, forbidden: 403, rate_limited: 429, timeout: 504, error: 500,
};

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function peekToolName(raw: unknown, registry: ToolRegistry): string | null {
  if (!isPlain(raw) || typeof raw.name !== 'string') return null;
  return lookupTool(registry, raw.name)?.name ?? null;
}

function parseBody(raw: unknown): { name: string; args: unknown } | undefined {
  if (!isPlain(raw)) return undefined;
  if (Object.keys(raw).some((key) => key !== 'name' && key !== 'arguments')) return undefined;
  const name = raw.name;
  if (typeof name !== 'string' || name.length < 1 || name.length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) return undefined;
  return { name, args: Object.hasOwn(raw, 'arguments') ? raw.arguments : {} };
}

/**
 * One tool call = one tenant-scoped READ ONLY transaction:
 * rate budget -> current DB membership -> body shape -> allowlist -> RBAC permission -> strict validation -> query.
 * Tenant and actor come exclusively from the verified token identity; nothing in the body can change them.
 */
export async function executeTool(deps: GatewayDeps, identity: Identity, limit: LimitResult, rawBody: unknown): Promise<GatewayResult> {
  const traceId = randomUUID();
  const started = performance.now();
  const registry = deps.registry ?? defaultRegistry;
  const timeoutMs = deps.timeoutMs ?? 2000;
  // The tool name is only recorded when it is an allowlisted registry entry (never raw client input).
  const peeked = peekToolName(rawBody, registry);

  const result = (status: AuditStatus, code: string | null, toolName: string | null, decision: 'allowed' | 'denied',
    data?: Record<string, unknown>): GatewayResult => ({
    httpStatus: HTTP[status],
    body: status === 'ok'
      ? { trace_id: traceId, tool: toolName, status: 'ok', result: data }
      : { trace_id: traceId, status: 'error', error: { code: code ?? 'INTERNAL_ERROR', message: MESSAGES[code ?? 'INTERNAL_ERROR'] ?? 'Internal error' } },
    audit: {
      traceId, orgId: identity.org, actorId: identity.sub, toolName, decision, status, errorCode: status === 'ok' ? null : code,
      durationMs: performance.now() - started,
    },
  });

  // The budget was consumed by the route's onRequest hook (before any body parsing or database work), so
  // hostile traffic cannot cause unbounded DB load.
  if (!limit.allowed) {
    const limited = result('rate_limited', 'RATE_LIMITED', peeked, 'allowed');
    if (!limit.firstDenial) limited.audit = null; // audit only the first denial per window (bounds audit amplification)
    limited.retryAfter = limit.retryAfter;
    return limited;
  }

  try {
    return await withTenant(deps.pool, identity.org, async (client): Promise<GatewayResult> => {
      const membership = await client.query<{ role: unknown }>('SELECT role FROM memberships WHERE user_id=$1', [identity.sub]);
      const role = membership.rows[0]?.role;
      if (!isRole(role)) return result('forbidden', 'FORBIDDEN', null, 'denied');
      const parsed = parseBody(rawBody);
      if (!parsed) return result('invalid_input', 'INVALID_REQUEST', null, 'allowed');
      const entry = lookupTool(registry, parsed.name);
      if (!entry) return result('unknown_tool', 'UNKNOWN_TOOL', null, 'allowed');
      if (!can(role, entry.permission)) return result('forbidden', 'FORBIDDEN', entry.name, 'denied');
      const outcome = await runTool(registry, entry.name, parsed.args, { client });
      if (outcome.status === 'ok') return result('ok', null, entry.name, 'allowed', outcome.data);
      return result(outcome.status, outcome.code, entry.name, 'allowed');
    }, { readOnly: true, statementTimeoutMs: timeoutMs, actorId: identity.sub });
  } catch (error) {
    const timedOut = typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '57014';
    return timedOut ? result('timeout', 'TIMEOUT', peeked, 'allowed') : result('error', 'INTERNAL_ERROR', peeked, 'allowed');
  }
}
