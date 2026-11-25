import type { Pool } from 'pg';
import { isRole, type Role } from '../auth/permissions.js';
import { withTenant } from '../db/tenant.js';
import type { Identity } from '../tools/gateway.js';
import type { RunOutcome } from './types.js';

/** A `running` row older than this is considered abandoned (run budget 10 s + generous slack). */
export const ABANDONED_AFTER_SECONDS = 30;
export interface StoredResponse { httpStatus: number; body: Record<string, unknown> }
export type BeginResult =
  | { kind: 'started' }
  | { kind: 'replay'; response: StoredResponse; status: string }
  | { kind: 'conflict' }
  | { kind: 'in_progress' }
  | { kind: 'forbidden' };

/**
 * Starts a run inside ONE tenant transaction: the current DB membership is re-checked first (also for replays),
 * then the run row is inserted. With an idempotency key the insert is conflict-safe, so two concurrent requests
 * with the same key can never both execute tools.
 */
export async function beginRun(pool: Pool, identity: Identity,
  run: { runId: string; traceId: string; key: string | null; requestHash: string },
  permits: (role: Role, toolNames: readonly string[]) => boolean): Promise<BeginResult> {
  return withTenant(pool, identity.org, async (client): Promise<BeginResult> => {
    const membership = await client.query<{ role: unknown }>('SELECT role FROM memberships WHERE user_id=$1', [identity.sub]);
    const role = membership.rows[0]?.role;
    if (!isRole(role)) return { kind: 'forbidden' };
    const inserted = await client.query(
      `INSERT INTO public.agent_runs(id, trace_id, org_id, actor_id, idempotency_key, request_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,'running') ON CONFLICT (org_id, actor_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [run.runId, run.traceId, identity.org, identity.sub, run.key, run.requestHash]);
    if (inserted.rowCount === 1) return { kind: 'started' };
    const readExisting = async () => (await client.query<{ id: string; trace_id: string; request_hash: string; status: string; response: StoredResponse | null; stale: boolean }>(
      `SELECT id, trace_id, request_hash, status, response, (created_at < now() - make_interval(secs => $3)) AS stale
         FROM public.agent_runs WHERE actor_id=$1 AND idempotency_key=$2`, [identity.sub, run.key, ABANDONED_AFTER_SECONDS])).rows[0];
    let row = await readExisting();
    if (!row) throw new Error('Run record unavailable');
    if (row.request_hash !== run.requestHash) return { kind: 'conflict' };
    if (row.status === 'running' && row.stale) {
      // A run that never finished (process died or its record could not be completed) must not block its key forever:
      // it is closed with a stable, explicit error and the client retries with a NEW key.
      const body = { runId: row.id, traceId: row.trace_id, status: 'error', answer: null, sources: [], executedTools: [], errorCode: 'RUN_ABANDONED' };
      const closed = await client.query(
        `UPDATE public.agent_runs SET status='error', error_code='RUN_ABANDONED', response=$3 WHERE id=$1 AND actor_id=$2`,
        [row.id, identity.sub, JSON.stringify({ httpStatus: 500, body })]);
      if (closed.rowCount === 1) return { kind: 'replay', response: { httpStatus: 500, body }, status: 'error' };
      // The finishing transaction won. Read its committed result before deciding whether to replay.
      row = await readExisting();
    }
    if (row && row.request_hash !== run.requestHash) return { kind: 'conflict' };
    if (row?.status === 'running' && !row.stale) return { kind: 'in_progress' };
    if (!row?.response || row.status === 'running') throw new Error('Run record unavailable');
    const executed: unknown = row.response.body.executedTools;
    if (!Array.isArray(executed)) return { kind: 'forbidden' };
    const toolNames: string[] = [];
    for (const entry of executed as unknown[]) {
      if (typeof entry !== 'object' || entry === null || !('tool' in entry)) return { kind: 'forbidden' };
      if (entry.tool === null) continue;
      if (typeof entry.tool !== 'string') return { kind: 'forbidden' };
      toolNames.push(entry.tool);
    }
    if (!permits(role, toolNames)) return { kind: 'forbidden' };
    return { kind: 'replay', response: row.response, status: row.status };
  }, { actorId: identity.sub, statementTimeoutMs: 3000 });
}

/** Finishes a run exactly once (the RLS policy only allows updating rows that are still 'running'). */
export async function finishRun(pool: Pool, identity: Identity, runId: string, outcome: RunOutcome, response: StoredResponse): Promise<void> {
  await withTenant(pool, identity.org, async (client) => {
    const result = await client.query(
      `UPDATE public.agent_runs SET status=$3, error_code=$4, tool_calls=$5, duration_ms=$6, response=$7
        WHERE id=$1 AND actor_id=$2`,
      [runId, identity.sub, outcome.status, outcome.errorCode, Math.min(outcome.toolCalls, 20), outcome.durationMs, JSON.stringify(response)]);
    if (result.rowCount !== 1) throw new Error('Run record unavailable');
  }, { actorId: identity.sub, statementTimeoutMs: 3000 });
}
