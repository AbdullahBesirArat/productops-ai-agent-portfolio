export type Role = 'owner' | 'member' | 'viewer';
export type Permission = 'catalog:read' | 'order_status:read' | 'policy:read' | 'message:classify' | 'draft:create' | 'draft:decide' | 'audit:read';
const read: Permission[] = ['catalog:read', 'order_status:read', 'policy:read'];
const write: Permission[] = [...read, 'message:classify', 'draft:create', 'draft:decide'];
export const PERMISSION_MATRIX: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  owner: Object.freeze([...write, 'audit:read'] as Permission[]),
  member: Object.freeze(write), viewer: Object.freeze(read),
});
export function isRole(value: unknown): value is Role {
  return value === 'owner' || value === 'member' || value === 'viewer';
}
export function can(role: string, permission: string): boolean {
  return isRole(role) && PERMISSION_MATRIX[role].includes(permission as Permission);
}
