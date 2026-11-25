import type { SourceRef } from './types.js';

/** A fact is a VERIFIED tool outcome produced by the gateway. Model text never becomes a fact. */
export type Fact =
  | { tool: 'list_low_stock_products'; outcome: 'ok'; data: Record<string, unknown> }
  | { tool: 'get_order_status'; outcome: 'ok'; data: Record<string, unknown> }
  | { tool: 'get_policy_snippet'; outcome: 'ok'; data: Record<string, unknown> }
  | { tool: string; outcome: 'not_found' };

// Default ignorables include variation selectors and tags. Keep visible text and replace controls separately.
const INVISIBLE = new RegExp('[\\p{Cf}\\p{Default_Ignorable_Code_Point}]', 'gu');
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

export function sanitizeText(text: string, controlReplacement: string): string {
  return text.replace(INVISIBLE, '').replace(CONTROL, () => controlReplacement);
}
const clean = (value: unknown, max = 200): string => sanitizeText(String(value ?? ''), ' ').slice(0, max);
const ENTITIES = new Set(['product', 'order', 'policy_snippet']);

export function asSource(value: unknown): SourceRef | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  if (source.kind !== 'postgres' || typeof source.entity !== 'string' || !ENTITIES.has(source.entity) || typeof source.id !== 'string') return undefined;
  return { kind: 'postgres', entity: source.entity as SourceRef['entity'], id: source.id };
}

/** Source references come ONLY from gateway output (trusted data), never from the model. */
export function collectSources(facts: readonly Fact[]): SourceRef[] {
  const found = new Map<string, SourceRef>();
  const add = (candidate: unknown) => {
    const source = asSource(candidate);
    if (source) found.set(`${source.entity}:${source.id}`, source);
  };
  for (const fact of facts) {
    if (fact.outcome !== 'ok') continue;
    add(fact.data.source);
    if (Array.isArray(fact.data.items)) for (const item of fact.data.items) add((item as Record<string, unknown> | null)?.source);
  }
  return [...found.values()];
}

export const UNVERIFIED_ANSWER = "The requested information could not be verified from this organization's data.";

/**
 * Deterministic answer templates. Every statement is derived from a verified fact; policy text is quoted as data.
 * Not-found outcomes are stated as "could not be verified", never as invented values.
 */
export function composeAnswer(facts: readonly Fact[]): { text: string; sources: SourceRef[] } {
  let text = '';
  const sources = new Map<string, SourceRef>();
  const append = (line: string, refs: SourceRef[] = []) => {
    const next = text ? `${text} ${line}` : line;
    // Keep each rendered group and its citations together at the response limit.
    if (next.length > 3000) return;
    text = next;
    for (const source of refs) sources.set(`${source.entity}:${source.id}`, source);
  };
  for (const fact of facts) {
    if (fact.outcome === 'not_found') {
      if (fact.tool === 'get_order_status') append('The requested order could not be verified: no matching order was found for your organization.');
      else if (fact.tool === 'get_policy_snippet') append('The requested policy could not be verified for your organization.');
      else append('The requested record could not be verified.');
      continue;
    }
    const data = fact.data;
    if (fact.tool === 'get_order_status') {
      const source = asSource(data.source);
      if (source?.entity !== 'order') continue;
      append(`Order ${clean(data.order_code, 40)}: status ${clean(data.status, 40)}, last updated ${clean(data.status_updated_at, 40)}.`, [source]);
    } else if (fact.tool === 'get_policy_snippet') {
      const source = asSource(data.source);
      if (source?.entity !== 'policy_snippet') continue;
      append(`Policy "${clean(data.topic, 40)}" (version ${clean(data.version, 10)}), quoted as data: "${clean(data.snippet, 500)}"`, [source]);
    } else if (fact.tool === 'list_low_stock_products') {
      const items = Array.isArray(data.items) ? data.items as Record<string, unknown>[] : [];
      if (items.length === 0) {
        if (typeof data.threshold_applied === 'number') {
          append(`No products are at or below the stock threshold of ${data.threshold_applied}.`);
        }
      } else {
        const shown = items.slice(0, 10).flatMap((item) => {
          const source = asSource(item?.source);
          if (source?.entity !== 'product') return [];
          return [{ source, text: `${clean(item.sku, 40)} (${clean(item.name, 80)}): ${clean(item.available_stock, 10)} in stock` }];
        });
        if (shown.length) {
          append(`Low stock, ${items.length} product(s): ${shown.map((item) => item.text).join('; ')}${items.length > shown.length ? '; ...' : ''}.`,
            shown.map((item) => item.source));
        }
      }
    }
  }
  return { text, sources: [...sources.values()] };
}
