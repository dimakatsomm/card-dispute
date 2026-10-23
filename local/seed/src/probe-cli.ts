import { allPassed, parseHttpUrl, probeDenials, probeUnreachable, type CheckResult, type ProbeDeps } from './probe.ts';

export const HOLD_MAX_SECONDS = 900;

export const USAGE = `usage: probe [--expect-unreachable] [--hold <seconds>]
  default               service port answers; user token 403, no token 401, svc-notifier PUT evidence 403
  --expect-unreachable  every connection to SERVICE_PORT_BASE_URL fails or times out
  --hold <seconds>      after the checks, stay alive 0-${HOLD_MAX_SECONDS}s (default 0) so the task ENI exists for Reachability Analyzer
env: SERVICE_PORT_BASE_URL; default mode also COGNITO_USER_POOL_ID, PROBE_USER_SECRET_ID, E2E_CLIENT_ID,
     SERVICE_CLIENT_ID, SERVICE_CLIENT_SECRET, TOKEN_URL
`;

export const EXIT_USAGE = 64;

const DENIAL_ENV = [
  'SERVICE_PORT_BASE_URL',
  'COGNITO_USER_POOL_ID',
  'PROBE_USER_SECRET_ID',
  'E2E_CLIENT_ID',
  'SERVICE_CLIENT_ID',
  'SERVICE_CLIENT_SECRET',
  'TOKEN_URL',
] as const;

export type ProbeArgs = { readonly expectUnreachable: boolean; readonly holdSeconds: number };

export type ParsedArgs =
  | { readonly kind: 'help' }
  | { readonly kind: 'run'; readonly args: ProbeArgs }
  | { readonly kind: 'usage'; readonly reason: string };

const parseHold = (raw: string | undefined): number | null => {
  if (raw === undefined || !/^\d{1,4}$/.test(raw)) return null;
  const seconds = Number(raw);
  return seconds <= HOLD_MAX_SECONDS ? seconds : null;
};

export const parseProbeArgs = (argv: ReadonlyArray<string>): ParsedArgs => {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };
  const step = (i: number, acc: { readonly expectUnreachable: boolean; readonly holdSeconds: number | undefined }): ParsedArgs => {
    if (i >= argv.length) return { kind: 'run', args: { expectUnreachable: acc.expectUnreachable, holdSeconds: acc.holdSeconds ?? 0 } };
    const arg = argv[i];
    if (arg === '--expect-unreachable' && !acc.expectUnreachable) return step(i + 1, { ...acc, expectUnreachable: true });
    if (arg === '--hold' && acc.holdSeconds === undefined) {
      const seconds = parseHold(argv[i + 1]);
      if (seconds === null) return { kind: 'usage', reason: `--hold needs whole seconds 0-${HOLD_MAX_SECONDS}` };
      return step(i + 2, { ...acc, holdSeconds: seconds });
    }
    return { kind: 'usage', reason: 'unknown or repeated argument' };
  };
  return step(0, { expectUnreachable: false, holdSeconds: undefined });
};

type LogFn = (obj: object, msg: string) => void;

// A plain ref'd timer, so the process (and with it the task ENI) stays alive for the whole hold.
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export type ProbeCliDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: { readonly info: LogFn; readonly error: LogFn };
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly probe: () => ProbeDeps;
  readonly userId: string;
  readonly newId: () => string;
  readonly sleep: (ms: number) => Promise<void>;
};

const report = (deps: ProbeCliDeps, results: ReadonlyArray<CheckResult>): number => {
  for (const r of results) {
    deps.log.info({ check: r.check, expected: r.expected, observed: r.observed, code: r.code, pass: r.pass }, 'probe check');
  }
  const passed = allPassed(results);
  deps.log.info({ passed, checks: results.length }, passed ? 'probe passed' : 'probe failed');
  return passed ? 0 : 1;
};

const check = async (deps: ProbeCliDeps, args: ProbeArgs): Promise<number> => {
  const value = (key: string): string => deps.env[key] ?? '';
  const probe = deps.probe();
  if (args.expectUnreachable) return report(deps, await probeUnreachable(probe)([value('SERVICE_PORT_BASE_URL')]));
  const denials = await probeDenials(probe)({ serviceBaseUrl: value('SERVICE_PORT_BASE_URL'), userId: deps.userId, unknownId: deps.newId });
  if (!denials.ok) {
    deps.log.error({ error: denials.error }, 'probe: could not obtain a token');
    return 1;
  }
  return report(deps, denials.value);
};

export const runProbe =
  (deps: ProbeCliDeps) =>
  async (argv: ReadonlyArray<string>): Promise<number> => {
    const parsed = parseProbeArgs(argv);
    if (parsed.kind === 'help') {
      deps.stdout(USAGE);
      return 0;
    }
    if (parsed.kind === 'usage') {
      deps.stderr(`probe: ${parsed.reason}\n${USAGE}`);
      return EXIT_USAGE;
    }
    const { args } = parsed;
    const required = args.expectUnreachable ? ['SERVICE_PORT_BASE_URL'] : DENIAL_ENV;
    const missing = required.filter((k) => !deps.env[k]);
    if (missing.length > 0) {
      deps.log.error({ missing }, 'probe: missing environment variables');
      return 1;
    }
    const invalid = [
      ...(parseHttpUrl(deps.env.SERVICE_PORT_BASE_URL ?? '') === null ? ['SERVICE_PORT_BASE_URL'] : []),
      ...(!args.expectUnreachable && parseHttpUrl(deps.env.TOKEN_URL ?? '', ['https:']) === null ? ['TOKEN_URL'] : []),
    ];
    if (invalid.length > 0) {
      deps.log.error({ invalid }, 'probe: invalid environment variables (SERVICE_PORT_BASE_URL http(s), TOKEN_URL https)');
      return 1;
    }
    const code = await check(deps, args);
    if (args.holdSeconds > 0) {
      deps.log.info({ holdSeconds: args.holdSeconds, exitCode: code }, 'probe: holding before exit');
      await deps.sleep(args.holdSeconds * 1_000);
    }
    return code;
  };
