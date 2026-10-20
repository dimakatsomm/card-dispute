import { randomUUID } from 'node:crypto';
import type { Fetch } from '@cd/auth-client';

export const URLS = {
  token: 'http://token.test/oauth2/token',
  auth: 'http://auth.test',
  transactions: 'http://transactions.test:8081',
  users: 'http://users.test:8081',
} as const;

export const USER_A = { token: 'hdr.user-a-token.signature', userId: randomUUID() };
export const USER_B = { token: 'hdr.user-b-token.signature', userId: randomUUID() };
export const SERVICE_CALLER = { token: 'hdr.service-caller-token.signature', scopes: ['disputes/read'] };
export const WRONG_SCOPE_CALLER = {
  token: 'hdr.wrong-scope-caller-token.signature',
  scopes: ['disputes/review'],
};
export const INTAKE_CALLER = {
  token: 'hdr.intake-caller-token.signature',
  scopes: ['disputes/evidence.write'],
};

const SERVICE_CALLERS: ReadonlyArray<{
  readonly token: string;
  readonly clientId: string;
  readonly scopes: ReadonlyArray<string>;
}> = [
  { ...SERVICE_CALLER, clientId: 'svc-transactions' },
  { ...WRONG_SCOPE_CALLER, clientId: 'svc-transactions' },
  { ...INTAKE_CALLER, clientId: 'svc-evidence-intake' },
];

export type FakeTransaction = {
  readonly transactionId: string;
  readonly accountId: string;
  readonly cardId: string;
  readonly amount: string;
  readonly currency: string;
  readonly merchantName: string;
  readonly mcc: string | null;
  readonly type: 'PURCHASE' | 'REFUND' | 'ATM_WITHDRAWAL' | 'FEE';
  readonly status: 'PENDING' | 'POSTED' | 'DECLINED' | 'REVERSED';
  readonly transactionAt: string;
  readonly postedAt: string | null;
};

export type FakeCard = {
  readonly cardId: string;
  readonly accountId: string;
  readonly userId: string;
  readonly brand: 'VISA';
  readonly cardType: 'DEBIT';
  readonly last4: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly expired: boolean;
  readonly status: 'ACTIVE' | 'BLOCKED' | 'CANCELLED';
};

export type RecordedCall = {
  readonly url: URL;
  readonly authorization: string | null;
  readonly body: string;
};

const DAY_MS = 86_400_000;

export const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Stands in for Cognito, auth /validate, transactions :8081 and users :8081; each downstream asserts its own scope.
export const createFakeUpstreams = () => {
  const transactions = new Map<string, { readonly userId: string; readonly txn: FakeTransaction }>();
  const cards = new Map<string, FakeCard>();
  const calls: RecordedCall[] = [];
  const extraUsers = new Map<string, string>();

  const addUser = (): { readonly token: string; readonly userId: string } => {
    const userId = randomUUID();
    const token = `hdr.user-${userId}.signature`;
    extraUsers.set(token, userId);
    return { token, userId };
  };

  const addTransaction = (
    userId: string,
    overrides: Partial<FakeTransaction> = {},
    cardOverrides: Partial<FakeCard> = {},
  ): FakeTransaction => {
    const card: FakeCard = {
      cardId: randomUUID(),
      accountId: randomUUID(),
      userId,
      brand: 'VISA',
      cardType: 'DEBIT',
      last4: '4821',
      expiryMonth: 12,
      expiryYear: new Date().getUTCFullYear() + 3,
      expired: false,
      status: 'ACTIVE',
      ...cardOverrides,
    };
    cards.set(card.cardId, card);
    const txn: FakeTransaction = {
      transactionId: randomUUID(),
      accountId: card.accountId,
      cardId: card.cardId,
      amount: '125.50',
      currency: 'ZAR',
      merchantName: 'Corner Cafe',
      mcc: '5814',
      type: 'PURCHASE',
      status: 'POSTED',
      transactionAt: daysAgo(6),
      postedAt: daysAgo(5),
      ...overrides,
    };
    transactions.set(txn.transactionId, { userId, txn });
    return txn;
  };

  const validate = (token: string): unknown => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    if (token === USER_A.token || token === USER_B.token) {
      const user = token === USER_A.token ? USER_A : USER_B;
      return {
        valid: true,
        principalType: 'user',
        authId: `a0a0a0a0${user.userId.slice(8)}`,
        userId: user.userId,
        scopes: [],
        exp,
      };
    }
    const extraUserId = extraUsers.get(token);
    if (extraUserId !== undefined) {
      return {
        valid: true,
        principalType: 'user',
        authId: `a0a0a0a0${extraUserId.slice(8)}`,
        userId: extraUserId,
        scopes: [],
        exp,
      };
    }
    const caller = SERVICE_CALLERS.find((c) => c.token === token);
    if (caller !== undefined) {
      return { valid: true, principalType: 'service', clientId: caller.clientId, scopes: caller.scopes, exp };
    }
    return { valid: false, principalType: 'none', reason: 'bad_signature' };
  };

  const fetch: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get('authorization');
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, authorization, body });

    if (url.href === URLS.token) {
      const scope = new URLSearchParams(body).get('scope') ?? '';
      return json(200, { access_token: `svc:${scope}`, expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.href === `${URLS.auth}/validate`) {
      if (authorization !== 'Bearer svc:auth/validate') return json(403, {});
      return json(200, validate((JSON.parse(body) as { token: string }).token));
    }
    if (url.origin === URLS.transactions && url.pathname === '/transactions') {
      if (authorization !== 'Bearer svc:transactions/read') return json(403, {});
      const userId = url.searchParams.get('userId');
      const ids = (url.searchParams.get('transactionIds') ?? '').split(',');
      if (ids.length > 100) return json(400, {});
      const accountId = url.searchParams.get('accountId');
      const cardId = url.searchParams.get('cardId');
      const items = ids.flatMap((id) => {
        const row = transactions.get(id);
        return row &&
          row.userId === userId &&
          (accountId === null || row.txn.accountId === accountId) &&
          (cardId === null || row.txn.cardId === cardId)
          ? [row.txn]
          : [];
      });
      return json(200, { items });
    }
    if (url.origin === URLS.users && url.pathname === '/cards') {
      if (authorization !== 'Bearer svc:users/cards.read') return json(403, {});
      const userId = url.searchParams.get('userId');
      const cardId = url.searchParams.get('cardId');
      const found = [...cards.values()].filter(
        (c) => c.userId === userId && (cardId === null || c.cardId === cardId),
      );
      return json(200, { cards: found });
    }
    return json(404, {});
  };

  const cardOf = (cardId: string): FakeCard | undefined => cards.get(cardId);

  return { fetch, calls, addTransaction, addUser, cardOf };
};

// Never answers; settles only when the caller's own timeout aborts it.
export const hang: Fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });

export type FakeUpstreams = ReturnType<typeof createFakeUpstreams>;
