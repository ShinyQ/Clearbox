import type { MailAddress } from "../model/mail.ts";
import { decodeEncodedWords, unfoldHeader } from "./rfc2047.ts";

const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

function cleanName(raw: string): string | null {
  let name = raw.trim();
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
    name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  name = decodeEncodedWords(name).replace(/\s+/g, " ").trim();
  return name === "" ? null : name;
}

function normalizeAddress(raw: string): string | null {
  const candidate = raw
    .trim()
    .replace(/^mailto:/i, "")
    .toLowerCase();
  return ADDRESS.test(candidate) ? candidate : null;
}

/** Parses one mailbox: `"Name" <a@b>`, `Name <a@b>`, `<a@b>`, `a@b`, `a@b (Name)`. */
export function parseAddress(raw: string | null): MailAddress {
  if (raw === null) return { address: null, name: null };
  const value = unfoldHeader(raw);
  const angle = /<([^<>]*)>/.exec(value);
  if (angle) {
    const before = value.slice(0, angle.index);
    return { address: normalizeAddress(angle[1] ?? ""), name: cleanName(before) };
  }
  const comment = /\(([^()]*)\)/.exec(value);
  const bare = comment ? value.replace(comment[0], "") : value;
  return { address: normalizeAddress(bare), name: comment ? cleanName(comment[1] ?? "") : null };
}

/** Splits on commas outside quotes, angle brackets and comments; drops group names ("team: a, b;"). */
function splitList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch === "\\" && quoted) {
      current += ch + (value[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle++;
    else if (!quoted && ch === ">") angle = Math.max(0, angle - 1);
    else if (!quoted && ch === "(") paren++;
    else if (!quoted && ch === ")") paren = Math.max(0, paren - 1);
    if (!quoted && angle === 0 && paren === 0 && (ch === "," || ch === ";")) {
      parts.push(current);
      current = "";
      continue;
    }
    if (!quoted && angle === 0 && paren === 0 && ch === ":") {
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** Parses an address list header; returns only entries with a parseable address. */
export function parseAddressList(raw: string | null): MailAddress[] {
  if (raw === null) return [];
  return splitList(unfoldHeader(raw))
    .map((part) => parseAddress(part))
    .filter((a) => a.address !== null);
}

/** Second-level labels under which registrations happen (small built-in list). */
const MULTI_PART_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "net.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.nz",
  "org.nz",
  "net.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "go.jp",
  "co.kr",
  "or.kr",
  "com.br",
  "net.br",
  "org.br",
  "com.cn",
  "net.cn",
  "org.cn",
  "com.mx",
  "com.ar",
  "com.tr",
  "com.sg",
  "com.hk",
  "com.tw",
  "com.my",
  "com.ph",
  "co.in",
  "net.in",
  "org.in",
  "co.za",
  "co.id",
  "co.il",
  "co.th",
]);

/** Registrable domain of a host or address: last two labels, or last three under a known multi-part suffix. "" when empty. */
export function registrableDomain(hostOrAddress: string): string {
  const at = hostOrAddress.lastIndexOf("@");
  const host = (at >= 0 ? hostOrAddress.slice(at + 1) : hostOrAddress)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (host === "") return "";
  if (/^\[.*\]$/.test(host) || /^\d+(\.\d+){3}$/.test(host)) return host;
  const labels = host.split(".").filter((l) => l !== "");
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}
