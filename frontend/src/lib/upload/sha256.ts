export const sha256Hex = async (file: Blob, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string> => {
  const digest = await subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const hexToBase64 = (hex: string): string =>
  btoa(String.fromCharCode(...(hex.match(/[0-9a-f]{2}/gi) ?? []).map((pair) => parseInt(pair, 16))));
