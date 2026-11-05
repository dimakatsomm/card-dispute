import { EVIDENCE_VIEW_RATE_LIMIT, type EvidenceViewRequest } from '@cd/dispute-domain';
import { createLogger } from '@cd/shared';
import { describe, expect, it } from 'vitest';
import {
  createLambdaViewer,
  type LambdaInvoke,
  type LambdaInvokeInput,
  type LambdaInvokeOutput,
} from '../src/adapters/evidence-viewer.ts';
import { checkViewRateCap } from '../src/core/evidence-view.ts';

const REQUEST: EvidenceViewRequest = {
  disputeId: '0192f0c1-0000-7000-8000-0000000000d1',
  evidenceId: '0192f0c1-0000-7000-8000-0000000000e1',
  contentType: 'application/pdf',
  correlationId: 'corr-0001-abcd',
};

const REPLY = { url: 'https://evidence.test/k?X-Amz-Signature=abc', expiresAt: '2026-11-05T10:01:00.000Z' };

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const viewerWith = (respond: (signal: AbortSignal) => Promise<LambdaInvokeOutput>) => {
  const calls: Array<{ readonly input: LambdaInvokeInput; readonly signal: AbortSignal }> = [];
  const invoke: LambdaInvoke = async (input, signal) => {
    calls.push({ input, signal });
    return respond(signal);
  };
  const viewer = createLambdaViewer({
    invoke,
    functionName: 'cd-dev-evidence-viewer',
    timeoutMs: 50,
    log: createLogger({ level: 'silent' }),
  });
  return { viewer, calls };
};

describe('createLambdaViewer', () => {
  it('invokes the configured function synchronously with exactly the request and returns the parsed reply', async () => {
    const { viewer, calls } = viewerWith(async () => ({ Payload: bytes(REPLY) }));
    expect(await viewer(REQUEST)).toEqual({ ok: true, value: REPLY });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.FunctionName).toBe('cd-dev-evidence-viewer');
    expect(calls[0]?.input.InvocationType).toBe('RequestResponse');
    expect(JSON.parse(new TextDecoder().decode(calls[0]?.input.Payload))).toEqual(REQUEST);
  });

  it.each<[string, (signal: AbortSignal) => Promise<LambdaInvokeOutput>]>([
    ['a function error', async () => ({ FunctionError: 'Unhandled', Payload: bytes({ errorMessage: 'x' }) })],
    ['an SDK error', async () => Promise.reject(new Error('AccessDeniedException'))],
    ['an empty reply', async () => ({})],
    ['a non-JSON reply', async () => ({ Payload: new TextEncoder().encode('not json') })],
    ['a reply with an extra key', async () => ({ Payload: bytes({ ...REPLY, s3Key: 'evidence/a/b' }) })],
    ['a reply with a non-URL', async () => ({ Payload: bytes({ ...REPLY, url: 'javascript:alert(1)' }) })],
    [
      'a timeout',
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    ],
  ])('%s → VIEWER_UNAVAILABLE', async (_case, respond) => {
    const { viewer, calls } = viewerWith(respond);
    expect(await viewer(REQUEST)).toEqual({ ok: false, error: 'VIEWER_UNAVAILABLE' });
    expect(calls).toHaveLength(1);
  });

  it('the timeout aborts the in-flight invoke', async () => {
    const { viewer, calls } = viewerWith(() => new Promise(() => undefined));
    await viewer(REQUEST);
    expect(calls[0]?.signal.aborted).toBe(true);
  });

  it.each<[string, unknown]>([
    ['an object key', { ...REQUEST, s3Key: 'evidence/other/item' }],
    ['an undeclared content type', { ...REQUEST, contentType: 'text/html' }],
    ['a non-uuid dispute id', { ...REQUEST, disputeId: '../other' }],
  ])('a request with %s is refused before any invoke', async (_case, request) => {
    const { viewer, calls } = viewerWith(async () => ({ Payload: bytes(REPLY) }));
    expect(await viewer(request as EvidenceViewRequest)).toEqual({ ok: false, error: 'VIEWER_UNAVAILABLE' });
    expect(calls).toEqual([]);
  });
});

describe('checkViewRateCap', () => {
  const max = EVIDENCE_VIEW_RATE_LIMIT.maxViews;
  it.each<[number, number | null, number | null]>([
    [max - 1, 30, null],
    [max, 59.2, 60],
    [max, 0, 1],
    [max, -0.5, 1],
    [max + 3, 9999, 600],
  ])(
    '%i recent views, oldest leaves in %s s → retry after %s',
    (count, secondsUntilOldestLeaves, retryAfter) => {
      const result = checkViewRateCap({ count, secondsUntilOldestLeaves });
      expect(result).toEqual(
        retryAfter === null
          ? { ok: true, value: null }
          : { ok: false, error: { kind: 'RATE_LIMITED', retryAfterSeconds: retryAfter } },
      );
    },
  );
});
