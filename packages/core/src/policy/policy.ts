import { z } from "zod";

/** "user@example.com" or "@example.com" (whole domain, including subdomains). Lowercased, trimmed. */
export const SenderEntrySchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^(@|[^@\s]+@)[a-z0-9-]+(\.[a-z0-9-]+)+$/, "expected user@domain or @domain");

/** Inbox backfill window in days (rev 2.4); null scans all mail. New mail is always scanned. */
export const SCAN_HISTORY_DAYS_OPTIONS = [30, 90, 365] as const;
export const DEFAULT_SCAN_HISTORY_DAYS = 90;

export const ScanHistoryDaysSchema = z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable();

export type ScanHistoryDays = z.infer<typeof ScanHistoryDaysSchema>;

/**
 * Weekly "ready to clean" reminder (contracts 12.8). `weekday` is a UTC day of the week (0 = Sunday, as
 * Date.getUTCDay); the nightly job (02:00 UTC) adds the note to the owner's inbox on that day.
 */
export const WeeklyReminderSchema = z
  .object({ enabled: z.boolean(), weekday: z.int().min(0).max(6) })
  .strict();

export type WeeklyReminder = z.infer<typeof WeeklyReminderSchema>;

export const DEFAULT_WEEKLY_REMINDER: WeeklyReminder = { enabled: true, weekday: 0 };

export const PolicySchema = z
  .object({
    allowlist: z.array(SenderEntrySchema).max(1000),
    denylist: z.array(SenderEntrySchema).max(1000),
    minAgeDays: z.int().min(0).max(365),
    storeSnippets: z.boolean(),
    labelSubjects: z.boolean(),
    recordPatterns: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(100),
    scanHistoryDays: ScanHistoryDaysSchema,
    weeklyReminder: WeeklyReminderSchema,
    /** Contracts 12.11: trash Always OK to trash mail without review (nightly, undoable for 24 hours). Off by default. */
    autoTrash: z.boolean(),
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
  scanHistoryDays: DEFAULT_SCAN_HISTORY_DAYS,
  weeklyReminder: DEFAULT_WEEKLY_REMINDER,
  autoTrash: false,
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
  .transform(withStoredDefaults)
  .pipe(PolicySchema);

/**
 * Policies stored before rev 2.4 have no scanHistoryDays; they read as the default (90 days). Policies stored
 * before the weekly reminder (12.8) have no weeklyReminder; they read as the default (on, Sunday). Policies stored
 * before auto-trash (12.11) have no autoTrash; they read as off.
 */
function withStoredDefaults(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = { ...value };
  if (!("scanHistoryDays" in out)) out.scanHistoryDays = DEFAULT_SCAN_HISTORY_DAYS;
  if (!("weeklyReminder" in out)) out.weeklyReminder = { ...DEFAULT_WEEKLY_REMINDER };
  if (!("autoTrash" in out)) out.autoTrash = false;
  return out;
}

/**
 * Inbox backfill cutoff (epoch ms): mail received before it is outside the scan history window.
 * null when the window is "all mail".
 */
export function scanHistoryCutoff(days: ScanHistoryDays, now: number): number | null {
  return days === null ? null : now - days * 86_400_000;
}

/** True when `next` scans further back than `prev` (null = all mail is the widest). */
export function scanHistoryWidened(prev: ScanHistoryDays, next: ScanHistoryDays): boolean {
  if (prev === null) return false;
  return next === null || next > prev;
}

/**
 * Parses stored JSON; returns a copy of DEFAULT_POLICY when input is null; throws ZodError when invalid.
 * A stored policy without scanHistoryDays (written before rev 2.4) gets DEFAULT_SCAN_HISTORY_DAYS; one without
 * weeklyReminder gets DEFAULT_WEEKLY_REMINDER; one without autoTrash gets false.
 */
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
