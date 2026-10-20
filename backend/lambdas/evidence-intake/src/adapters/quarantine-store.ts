import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { HeadResult, QuarantineStore, SniffResult } from '../use-cases/process-evidence.ts';

export type QuarantineStoreDeps = {
  readonly s3: Pick<S3Client, 'send'>;
  readonly quarantineBucket: string;
  readonly evidenceBucket: string;
};

const httpStatus = (error: unknown): number | undefined =>
  (error as { readonly $metadata?: { readonly httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;

// A composite (multipart) checksum is not a hash of the whole object, so it cannot vouch for the declared sha256.
export const checksumToHex = (base64: string | undefined): string | null => {
  if (!base64 || base64.includes('-')) return null;
  const bytes = Buffer.from(base64, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === base64 ? bytes.toString('hex') : null;
};

const absentOrDenied = <T>(error: unknown, missing: T, denied: T): T => {
  const status = httpStatus(error);
  if (status === 404) return missing;
  if (status === 403) return denied;
  throw error;
};

export const createQuarantineStore = ({ s3, quarantineBucket, evidenceBucket }: QuarantineStoreDeps): QuarantineStore => ({
  head: async (key) => {
    try {
      const out = await s3.send(new HeadObjectCommand({ Bucket: quarantineBucket, Key: key, ChecksumMode: 'ENABLED' }));
      return {
        kind: 'found',
        sizeBytes: out.ContentLength ?? 0,
        sha256Hex: checksumToHex(out.ChecksumSHA256),
        contentType: out.ContentType ?? null,
        eTag: out.ETag ?? null,
      };
    } catch (error) {
      return absentOrDenied<HeadResult>(error, { kind: 'missing' }, { kind: 'denied' });
    }
  },

  sniff: async (key, bytes, eTag) => {
    try {
      const out = await s3.send(
        new GetObjectCommand({
          Bucket: quarantineBucket,
          Key: key,
          Range: `bytes=0-${bytes - 1}`,
          ...(eTag ? { IfMatch: eTag } : {}),
        }),
      );
      const head = (await out.Body?.transformToByteArray()) ?? new Uint8Array();
      return { kind: 'bytes', head: head.slice(0, bytes) };
    } catch (error) {
      return absentOrDenied<SniffResult>(error, { kind: 'missing' }, { kind: 'denied' });
    }
  },

  // Metadata and tags are replaced, not copied: client metadata may name the file, and tag copy needs extra IAM.
  promote: async (key, { s3Key, eTag, contentType }) => {
    await s3.send(
      new CopyObjectCommand({
        Bucket: evidenceBucket,
        Key: s3Key,
        CopySource: `${quarantineBucket}/${key}`,
        ...(eTag ? { CopySourceIfMatch: eTag } : {}),
        MetadataDirective: 'REPLACE',
        ContentType: contentType,
        TaggingDirective: 'REPLACE',
        ChecksumAlgorithm: 'SHA256',
      }),
    );
  },

  remove: async (key) => {
    await s3.send(new DeleteObjectCommand({ Bucket: quarantineBucket, Key: key }));
  },
});
