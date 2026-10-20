import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASE_ENV,
  DISPUTE_A,
  EMAIL_A,
  NAME_A,
  TXN_A,
  USER_A,
  USER_B,
  rejectedEvent,
  setup,
  sqsEvent,
  statusEvent,
  storedEvent,
  type UpstreamState,
} from './support.ts';

const ses = mockClient(SESv2Client);
const secrets = mockClient(SecretsManagerClient);

const sesError = (name: string, message: string) => Object.assign(new Error(message), { name });

const sent = () => ses.commandCalls(SendEmailCommand).map((c) => c.args[0].input);

const body = (value: unknown) => JSON.stringify(value);

beforeEach(() => {
  ses.reset();
  secrets.reset();
  ses.on(SendEmailCommand).resolves({ MessageId: 'ses-1' });
});

afterEach(() => {
  ses.reset();
  secrets.reset();
});

describe('batch semantics', () => {
  it('a batch of ok / poison / ok reports exactly the poison messageId', async () => {
    const { handler } = setup();
    const res = await handler(
      sqsEvent([
        ['m-ok-1', body(statusEvent('DisputeStatusChanged', 'UNDER_REVIEW', 3))],
        ['m-poison', '{"eventType":"DisputeCreated"'],
        ['m-ok-2', body(storedEvent(3))],
      ]),
    );
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm-poison' }] });
    expect(sent()).toHaveLength(2);
  });

  it('a duplicate delivery sends again (accepted, ADR-023)', async () => {
    const { handler } = setup();
    const raw = body(statusEvent('DisputeStatusChanged', 'UNDER_REVIEW', 3));
    const res = await handler(sqsEvent([['m-1', raw], ['m-1-again', raw]]));
    expect(res.batchItemFailures).toEqual([]);
    expect(sent()).toHaveLength(2);
  });
});

describe('message validation', () => {
  it.each([
    ['garbage', 'not json at all'],
    ['a bad schema (no version)', body({ ...storedEvent(), version: undefined })],
    ['an extra email key', body({ ...storedEvent(), email: 'attacker@example.com' })],
    ['an extra to key', body({ ...storedEvent(), to: 'attacker@example.com' })],
    ['an email inside data', body({ ...storedEvent(), data: { evidence: { evidenceId: DISPUTE_A }, email: 'a@b.co' } })],
  ])('%s is a failure with no lookup and no email', async (_, raw) => {
    const { handler, upstream } = setup();
    const res = await handler(sqsEvent([['m-1', raw]]));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm-1' }]);
    expect(upstream.calls).toEqual([]);
    expect(sent()).toEqual([]);
  });
});

describe('recipient', () => {
  it('comes only from users/{event.userId}/contact: SES To is that email, From is SES_SENDER', async () => {
    const { handler, upstream } = setup();
    const event = statusEvent('DisputeStatusChanged', 'RESOLVED_ACCEPTED', 3);
    await handler(sqsEvent([['m-1', body(event)]]));
    expect(sent()).toEqual([
      expect.objectContaining({
        FromEmailAddress: BASE_ENV.SES_SENDER,
        Destination: { ToAddresses: [EMAIL_A] },
      }),
    ]);
    const paths = upstream.calls.map((c) => `${c.url.pathname}${c.url.search}`);
    expect(paths).toEqual([
      `/disputes?userId=${USER_A}&transactionIds=${TXN_A}`,
      `/users/${USER_A}/contact`,
    ]);
    expect(sent()[0]?.Content?.Simple?.Body?.Text?.Data).toContain(`Hi ${NAME_A},`);
  });

  it.each([
    ['contact 404', { contacts: new Map() }],
    ['contact 5xx', { users: 503 }],
    ['contact timeout', { users: 'hang' }],
    ['a contact for another user', { contacts: new Map([[USER_A, { userId: USER_B, email: 'b@example.com', name: 'B' }]]) }],
    ['an unparseable contact', { contacts: new Map([[USER_A, { userId: USER_A, email: 'not-an-email', name: NAME_A }]]) }],
  ] satisfies ReadonlyArray<[string, Partial<UpstreamState>]>)('%s is a failure and sends nothing', async (_, state) => {
    const s = setup();
    Object.assign(s.upstream.state, state);
    const res = await s.handler(sqsEvent([['m-1', body(storedEvent(3))]]));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm-1' }]);
    expect(sent()).toEqual([]);
  });
});

describe('staleness via the disputes lookup', () => {
  it.each([
    ['DisputeCreated', statusEvent('DisputeCreated', 'SUBMITTED', 1)],
    ['DisputeEdited', statusEvent('DisputeEdited', 'SUBMITTED', 2)],
    ['DisputeStatusChanged', statusEvent('DisputeStatusChanged', 'UNDER_REVIEW', 2)],
  ])('a stale %s is skipped as a success, with no contact lookup or email', async (_, event) => {
    const { handler, upstream } = setup();
    const res = await handler(sqsEvent([['m-1', body(event)]]));
    expect(res.batchItemFailures).toEqual([]);
    expect(upstream.calls.map((c) => c.url.pathname)).toEqual(['/disputes']);
    expect(sent()).toEqual([]);
  });

  it('an evidence event older than the current version still sends', async () => {
    const { handler } = setup();
    const res = await handler(sqsEvent([['m-1', body(rejectedEvent('SCAN_FAILED', 1))]]));
    expect(res.batchItemFailures).toEqual([]);
    expect(sent()[0]?.Content?.Simple?.Body?.Text?.Data).toContain('we could not finish checking it for viruses');
  });

  it.each([
    [
      'the dispute is absent for that user',
      { disputes: [{ userId: USER_B, transactionId: TXN_A, disputeId: DISPUTE_A, status: 'SUBMITTED', version: 3 }] },
    ],
    ['the lookup answers 5xx', { disputesReply: 500 }],
    ['the lookup times out', { disputesReply: 'hang' }],
    ['the lookup answers an unparseable body', { disputesReply: { status: 200, body: { items: [{}] } } }],
  ] satisfies ReadonlyArray<[string, Partial<UpstreamState>]>)('%s: failure, no contact lookup and no email', async (_, state) => {
    const s = setup();
    Object.assign(s.upstream.state, state);
    const res = await s.handler(sqsEvent([['m-1', body(storedEvent(3))]]));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm-1' }]);
    expect(s.upstream.calls.some((c) => c.url.pathname.startsWith('/users'))).toBe(false);
    expect(sent()).toEqual([]);
  });
});

describe('service tokens', () => {
  it('uses one svc-notifier token per scope, each only on its own callee', async () => {
    const { handler, upstream } = setup();
    await handler(sqsEvent([['m-1', body(storedEvent(3))], ['m-2', body(storedEvent(3))]]));
    expect(upstream.tokenScopes.sort()).toEqual(['disputes/read', 'users/contact.read']);
    for (const call of upstream.calls) {
      const scope = call.url.pathname.startsWith('/users') ? 'users/contact.read' : 'disputes/read';
      expect(call.authorization).toMatch(new RegExp(`^Bearer tok:${scope}:`));
    }
  });

  it('a 401 from users refreshes the token once and the email still goes out', async () => {
    const s = setup();
    s.upstream.state.rejectNextUsersToken = true;
    const res = await s.handler(sqsEvent([['m-1', body(storedEvent(3))]]));
    expect(res.batchItemFailures).toEqual([]);
    expect(s.upstream.tokenScopes.filter((t) => t === 'users/contact.read')).toHaveLength(2);
    expect(sent()).toHaveLength(1);
  });
});

describe('SES', () => {
  it.each([
    ['MessageRejected', sesError('MessageRejected', `Email address is not verified: ${EMAIL_A}`)],
    ['throttling', sesError('TooManyRequestsException', 'Too many requests')],
    ['an outage', sesError('InternalServiceErrorException', 'boom')],
  ])('%s is a failure', async (_, error) => {
    ses.on(SendEmailCommand).rejects(error);
    const { handler } = setup();
    const res = await handler(sqsEvent([['m-1', body(storedEvent(3))]]));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm-1' }]);
  });

  it('honours SES_ENDPOINT', async () => {
    const { handler } = setup({ SES_ENDPOINT: 'http://127.0.0.1:55901' });
    await handler(sqsEvent([['m-1', body(storedEvent(3))]]));
    const endpoint = await ses.call(0).thisValue.config.endpoint?.();
    expect(endpoint?.hostname).toBe('127.0.0.1');
    expect(endpoint?.port).toBe(55901);
  });
});

describe('initialisation', () => {
  it('a secret that cannot be read returns the whole batch, and the next batch retries', async () => {
    secrets
      .on(GetSecretValueCommand)
      .rejectsOnce(sesError('InternalServiceError', 'unavailable'))
      .resolves({ SecretString: 'from-secrets-manager' });
    const { handler } = setup({ SERVICE_CLIENT_SECRET: '', SERVICE_CLIENT_SECRET_ARN: 'arn:aws:secretsmanager:af-south-1:1:secret:n' });
    const batch = sqsEvent([['m-1', body(storedEvent(3))], ['m-2', body(storedEvent(3))]]);

    expect((await handler(batch)).batchItemFailures).toEqual([{ itemIdentifier: 'm-1' }, { itemIdentifier: 'm-2' }]);
    expect(sent()).toEqual([]);
    expect((await handler(batch)).batchItemFailures).toEqual([]);
    expect(sent()).toHaveLength(2);
  });
});

describe('logs', () => {
  it('never contain the recipient email or name, even when SES echoes the address', async () => {
    ses
      .on(SendEmailCommand)
      .resolvesOnce({ MessageId: 'ses-1' })
      .rejects(sesError('MessageRejected', `Email address is not verified. The following identities failed the check: ${EMAIL_A}`));
    const { handler, lines } = setup();
    const res = await handler(
      sqsEvent([['m-ok', body(storedEvent(3))], ['m-rejected', body(storedEvent(3))], ['m-bad', body({ email: EMAIL_A, name: NAME_A })]]),
    );
    expect(res.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(['m-rejected', 'm-bad']);
    const output = lines.join('');
    expect(output).toContain('m-rejected');
    expect(output).not.toContain(EMAIL_A);
    expect(output).not.toContain(NAME_A);
  });
});
