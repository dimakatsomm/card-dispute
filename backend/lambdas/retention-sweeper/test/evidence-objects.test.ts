import { DeleteObjectsCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { createEvidenceObjects, type EvidenceObjectsDeps } from '../src/adapters/evidence-objects.ts';

const PREFIX = 'evidence/0190f1a2-0000-7000-8000-000000000001/';
const versions = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ Key: `${PREFIX}e${(from + i) % 3}`, VersionId: `v${from + i}` }));

type Sent = ListObjectVersionsCommand | DeleteObjectsCommand;

const fakeS3 = (respond: (cmd: Sent) => unknown) => {
  const sent: Sent[] = [];
  const s3 = {
    send: async (cmd: Sent) => {
      sent.push(cmd);
      return respond(cmd);
    },
  } as unknown as EvidenceObjectsDeps['s3'];
  return { s3, sent };
};

describe('createEvidenceObjects', () => {
  it('lists every page first, then deletes all versions and delete markers by VersionId in batches of at most 1000', async () => {
    const { s3, sent } = fakeS3((cmd) => {
      if (cmd instanceof DeleteObjectsCommand) return {};
      return cmd.input.KeyMarker === undefined
        ? { Versions: versions(1000), IsTruncated: true, NextKeyMarker: `${PREFIX}e0`, NextVersionIdMarker: 'v999' }
        : { Versions: versions(300, 1000), DeleteMarkers: versions(200, 1300), IsTruncated: false };
    });

    expect(await createEvidenceObjects({ s3, bucket: 'b' }).deleteAllVersions(PREFIX)).toEqual({ ok: true, value: 1500 });

    expect(sent.map((c) => c.constructor.name)).toEqual([
      'ListObjectVersionsCommand',
      'ListObjectVersionsCommand',
      'DeleteObjectsCommand',
      'DeleteObjectsCommand',
    ]);
    expect(sent[1]?.input).toMatchObject({ Prefix: PREFIX, KeyMarker: `${PREFIX}e0`, VersionIdMarker: 'v999' });
    const deletes = sent.filter((c): c is DeleteObjectsCommand => c instanceof DeleteObjectsCommand);
    const objects = deletes.map((d) => d.input.Delete?.Objects ?? []);
    expect(objects.map((o) => o.length)).toEqual([1000, 500]);
    expect(objects.flat()).toEqual(versions(1500));
  });

  it.each<[string, unknown, unknown]>([
    ['a version already gone is fine', { Errors: [{ Code: 'NoSuchVersion' }] }, { ok: true, value: 1 }],
    ['a per-key AccessDenied is a failure', { Errors: [{ Code: 'AccessDenied' }] }, { ok: false, error: { errorName: 'AccessDenied' } }],
  ])('%s', async (_name, deleteResponse, expected) => {
    const { s3 } = fakeS3((cmd) => (cmd instanceof ListObjectVersionsCommand ? { Versions: versions(1) } : deleteResponse));
    expect(await createEvidenceObjects({ s3, bucket: 'b' }).deleteAllVersions(PREFIX)).toEqual(expected);
  });

  it('refuses to delete anything when the listing returns a key outside the prefix', async () => {
    const { s3, sent } = fakeS3(() => ({ Versions: [...versions(1), { Key: 'evidence/other/e', VersionId: 'x' }] }));
    expect(await createEvidenceObjects({ s3, bucket: 'b' }).deleteAllVersions(PREFIX)).toEqual({
      ok: false,
      error: { errorName: 'KeyOutsidePrefix' },
    });
    expect(sent.some((c) => c instanceof DeleteObjectsCommand)).toBe(false);
  });

  it.each(['', 'evidence/', 'evidence/0190f1a2-0000-7000-8000-000000000001', 'evidence/../', `${PREFIX}x/`])(
    'refuses the prefix %j without calling S3',
    async (prefix) => {
      const { s3, sent } = fakeS3(() => ({}));
      expect(await createEvidenceObjects({ s3, bucket: 'b' }).deleteAllVersions(prefix)).toEqual({
        ok: false,
        error: { errorName: 'InvalidPrefix' },
      });
      expect(sent).toHaveLength(0);
    },
  );
});
