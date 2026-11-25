import type { PoolClient } from 'pg';
import type { Permission } from '../auth/permissions.js';
export interface ToolContext { client: PoolClient }
export type ToolOutcome =
  | { status: 'ok'; data: Record<string, unknown> }
  | { status: 'not_found'; code: 'ORDER_NOT_FOUND' | 'POLICY_NOT_FOUND'; message: string }
  | { status: 'invalid_input'; code: 'INVALID_ARGUMENT' | 'FORBIDDEN_ARGUMENT'; message: string }
  | { status: 'unknown_tool'; code: 'UNKNOWN_TOOL'; message: string };
export type Validation = { valid: true; args: Record<string, unknown> } | { valid: false; code: 'INVALID_ARGUMENT' | 'FORBIDDEN_ARGUMENT' };
export interface ToolEntry {
  readonly name: string;
  readonly permission: Permission;
  readonly validate: (raw: unknown) => Validation;
  readonly handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolOutcome>;
}
export type ToolRegistry = Readonly<Record<string, ToolEntry>>;
