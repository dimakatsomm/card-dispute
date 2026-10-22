import http from 'node:http';
import https from 'node:https';

export type RawReply = {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
};

// fetch() normalises or refuses some headers (Origin, Content-Length); the S3 negative tests need them exactly as given.
export const rawRequest = (
  method: string,
  url: string,
  headers: Readonly<Record<string, string>>,
  body?: Uint8Array,
): Promise<RawReply> =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'http:' ? http : https;
    const req = transport.request(target, { method, headers, timeout: 30_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('timeout', () => req.destroy(new Error(`${method} timed out`)));
    req.on('error', reject);
    req.end(body);
  });

export const asHttp = (url: string): string => {
  const target = new URL(url);
  target.protocol = 'http:';
  return target.toString();
};
