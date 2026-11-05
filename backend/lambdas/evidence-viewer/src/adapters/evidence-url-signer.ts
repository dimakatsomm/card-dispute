import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PresignRequest } from '../use-cases/mint-evidence-url.ts';

export type EvidenceUrlSignerDeps = {
  readonly s3: S3Client;
  readonly bucket: string;
};

export const createEvidenceUrlSigner =
  ({ s3, bucket }: EvidenceUrlSignerDeps) =>
  (request: PresignRequest): Promise<string> =>
    getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: request.key,
        ResponseContentDisposition: request.contentDisposition,
        ResponseContentType: request.contentType,
        ResponseCacheControl: 'no-store',
      }),
      { expiresIn: request.expiresInSeconds, signingDate: request.signedAt },
    );
