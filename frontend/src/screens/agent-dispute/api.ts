import type { ApiClient } from '../../api/client';
import type { components } from '../../api/generated/disputes';
import { err, ok, type Result } from '../../app/result';

type Schemas = components['schemas'];
export type AgentDispute = Schemas['AgentDisputeDetail'];
export type AgentTimelineEvent = Schemas['AgentTimelineEvent'];
export type Outcome = Schemas['ResolveDisputeRequest']['outcome'];
export type Expected = Schemas['ReviewDisputeRequest'];

export type LoadError = 'NOT_FOUND' | 'FAILED';
export type ActionError = 'STALE' | 'INVALID_TRANSITION' | 'INVALID_INPUT' | 'NOT_FOUND' | 'FAILED';

export const loadAgentDispute =
  (api: ApiClient) =>
  async (transactionId: string): Promise<Result<AgentDispute, LoadError>> => {
    const { data, response } = await api.GET('/agent/disputes/{transactionId}', {
      params: { path: { transactionId } },
    });
    if (data) return ok(data);
    return err(response.status === 404 ? 'NOT_FOUND' : 'FAILED');
  };

const actionErrorFor = (status: number): ActionError => {
  switch (status) {
    case 412:
      return 'STALE';
    case 409:
      return 'INVALID_TRANSITION';
    case 400:
      return 'INVALID_INPUT';
    case 404:
      return 'NOT_FOUND';
    default:
      return 'FAILED';
  }
};

export const pickUpDispute =
  (api: ApiClient) =>
  async (input: { readonly transactionId: string; readonly expected: Expected }): Promise<
    Result<AgentDispute, ActionError>
  > => {
    const { data, response } = await api.PUT('/agent/disputes/{transactionId}/review', {
      params: { path: { transactionId: input.transactionId } },
      body: input.expected,
    });
    return data ? ok(data) : err(actionErrorFor(response.status));
  };

export const resolveDispute =
  (api: ApiClient) =>
  async (input: {
    readonly transactionId: string;
    readonly expected: Expected;
    readonly outcome: Outcome;
    readonly note: string;
  }): Promise<Result<AgentDispute, ActionError>> => {
    const { data, response } = await api.PUT('/agent/disputes/{transactionId}/resolution', {
      params: { path: { transactionId: input.transactionId } },
      body: { outcome: input.outcome, note: input.note, ...input.expected },
    });
    return data ? ok(data) : err(actionErrorFor(response.status));
  };

export type DownloadError =
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_STORED' }
  | { readonly kind: 'RATE_LIMITED'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'UNAVAILABLE' };

const parseRetryAfter = (value: string | null): number | null => {
  const seconds = value !== null && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return seconds >= 1 && seconds <= 600 ? seconds : null;
};

const downloadErrorFor = (response: Response): DownloadError => {
  switch (response.status) {
    case 404:
      return { kind: 'NOT_FOUND' };
    case 409:
      return { kind: 'NOT_STORED' };
    case 429:
      return { kind: 'RATE_LIMITED', retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')) };
    default:
      return { kind: 'UNAVAILABLE' };
  }
};

// The blank tab shares our origin until it navigates, so a javascript: or data: URL would run as us.
const isNavigableDownloadUrl = (url: string): boolean => {
  const parsed = URL.parse(url);
  if (parsed?.protocol === 'https:') return true;
  return parsed?.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
};

export const getEvidenceDownloadUrl =
  (api: ApiClient) =>
  async (input: { readonly transactionId: string; readonly evidenceId: string }): Promise<Result<string, DownloadError>> => {
    try {
      const { data, response } = await api.GET('/agent/disputes/{transactionId}/evidence/{evidenceId}/download', {
        params: { path: { transactionId: input.transactionId, evidenceId: input.evidenceId } },
      });
      if (!data) return err(downloadErrorFor(response));
      return isNavigableDownloadUrl(data.url) ? ok(data.url) : err({ kind: 'UNAVAILABLE' });
    } catch {
      return err({ kind: 'UNAVAILABLE' });
    }
  };
