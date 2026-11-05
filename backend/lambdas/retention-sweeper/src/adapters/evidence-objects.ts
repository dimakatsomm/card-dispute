import { DeleteObjectsCommand, ListObjectVersionsCommand, type S3Client } from '@aws-sdk/client-s3';
import { err, ok, type Result } from '@cd/shared/fp';
import { z } from 'zod';
import type { DeleteFailure, EvidenceObjects } from '../use-cases/ports.ts';

const S3_BATCH_LIMIT = 1000;

const versionEntry = z.object({ Key: z.string(), VersionId: z.string() });
const versionsPage = z.object({
  Versions: z.array(versionEntry).default([]),
  DeleteMarkers: z.array(versionEntry).default([]),
  IsTruncated: z.boolean().default(false),
  NextKeyMarker: z.string().optional(),
  NextVersionIdMarker: z.string().optional(),
});

type Target = z.infer<typeof versionEntry>;
type Marker = { readonly key: string; readonly versionId: string | undefined };

// Already-gone versions count as deleted: a retry after a partial batch must not fail on them.
const MISSING_CODES: ReadonlySet<string> = new Set(['NoSuchKey', 'NoSuchVersion']);

const errorNameOf = (e: unknown): string =>
  typeof e === 'object' && e !== null && 'name' in e && typeof e.name === 'string' ? e.name : 'unknown';

const chunk = <T>(items: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

export type EvidenceObjectsDeps = { readonly s3: Pick<S3Client, 'send'>; readonly bucket: string };

const DISPUTE_PREFIX = /^evidence\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/;

export const createEvidenceObjects = ({ s3, bucket }: EvidenceObjectsDeps): EvidenceObjects => {
  // Listed in full before deleting, so a pagination marker never names a version this run already removed.
  const listAll = async (prefix: string, marker?: Marker): Promise<Result<ReadonlyArray<Target>, DeleteFailure>> => {
    const parsed = versionsPage.safeParse(
      await s3.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: S3_BATCH_LIMIT,
          ...(marker === undefined ? {} : { KeyMarker: marker.key }),
          ...(marker?.versionId === undefined ? {} : { VersionIdMarker: marker.versionId }),
        }),
      ),
    );
    if (!parsed.success) return err({ errorName: 'MalformedListResponse' });
    const page = parsed.data;
    const targets = [...page.Versions, ...page.DeleteMarkers];
    if (targets.some((t) => !t.Key.startsWith(prefix))) return err({ errorName: 'KeyOutsidePrefix' });
    if (!page.IsTruncated) return ok(targets);
    if (page.NextKeyMarker === undefined) return err({ errorName: 'MalformedListResponse' });
    const rest = await listAll(prefix, { key: page.NextKeyMarker, versionId: page.NextVersionIdMarker });
    return rest.ok ? ok([...targets, ...rest.value]) : rest;
  };

  const deleteBatch = async (targets: ReadonlyArray<Target>): Promise<Result<number, DeleteFailure>> => {
    const r = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: targets.map(({ Key, VersionId }) => ({ Key, VersionId })), Quiet: true },
      }),
    );
    const failed = (r.Errors ?? []).find((e) => !MISSING_CODES.has(e.Code ?? ''));
    return failed === undefined ? ok(targets.length) : err({ errorName: failed.Code ?? 'DeleteObjectsError' });
  };

  return {
    deleteAllVersions: async (prefix) => {
      // The caller validates ids too, but a bad prefix here would purge the whole bucket.
      if (!DISPUTE_PREFIX.test(prefix)) return err({ errorName: 'InvalidPrefix' });
      try {
        const listed = await listAll(prefix);
        if (!listed.ok) return listed;
        let deleted = 0;
        for (const batch of chunk(listed.value, S3_BATCH_LIMIT)) {
          const r = await deleteBatch(batch);
          if (!r.ok) return r;
          deleted += r.value;
        }
        return ok(deleted);
      } catch (e) {
        return err({ errorName: errorNameOf(e) });
      }
    },
  };
};
