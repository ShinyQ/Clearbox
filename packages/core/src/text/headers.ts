import type { AuthVerdict } from "../model/mail.ts";
import { unfoldHeader } from "./rfc2047.ts";

/** A raw header as both providers return it (Gmail payload.headers, Graph internetMessageHeaders). */
export interface RawHeader {
  name: string;
  value: string;
}

/** First header with this name (case-insensitive), unfolded; null when absent. */
export function headerValue(headers: readonly RawHeader[], name: string): string | null {
  const wanted = name.toLowerCase();
  const found = headers.find((h) => h.name.toLowerCase() === wanted);
  return found ? unfoldHeader(found.value) : null;
}

export interface ParsedAuthResults {
  /** authserv-id (lowercased) when the header starts with one, else null (Microsoft style). */
  authservId: string | null;
  spf: AuthVerdict;
  dkim: AuthVerdict;
  dmarc: AuthVerdict;
}

const FAIL_RESULTS: ReadonlySet<string> = new Set(["fail", "softfail", "hardfail", "permerror"]);

/** Replaces each balanced top-level comment with one space in a single linear pass; unbalanced parentheses stay as text. */
function stripComments(value: string): string {
  const out: string[] = [];
  const opens: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch === "\\" && opens.length > 0 && i + 1 < value.length) {
      out.push(ch, value[i + 1] as string);
      i++;
    } else if (ch === "(") {
      opens.push(out.length);
      out.push(ch);
    } else if (ch === ")" && opens.length > 0) {
      out.length = opens.pop() as number;
      out.push(" ");
    } else out.push(ch);
  }
  return out.join("");
}

/** Parses one Authentication-Results value. Per method: pass if any pass, else fail if any fail/softfail/permerror, else none. */
export function parseAuthResults(value: string | null): ParsedAuthResults {
  const result: ParsedAuthResults = { authservId: null, spf: "none", dkim: "none", dmarc: "none" };
  if (value === null) return result;
  const clean = stripComments(unfoldHeader(value));
  const segments = clean.split(";").map((s) => s.trim());
  const first = segments[0] ?? "";
  if (first !== "" && !first.includes("=")) {
    result.authservId = (first.split(/\s+/)[0] ?? "").toLowerCase();
  }
  for (const method of ["spf", "dkim", "dmarc"] as const) {
    const verdicts = [...clean.matchAll(new RegExp(`(?:^|[\\s;])${method}\\s*=\\s*([a-z]+)`, "gi"))].map(
      (m) => (m[1] ?? "").toLowerCase(),
    );
    if (verdicts.includes("pass")) result[method] = "pass";
    else if (verdicts.some((v) => FAIL_RESULTS.has(v))) result[method] = "fail";
  }
  return result;
}

export interface ListUnsubscribe {
  https: string[];
  mailto: string[];
}

/** Extracts the <...> URIs of a List-Unsubscribe header, split into https and mailto. */
export function parseListUnsubscribe(value: string | null): ListUnsubscribe {
  const out: ListUnsubscribe = { https: [], mailto: [] };
  if (value === null) return out;
  for (const match of unfoldHeader(value).matchAll(/<\s*([^<>\s]+)\s*>/g)) {
    const uri = match[1] ?? "";
    if (/^https:\/\//i.test(uri)) out.https.push(uri);
    else if (/^mailto:/i.test(uri)) out.mailto.push(uri);
  }
  return out;
}

/** Precedence: bulk, list or junk (case-insensitive). */
export function isBulkPrecedence(value: string | null): boolean {
  return value !== null && /^(bulk|list|junk)$/i.test(value.trim());
}

/** Auto-Submitted: any value except "no" (parameters after ";" are ignored). */
export function isAutoSubmitted(value: string | null): boolean {
  if (value === null) return false;
  const token = (value.split(";")[0] ?? "").trim().toLowerCase();
  return token !== "" && token !== "no";
}
