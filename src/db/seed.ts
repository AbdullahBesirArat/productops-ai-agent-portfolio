import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDatabaseConfig, type DatabaseConfig } from '../config.js';
import { populate } from './bootstrap.js';
export const runSeed = (config: DatabaseConfig, password: string | undefined) => populate(config, password, true);
async function main() {
  try {
    console.log(await runSeed(loadDatabaseConfig(process.env.PRODUCTOPS_BOOTSTRAP_DB_URL, 'productops_bootstrap'), process.env.PRODUCTOPS_DEMO_PASSWORD));
  } catch { process.stderr.write('ProductOps seed failed.\n'); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
