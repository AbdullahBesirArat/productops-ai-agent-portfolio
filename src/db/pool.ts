import pg from 'pg';
import type { DatabaseConfig } from '../config.js';

export function createPool(config: DatabaseConfig, max = 16): pg.Pool {
  const pool = new pg.Pool({
    host: config.host, port: config.port, database: config.database,
    user: config.username, password: config.password, ssl: false,
    max, statement_timeout: 10000, idle_in_transaction_session_timeout: 10000,
    // Client-side bound so a blackholed connection cannot hang a request past the server-side timeouts.
    query_timeout: 15000,
    idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000,
  });
  // An error on an idle pooled client (e.g. the database restarts) is emitted on the pool; without a listener
  // Node would treat it as an uncaught exception and terminate the process. The client is discarded by pg itself.
  pool.on('error', () => undefined);
  return pool;
}
