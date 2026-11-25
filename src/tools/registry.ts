import type { ToolEntry, ToolRegistry } from './types.js';
import { validateArguments } from './validation.js';

const lowStock: ToolEntry = {
  name: 'list_low_stock_products', permission: 'catalog:read',
  validate: (raw) => validateArguments('list_low_stock_products', raw),
  handler: async ({ client }, args) => {
    const threshold = args.threshold as number;
    const limit = args.limit as number;
    const rows = await client.query<{ id: string; sku: string; name: string; stock: number; reorder_level: number }>(
      'SELECT id, sku, name, stock, reorder_level FROM public.products WHERE stock <= $1 ORDER BY stock ASC, sku ASC LIMIT $2',
      [threshold, limit]);
    const items = rows.rows.map((row) => ({
      sku: row.sku, name: row.name, available_stock: row.stock,
      threshold_applied: threshold, reorder_level: row.reorder_level,
      priority_reason: row.stock === 0 ? 'out_of_stock'
        : row.stock <= row.reorder_level ? 'at_or_below_reorder_level' : 'at_or_below_requested_threshold',
      source: { kind: 'postgres', entity: 'product', id: row.id },
    }));
    return {
      status: 'ok' as const,
      data: {
        items, threshold_applied: threshold, count: items.length, limit_applied: limit, open_order_quantity: null,
        notes: ['open_order_quantity_unavailable: the current schema has no order line items'],
      },
    };
  },
};

const orderStatus: ToolEntry = {
  name: 'get_order_status', permission: 'order_status:read',
  validate: (raw) => validateArguments('get_order_status', raw),
  handler: async ({ client }, args) => {
    const result = await client.query<{ id: string; order_code: string; status: string; status_updated_at: Date }>(
      'SELECT id, order_code, status, status_updated_at FROM public.orders WHERE order_code = $1',
      [args.orderCode as string]);
    const row = result.rows[0];
    if (!row) return { status: 'not_found' as const, code: 'ORDER_NOT_FOUND' as const, message: 'Order not found' };
    return {
      status: 'ok' as const,
      data: {
        order_code: row.order_code, status: row.status, status_updated_at: row.status_updated_at.toISOString(),
        source: { kind: 'postgres', entity: 'order', id: row.id },
      },
    };
  },
};

const policy: ToolEntry = {
  name: 'get_policy_snippet', permission: 'policy:read',
  validate: (raw) => validateArguments('get_policy_snippet', raw),
  handler: async ({ client }, args) => {
    const result = await client.query<{ id: string; topic: string; version: number; body: string }>(
      'SELECT id, topic, version, body FROM public.policy_snippets WHERE topic = $1',
      [args.topic as string]);
    const row = result.rows[0];
    if (!row) return { status: 'not_found' as const, code: 'POLICY_NOT_FOUND' as const, message: 'Policy not found' };
    return {
      status: 'ok' as const,
      data: {
        policy_id: row.id, topic: row.topic, version: row.version,
        snippet: row.body.slice(0, 1000), truncated: row.body.length > 1000,
        source: { kind: 'postgres', entity: 'policy_snippet', id: row.id },
      },
    };
  },
};

export const registry: ToolRegistry = Object.freeze(Object.assign(Object.create(null) as Record<string, ToolEntry>, {
  list_low_stock_products: Object.freeze(lowStock),
  get_order_status: Object.freeze(orderStatus),
  get_policy_snippet: Object.freeze(policy),
}));

export function lookupTool(entries: ToolRegistry, name: string): ToolEntry | undefined {
  return Object.hasOwn(entries, name) ? entries[name] : undefined;
}
