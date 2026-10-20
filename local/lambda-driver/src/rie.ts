export type Invocation =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly reason: string };

export type Invoke = (url: string, event: unknown) => Promise<Invocation>;

const isFunctionError = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'errorType' in value;

// The RIE answers 200 for handler errors and timeouts, so failure is read from the body.
export const makeInvoke =
  (timeoutMs: number): Invoke =>
  async (url, event) => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return { ok: false, reason: text.slice(0, 200) };
      }
      return isFunctionError(payload)
        ? { ok: false, reason: JSON.stringify(payload).slice(0, 200) }
        : { ok: true, payload };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };
