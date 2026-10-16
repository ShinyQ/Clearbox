const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  if (!BASE64_RE.test(b64)) throw new Error("invalid base64");
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL_RE.test(s) || s.length % 4 === 1) throw new Error("invalid base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(new TextEncoder().encode(s));
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** D1 returns BLOB columns as ArrayBuffer or number[] depending on the API; normalize to bytes. */
export function bytesFromBlob(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value === null || value === undefined) return null;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (Array.isArray(value) && value.every((v) => typeof v === "number"))
    return Uint8Array.from(value as number[]);
  throw new Error("unexpected blob value");
}
