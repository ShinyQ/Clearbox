import { z } from "zod";

/** "user@example.com" or "@example.com" (whole domain, including subdomains). Lowercased, trimmed. */
export const SenderEntrySchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^(@|[^@\s]+@)[a-z0-9-]+(\.[a-z0-9-]+)+$/, "expected user@domain or @domain");

export const PolicySchema = z
  .object({
    allowlist: z.array(SenderEntrySchema).max(1000),
    denylist: z.array(SenderEntrySchema).max(1000),
    minAgeDays: z.int().min(0).max(365),
    storeSnippets: z.boolean(),
    labelSubjects: z.boolean(),
    recordPatterns: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(100),
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = {
  allowlist: [],
  denylist: [],
  minAgeDays: 3,
  storeSnippets: true,
  labelSubjects: true,
  recordPatterns: ["receipt", "invoice", "tax", "statement", "contract", "medical", "legal"],
};

const PolicyJsonSchema = z
  .string()
  .transform((text, ctx): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      ctx.issues.push({ code: "custom", message: "policy is not valid JSON", input: text });
      return z.NEVER;
    }
  })
  .pipe(PolicySchema);

/** Parses stored JSON; returns a copy of DEFAULT_POLICY when input is null; throws ZodError when invalid. */
export function parsePolicy(json: string | null): Policy {
  if (json === null) return structuredClone(DEFAULT_POLICY);
  return PolicyJsonSchema.parse(json);
}

function hostOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1) : "";
}

function domainMatches(entryDomain: string, host: string): boolean {
  return host !== "" && (host === entryDomain || host.endsWith(`.${entryDomain}`));
}

/**
 * True when address equals an entry, or an "@domain" entry equals the domain or is a parent domain of it.
 * "@domain" entries are checked against both the address host and the given (registrable) domain.
 */
export function matchesSenderList(address: string, domain: string, list: readonly string[]): boolean {
  const addr = address.trim().toLowerCase();
  const host = hostOf(addr);
  const dom = domain.trim().toLowerCase();
  return list.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry.startsWith("@")) {
      const entryDomain = entry.slice(1);
      return domainMatches(entryDomain, host) || domainMatches(entryDomain, dom);
    }
    return addr !== "" && entry === addr;
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive whole-word match of any pattern in subject + " " + snippet; returns the first matching pattern (list order) or null. */
export function matchRecordPattern(
  subject: string,
  snippet: string,
  patterns: readonly string[],
): string | null {
  const text = `${subject} ${snippet}`;
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (trimmed === "") continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}_])`, "iu");
    if (re.test(text)) return pattern;
  }
  return null;
}
