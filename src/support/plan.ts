import type { ModelAdapter, ModelContext, ModelDecision } from '../agent/types.js';
import type { Classification } from './classifier.js';

export function supportLookup({ intent, entities, ambiguous, needsInformation }: Classification):
  Extract<ModelDecision, { kind: 'tool_call' }> | undefined {
  if (ambiguous || needsInformation) return undefined;
  switch (intent) {
    case 'order_status':
      return entities.orderCode ? { kind: 'tool_call', tool: 'get_order_status', arguments: { orderCode: entities.orderCode } } : undefined;
    case 'low_stock':
      return { kind: 'tool_call', tool: 'list_low_stock_products', arguments: {} };
    case 'shipping_delay':
    case 'returns':
    case 'warranty':
      return { kind: 'tool_call', tool: 'get_policy_snippet', arguments: { topic: intent } };
    default:
      return undefined;
  }
}

export class SupportPlanAdapter implements ModelAdapter {
  readonly name = 'mock-support-plan';

  constructor(private readonly classification: Classification) {}

  async plan(context: ModelContext): Promise<ModelDecision> {
    if (context.step === 0) {
      return supportLookup(this.classification) ?? { kind: 'final_answer', template: 'cannot_verify', sourceIds: [] };
    }
    // T4 accepts at most eight proposed IDs. The composer uses gateway facts for its own citations.
    const sourceIds = [...new Set(context.history.flatMap(({ sources }) => sources.map(({ id }) => id)))].slice(0, 8);
    return { kind: 'final_answer', template: 'summarize_verified', sourceIds };
  }
}
