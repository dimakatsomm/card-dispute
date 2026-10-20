import { EVIDENCE_SNIFF_BYTES, detectEvidenceType } from '@cd/dispute-domain';
import { err, ok, type Result } from '@cd/shared/fp';
import { resolveCorrelationId } from '@cd/shared/correlation';
import { decide, type EvidenceResult, type ObservedFacts } from '../core/decide.ts';
import { parseTrigger, normalizeETag, type Trigger, type TriggerError } from '../core/trigger.ts';

export type HeadResult =
  | {
      readonly kind: 'found';
      readonly sizeBytes: number;
      readonly sha256Hex: string | null;
      readonly contentType: string | null;
      readonly eTag: string | null;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'denied' };

export type SniffResult =
  | { readonly kind: 'bytes'; readonly head: Uint8Array }
  | { readonly kind: 'missing' }
  | { readonly kind: 'denied' };

export type QuarantineStore = {
  readonly head: (key: string) => Promise<HeadResult>;
  readonly sniff: (key: string, bytes: number, eTag: string | null) => Promise<SniffResult>;
  readonly promote: (
    key: string,
    target: { readonly s3Key: string; readonly eTag: string | null; readonly contentType: string },
  ) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
};

export type EvidenceRef = { readonly transactionId: string; readonly evidenceId: string };

export type RecordOutcome =
  | { readonly kind: 'recorded'; readonly status: 'STORED'; readonly s3Key: string }
  | { readonly kind: 'recorded'; readonly status: 'REJECTED' }
  | { readonly kind: 'closed' };

export type DisputesError =
  | 'UNAVAILABLE'
  | 'NOT_FOUND'
  | 'REFUSED'
  | 'BAD_RESPONSE'
  | 'RESULT_CONFLICT'
  | 'UNKNOWN_CONFLICT';

export type IntakeLog = {
  readonly info: (obj: object, msg: string) => void;
  readonly warn: (obj: object, msg: string) => void;
  readonly error: (obj: object, msg: string) => void;
};

export type IntakeDeps = {
  readonly quarantineBucket: string;
  readonly requireScan: boolean;
  readonly quarantine: QuarantineStore;
  readonly recordResult: (
    ref: EvidenceRef,
    result: EvidenceResult,
    correlationId: string,
  ) => Promise<Result<RecordOutcome, DisputesError>>;
  readonly notScanned: () => void;
  readonly resultConflict: () => void;
  readonly newId: () => string;
  readonly log: IntakeLog;
};

export type IntakeOutcome = 'PROMOTED' | 'REJECTED' | 'CLOSED' | 'ALREADY_PROCESSED' | 'SUPERSEDED';

export type IntakeError = TriggerError | `DISPUTES_${DisputesError}` | 'INCONSISTENT_RESPONSE';

type Assessment =
  | { readonly kind: 'skip'; readonly outcome: 'ALREADY_PROCESSED' | 'SUPERSEDED' }
  | { readonly kind: 'result'; readonly result: EvidenceResult; readonly eTag: string | null };

const observe = async (
  deps: IntakeDeps,
  trigger: Trigger,
  head: Extract<HeadResult, { kind: 'found' }>,
): Promise<ObservedFacts | 'UNOBSERVABLE' | 'MISSING'> => {
  const facts = { sizeBytes: head.sizeBytes, sha256Hex: head.sha256Hex, contentType: head.contentType };
  // S3 answers 416 to a range on an empty object.
  if (head.sizeBytes === 0) return { ...facts, detectedType: null };
  const sniffed = await deps.quarantine.sniff(trigger.key, EVIDENCE_SNIFF_BYTES, head.eTag);
  if (sniffed.kind === 'missing') return 'MISSING';
  if (sniffed.kind === 'denied') return 'UNOBSERVABLE';
  return { ...facts, detectedType: detectEvidenceType(sniffed.head) };
};

const assess = async (deps: IntakeDeps, trigger: Trigger): Promise<Assessment> => {
  const { verdict } = trigger;
  if (verdict === 'MALWARE' || verdict === 'SCAN_FAILED') {
    return { kind: 'result', result: decide({ verdict }), eTag: null };
  }
  const head = await deps.quarantine.head(trigger.key);
  if (head.kind === 'missing') return { kind: 'skip', outcome: 'ALREADY_PROCESSED' };
  if (head.kind === 'denied') return { kind: 'result', result: decide({ verdict, facts: 'UNOBSERVABLE' }), eTag: null };
  // Without an ETag the scanned bytes cannot be matched to the stored ones.
  if (verdict === 'CLEAN' && !head.eTag) {
    return { kind: 'result', result: decide({ verdict, facts: 'UNOBSERVABLE' }), eTag: null };
  }
  // A re-upload replaced the scanned object; its own scan event will settle it.
  if (trigger.eTag && head.eTag && normalizeETag(head.eTag) !== trigger.eTag) {
    return { kind: 'skip', outcome: 'SUPERSEDED' };
  }
  const facts = await observe(deps, trigger, head);
  if (facts === 'MISSING') return { kind: 'skip', outcome: 'ALREADY_PROCESSED' };
  return { kind: 'result', result: decide({ verdict, facts }), eTag: head.eTag };
};

export const processEvidence =
  (deps: IntakeDeps) =>
  async (event: unknown): Promise<Result<IntakeOutcome, IntakeError>> => {
    const parsed = parseTrigger(event, { quarantineBucket: deps.quarantineBucket, requireScan: deps.requireScan });
    if (!parsed.ok) return parsed;
    const trigger = parsed.value;
    const ref: EvidenceRef = { transactionId: trigger.transactionId, evidenceId: trigger.evidenceId };
    const correlationId = resolveCorrelationId(trigger.eventId, deps.newId);
    const context = { correlationId, ...ref };

    if (trigger.verdict === 'NOT_SCANNED') {
      deps.notScanned();
      deps.log.warn(context, 'evidence accepted without a malware scan (EVIDENCE_REQUIRE_SCAN=false)');
    }

    const assessment = await assess(deps, trigger);
    if (assessment.kind === 'skip') {
      deps.log.info({ ...context, outcome: assessment.outcome }, 'evidence intake skipped');
      return ok(assessment.outcome);
    }

    const { result } = assessment;
    const recorded = await deps.recordResult(ref, result, correlationId);
    if (!recorded.ok) {
      if (recorded.error === 'RESULT_CONFLICT') {
        deps.resultConflict();
        deps.log.error({ ...context, claimed: result.result }, 'evidence result conflicts with the settled result; object kept');
      }
      return err(`DISPUTES_${recorded.error}` as const);
    }
    const outcome = recorded.value;

    if (outcome.kind === 'recorded' && outcome.status === 'STORED') {
      if (result.result !== 'STORED') return err('INCONSISTENT_RESPONSE');
      await deps.quarantine.promote(trigger.key, {
        s3Key: outcome.s3Key,
        eTag: assessment.eTag,
        contentType: result.contentType,
      });
    }
    await deps.quarantine.remove(trigger.key);

    const final: IntakeOutcome =
      outcome.kind === 'closed' ? 'CLOSED' : outcome.status === 'STORED' ? 'PROMOTED' : 'REJECTED';
    const reason = result.result === 'REJECTED' ? result.reason : undefined;
    const summary = { ...context, outcome: final, claimed: result.result, reason };
    if (final === 'CLOSED') deps.log.warn(summary, 'evidence slot expired or erased; quarantine copy deleted');
    else deps.log.info(summary, 'evidence intake done');
    return ok(final);
  };
