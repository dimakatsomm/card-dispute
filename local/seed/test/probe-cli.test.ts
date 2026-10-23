import { ok } from '@cd/shared/fp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_USAGE, parseProbeArgs, runProbe, sleep, type ProbeCliDeps } from '../src/probe-cli.ts';
import type { Fetch } from '../src/probe.ts';

const ENV = {
  SERVICE_PORT_BASE_URL: 'http://internal-cd-alb.example.com:8081',
  COGNITO_USER_POOL_ID: 'af-south-1_FAKEPOOL',
  PROBE_USER_SECRET_ID: 'cd/dev/seed-users/thandi.nkosi',
  E2E_CLIENT_ID: 'fake-e2e-client',
  SERVICE_CLIENT_ID: 'fake-svc-notifier',
  SERVICE_CLIENT_SECRET: 'fake-svc-secret',
  TOKEN_URL: 'https://auth.example.com/oauth2/token',
};

const refused: Fetch = async () => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }));
const denying: Fetch = async (_, init) => ({ status: (init.headers as Record<string, string>).authorization === undefined ? 401 : 403 });
const answering: Fetch = async () => ({ status: 404 });

const cli = (fetch: Fetch, env: Record<string, string> = ENV) => {
  const fetched: string[] = [];
  const deps: ProbeCliDeps = {
    env,
    log: { info: () => undefined, error: () => undefined },
    stdout: () => undefined,
    stderr: () => undefined,
    userId: '11111111-1111-4111-8111-111111111111',
    newId: () => '22222222-2222-4222-8222-222222222222',
    sleep,
    probe: () => ({
      fetch: (url, init) => {
        fetched.push(url);
        return fetch(url, init);
      },
      timeoutMs: 50,
      userToken: async () => ok('user-tok'),
      serviceToken: async () => ok('svc-tok'),
    }),
  };
  return { run: runProbe(deps), fetched };
};

const settled = <T>(promise: Promise<T>) => {
  const state: { done: boolean; value?: T } = { done: false };
  void promise.then((value) => Object.assign(state, { done: true, value }));
  return state;
};

describe('probe arguments', () => {
  it.each([
    [[], { expectUnreachable: false, holdSeconds: 0 }],
    [['--hold', '0'], { expectUnreachable: false, holdSeconds: 0 }],
    [['--hold', '900', '--expect-unreachable'], { expectUnreachable: true, holdSeconds: 900 }],
    [['--expect-unreachable', '--hold', '300'], { expectUnreachable: true, holdSeconds: 300 }],
  ])('%j parses to %j', (argv, args) => {
    expect(parseProbeArgs(argv)).toEqual({ kind: 'run', args });
  });

  it.each([
    [['--hold']],
    [['--hold', '901']],
    [['--hold', '-1']],
    [['--hold', '1.5']],
    [['--hold', '30s']],
    [['--hold', '']],
    [['--hold', '--expect-unreachable']],
    [['--hold', '5', '--hold', '5']],
    [['--hold=5']],
    [['--expect-unreachable', '--expect-unreachable']],
    [['--unknown']],
  ])('%j is a usage error and runs no check', async (argv) => {
    expect(parseProbeArgs(argv).kind).toBe('usage');
    const { run, fetched } = cli(refused);
    expect(await run(argv)).toBe(EXIT_USAGE);
    expect(fetched).toEqual([]);
  });
});

describe('probe --hold (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['--expect-unreachable passing', refused, ['--expect-unreachable', '--hold', '300'], 0],
    ['--expect-unreachable failing', answering, ['--expect-unreachable', '--hold', '300'], 1],
    ['denials passing', denying, ['--hold', '300'], 0],
    ['denials failing', answering, ['--hold', '300'], 1],
  ])('%s: checks run first, the process stays alive 300 s, then exits with the checks result', async (_, fetch, argv, code) => {
    const { run, fetched } = cli(fetch);
    const exit = settled(run(argv));

    await vi.advanceTimersByTimeAsync(0);
    expect(fetched.length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(exit.done).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toEqual({ done: true, value: code });
  });

  it('without --hold the probe exits as soon as the checks finish and leaves no timer', async () => {
    const { run } = cli(refused);
    const exit = settled(run(['--expect-unreachable']));
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toEqual({ done: true, value: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not hold when the environment is incomplete, so a misconfigured task fails fast', async () => {
    const { run } = cli(refused, {});
    const exit = settled(run(['--expect-unreachable', '--hold', '900']));
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toEqual({ done: true, value: 1 });
  });
});
