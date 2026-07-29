/**
 * Server lifecycle helpers for E2E tests.
 *
 * These are used when you need fine-grained control over the server
 * (e.g. per-test database isolation). The default `playwright.config.ts`
 * already starts a shared server via the `webServer` directive.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = join(__dirname, '../../server');

export interface ServerInstance {
  process: ChildProcess;
  baseUrl: string;
  secret: string;
  dataDir: string;
}

/**
 * Start a fresh server instance with an isolated database.
 */
export async function startServer(): Promise<ServerInstance> {
  const port = 8765 + Math.floor(Math.random() * 1000);
  const dataDir = join(__dirname, '../.test-data', `run-${Date.now()}`);
  const secret = 'e2e-test-secret';

  await mkdir(dataDir, { recursive: true });

  const proc = spawn('node', ['dist/main.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      TAMARI_SECRET: secret,
      LOG_LEVEL: 'warn',
      DISABLE_CSRF: 'true',
    },
    stdio: 'pipe',
  });

  // Wait for server to be ready
  await waitForServer(`http://localhost:${port}`);

  return {
    process: proc,
    baseUrl: `http://localhost:${port}`,
    secret,
    dataDir,
  };
}

/**
 * Stop a server instance and clean up its data directory.
 */
export async function stopServer(instance: ServerInstance): Promise<void> {
  instance.process.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    instance.process.on('exit', () => resolve());
    setTimeout(() => {
      instance.process.kill('SIGKILL');
      resolve();
    }, 5000);
  });
  await rm(instance.dataDir, { recursive: true, force: true });
}

async function waitForServer(url: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200 || res.status === 401 || res.status === 403) {
        return;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}
