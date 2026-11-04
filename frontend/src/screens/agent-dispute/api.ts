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
