import { createHash } from 'node:crypto';
import { canonicalEvidence } from '../core/evidence-digest.ts';
import type { EvidenceDigest } from '../use-cases/ports.ts';

export const sha256EvidenceDigest: EvidenceDigest = (evidence) =>
  createHash('sha256').update(canonicalEvidence(evidence)).digest('hex');
