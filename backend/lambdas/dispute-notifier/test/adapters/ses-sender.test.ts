import { describe, expect, it } from 'vitest';
import { classifySesError } from '../../src/adapters/ses-sender.ts';
import type { SendFailure } from '../../src/use-cases/ports.ts';

describe('classifySesError', () => {
  it.each<[string, SendFailure['kind']]>([
    ['MessageRejected', 'undeliverable'],
    ['BadRequestException', 'undeliverable'],
    ['AccessDeniedException', 'rejected'],
    ['MailFromDomainNotVerifiedException', 'rejected'],
    ['AccountSuspendedException', 'rejected'],
    ['SendingPausedException', 'rejected'],
    ['TooManyRequestsException', 'throttled'],
    ['ThrottlingException', 'throttled'],
    ['LimitExceededException', 'throttled'],
    ['InternalServiceErrorException', 'unavailable'],
    ['NotFoundException', 'unavailable'],
    ['TimeoutError', 'unavailable'],
    ['Error', 'unavailable'],
    ['UnknownError', 'unavailable'],
  ])('%s is %s', (name, kind) => {
    expect(classifySesError(name)).toBe(kind);
  });
});
