import { describe, expect, it } from 'vitest';
import { problemBody } from '../src/problem.ts';

describe('problem helpers', () => {
  it('builds an RFC 9457 body with type, title, status, detail, code and correlationId', () => {
    expect(
      problemBody({ status: 409, title: 'Conflict', code: 'ALREADY_DISPUTED', detail: 'd', correlationId: 'cid-12345' }),
    ).toEqual({
      type: 'urn:cd:problem:ALREADY_DISPUTED',
      title: 'Conflict',
      status: 409,
      detail: 'd',
      code: 'ALREADY_DISPUTED',
      correlationId: 'cid-12345',
    });
  });
});
