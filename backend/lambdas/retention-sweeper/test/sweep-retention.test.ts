import { describe, expect, it } from 'vitest';
import type { RetentionStore } from '../src/use-cases/ports.ts';
import { sweepRetention } from '../src/use-cases/sweep-retention.ts';

describe('sweepRetention', () => {
  it('returns invalid_clock for an invalid date before the role check or any query', async () => {
    const calls: string[] = [];
    const record =
      (name: string) =>
      (): Promise<never> => {
        calls.push(name);
        return Promise.reject(new Error(`${name} must not run`));
      };
    const store: RetentionStore = {
      currentUser: record('currentUser'),
      expirePendingEvidence: record('expirePendingEvidence'),
      findErasureCandidates: record('findErasureCandidates'),
      eraseDispute: record('eraseDispute'),
    };
    const sweep = sweepRetention({
      store,
      batchSize: 10,
      log: { info: () => calls.push('log'), error: () => calls.push('log') },
      metric: (name) => calls.push(name),
    });

    expect(await sweep(new Date(Number.NaN))).toEqual({ ok: false, error: { kind: 'invalid_clock' } });
    expect(calls).toEqual([]);
  });
});
