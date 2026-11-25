import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main() {
  try {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('PRODUCTOPS_') && !['PRODUCTOPS_DB_URL', 'PRODUCTOPS_AUTH_PORT',
        'PRODUCTOPS_JWT_PUBLIC_KEYS', 'PRODUCTOPS_REQUEST_DIGEST_SECRET'].includes(name)) {
        throw new Error('Unexpected ProductOps API configuration');
      }
    }
    const ephemeral = process.env.PORT === '0' && process.send !== undefined;
    const env = ephemeral ? { ...process.env, PORT: undefined } : process.env;
    const config = loadConfig(env);
    const app = buildApp(env);
    await app.listen({ host: config.host, port: ephemeral ? 0 : config.port });
    const address = app.server.address();
    if (address && typeof address === 'object') process.send?.({ port: address.port });
    process.stdout.write('ProductOps API listening on loopback.\n');
  } catch {
    process.stderr.write('ProductOps startup failed; check local configuration.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
