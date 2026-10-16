import { randomBytes } from "node:crypto";
import { isMain } from "./lib/is-main.ts";

export const KEY_BYTES = 32;

/** Standard base64 of exactly 32 random bytes (TOKEN_ENC_KEY, STATE_SIGNING_KEY). */
export function generateKey(random: (size: number) => Uint8Array = (size) => randomBytes(size)): string {
  const bytes = random(KEY_BYTES);
  if (bytes.length !== KEY_BYTES) throw new Error(`expected ${KEY_BYTES} random bytes, got ${bytes.length}`);
  return Buffer.from(bytes).toString("base64");
}

export function isValidKey(value: string): boolean {
  return /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, "base64").length === KEY_BYTES;
}

if (isMain(import.meta.url)) {
  console.log(generateKey());
}
