import type { components } from '../../api/generated/disputes';
import { err, ok, type Result } from '../../app/result';

export type UploadInstruction = components['schemas']['UploadInstruction'];

export type UploadError = 'INVALID_INSTRUCTION' | 'NETWORK' | 'REJECTED';

export type UploadDeps = { readonly createXhr: () => XMLHttpRequest };

const isLocalHost = (url: URL): boolean => url.hostname === 'localhost' || url.hostname === '127.0.0.1';

const isAllowedUploadUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHost(url));
};

// Browsers forbid setting Content-Length (it is derived from the body), so it is checked against the file instead.
const isForbiddenHeader = (name: string): boolean => name.toLowerCase() === 'content-length';

// XHR, not fetch: fetch cannot report upload progress, and neither path may carry the API bearer to S3.
export const uploadEvidence = (
  instruction: UploadInstruction,
  file: Blob,
  onProgress: (fraction: number) => void,
  deps: UploadDeps = { createXhr: () => new XMLHttpRequest() },
): Promise<Result<void, UploadError>> => {
  if (
    instruction.method !== 'PUT' ||
    !isAllowedUploadUrl(instruction.url) ||
    instruction.headers['Content-Length'] !== String(file.size)
  ) {
    return Promise.resolve(err('INVALID_INSTRUCTION'));
  }
  return new Promise((resolve) => {
    const xhr = deps.createXhr();
    xhr.open('PUT', instruction.url);
    Object.entries(instruction.headers)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !isForbiddenHeader(entry[0]))
      .forEach(([name, value]) => xhr.setRequestHeader(name, value));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300 ? ok(undefined) : err('REJECTED'));
    xhr.onerror = () => resolve(err('NETWORK'));
    xhr.onabort = () => resolve(err('NETWORK'));
    xhr.ontimeout = () => resolve(err('NETWORK'));
    xhr.send(file);
  });
};
