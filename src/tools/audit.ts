import type { Pool } from 'pg';
import { withTenant } from '../db/tenant.js';

export const TOOL_NAMES = ['list_low_stock_products', 'get_order_status', 'get_policy_snippet'] as const;
export type AuditStatus = 'ok' | 'not_found' | 'invalid_input' | 'unknown_tool' | 'forbidden' | 'rate_limited' | 'timeout' | 'error';

/** Redacted audit record: identifiers, decision and classification only. No arguments, tokens, e-mails or free text. */
export interface AuditEvent {
  traceId: string;
  orgId: string;
  actorId: string;
  toolName: string | null;
  decision: 'allowed' | 'denied';
  status: AuditStatus;
  errorCode: string | null;
  durationMs: number;
  /** Agent run correlation (T4); null for direct tool calls. */
  runId?: string | null;
  step?: number | null;
}

export async function recordAudit(pool: Pool, event: AuditEvent): Promise<void> {
  const toolName = event.toolName !== null && (TOOL_NAMES as readonly string[]).includes(event.toolName) ? event.toolName : null;
  const errorCode = event.errorCode === null ? null : event.errorCode.slice(0, 64);
  const duration = Math.max(0, Math.min(2147483647, Math.round(event.durationMs)));
  // Append-only, separate transaction: the runtime role holds INSERT only (no SELECT, so no RETURNING).
  await withTenant(pool, event.orgId, async (client) => {
    await client.query(
      'INSERT INTO public.tool_audit_events(trace_id, org_id, actor_id, tool_name, decision, status, error_code, duration_ms, run_id, step) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [event.traceId, event.orgId, event.actorId, toolName, event.decision, event.status, errorCode, duration, event.runId ?? null, event.step ?? null]);
  }, { actorId: event.actorId, statementTimeoutMs: 3000 });
}
