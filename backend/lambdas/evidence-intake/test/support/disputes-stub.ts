import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export type StubRequest = {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
};

export type StubReply = { readonly status: number; readonly body?: unknown; readonly delayMs?: number };

export type DisputesStub = {
  readonly url: string;
  readonly tokenUrl: string;
  readonly puts: () => ReadonlyArray<StubRequest>;
  readonly tokenRequests: () => ReadonlyArray<StubRequest>;
  readonly reply: (fn: (req: StubRequest, call: number) => StubReply) => void;
  readonly close: () => Promise<void>;
};

export const DISPUTE_ID = '0199f000-0000-7000-8000-00000000abcd';

const evidenceIdOf = (path: string): string => path.split('/').at(-1) ?? '';

// Mirrors disputes' answer: the reported result is recorded as-is and STORED gets the evidence-bucket key.
export const recordAsReported = (req: StubRequest): StubReply => {
  const evidenceId = evidenceIdOf(req.path);
  const result = (req.body as { readonly result?: string }).result;
  return result === 'STORED'
    ? { status: 200, body: { evidenceId, status: 'STORED', s3Key: `evidence/${DISPUTE_ID}/${evidenceId}` } }
    : { status: 200, body: { evidenceId, status: 'REJECTED' } };
};

export const startDisputesStub = async (): Promise<DisputesStub> => {
  const puts: StubRequest[] = [];
  const tokens: StubRequest[] = [];
  let answer: (req: StubRequest, call: number) => StubReply = recordAsReported;
  let tokenCount = 0;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const path = req.url ?? '';
      const send = ({ status, body }: StubReply) => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(body === undefined ? '' : JSON.stringify(body));
      };
      if (req.method === 'POST' && path === '/oauth2/token') {
        tokens.push({ method: 'POST', path, headers: req.headers, body: text });
        tokenCount += 1;
        send({ status: 200, body: { access_token: `token-${tokenCount}`, expires_in: 3600 } });
        return;
      }
      const recorded: StubRequest = { method: req.method ?? '', path, headers: req.headers, body: text ? JSON.parse(text) : undefined };
      puts.push(recorded);
      const reply = answer(recorded, puts.length);
      if (reply.delayMs) setTimeout(() => res.destroyed || send(reply), reply.delayMs);
      else send(reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    url: base,
    tokenUrl: `${base}/oauth2/token`,
    puts: () => [...puts],
    tokenRequests: () => [...tokens],
    reply: (fn) => {
      answer = fn;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
