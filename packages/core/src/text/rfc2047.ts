/** RFC 5322 unfolding: removes CRLF (or LF) that is followed by whitespace, then trims. */
export function unfoldHeader(value: string): string {
  return value.replace(/\r?\n(?=[ \t])/g, "").trim();
}

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
const ADJACENT_GAP = /(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)/g;

function base64ToBytes(text: string): Uint8Array | null {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  try {
    const binary = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function qToBytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "_") {
      out.push(0x20);
    } else if (ch === "=" && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function decodeBytes(bytes: Uint8Array, charset: string): string | null {
  const label = charset.toLowerCase().split("*")[0] ?? "";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    if (label === "us-ascii" || label === "ascii" || label === "iso-8859-1" || label === "latin1") {
      return String.fromCharCode(...bytes);
    }
    return null;
  }
}

/** Decodes RFC 2047 encoded words (B and Q). Whitespace between adjacent encoded words is dropped. Undecodable words stay raw. */
export function decodeEncodedWords(input: string): string {
  if (!input.includes("=?")) return input;
  const joined = input.replace(ADJACENT_GAP, "$1");
  return joined.replace(ENCODED_WORD, (whole, charset: string, encoding: string, text: string) => {
    const bytes = encoding.toUpperCase() === "B" ? base64ToBytes(text) : qToBytes(text);
    if (bytes === null) return whole;
    return decodeBytes(bytes, charset) ?? whole;
  });
}
