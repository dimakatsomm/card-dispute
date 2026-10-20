import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UPLOAD_URL_TTL_SECONDS } from '@cd/dispute-domain';
import { err, ok } from '@cd/shared/fp';
import type { FastifyBaseLogger } from 'fastify';
import { quarantineObjectKey } from '../core/dispute.ts';
import type { EvidenceRecord, UploadInstruction } from '../core/types.ts';
import type { SignUploads, UploadTarget } from '../use-cases/ports.ts';
import { summarizeError } from './deadline.ts';

export type UploadSignerOptions = {
  readonly region: string;
  readonly bucket: string;
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
  readonly now: () => Date;
};

// S3 wants base64 of the raw 32-byte digest; the API and DB carry lowercase hex (docs/03 D-04).
const hexToBase64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64');

export type PresignUploads = (
  target: UploadTarget,
  evidence: ReadonlyArray<EvidenceRecord>,
) => Promise<ReadonlyArray<UploadInstruction>>;

export const createUploadSigner = (options: UploadSignerOptions): PresignUploads => {
  const client = new S3Client({
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
  });

  const signOne = async (
    target: UploadTarget,
    evidence: EvidenceRecord,
    signedAt: Date,
  ): Promise<UploadInstruction> => {
    const checksum = hexToBase64(evidence.sha256);
    const command = new PutObjectCommand({
      Bucket: options.bucket,
      Key: quarantineObjectKey(target.transactionId, evidence.evidenceId),
      ContentType: evidence.contentType,
      ContentLength: evidence.sizeBytes,
      ChecksumSHA256: checksum,
    });
    // Unhoisted, the checksum would become a query parameter the client need not send (verify-claims-02 #1).
    const url = await getSignedUrl(client, command, {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      signingDate: signedAt,
      unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      evidenceId: evidence.evidenceId,
      method: 'PUT',
      url,
      headers: {
        'Content-Type': evidence.contentType,
        'Content-Length': String(evidence.sizeBytes),
        'x-amz-checksum-sha256': checksum,
      },
      expiresAt: new Date(signedAt.getTime() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    };
  };

  return async (target, evidence) => {
    const signedAt = options.now();
    return Promise.all(evidence.map((e) => signOne(target, e, signedAt)));
  };
};

export const guardSigner =
  (presign: PresignUploads, log: FastifyBaseLogger): SignUploads =>
  async (target, evidence) => {
    try {
      return ok(await presign(target, evidence));
    } catch (error) {
      log.error({ disputeId: target.disputeId, error: summarizeError(error) }, 'upload signing failed');
      return err('UPLOAD_SIGNING_UNAVAILABLE');
    }
  };
