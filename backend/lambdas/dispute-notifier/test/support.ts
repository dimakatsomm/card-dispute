import { randomUUID } from 'node:crypto';
import type { Fetch } from '@cd/auth-client/service-client';
import type { DisputeStatus, EvidenceRejectionReason } from '@cd/dispute-domain';
import { createLogger } from '@cd/shared/lambda';
import { createLambdaHandler } from '../src/main.ts';

export const USER_A = '0b7c1d2e-3f40-4a51-8b62-7c83d94ea5f1';
export const USER_B = '1c8d2e3f-4051-4b62-9c73-8d94ea5fb602';
export const DISPUTE_A = '2d9e3f40-5162-4c73-ad84-9ea5fb60c713';
export const TXN_A = '3eaf4051-6273-4d84-be95-afb60c71d824';
export const EMAIL_A = 'thandi.owner@example.com';
export const NAME_A = 'Thandi';

const TOKEN_URL = 'http://issuer.test/oauth2/token';
const USERS_URL = 'http://users.test:8081';
const DISPUTES_URL = 'http://disputes.test:8081';

export const BASE_ENV = {
  AWS_REGION: 'eu-north-1',
  TOKEN_URL,
  SERVICE_CLIENT_ID: 'svc-notifier',
  SERVICE_CLIENT_SECRET: 'local-dev-client-secret',
  USERS_SERVICE_URL: USERS_URL,
  DISPUTES_SERVICE_URL: DISPUTES_URL,
  SES_SENDER: 'noreply@disputes.example.com',
} as const;

// 22:30 UTC is already the next day in South Africa.
export const OCCURRED_AT = '2026-10-20T22:30:00Z';
export const OCCURRED_DATE_SAST = '21 October 2026';

type Envelope = {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly disputeId: string;
  readonly transactionId: string;
  readonly userId: string;
  readonly version: number;
};

const envelope = (version: number): Envelope => ({
  eventId: randomUUID(),
  occurredAt: OCCURRED_AT,
  disputeId: DISPUTE_A,
  transactionId: TXN_A,
  userId: USER_A,
  version,
});

export const statusEvent = (
  eventType: 'DisputeCreated' | 'DisputeEdited' | 'DisputeStatusChanged',
  toStatus: DisputeStatus,
  version = 1,
) => ({
  ...envelope(version),
  eventType,
  data: { fromStatus: eventType === 'DisputeCreated' ? null : 'SUBMITTED', toStatus, reasonCode: 'FRAUD' },
});

export const storedEvent = (version = 1) => ({
  ...envelope(version),
  eventType: 'EvidenceStored',
  data: { evidence: { evidenceId: randomUUID() } },
});

export const rejectedEvent = (reason: EvidenceRejectionReason, version = 1) => ({
  ...envelope(version),
  eventType: 'EvidenceRejected',
  data: { evidence: { evidenceId: randomUUID(), reason } },
});

export const sqsEvent = (records: ReadonlyArray<readonly [messageId: string, body: string]>) => ({
  Records: records.map(([messageId, body]) => ({ messageId, body, eventSource: 'aws:sqs' })),
});

type Reply = number | 'hang' | { readonly status: number; readonly body: unknown };

export type UpstreamState = {
  contacts: Map<string, unknown>;
  disputes: Array<{ userId: string; transactionId: string; disputeId: string; status: DisputeStatus; version: number }>;
  users?: Reply;
  disputesReply?: Reply;
  rejectNextUsersToken?: boolean;
};

export type Call = { readonly url: URL; readonly authorization: string | null };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const hang = (signal: AbortSignal | null | undefined) =>
  new Promise<Response>((_, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

const override = (reply: Reply | undefined, signal: AbortSignal | null | undefined): Promise<Response> | undefined => {
  if (reply === undefined) return undefined;
  if (reply === 'hang') return hang(signal);
  return Promise.resolve(typeof reply === 'number' ? json(reply, {}) : json(reply.status, reply.body));
};

export const fakeUpstream = () => {
  const state: UpstreamState = {
    contacts: new Map([[USER_A, { userId: USER_A, email: EMAIL_A, name: NAME_A }]]),
    disputes: [{ userId: USER_A, transactionId: TXN_A, disputeId: DISPUTE_A, status: 'UNDER_REVIEW', version: 3 }],
  };
  const calls: Call[] = [];
  const tokenScopes: string[] = [];
  let tokenSerial = 0;

  const fetch: Fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const authorization = new Headers(init?.headers).get('authorization');
    if (url.href === TOKEN_URL) {
      const scope = new URLSearchParams(String(init?.body)).get('scope') ?? '';
      tokenScopes.push(scope);
      tokenSerial += 1;
      return json(200, { access_token: `tok:${scope}:${tokenSerial}`, expires_in: 3600 });
    }
    calls.push({ url, authorization });
    const bearer = authorization?.replace(/:\d+$/, '');
    if (url.origin === USERS_URL) {
      if (bearer !== 'Bearer tok:users/contact.read') return json(403, {});
      if (state.rejectNextUsersToken) {
        state.rejectNextUsersToken = false;
        return json(401, {});
      }
      const replaced = override(state.users, init?.signal);
      if (replaced) return replaced;
      const userId = /^\/users\/([^/]+)\/contact$/.exec(url.pathname)?.[1] ?? '';
      const contact = state.contacts.get(userId);
      return contact ? json(200, contact) : json(404, {});
    }
    if (url.origin === DISPUTES_URL) {
      if (bearer !== 'Bearer tok:disputes/read') return json(403, {});
      const replaced = override(state.disputesReply, init?.signal);
      if (replaced) return replaced;
      const userId = url.searchParams.get('userId');
      const ids = (url.searchParams.get('transactionIds') ?? '').split(',');
      const items = state.disputes
        .filter((d) => d.userId === userId && ids.includes(d.transactionId))
        .map((d) => ({ transactionId: d.transactionId, disputeId: d.disputeId, status: d.status, version: d.version }));
      return json(200, { items });
    }
    return json(404, {});
  };

  return { fetch, state, calls, tokenScopes };
};

export const captureLogger = () => {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', destination: { write: (line: string) => void lines.push(line) } });
  return { log, lines };
};

export const setup = (env: Readonly<Record<string, string>> = {}) => {
  const upstream = fakeUpstream();
  const { log, lines } = captureLogger();
  const handler = createLambdaHandler({
    env: { ...BASE_ENV, ...env },
    fetch: upstream.fetch,
    nowMs: () => 1_700_000_000_000,
    log,
    deadlineMs: 300,
  });
  return { handler, upstream, lines };
};
