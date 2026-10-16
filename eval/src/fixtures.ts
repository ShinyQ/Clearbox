import { readFileSync } from "node:fs";
import { z } from "zod";
import type { MailHeaders, MailMessage, Signals } from "@clearbox/core";

export const OWNER_ADDRESS = "owner@example.test";
export const DAY_MS = 86_400_000;

export const FIXTURE_CATEGORIES = [
  "promotion",
  "newsletter",
  "receipt",
  "otp",
  "human",
  "github",
  "security_alert",
  "calendar",
  "other",
] as const;
export type FixtureCategory = (typeof FIXTURE_CATEGORIES)[number];

const MailCategorySchema = z.enum([
  "primary",
  "promotions",
  "social",
  "updates",
  "forums",
  "focused",
  "other",
]);
const AuthVerdictSchema = z.enum(["pass", "fail", "none"]);
const nullableText = z.string().nullable().optional();

const HeadersSchema = z
  .object({
    listUnsubscribe: nullableText,
    listUnsubscribePost: nullableText,
    listId: nullableText,
    precedence: nullableText,
    autoSubmitted: nullableText,
    authenticationResults: nullableText,
    returnPath: nullableText,
    contentType: nullableText,
    references: nullableText,
    inReplyTo: nullableText,
  })
  .strict();

const MessageInputSchema = z
  .object({
    kind: z.literal("message"),
    from: z.object({ address: z.string().nullable(), name: z.string().nullable() }).strict(),
    to: z.array(z.string()).default([OWNER_ADDRESS]),
    cc: z.array(z.string()).default([]),
    subject: z.string(),
    snippet: z.string().max(255),
    ageDays: z.int().min(0).max(3650),
    isRead: z.boolean(),
    starred: z.boolean().default(false),
    providerImportant: z.boolean().default(false),
    category: MailCategorySchema.nullable().default(null),
    hasAttachments: z.boolean().default(false),
    threadDepth: z.int().min(1).nullable().default(1),
    ownerReplied: z.boolean().default(false),
    headers: HeadersSchema.default({}),
  })
  .strict();

/** Mirrors `Signals` (contracts 4.5); used for exported owner labels. */
export const SignalsSchema = z
  .object({
    senderAddress: z.string(),
    senderDomain: z.string(),
    senderName: z.string().nullable(),
    senderKnown: z.boolean(),
    ownerReplied: z.boolean(),
    isCorrespondent: z.boolean(),
    senderSeenCount: z.number(),
    senderOpenRate: z.number().nullable(),
    ownerDeleteRate: z.number().nullable(),
    ownerDecisions: z.number(),
    hasListUnsubscribe: z.boolean(),
    oneClickUnsubscribe: z.boolean(),
    hasListId: z.boolean(),
    precedenceBulk: z.boolean(),
    autoSubmitted: z.boolean(),
    espDomain: z.string().nullable(),
    auth: z.object({ spf: AuthVerdictSchema, dkim: AuthVerdictSchema, dmarc: AuthVerdictSchema }),
    category: MailCategorySchema.nullable(),
    starred: z.boolean(),
    providerImportant: z.boolean(),
    ageDays: z.number().min(0),
    isRead: z.boolean(),
    hasAttachments: z.boolean(),
    attachmentsApprox: z.boolean(),
    threadDepth: z.number().nullable(),
    ownerPosition: z.enum(["to", "cc", "bcc_or_list"]),
  })
  .loose();

const SignalsInputSchema = z
  .object({
    kind: z.literal("signals"),
    subject: z.string(),
    snippet: z.string(),
    signals: SignalsSchema,
  })
  .strict();

const HistorySchema = z
  .object({
    seenCount: z.int().min(0),
    readCount: z.int().min(0),
    isCorrespondent: z.boolean(),
  })
  .strict();

export const EvalFixtureSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,64}$/),
    source: z.enum(["synthetic", "owner"]),
    category: z.enum(FIXTURE_CATEGORIES),
    label: z.enum(["delete", "archive", "keep"]),
    input: z.discriminatedUnion("kind", [MessageInputSchema, SignalsInputSchema]),
    history: HistorySchema.default({ seenCount: 0, readCount: 0, isCorrespondent: false }),
  })
  .strict();

export type EvalFixture = z.infer<typeof EvalFixtureSchema>;
export type MessageInput = z.infer<typeof MessageInputSchema>;

const RESERVED_BASES = ["example.com", "example.net", "example.org"];

/** RFC 2606 / 6761 reserved names only: example.com|net|org (and subdomains), *.test, *.example. */
export function isReservedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (d.endsWith(".test") || d.endsWith(".example")) return true;
  return RESERVED_BASES.some((base) => d === base || d.endsWith(`.${base}`));
}

function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).replace(/>$/, "") : null;
}

/** Every domain mentioned in addresses, Return-Path and List-Unsubscribe URIs of a message input. */
export function domainsIn(input: MessageInput): string[] {
  const out: string[] = [];
  const addresses = [input.from.address, ...input.to, ...input.cc, input.headers.returnPath ?? null];
  for (const a of addresses) {
    const d = a === null ? null : domainOf(a);
    if (d !== null) out.push(d);
  }
  for (const uri of (input.headers.listUnsubscribe ?? "").matchAll(/<([^>]+)>/g)) {
    const value = uri[1] ?? "";
    const d = value.startsWith("mailto:")
      ? domainOf(value)
      : URL.canParse(value)
        ? new URL(value).hostname
        : null;
    if (d !== null) out.push(d);
  }
  return out;
}

/** Parses JSONL. Synthetic fixtures must only use reserved domains; ids must be unique. */
export function parseFixtures(text: string, origin: string): EvalFixture[] {
  const fixtures: EvalFixture[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const where = `${origin}:${index + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`${where}: invalid JSON`);
    }
    const parsed = EvalFixtureSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`${where}: ${issue?.path.join(".") ?? ""} ${issue?.message ?? "invalid fixture"}`);
    }
    const fixture = parsed.data;
    if (seen.has(fixture.id)) throw new Error(`${where}: duplicate id ${fixture.id}`);
    seen.add(fixture.id);
    if (fixture.source === "synthetic") {
      if (fixture.input.kind !== "message")
        throw new Error(`${where}: synthetic fixtures use kind "message"`);
      const bad = domainsIn(fixture.input).filter((d) => !isReservedDomain(d));
      if (bad.length > 0)
        throw new Error(`${where}: non-reserved domain(s) in a synthetic fixture: ${bad.join(", ")}`);
    }
    fixtures.push(fixture);
  });
  return fixtures;
}

export function loadFixtures(path: string): EvalFixture[] {
  return parseFixtures(readFileSync(path, "utf8"), path);
}

const EMPTY_HEADERS: MailHeaders = {
  listUnsubscribe: null,
  listUnsubscribePost: null,
  listId: null,
  precedence: null,
  autoSubmitted: null,
  authenticationResults: null,
  returnPath: null,
  contentType: null,
  references: null,
  inReplyTo: null,
};

export function threadIdFor(fixture: EvalFixture): string {
  return `thread-${fixture.id}`;
}

/** Builds the normalized message the provider layer would produce. */
export function toMailMessage(fixture: EvalFixture, now: number): MailMessage {
  const base = {
    providerMessageId: fixture.id,
    threadId: threadIdFor(fixture),
    internetMessageId: `<${fixture.id}@fixtures.example>`,
    deliveredTo: [],
    webLink: null,
    labels: [],
  };
  const input = fixture.input;
  if (input.kind === "message") {
    const headers: MailHeaders = { ...EMPTY_HEADERS };
    for (const key of Object.keys(EMPTY_HEADERS) as (keyof MailHeaders)[]) {
      headers[key] = input.headers[key] ?? null;
    }
    return {
      ...base,
      receivedAt: now - input.ageDays * DAY_MS,
      from: { address: input.from.address?.toLowerCase() ?? null, name: input.from.name },
      to: input.to.map((a) => a.toLowerCase()),
      cc: input.cc.map((a) => a.toLowerCase()),
      subject: input.subject,
      snippet: input.snippet,
      isRead: input.isRead,
      starred: input.starred,
      providerImportant: input.providerImportant,
      category: input.category,
      hasAttachments: input.hasAttachments,
      attachmentsApprox: false,
      threadDepth: input.threadDepth,
      headers,
    };
  }
  const s: Signals = input.signals;
  return {
    ...base,
    receivedAt: now - s.ageDays * DAY_MS,
    from: { address: s.senderAddress === "" ? null : s.senderAddress, name: s.senderName },
    to: [OWNER_ADDRESS],
    cc: [],
    subject: input.subject,
    snippet: input.snippet,
    isRead: s.isRead,
    starred: s.starred,
    providerImportant: s.providerImportant,
    category: s.category,
    hasAttachments: s.hasAttachments,
    attachmentsApprox: s.attachmentsApprox,
    threadDepth: s.threadDepth,
    headers: { ...EMPTY_HEADERS },
  };
}
