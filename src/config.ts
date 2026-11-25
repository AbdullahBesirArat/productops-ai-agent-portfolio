export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export interface DatabaseConfig {
  protocol: 'postgres:' | 'postgresql:';
  host: 'localhost' | '127.0.0.1' | 'productops-db';
  port: number;
  database: 'productops_dev' | 'productops_test';
  username: string;
  password: string;
}

export interface AppConfig {
  host: '127.0.0.1' | 'localhost';
  port: number;
  authPort: number;
  modelAdapter: 'mock';
  database: DatabaseConfig | undefined;
}

function invalid(message: string): never {
  throw new ConfigurationError(message);
}

export function validateDatabaseUrl(raw: string): DatabaseConfig {
  if (raw !== raw.trim() || /[\s\\\u0000-\u001f\u007f]/u.test(raw)) invalid('Invalid database URL');
  if (raw.includes('?') || raw.includes('#')) invalid('Database query or fragment is forbidden');
  let url: URL;
  try {
    url = new URL(raw);
    // Reject malformed escapes in every component without exposing parser errors.
    decodeURIComponent(raw);
  } catch {
    return invalid('Invalid database URL');
  }
  const protocol = url.protocol;
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') invalid('Unsupported database protocol');
  // Reject ambiguous authorities and path normalization before accepting parsed fields.
  const authority = raw.match(/^[a-z]+:\/\/([^/]*)(\/[^?#]*)$/u);
  if (!authority || authority[2] !== url.pathname) invalid('Invalid database URL structure');
  const host = url.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== 'productops-db') invalid('Unsupported database host');
  if ((authority[1]?.match(/@/gu)?.length ?? 0) > 1) invalid('Invalid database credentials');
  const ports = host === 'productops-db' ? [5432] : [54329, 54330];
  const hostPort = authority[1]?.split('@').at(-1);
  if (hostPort !== host && !ports.some(port => hostPort === `${host}:${port}`)) {
    invalid('Invalid database authority');
  }
  const expectedPort = url.port ? Number(url.port) : ports[0]!;
  const database = url.pathname.slice(1);
  if (database !== 'productops_dev' && database !== 'productops_test') invalid('Invalid database name');
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    return invalid('Invalid database credentials');
  }
  if ((authority[1]?.includes('@') && !username) ||
      (username && !/^[a-zA-Z_][a-zA-Z0-9_-]*$/u.test(username)) ||
      /[\u0000-\u001f\u007f]/u.test(password)) invalid('Invalid database credentials');
  return { protocol, host, port: Number(expectedPort), database, username, password };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  for (const [key, role] of [
    ['PRODUCTOPS_MIGRATOR_DB_URL', 'productops_migrator'],
    ['PRODUCTOPS_BOOTSTRAP_DB_URL', 'productops_bootstrap'],
    ['PRODUCTOPS_BOOTSTRAP_TEST_DB_URL', 'productops_bootstrap'],
    ['PRODUCTOPS_TEST_DB_URL', 'productops_app'],
    ['PRODUCTOPS_MIGRATOR_TEST_DB_URL', 'productops_migrator'],
  ] as const) {
    if (env[key] !== undefined) loadDatabaseConfig(env[key], role);
  }
  for (const name of ['PRODUCTOPS_AUTH_DB_URL', 'PRODUCTOPS_AUTH_TEST_DB_URL', 'PRODUCTOPS_AUTH_PASSWORD',
    'PRODUCTOPS_JWT_PRIVATE_KEY', 'PRODUCTOPS_JWT_KID', 'PRODUCTOPS_JWT_SECRET']) {
    if (env[name] !== undefined) invalid('Signing or authentication-service configuration in API environment');
  }
  const host = env.HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost') invalid('Unsupported application host');
  const portText = env.PORT || '3108';
  if (!/^[1-9][0-9]*$/u.test(portText) || Number(portText) > 65535) invalid('Invalid application port');
  const authPort = env.PRODUCTOPS_AUTH_PORT ?? '3109';
  if (!/^[1-9][0-9]{0,4}$/u.test(authPort) || Number(authPort) > 65535 || authPort === portText) invalid('Invalid authentication service port');
  if (env.MODEL_ADAPTER && env.MODEL_ADAPTER !== 'mock') invalid('Unsupported model adapter; mock only');
  return {
    host, port: Number(portText), authPort: Number(authPort), modelAdapter: 'mock',
    database: env.PRODUCTOPS_DB_URL === undefined ? undefined : loadDatabaseConfig(env.PRODUCTOPS_DB_URL, 'productops_app'),
  };
}

export function loadDatabaseConfig(raw: string | undefined, role: 'productops_app' | 'productops_migrator' | 'productops_bootstrap' | 'productops_authsvc'): DatabaseConfig {
  if (!raw) invalid('Required database configuration is missing');
  const config = validateDatabaseUrl(raw);
  if (config.username !== role || !config.password) invalid('Invalid database role or credentials');
  return config;
}
