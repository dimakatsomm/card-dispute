export const UPSTREAM_DEADLINE_MS = 2000;

export const withDeadline = async <T>(ms: number, work: Promise<T>, onTimeout: () => T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(
      () => {
        resolve(onTimeout());
      },
      Math.max(0, ms),
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

export type ErrorSummary = { readonly type: string; readonly code?: string; readonly message: string };

// Raw SDK errors carry request metadata and inputs; only these fields are safe to log.
export const summarizeError = (error: unknown): ErrorSummary => {
  if (!(error instanceof Error)) return { type: 'UnknownError', message: 'non-error thrown' };
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string'
    ? { type: error.name, code, message: error.message }
    : { type: error.name, message: error.message };
};
