import { parseListUnsubscribe } from "./headers.ts";

/** RFC 8058 one-click unsubscribe (contracts 12.8). Sender-supplied values are untrusted. */

export const UNSUBSCRIBE_URL_MAX_CHARS = 2_048;
const HOSTNAME_MAX_CHARS = 253;

/** RFC 8058 section 5: the List-Unsubscribe-Post value is exactly this key/value pair (case-insensitive). */
export function isOneClickPost(value: string | null): boolean {
  return value !== null && value.trim().toLowerCase() === "list-unsubscribe=one-click";
}

/**
 * The https URI a one-click POST goes to: the first https URI of List-Unsubscribe when List-Unsubscribe-Post
 * is the one-click pair, else null. mailto: URIs are never used (Clearbox has no send scope).
 */
export function oneClickTarget(
  listUnsubscribe: string | null,
  listUnsubscribePost: string | null,
): string | null {
  if (!isOneClickPost(listUnsubscribePost)) return null;
  return parseListUnsubscribe(listUnsubscribe).https[0] ?? null;
}

export type UnsafeUrlReason =
  | "too_long"
  | "invalid_chars"
  | "malformed"
  | "not_https"
  | "credentials"
  | "port"
  | "ip_literal"
  | "local_host"
  | "own_host";

export type CheckedUrl = { ok: true; url: string } | { ok: false; reason: UnsafeUrlReason };

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".arpa", ".onion", ".invalid"];
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Validates a sender-supplied one-click URL before the Worker POSTs to it. Accepts only https on the default
 * port, with a public-looking DNS name: no credentials, no IP literals, no single-label or reserved local
 * names, and not the app's own host. Returns the normalized URL without its fragment.
 */
export function checkUnsubscribeUrl(raw: string, opts: { ownHost?: string | null } = {}): CheckedUrl {
  if (raw.length > UNSUBSCRIBE_URL_MAX_CHARS) return { ok: false, reason: "too_long" };
  // Printable ASCII only: rejects whitespace, CR/LF, other control and non-ASCII characters outright.
  if (!/^[\x21-\x7e]+$/.test(raw)) return { ok: false, reason: "invalid_chars" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
  if (url.port !== "") return { ok: false, reason: "port" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || IPV4_LITERAL.test(host)) return { ok: false, reason: "ip_literal" };
  const labels = host.split(".");
  const tld = labels[labels.length - 1] ?? "";
  if (
    host.length === 0 ||
    host.length > HOSTNAME_MAX_CHARS ||
    labels.length < 2 ||
    !/^[a-z][a-z0-9-]*$/.test(tld) ||
    host === "localhost" ||
    BLOCKED_SUFFIXES.some((s) => host.endsWith(s))
  ) {
    return { ok: false, reason: "local_host" };
  }
  const own = opts.ownHost?.toLowerCase().replace(/\.$/, "") ?? null;
  if (own !== null && own !== "" && host === own) return { ok: false, reason: "own_host" };
  url.hash = "";
  const href = url.href;
  if (href.length > UNSUBSCRIBE_URL_MAX_CHARS) return { ok: false, reason: "too_long" };
  return { ok: true, url: href };
}
