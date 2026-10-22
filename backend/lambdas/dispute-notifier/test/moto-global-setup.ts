import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    motoEndpoint: string;
  }
}

const run = promisify(execFile);
const MOTO_IMAGE = 'motoserver/moto:5.2.4';
const ATTEMPTS = 3;

const waitForMoto = async (endpoint: string, deadline: number): Promise<void> => {
  const up = await fetch(`${endpoint}/moto-api/`).then(
    (r) => r.ok,
    () => false,
  );
  if (up) return;
  if (Date.now() > deadline) throw new Error(`moto did not become ready at ${endpoint}`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  return waitForMoto(endpoint, deadline);
};

// Docker can hand out a host port another listener already holds ("address already in use"), so retry with a fresh name.
const startContainer = async (
  attempt: number,
): Promise<{ readonly name: string; readonly endpoint: string }> => {
  const name = `cd-dispute-notifier-test-moto-${randomUUID().slice(0, 8)}`;
  try {
    await run('docker', ['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::5000', MOTO_IMAGE]);
    const { stdout } = await run('docker', ['port', name, '5000/tcp']);
    const hostPort = stdout.trim().split('\n')[0]?.split(':').pop();
    return { name, endpoint: `http://127.0.0.1:${hostPort}` };
  } catch (error) {
    await run('docker', ['rm', '-f', name]).catch(() => undefined);
    if (attempt >= ATTEMPTS) throw error;
    return startContainer(attempt + 1);
  }
};

// MOTO_ENDPOINT reuses a running moto (the compose one on host port 55000); otherwise a throwaway container is started.
export default async ({ provide }: TestProject): Promise<() => Promise<void>> => {
  const shared = process.env['MOTO_ENDPOINT'];
  if (shared) {
    await waitForMoto(shared, Date.now() + 30_000);
    provide('motoEndpoint', shared);
    return async () => undefined;
  }
  const { name, endpoint } = await startContainer(1);
  const stop = async () => {
    await run('docker', ['rm', '-f', name]).catch(() => undefined);
  };
  try {
    await waitForMoto(endpoint, Date.now() + 60_000);
  } catch (error) {
    await stop();
    throw error;
  }
  provide('motoEndpoint', endpoint);
  return stop;
};
