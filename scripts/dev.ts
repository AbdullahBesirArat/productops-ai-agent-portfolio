import { fork } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { loadConfig } from '../src/config.js';

class PortInUseError extends Error {}

export async function assertPortAvailable(host: 'localhost' | '127.0.0.1', port: number, setting: string) {
  const addresses = host === 'localhost'
    ? (await lookup(host, { all: true })).map(({ address }) => address)
      .filter(address => address === '::1' || address.startsWith('127.'))
    : [host];
  for (const address of addresses) {
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once('error', (error: NodeJS.ErrnoException) => {
        reject(error.code === 'EADDRINUSE' ? new PortInUseError(`${setting} port ${port} is already in use.`) : error);
      });
      server.listen(port, address, () => server.close(error => error ? reject(error) : resolve()));
    });
  }
}

async function main() {
  const env = parseEnv(readFileSync('.env.local', 'utf8'));
  const digest = env.PRODUCTOPS_REQUEST_DIGEST_SECRET ?? env.PRODUCTOPS_JWT_SECRET;
  if (!env.PRODUCTOPS_DB_URL || !env.PRODUCTOPS_AUTH_DB_URL || !digest || !/^[a-fA-F0-9]{64}$/u.test(digest)) {
    throw new Error('Missing development configuration');
  }
  const authPort = env.PRODUCTOPS_AUTH_PORT ?? '3109';
  const ephemeralApi = env.PORT === '0';
  const config = loadConfig({ HOST: env.HOST, PORT: ephemeralApi ? undefined : env.PORT, PRODUCTOPS_AUTH_PORT: authPort });
  if (!ephemeralApi) await assertPortAvailable(config.host, config.port, 'API (PORT)');
  await assertPortAvailable('127.0.0.1', config.authPort, 'Auth (PRODUCTOPS_AUTH_PORT)');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const kid = randomUUID();
  const system = process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
  const children: ReturnType<typeof fork>[] = [];
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    for (const child of children) child.kill();
  };
  const launch = (entry: string, values: NodeJS.ProcessEnv) => {
    const child = fork(fileURLToPath(new URL(entry, import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], env: { ...system, ...values }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    children.push(child);
    child.once('error', () => stop(1));
    child.once('exit', () => stop(1));
    return child;
  };

  process.once('SIGINT', () => stop(0));
  process.once('SIGTERM', () => stop(0));
  const auth = launch('../src/auth-server.ts', {
    PRODUCTOPS_AUTH_DB_URL: env.PRODUCTOPS_AUTH_DB_URL,
    PRODUCTOPS_JWT_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    PRODUCTOPS_JWT_KID: kid, PRODUCTOPS_AUTH_PORT: authPort,
  });
  auth.once('message', () => {
    if (stopping) return;
    launch('../src/server.ts', {
      HOST: env.HOST, PORT: env.PORT, MODEL_ADAPTER: env.MODEL_ADAPTER,
      PRODUCTOPS_DB_URL: env.PRODUCTOPS_DB_URL, PRODUCTOPS_AUTH_PORT: authPort,
      PRODUCTOPS_JWT_PUBLIC_KEYS: JSON.stringify([{ kid, pem: publicKey.export({ format: 'pem', type: 'spki' }).toString() }]),
      PRODUCTOPS_REQUEST_DIGEST_SECRET: digest,
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof PortInUseError ? error.message : 'Check .env.local configuration.';
    process.stderr.write(`ProductOps development startup failed. ${message}\n`);
    process.exitCode = 1;
  });
}
