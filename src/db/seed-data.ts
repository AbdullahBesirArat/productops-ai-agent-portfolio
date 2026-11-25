const id = (tenant: number, kind: number, index: number) =>
  `${tenant.toString().padStart(8, '0')}-0000-4000-8000-${(kind * 100 + index).toString().padStart(12, '0')}`;
export const SHARED_SKU = 'SKU-100';
export const SHARED_ORDER_CODE = 'ORD-1001';
export const SEED_TENANTS = (['a', 'b'] as const).map((letter, offset) => ({
  id: id(offset + 1, 0, 1), slug: `tenant-${letter}`, name: `Tenant ${letter.toUpperCase()}`,
  users: (['owner', 'member', 'viewer'] as const).map((role, index) => ({
    id: id(offset + 1, 1, index), role, email: `${role}-${letter}@example.test`,
  })),
  products: [0, 1, 2].map(index => ({
    id: id(offset + 1, 2, index), sku: index === 0 ? SHARED_SKU : `SKU-${101 + index}`,
    name: `${offset === 0 ? 'Alpha Widget' : 'Beta Gadget'} ${index || ''}`.trim(),
    stock: index === 0 ? (offset === 0 ? 3 : 40) : index, reorderLevel: 5,
  })),
  orders: [0, 1, 2].map(index => ({
    id: id(offset + 1, 3, index), code: index === 0 ? SHARED_ORDER_CODE : `ORD-${1001 + index}`,
    customerRef: `SYN-${letter}-${index}`, status: offset === 0 ? 'shipped' : 'pending',
  })),
  policies: [0, 1, 2].map(index => ({
    id: id(offset + 1, 4, index), slug: `policy-${index}`, title: `Tenant ${letter} policy ${index}`,
    topic: ['shipping_delay', 'returns', 'warranty'][index]!, version: index === 2 ? 2 : 1,
    body: `Synthetic ${letter.toUpperCase()} ${['shipping delay', 'returns', 'warranty'][index]}: Contact this tenant's support team for assistance.`,
  })),
}));
export const SEED_TABLES = ['organizations', 'users', 'memberships', 'projects', 'user_credentials', 'products', 'orders', 'policy_snippets'] as const;
