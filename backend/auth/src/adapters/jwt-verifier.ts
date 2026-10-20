import { err, ok, type Result } from '@cd/shared/fp';
import { JwtVerifier } from 'aws-jwt-verify';
import {
  JwtExpiredError,
  JwtInvalidIssuerError,
  JwtInvalidSignatureAlgorithmError,
  JwtInvalidSignatureError,
  JwtNotBeforeError,
  JwtParseError,
  JwtWithoutValidKidError,
  KidNotFoundInJwksError,
  WaitPeriodNotYetEndedJwkError,
} from 'aws-jwt-verify/error';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import { z } from 'zod';
import type { SignatureRejection, VerifiedClaims } from '../core/token.ts';

export type JwtVerifierConfig = {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly fetch: typeof globalThis.fetch;
  readonly allowInsecureJwks: boolean;
  readonly jwksTimeoutMs?: number;
};

export type TokenVerifier = {
  readonly verify: (token: string) => Promise<Result<VerifiedClaims, SignatureRejection>>;
};

const MAX_JWKS_BYTES = 64 * 1024;

const optional = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const claimsSchema = z.object({
  token_use: optional(z.string()),
  client_id: optional(z.string()),
  sub: optional(z.string()),
  scope: optional(z.string()),
  exp: optional(z.number().int()),
});

const headerSchema = z.object({ alg: z.literal('RS256') });

const toClaims = (payload: unknown): VerifiedClaims => {
  const c = claimsSchema.parse(payload);
  return { tokenUse: c.token_use, clientId: c.client_id, sub: c.sub, scope: c.scope, exp: c.exp };
};

// Cognito signs with RS256 only; pinning it shuts out alg=none and HS256-with-public-key confusion.
const isRs256 = (token: string): boolean => {
  const encoded = token.split('.')[0] ?? '';
  try {
    return headerSchema.safeParse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).success;
  } catch {
    return false;
  }
};

// Anything else (JWKS unreachable, malformed JWKS) is an infrastructure fault and must not read as an invalid token.
const rejectionOf = (e: unknown): SignatureRejection | undefined => {
  // The contract has no not-yet-valid reason, so a future nbf reports as expired.
  if (e instanceof JwtExpiredError || e instanceof JwtNotBeforeError) return 'expired';
  if (e instanceof JwtInvalidIssuerError) return 'wrong_issuer';
  if (
    e instanceof JwtInvalidSignatureError ||
    e instanceof JwtInvalidSignatureAlgorithmError ||
    e instanceof JwtParseError ||
    e instanceof JwtWithoutValidKidError ||
    e instanceof KidNotFoundInJwksError ||
    e instanceof WaitPeriodNotYetEndedJwkError
  ) {
    return 'bad_signature';
  }
  return undefined;
};

const readBounded = async (res: Response, limit: number): Promise<ArrayBuffer> => {
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error('JWKS response has no body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error('JWKS response too large');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  chunks.reduce((offset, chunk) => {
    body.set(chunk, offset);
    return offset + chunk.byteLength;
  }, 0);
  return body.buffer;
};

export const createJwksFetcher = (
  config: Pick<JwtVerifierConfig, 'fetch' | 'allowInsecureJwks' | 'jwksTimeoutMs'>,
) => ({
  fetch: async (uri: string): Promise<ArrayBuffer> => {
    const { protocol } = new URL(uri);
    if (protocol !== 'https:' && !(protocol === 'http:' && config.allowInsecureJwks)) {
      throw new Error(`JWKS scheme not allowed: ${protocol}`);
    }
    const res = await config.fetch(uri, {
      redirect: 'error',
      signal: AbortSignal.timeout(config.jwksTimeoutMs ?? 3000),
    });
    if (res.status !== 200) throw new Error(`JWKS fetch failed with status ${res.status}`);
    if (!/^application\/(jwk-set\+)?json\b/i.test(res.headers.get('content-type') ?? '')) {
      throw new Error('JWKS response is not JSON');
    }
    if (Number(res.headers.get('content-length') ?? 0) > MAX_JWKS_BYTES)
      throw new Error('JWKS response too large');
    return readBounded(res, MAX_JWKS_BYTES);
  },
});

export const createJwtVerifier = (config: JwtVerifierConfig): TokenVerifier => {
  // Own fetcher: the library's default is https-only (the local issuer is http) and has no size or redirect limits.
  const verifier = JwtVerifier.create(
    { issuer: config.issuer, audience: null, jwksUri: config.jwksUri },
    { jwksCache: new SimpleJwksCache({ fetcher: createJwksFetcher(config) }) },
  );
  return {
    verify: async (token) => {
      if (!isRs256(token)) return err('bad_signature');
      try {
        return ok(toClaims(await verifier.verify(token)));
      } catch (e) {
        const reason = rejectionOf(e);
        if (reason === undefined) throw e;
        return err(reason);
      }
    },
  };
};
