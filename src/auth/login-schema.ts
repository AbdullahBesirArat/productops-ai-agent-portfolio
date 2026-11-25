export interface LoginBody { org_slug: string; email: string; password: string }
export const LOGIN_OPTIONS = { bodyLimit: 2048, schema: { body: {
  type: 'object', required: ['org_slug', 'email', 'password'], additionalProperties: false,
  properties: { org_slug: { type: 'string', maxLength: 40 }, email: { type: 'string', maxLength: 254 }, password: { type: 'string', maxLength: 256 } },
} } };
