import type { Fact } from './grounding.js';

/**
 * Provider-neutral model contract. A ModelAdapter only ever sees `ModelContext` and only ever returns UNTRUSTED data:
 * the orchestrator parses every return value with `parseDecision` before acting on it.
 */
export type SourceRef = { kind: 'postgres'; entity: 'product' | 'order' | 'policy_snippet'; id: string };

/** History contains tool outcomes and verified source references. */
export interface HistoryItem {
  readonly tool: string;
  readonly status: 'ok' | 'not_found';
  readonly sources: SourceRef[];
}

export interface ModelContext {
  /** Operator request text (untrusted, bounded). No identity, tenant, role, token or credential is ever included. */
  readonly request: string;
  readonly step: number;
  readonly maxToolCalls: number;
  /** Names of tools the server exposes (informational; the gateway remains the only authority). */
  readonly tools: readonly string[];
  readonly history: readonly HistoryItem[];
}

export interface ModelAdapter {
  readonly name: string;
  /** Returns an UNTRUSTED structured decision. Must honour `signal` where it can; the orchestrator also enforces a deadline. */
  plan(context: ModelContext, signal: AbortSignal): Promise<unknown>;
}

export type ModelDecision =
  | { kind: 'tool_call'; tool: string; arguments: Record<string, unknown> }
  | { kind: 'final_answer'; template: 'summarize_verified' | 'cannot_verify'; sourceIds: string[] }
  | { kind: 'refusal'; reason: 'out_of_scope' | 'unsafe_request' | 'cannot_verify' }
  | { kind: 'error'; code: 'model_failure' | 'model_unavailable' };

export type RunStatus =
  | 'completed' | 'unverified' | 'refused' | 'budget_exceeded' | 'invalid_model_output'
  | 'rejected_tool_call' | 'forbidden' | 'timeout' | 'model_error' | 'error';

export interface ExecutedTool { tool: string | null; status: 'ok' | 'not_found' | 'rejected' | 'forbidden' | 'timeout' | 'error' }

export interface RunOutcome {
  facts: readonly Fact[];
  status: RunStatus;
  answer: string | null;
  sources: SourceRef[];
  executedTools: ExecutedTool[];
  errorCode: string | null;
  toolCalls: number;
  durationMs: number;
}
