import type { HistoryItem, ModelAdapter, ModelContext } from '../types.js';

const ORDER_CODE = /\bORD-[A-Za-z0-9][A-Za-z0-9._-]{0,27}\b/u;

interface Intent { tool: string; arguments: Record<string, unknown> }

function intents(request: string): Intent[] {
  const found: Intent[] = [];
  const order = ORDER_CODE.exec(request);
  if (order) found.push({ tool: 'get_order_status', arguments: { orderCode: order[0] } });
  if (/\bstock\b|running low|low on/iu.test(request)) found.push({ tool: 'list_low_stock_products', arguments: {} });
  const lower = request.toLowerCase();
  if (/shipping delay|delayed (shipping|shipment)/u.test(lower)) found.push({ tool: 'get_policy_snippet', arguments: { topic: 'shipping_delay' } });
  else if (/\breturns?\b|refund policy/u.test(lower)) found.push({ tool: 'get_policy_snippet', arguments: { topic: 'returns' } });
  else if (/warranty/u.test(lower)) found.push({ tool: 'get_policy_snippet', arguments: { topic: 'warranty' } });
  return found.slice(0, 3);
}

const sourceIds = (history: readonly HistoryItem[]): string[] => {
  return history.flatMap((item) => item.sources.map((source) => source.id)).slice(0, 8);
};

/**
 * Deterministic, keyword-driven SIMULATOR. It is not a language model and makes no claim of language understanding:
 * the same request always yields the same sequence of decisions. It only reads the request text and prior tool outcomes
 * and source references and never sees identity, tenant, role, tokens or credentials.
 */
export class MockAdapter implements ModelAdapter {
  readonly name = 'mock';
  async plan(context: ModelContext, _signal?: AbortSignal): Promise<unknown> {
    void _signal; // deterministic and synchronous: nothing to cancel
    const wanted = intents(context.request);
    if (wanted.length === 0) return { kind: 'refusal', reason: 'out_of_scope' };
    const next = wanted[context.step];
    if (next) return { kind: 'tool_call', tool: next.tool, arguments: next.arguments };
    return { kind: 'final_answer', template: context.history.length > 0 ? 'summarize_verified' : 'cannot_verify', sourceIds: sourceIds(context.history) };
  }
}
