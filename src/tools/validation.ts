import type { Validation } from './types.js';
const forbidden = /^(tenant[_-]?id|organi[sz]ation[_-]?id|org[_-]?id|user[_-]?id|tenant|organi[sz]ation|org|user|role|roles|sub|actor|actor[_-]?id)$/iu;
const dangerous = new Set(['__proto__', 'constructor', 'prototype']);
function inspect(value: unknown, seen = new Set<object>()): 'INVALID_ARGUMENT' | 'FORBIDDEN_ARGUMENT' | undefined {
  if (typeof value === 'string') return value.length > 32 || /[\u0000-\u001f\u007f-\u009f]/u.test(value) ? 'INVALID_ARGUMENT' : undefined;
  if (value === null || typeof value !== 'object') return undefined;
  if (seen.has(value)) return 'INVALID_ARGUMENT';
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key === 'string' && forbidden.test(key))) return 'FORBIDDEN_ARGUMENT';
  for (const key of keys) {
    if (typeof key !== 'string' || dangerous.has(key)) return 'INVALID_ARGUMENT';
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) return 'INVALID_ARGUMENT';
    const error = inspect(descriptor.value, seen);
    if (error) return error;
  }
  return undefined;
}
export function validateArguments(name: string, raw: unknown): Validation {
  const code = inspect(raw);
  if (code) return { valid: false, code };
  const invalid: Validation = { valid: false, code: 'INVALID_ARGUMENT' };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) ||
      (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)) return invalid;
  const args = raw as Record<string, unknown>;
  const keys = Object.keys(args);
  if (name === 'list_low_stock_products') {
    if (keys.some(key => key !== 'threshold' && key !== 'limit')) return invalid;
    const threshold = Object.hasOwn(args, 'threshold') ? args.threshold : 5;
    const limit = Object.hasOwn(args, 'limit') ? args.limit : 20;
    if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 0 || threshold > 50 ||
        typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) return invalid;
    return { valid: true, args: { threshold, limit } };
  }
  if (name === 'get_order_status' && keys.length === 1 && keys[0] === 'orderCode' && typeof args.orderCode === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(args.orderCode)) return { valid: true, args: { orderCode: args.orderCode } };
  if (name === 'get_policy_snippet' && keys.length === 1 && keys[0] === 'topic' && typeof args.topic === 'string' && ['shipping_delay', 'returns', 'warranty'].includes(args.topic)) return { valid: true, args: { topic: args.topic } };
  return invalid;
}
