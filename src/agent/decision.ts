import type { ModelDecision } from './types.js';

export const MAX_DECISION_JSON_CHARS = 2000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key)) && allowed.every((key) => Object.hasOwn(value, key) || key === 'arguments');

export type ParsedDecision = { ok: true; decision: ModelDecision } | { ok: false };

/**
 * Strict, allowlist-based validation of an untrusted model decision (discriminated union).
 * Unknown kinds, missing/extra fields, wrong types, oversized or cyclic output are all rejected, never repaired.
 * Free text produced by a model is not part of the contract: answers are composed by the server from verified results.
 */
export function parseDecision(raw: unknown): ParsedDecision {
  const bad: ParsedDecision = { ok: false };
  let size: number;
  try { size = JSON.stringify(raw)?.length ?? Number.POSITIVE_INFINITY; } catch { return bad; }
  if (size > MAX_DECISION_JSON_CHARS || !isPlain(raw) || typeof raw.kind !== 'string') return bad;
  switch (raw.kind) {
    case 'tool_call': {
      if (!onlyKeys(raw, ['kind', 'tool', 'arguments'])) return bad;
      const tool = raw.tool;
      if (typeof tool !== 'string' || tool.length < 1 || tool.length > 64 || CONTROL.test(tool)) return bad;
      const args = Object.hasOwn(raw, 'arguments') ? raw.arguments : {};
      if (!isPlain(args)) return bad;
      return { ok: true, decision: { kind: 'tool_call', tool, arguments: args } };
    }
    case 'final_answer': {
      if (!onlyKeys(raw, ['kind', 'template', 'sourceIds'])) return bad;
      const { template, sourceIds } = raw;
      if (template !== 'summarize_verified' && template !== 'cannot_verify') return bad;
      if (!Array.isArray(sourceIds) || sourceIds.length > 8) return bad;
      if (!sourceIds.every((id) => typeof id === 'string' && id.length >= 1 && id.length <= 64 && !CONTROL.test(id))) return bad;
      return { ok: true, decision: { kind: 'final_answer', template, sourceIds: sourceIds as string[] } };
    }
    case 'refusal': {
      if (!onlyKeys(raw, ['kind', 'reason'])) return bad;
      const { reason } = raw;
      if (reason !== 'out_of_scope' && reason !== 'unsafe_request' && reason !== 'cannot_verify') return bad;
      return { ok: true, decision: { kind: 'refusal', reason } };
    }
    case 'error': {
      if (!onlyKeys(raw, ['kind', 'code'])) return bad;
      const { code } = raw;
      if (code !== 'model_failure' && code !== 'model_unavailable') return bad;
      return { ok: true, decision: { kind: 'error', code } };
    }
    default:
      return bad;
  }
}
