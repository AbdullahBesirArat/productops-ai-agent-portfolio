import { parseDecision } from './decision.js';
import { collectSources, composeAnswer, UNVERIFIED_ANSWER, type Fact } from './grounding.js';
import type { ExecutedTool, HistoryItem, ModelAdapter, RunOutcome, RunStatus, SourceRef } from './types.js';
import type { AuditEvent } from '../tools/audit.js';
import type { GatewayDeps, GatewayResult, Identity } from '../tools/gateway.js';
import type { LimitResult } from '../tools/limiter.js';

export interface RunLimits {
  /** Maximum executed tool calls per run (the next one is rejected, not executed). */
  maxToolCalls: number;
  /** Wall-clock budget for the whole run, including model calls and tool calls. */
  totalTimeoutMs: number;
  /** Upper bound for a single tool call (further clamped to the remaining run time). */
  toolTimeoutMs: number;
}
export const DEFAULT_LIMITS: Readonly<RunLimits> = Object.freeze({ maxToolCalls: 4, totalTimeoutMs: 10000, toolTimeoutMs: 2000 });

export type ExecuteFn = (deps: GatewayDeps, identity: Identity, limit: LimitResult, rawBody: unknown) => Promise<GatewayResult>;

export interface OrchestratorDeps {
  adapter: ModelAdapter;
  /** The existing T3 gateway pipeline (membership, RBAC, allowlist, strict validation, READ ONLY RLS transaction). */
  execute: ExecuteFn;
  gateway: GatewayDeps;
  /** Persists a redacted tool audit event (fail-closed: a rejection aborts the run without returning data). */
  audit: (event: AuditEvent) => Promise<void>;
  tools: readonly string[];
  limits?: Partial<RunLimits>;
  now?: () => number;
}

export interface RunInput { request: string; runId: string; traceId: string }

const ALWAYS_OPEN: LimitResult = { allowed: true };

/** Deep-freezes a structured clone so an adapter can neither mutate verified results nor keep live references. */
function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (node: unknown): void => {
    if (node !== null && typeof node === 'object' && !Object.isFrozen(node)) { Object.freeze(node); for (const child of Object.values(node)) freeze(child); }
  };
  freeze(copy);
  return copy;
}

/** Untrusted model output is copied before validation so later mutation by the adapter cannot affect the run. */
function detach(raw: unknown): unknown {
  try { return structuredClone(raw); } catch { return undefined; }
}

/**
 * Bounded agent loop. The orchestrator has NO database or auth code of its own: every tool call goes through the
 * T3 gateway with the trusted identity, so membership, RBAC, allowlist, strict validation, RLS and READ ONLY apply
 * on every single step. Model output is untrusted data and is parsed strictly; answers are composed from verified
 * tool results, never from model text.
 */
export async function runAgent(deps: OrchestratorDeps, identity: Identity, input: RunInput): Promise<RunOutcome> {
  const limits: RunLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => performance.now());
  const started = now();
  const deadline = started + limits.totalTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.totalTimeoutMs);
  const expired = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('Run deadline exceeded')), { once: true });
  });
  const timedOut = () => controller.signal.aborted || now() >= deadline;
  const facts: Fact[] = [];
  const history: HistoryItem[] = [];
  const executed: ExecutedTool[] = [];
  let toolCalls = 0;

  const finish = (status: RunStatus, errorCode: string | null, answer: string | null, sources: SourceRef[] = []): RunOutcome => ({
    status, errorCode, answer, sources, facts, executedTools: executed, toolCalls, durationMs: Math.max(0, Math.round(now() - started)),
  });

  try {
    for (let step = 0; step <= limits.maxToolCalls; step++) {
      if (timedOut()) return finish('timeout', 'RUN_TIMEOUT', null);

      // 1) Ask the (untrusted) model, bounded by the run deadline even if the adapter ignores the abort signal.
      let raw: unknown;
      try {
        raw = await Promise.race([
          deps.adapter.plan({ request: input.request, step, maxToolCalls: limits.maxToolCalls, tools: deps.tools, history: frozenCopy(history) }, controller.signal),
          expired,
        ]);
      } catch {
        return timedOut() ? finish('timeout', 'RUN_TIMEOUT', null) : finish('model_error', 'MODEL_ERROR', null);
      }

      if (timedOut()) return finish('timeout', 'RUN_TIMEOUT', null);

      // 2) Strict validation of the untrusted decision.
      const parsed = parseDecision(detach(raw));
      if (!parsed.ok) return finish('invalid_model_output', 'INVALID_MODEL_OUTPUT', null);
      const decision = parsed.decision;

      if (decision.kind === 'error') return finish('model_error', 'MODEL_ERROR', null);
      if (decision.kind === 'refusal') {
        return finish('refused', null, 'This request cannot be handled by the agent.');
      }
      if (decision.kind === 'final_answer') {
        // Model-claimed source ids are only checked, never trusted: a forged id fails the whole run.
        const verified = collectSources(facts);
        const verifiedIds = new Set(verified.map((source) => source.id));
        if (!decision.sourceIds.every((id) => verifiedIds.has(id))) return finish('invalid_model_output', 'SOURCE_NOT_VERIFIED', null);
        if (decision.template === 'cannot_verify') return finish('unverified', null, UNVERIFIED_ANSWER);
        const answer = composeAnswer(facts);
        return finish(facts.some((fact) => fact.outcome === 'ok') && answer.text ? 'completed' : 'unverified',
          null, answer.text || UNVERIFIED_ANSWER, answer.sources);
      }

      // 3) tool_call: enforce the run budget BEFORE executing anything.
      if (toolCalls >= limits.maxToolCalls) return finish('budget_exceeded', 'BUDGET_EXCEEDED', null);
      const remaining = deadline - now();
      if (remaining < 50) return finish('timeout', 'RUN_TIMEOUT', null);
      toolCalls++;

      // The tool is executed by the gateway with the TRUSTED identity; model-provided fields cannot change it.
      const pending = deps.execute(
        { ...deps.gateway, timeoutMs: Math.max(1, Math.min(limits.toolTimeoutMs, Math.floor(remaining))) },
        identity, ALWAYS_OPEN, { name: decision.tool, arguments: decision.arguments });
      // Keep the audit attached to the tool even when the run stops waiting for either operation.
      const audited = pending.then(async (result) => {
        if (result.audit) {
          try { await deps.audit({ ...result.audit, traceId: input.traceId, runId: input.runId, step }); }
          catch { return null; }
        }
        return result;
      });
      let result: GatewayResult | null;
      try {
        result = await Promise.race([audited, expired]);
      } catch (error) {
        if (timedOut()) return finish('timeout', 'RUN_TIMEOUT', null);
        throw error;
      }
      if (timedOut()) return finish('timeout', 'RUN_TIMEOUT', null);
      if (!result) return finish('error', 'AUDIT_UNAVAILABLE', null);
      const audit = result.audit;
      const statusCode = audit?.status ?? 'error';
      const toolName = audit?.toolName ?? null;
      const body = result.body as { result?: Record<string, unknown> };

      if (statusCode === 'ok' && toolName && body.result) {
        executed.push({ tool: toolName, status: 'ok' });
        const fact = { tool: toolName, outcome: 'ok', data: body.result } as Fact;
        facts.push(fact);
        history.push({ tool: toolName, status: 'ok', sources: collectSources([fact]) });
      } else if (statusCode === 'not_found' && toolName) {
        executed.push({ tool: toolName, status: 'not_found' });
        facts.push({ tool: toolName, outcome: 'not_found' });
        history.push({ tool: toolName, status: 'not_found', sources: [] });
      } else if (statusCode === 'forbidden') {
        executed.push({ tool: toolName, status: 'forbidden' });
        return finish('forbidden', 'FORBIDDEN', null);
      } else if (statusCode === 'invalid_input' || statusCode === 'unknown_tool') {
        executed.push({ tool: toolName, status: 'rejected' });
        return finish('rejected_tool_call', audit?.errorCode ?? 'INVALID_TOOL_CALL', null);
      } else if (statusCode === 'timeout') {
        executed.push({ tool: toolName, status: 'timeout' });
        return finish('timeout', 'TOOL_TIMEOUT', null);
      } else {
        executed.push({ tool: toolName, status: 'error' });
        return finish('error', 'TOOL_ERROR', null);
      }
    }
    // The loop ended without a final answer: never present a partial run as a success.
    return finish('budget_exceeded', 'BUDGET_EXCEEDED', null);
  } finally {
    clearTimeout(timer);
  }
}
