import type { EvidenceViewResponse } from '@cd/dispute-domain';
import type { Result } from '@cd/shared/fp';
import type { MintError } from './use-cases/mint-evidence-url.ts';

export type HandlerLog = { readonly error: (obj: object, msg: string) => void };

const summarize = (error: unknown) =>
  error instanceof Error ? { type: error.name, message: error.message } : { type: 'UnknownError' };

// Every failure throws so the synchronous invoke returns a function error and disputes answers 503.
export const createHandler =
  (mint: (event: unknown) => Promise<Result<EvidenceViewResponse, MintError>>, log: HandlerLog) =>
  async (event: unknown): Promise<EvidenceViewResponse> => {
    const result = await mint(event).catch((error: unknown) => {
      log.error({ error: summarize(error) }, 'evidence url fault');
      throw error;
    });
    if (result.ok) return result.value;
    log.error(result.error, 'evidence url refused');
    throw new Error(`evidence url refused: ${result.error.kind}`);
  };
