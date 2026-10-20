import type { Result } from '@cd/shared/fp';
import type { IntakeError, IntakeOutcome } from './use-cases/process-evidence.ts';

export type HandlerLog = { readonly error: (obj: object, msg: string) => void };

const summarize = (error: unknown) =>
  error instanceof Error ? { type: error.name, message: error.message } : { type: 'UnknownError' };

// Every failure throws so EventBridge's async invoke retries twice and then parks the event in the DLQ.
export const createHandler =
  (processEvidence: (event: unknown) => Promise<Result<IntakeOutcome, IntakeError>>, log: HandlerLog) =>
  async (event: unknown): Promise<{ readonly outcome: IntakeOutcome }> => {
    const result = await processEvidence(event).catch((error: unknown) => {
      log.error({ error: summarize(error) }, 'evidence intake fault');
      throw error;
    });
    if (result.ok) return { outcome: result.value };
    log.error({ code: result.error }, 'evidence intake failed');
    throw new Error(`evidence intake failed: ${result.error}`);
  };
