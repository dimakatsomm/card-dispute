import { appendFileSync, readFileSync } from 'node:fs';
import { env } from './env.ts';

// Responses are untrusted JSON; tests assert on the shape instead of re-declaring every body type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export type Reply<T = Json> = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
};

const parse = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

export const api = async <T = Json>(
  method: string,
  path: string,
  options: {
    readonly token?: string;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  } = {},
): Promise<Reply<T>> => {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${env().webOrigin}/api${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, headers: res.headers, body: (await parse(res)) as T };
};

export type Txn = {
  readonly transactionId: string;
  readonly accountId: string;
  readonly cardId: string;
  readonly status: string;
  readonly dispute: { readonly disputeId: string; readonly status: string } | null;
  readonly disputable: { readonly allowed: boolean; readonly reason?: string };
};

export const listTransactions = async (
  token: string,
  query: Record<string, string> = {},
): Promise<readonly Txn[]> => {
  const items: Txn[] = [];
  let cursor: string | null = null;
  do {
    const params: URLSearchParams = new URLSearchParams({
      limit: '100',
      ...query,
      ...(cursor !== null ? { cursor } : {}),
    });
    const page: Reply<{ items: Txn[]; nextCursor: string | null }> = await api(
      'GET',
      `/transactions?${params}`,
      { token },
    );
    if (page.status !== 200) throw new Error(`GET /transactions returned ${page.status}`);
    items.push(...page.body.items);
    cursor = page.body.nextCursor;
  } while (cursor !== null);
  return items;
};

const MAX_TRANSACTIONS_PER_RUN = 3;

// Test files run in separate workers, so the per-run count lives in a ledger file created by global-setup.
const claimSlot = (): void => {
  const ledger = process.env['E2E_AWS_LEDGER'];
  if (ledger === undefined) throw new Error('e2e-aws: transaction ledger missing (global-setup did not run)');
  appendFileSync(ledger, 'x\n');
  if (readFileSync(ledger, 'utf8').length / 2 > MAX_TRANSACTIONS_PER_RUN)
    throw new Error('e2e-aws: transaction budget for this run is spent');
};

// Disputes are permanent (one per transaction, ever), so every run consumes rows; pick them dynamically and cap the count.
export const claimDisputable = async (token: string): Promise<Txn> => {
  claimSlot();
  const me = (await api('GET', '/me', { token })).body;
  const cards: Json[] = me['accounts'].flatMap((account: Json) => account['cards']);
  const live = cards.filter((card) => card['expired'] === false && card['status'] === 'ACTIVE');
  for (const card of live) {
    const row = (await listTransactions(token, { cardId: card['cardId'] })).find(
      (item) => item.disputable.allowed,
    );
    if (row !== undefined) return row;
  }
  throw new Error('no disputable transaction left for user A on a live card; rerun dev-seed');
};
