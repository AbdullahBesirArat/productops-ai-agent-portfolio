import type { ModelAdapter, ModelContext } from '../types.js';

/**
 * One scripted step. Exactly one of `output`, `throw`, `delayMs` selects the behaviour:
 * - output: the (possibly malformed or hostile) value returned verbatim as the untrusted decision
 * - throw:  simulate a model/provider failure
 * - delayMs: wait (abortable) before returning `output`, to simulate a slow model
 * - hook:   named test callback executed before the step (e.g. revoke a membership between steps)
 * - repeat: keep using this step for every following model call (simulates an endless tool-call request)
 */
export interface ScriptStep {
  output?: unknown;
  throw?: string;
  delayMs?: number;
  hook?: string;
  repeat?: boolean;
}

export type Hooks = Readonly<Record<string, () => Promise<void> | void>>;

/** Test/evaluation adapter that replays fixture scripts. It is never wired to the HTTP API by default. */
export class ScriptedMockAdapter implements ModelAdapter {
  readonly name = 'mock-scripted';
  calls = 0;
  constructor(private readonly steps: readonly ScriptStep[], private readonly hooks: Hooks = {}) {}

  async plan(_context: ModelContext, signal: AbortSignal): Promise<unknown> {
    const index = this.calls++;
    const last = this.steps[this.steps.length - 1];
    const step = this.steps[index] ?? (last?.repeat ? last : undefined);
    if (!step) return { kind: 'refusal', reason: 'cannot_verify' };
    if (step.hook) await this.hooks[step.hook]?.();
    if (step.throw !== undefined) throw new Error('simulated model failure');
    if (step.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, step.delayMs);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
    }
    return step.output;
  }
}
