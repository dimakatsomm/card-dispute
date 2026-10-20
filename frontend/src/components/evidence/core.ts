import type { components } from '../../api/generated/disputes';
import { err, ok, type Result } from '../../app/result';
import { hexToBase64, type UploadError, type UploadInstruction } from '../../lib/upload';

export type EvidenceDeclaration = components['schemas']['EvidenceDeclaration'];
export type EvidenceContentType = EvidenceDeclaration['contentType'];
export type { UploadInstruction };

// The server counts code points (char_length), not UTF-16 units, so an emoji counts once.
export const codePointLength = (value: string): number => [...value].length;

export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_NAME = 255;

const FILE_TYPES: ReadonlyArray<{ readonly contentType: EvidenceContentType; readonly extensions: ReadonlyArray<string> }> = [
  { contentType: 'application/pdf', extensions: ['.pdf'] },
  { contentType: 'image/jpeg', extensions: ['.jpg', '.jpeg'] },
  { contentType: 'image/png', extensions: ['.png'] },
];

export const ACCEPT_ATTRIBUTE = FILE_TYPES.flatMap((type) => [type.contentType, ...type.extensions]).join(',');

export type FileProblem = 'WRONG_TYPE' | 'EMPTY' | 'TOO_LARGE' | 'NAME_TOO_LONG';

type FileLike = { readonly name: string; readonly type: string; readonly size: number };

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
};

export const checkFile = (file: FileLike): Result<EvidenceContentType, FileProblem> => {
  const extension = extensionOf(file.name);
  const type = FILE_TYPES.find((t) => t.contentType === file.type && t.extensions.includes(extension));
  if (!type) return err('WRONG_TYPE');
  if (file.size === 0) return err('EMPTY');
  if (file.size > MAX_FILE_BYTES) return err('TOO_LARGE');
  if (codePointLength(file.name) > MAX_FILE_NAME) return err('NAME_TOO_LONG');
  return ok(type.contentType);
};

export type SelectedFile = {
  readonly key: string;
  readonly file: File;
  readonly contentType: EvidenceContentType;
};

export type RejectedFile = { readonly name: string; readonly problem: FileProblem };

export type FileSelection = {
  readonly files: ReadonlyArray<SelectedFile>;
  readonly rejected: ReadonlyArray<RejectedFile>;
  readonly overLimit: boolean;
};

export const selectFiles = (
  existing: ReadonlyArray<SelectedFile>,
  incoming: ReadonlyArray<File>,
  newKey: () => string,
): FileSelection => {
  const checked = incoming.map((file) => ({ file, result: checkFile(file) }));
  const valid = checked.flatMap(({ file, result }) =>
    result.ok ? [{ key: newKey(), file, contentType: result.value }] : [],
  );
  const rejected = checked.flatMap(({ file, result }) =>
    result.ok ? [] : [{ name: file.name, problem: result.error }],
  );
  if (existing.length + valid.length > MAX_FILES) return { files: existing, rejected, overLimit: true };
  return { files: [...existing, ...valid], rejected, overLimit: false };
};

export type PreparedFile = SelectedFile & { readonly sha256Hex: string };

export const toDeclaration = (prepared: PreparedFile): EvidenceDeclaration => ({
  fileName: prepared.file.name,
  contentType: prepared.contentType,
  sizeBytes: prepared.file.size,
  sha256: prepared.sha256Hex,
});

const instructionFits = (prepared: PreparedFile, instruction: UploadInstruction): boolean =>
  instruction.headers['x-amz-checksum-sha256'] === hexToBase64(prepared.sha256Hex) &&
  instruction.headers['Content-Length'] === String(prepared.file.size) &&
  instruction.headers['Content-Type'] === prepared.contentType;

export type MatchedUpload = readonly [PreparedFile, UploadInstruction | null];

// The contract does not promise uploads come back in declaration order, so each is paired by its signed checksum.
export const matchUploads = (
  files: ReadonlyArray<PreparedFile>,
  uploads: ReadonlyArray<UploadInstruction>,
): ReadonlyArray<MatchedUpload> =>
  files.reduce<{ readonly pairs: ReadonlyArray<MatchedUpload>; readonly remaining: ReadonlyArray<UploadInstruction> }>(
    (acc, prepared) => {
      const index = acc.remaining.findIndex((instruction) => instructionFits(prepared, instruction));
      const instruction = acc.remaining[index];
      return instruction
        ? { pairs: [...acc.pairs, [prepared, instruction]], remaining: acc.remaining.filter((_, i) => i !== index) }
        : { pairs: [...acc.pairs, [prepared, null]], remaining: acc.remaining };
    },
    { pairs: [], remaining: uploads },
  ).pairs;

export type EvidenceFailure = 'CLOSED' | 'TOO_MANY_FILES' | 'NOT_FOUND' | 'UNAVAILABLE' | 'UNEXPECTED';

export type FileUploadFailure = EvidenceFailure | UploadError | 'NO_MATCHING_UPLOAD';

const UPLOAD_FAILURE_MESSAGES: Readonly<Record<FileUploadFailure, string>> = {
  NO_MATCHING_UPLOAD: "The upload link we received didn't match this file.",
  INVALID_INSTRUCTION: "The upload link we received for this file isn't valid.",
  NETWORK: 'The upload was interrupted.',
  REJECTED: 'The file store rejected the upload. The link may have expired.',
  CLOSED: 'This dispute is closed, so no more files can be added.',
  TOO_MANY_FILES: 'This dispute already has the maximum number of files waiting or stored.',
  NOT_FOUND: "We couldn't get a new upload link.",
  UNAVAILABLE: "We couldn't get a new upload link. The service is temporarily unavailable.",
  UNEXPECTED: "We couldn't get a new upload link.",
};

export const uploadFailureMessage = (failure: FileUploadFailure): string => UPLOAD_FAILURE_MESSAGES[failure];

const FILE_PROBLEM_MESSAGES: Readonly<Record<FileProblem, string>> = {
  WRONG_TYPE: "isn't a PDF, JPEG or PNG file",
  EMPTY: 'is empty',
  TOO_LARGE: 'is larger than 10 MB',
  NAME_TOO_LONG: `has a name longer than ${MAX_FILE_NAME} characters`,
};

export const rejectedFileMessage = (rejected: RejectedFile): string =>
  `${rejected.name} ${FILE_PROBLEM_MESSAGES[rejected.problem]}.`;
