import { buildGmailDeepLink, REASON_CODES, renderReason, SUGGESTED_ACTIONS } from "@clearbox/core";
import type { ActionKind, Signals, SuggestedAction } from "@clearbox/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { routePath } from "hono/route";
import { z } from "zod";
import { GroupsQuerySchema, PageQuerySchema, SummaryQuerySchema } from "../../shared/api.ts";
import type {
  ApiReason,
  GroupDetail,
  ItemSignals,
  Page,
  QueueSummary,
  SenderGroup,
  SuggestionItem,
} from "../../shared/api.ts";
import { listAccounts } from "../db/accounts.ts";
import type { Account } from "../db/accounts.ts";
import { readSettings } from "../db/settings.ts";
import { bindQuery, chunk, decodeCursor, encodeCursor, flag, MAX_BOUND_PARAMS, toIso } from "../db/sql.ts";
import {
  awaitingCountQuery,
  cleanupCountsQuery,
  decodeGroupKey,
  encodeGroupKey,
  groupItemsQuery,
  groupReasonsQuery,
  groupSortValue,
  groupsQuery,
  parseLatest,
  pendingByActionQuery,
} from "../db/suggestions.ts";
import type { GroupItemRow, GroupRow, ReasonCountRow } from "../db/suggestions.ts";
import type { AppEnv } from "../env.ts";
import { logEvent } from "../log.ts";
import { ApiError, parseWith } from "../middleware/errors.ts";

/** Contracts 12.3: Keep suggestions are excluded from Clean up. */
export const CLEANUP_DEFAULT_ACTIONS: readonly ActionKind[] = ["delete", "archive"];

export const queueRoutes = new Hono<AppEnv>();

const zeroByAction = (): Record<SuggestedAction, number> => ({ delete: 0, archive: 0, keep: 0, unsure: 0 });

/** Visible accounts, optionally narrowed to one id (unknown ids give an empty scope). */
export async function scopeAccounts(db: D1Database, accountId?: string): Promise<Account[]> {
  const accounts = await listAccounts(db, { includeDisconnected: false });
  return accountId === undefined ? accounts : accounts.filter((a) => a.id === accountId);
}

const groupMapKey = (accountId: string, sender: string, action: string) =>
  `${accountId}\u001f${sender}\u001f${action}`;

/** Counts stored reasons left out of one response; the route logs the total once. */
interface ReasonSkips {
  count: number;
}

const StoredReasonSchema = z.object({
  code: z.enum(REASON_CODES),
  params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
});

/** renderReason throws on unknown codes (plan 01 carry-forward): unknown or malformed stored reasons are skipped. */
function renderStoredReason(value: unknown, skips: ReasonSkips): ApiReason | null {
  const parsed = StoredReasonSchema.safeParse(value);
  if (!parsed.success) {
    skips.count += 1;
    return null;
  }
  return { code: parsed.data.code, text: renderReason(parsed.data) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toApiReason(reasonJson: string, skips: ReasonSkips): ApiReason | null {
  return renderStoredReason(parseJson(reasonJson), skips);
}

function toApiReasons(reasonsJson: string, skips: ReasonSkips): ApiReason[] {
  const stored = parseJson(reasonsJson);
  if (!Array.isArray(stored)) {
    skips.count += 1;
    return [];
  }
  return stored.map((r) => renderStoredReason(r, skips)).filter((r): r is ApiReason => r !== null);
}

/** Opaque fields only: the skipped count, never the stored code text. */
function logSkippedReasons(c: Context<AppEnv>, skips: ReasonSkips): void {
  if (skips.count === 0) return;
  logEvent("request.error", {
    requestId: c.get("requestId"),
    route: routePath(c),
    errorName: "InvalidStoredReason",
    skippedReasons: skips.count,
  });
}

/** Top 3 reason codes per group (decision 15). */
export async function topReasonsFor(
  db: D1Database,
  groups: readonly { accountId: string; sender: string; action: SuggestedAction }[],
  action: SuggestedAction | null,
  skips: ReasonSkips = { count: 0 },
): Promise<Map<string, ApiReason[]>> {
  const sendersByAccount = new Map<string, Set<string>>();
  for (const g of groups) {
    const set = sendersByAccount.get(g.accountId) ?? new Set<string>();
    set.add(g.sender);
    sendersByAccount.set(g.accountId, set);
  }
  const queries: { accountId: string; q: ReturnType<typeof groupReasonsQuery> }[] = [];
  for (const [accountId, senders] of sendersByAccount) {
    for (const part of chunk([...senders], MAX_BOUND_PARAMS - 2)) {
      queries.push({ accountId, q: groupReasonsQuery(accountId, part, action) });
    }
  }
  const out = new Map<string, ApiReason[]>();
  if (queries.length === 0) return out;
  const results = await db.batch<ReasonCountRow>(queries.map((x) => bindQuery(db, x.q)));
  const counts = new Map<string, ReasonCountRow[]>();
  results.forEach((res, idx) => {
    const accountId = queries[idx]?.accountId ?? "";
    for (const row of res.results) {
      const key = groupMapKey(accountId, row.sender, row.action);
      counts.set(key, [...(counts.get(key) ?? []), row]);
    }
  });
  for (const [key, rows] of counts) {
    const ranked: { n: number; reason: ApiReason }[] = [];
    for (const row of rows) {
      const reason = toApiReason(row.reason_json, skips);
      if (reason) ranked.push({ n: row.n, reason });
    }
    ranked.sort((x, y) => y.n - x.n || x.reason.code.localeCompare(y.reason.code));
    out.set(
      key,
      ranked.slice(0, 3).map((r) => r.reason),
    );
  }
  return out;
}

function toSenderGroup(row: GroupRow, account: Account, reasons: Map<string, ApiReason[]>): SenderGroup {
  const latest = parseLatest(row.latest);
  return {
    key: encodeGroupKey(row.account_id, row.sender, row.action),
    accountId: row.account_id,
    provider: account.provider,
    sender: row.sender,
    senderName: latest.name,
    domain: row.domain,
    action: row.action,
    count: row.n,
    confidence: { min: row.cmin, avg: row.cavg, max: row.cmax },
    topReasons: reasons.get(groupMapKey(row.account_id, row.sender, row.action)) ?? [],
    ceilingApplied: flag(row.capped),
    newestReceivedAt: toIso(row.newest),
    oldestReceivedAt: toIso(row.oldest),
    latestSubject: latest.subject,
  };
}

function itemSignals(signals: Signals, receivedAt: number, now: number): ItemSignals {
  return {
    hasListUnsubscribe: signals.hasListUnsubscribe,
    precedenceBulk: signals.precedenceBulk,
    autoSubmitted: signals.autoSubmitted,
    category: signals.category,
    hasAttachments: signals.hasAttachments,
    starred: signals.starred,
    ownerReplied: signals.ownerReplied,
    isCorrespondent: signals.isCorrespondent,
    ageDays: Math.max(0, Math.floor((now - receivedAt) / 86_400_000)),
    ownerPosition: signals.ownerPosition,
    auth: signals.auth,
  };
}

export function toSuggestionItem(
  row: GroupItemRow,
  account: Account,
  now: number,
  skips: ReasonSkips = { count: 0 },
): SuggestionItem {
  const hasDistribution =
    row.p_delete !== null && row.p_archive !== null && row.p_keep !== null && row.p_unsure !== null;
  const reasons = toApiReasons(row.reasons_json, skips);
  return {
    id: row.message_id,
    accountId: row.account_id,
    provider: account.provider,
    status: row.status,
    action: row.action,
    confidence: row.confidence ?? 0,
    distribution: hasDistribution
      ? {
          delete: row.p_delete ?? 0,
          archive: row.p_archive ?? 0,
          keep: row.p_keep ?? 0,
          unsure: row.p_unsure ?? 0,
        }
      : null,
    importance: row.importance,
    ceiling: row.ceiling,
    ceilingApplied: flag(row.ceiling_applied),
    reasons,
    from: { address: row.sender, name: row.sender_name },
    subject: row.subject,
    snippet: row.snippet,
    receivedAt: toIso(row.received_at),
    isRead: flag(row.is_read),
    signals: itemSignals(JSON.parse(row.signals_json) as Signals, row.received_at, now),
    // Gmail links come from plan 02's buildGmailDeepLink; Graph stores webLink per message.
    deepLink:
      account.provider === "gmail" ? buildGmailDeepLink(account.email, row.provider_msg_id) : row.web_link,
    modelVersion: row.model_version,
    policyVersion: row.policy_version,
  };
}

queueRoutes.get("/queue/summary", async (c) => {
  const q = parseWith(SummaryQuerySchema, c.req.query());
  const db = c.env.DB;
  const now = c.get("deps").now();
  const settings = await readSettings(db);
  const ids = (await scopeAccounts(db, q.accountId)).map((a) => a.id);
  const pending = { ...zeroByAction(), total: 0 };
  const groupsByAction = zeroByAction();
  const byAction: Record<ActionKind, number> = { delete: 0, archive: 0, keep: 0 };
  let awaitingModel = 0;
  if (ids.length > 0) {
    const [byActionRes, awaitingRes, cleanupRes] = await db.batch([
      bindQuery(db, pendingByActionQuery(ids)),
      bindQuery(db, awaitingCountQuery(ids)),
      bindQuery(db, cleanupCountsQuery(ids, CLEANUP_DEFAULT_ACTIONS, settings.tauDelete)),
    ]);
    for (const row of (byActionRes?.results ?? []) as { action: SuggestedAction; n: number; g: number }[]) {
      pending[row.action] = row.n;
      pending.total += row.n;
      groupsByAction[row.action] = row.g;
    }
    awaitingModel = ((awaitingRes?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
    for (const row of (cleanupRes?.results ?? []) as { action: ActionKind; n: number }[])
      byAction[row.action] = row.n;
  }
  const body: QueueSummary = {
    asOf: toIso(now),
    pending,
    awaitingModel,
    groups: Object.values(groupsByAction).reduce((s, n) => s + n, 0),
    groupsByAction,
    tauDelete: settings.tauDelete,
    cleanup: {
      threshold: settings.tauDelete,
      count: byAction.delete + byAction.archive + byAction.keep,
      byAction,
    },
  };
  return c.json(body);
});

const GroupCursorSchema = z.strictObject({
  v: z.literal(1),
  f: z.string(),
  k: z.number(),
  a: z.string(),
  s: z.string(),
  x: z.enum(SUGGESTED_ACTIONS),
});

queueRoutes.get("/groups", async (c) => {
  const q = parseWith(GroupsQuerySchema, c.req.query());
  const db = c.env.DB;
  const fingerprint = JSON.stringify([
    q.accountId ?? null,
    q.action ?? null,
    q.sort,
    q.minConfidence ?? null,
  ]);
  const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor, GroupCursorSchema);
  if (cursor && cursor.f !== fingerprint)
    throw new ApiError(400, "validation_failed", "Cursor does not match the filters");
  const accounts = await scopeAccounts(db, q.accountId);
  const page: Page<SenderGroup> = { items: [], nextCursor: null };
  const skips: ReasonSkips = { count: 0 };
  if (accounts.length > 0) {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const query = groupsQuery(
      accounts.map((a) => a.id),
      { action: q.action ?? null, minConfidence: q.minConfidence ?? null, sender: null },
      q.sort,
      cursor ? { k: cursor.k, a: cursor.a, s: cursor.s, x: cursor.x } : null,
      q.limit + 1,
    );
    const rows = (await bindQuery(db, query).run<GroupRow>()).results;
    const pageRows = rows.slice(0, q.limit);
    const reasons = await topReasonsFor(
      db,
      pageRows.map((r) => ({ accountId: r.account_id, sender: r.sender, action: r.action })),
      q.action ?? null,
      skips,
    );
    for (const row of pageRows) {
      const account = byId.get(row.account_id);
      if (account) page.items.push(toSenderGroup(row, account, reasons));
    }
    const last = pageRows[pageRows.length - 1];
    if (rows.length > q.limit && last) {
      page.nextCursor = encodeCursor({
        v: 1,
        f: fingerprint,
        k: groupSortValue(last, q.sort),
        a: last.account_id,
        s: last.sender,
        x: last.action,
      });
    }
  }
  logSkippedReasons(c, skips);
  return c.json(page);
});

const ItemCursorSchema = z.strictObject({
  v: z.literal(1),
  f: z.string(),
  c: z.number(),
  r: z.int(),
  i: z.int(),
});

queueRoutes.get("/groups/:key", async (c) => {
  const key = c.req.param("key");
  const decoded = decodeGroupKey(key);
  if (!decoded) throw new ApiError(400, "validation_failed", "Malformed group key");
  const q = parseWith(PageQuerySchema, c.req.query());
  const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor, ItemCursorSchema);
  if (cursor && cursor.f !== key)
    throw new ApiError(400, "validation_failed", "Cursor does not match the group");
  const db = c.env.DB;
  const now = c.get("deps").now();
  const [account] = await scopeAccounts(db, decoded.accountId);
  if (!account) throw new ApiError(404, "not_found", "Group not found");

  const [groupRes, itemsRes] = await db.batch([
    bindQuery(
      db,
      groupsQuery(
        [account.id],
        { action: decoded.action, minConfidence: null, sender: decoded.sender },
        "confidence_desc",
        null,
        1,
      ),
    ),
    bindQuery(
      db,
      groupItemsQuery(
        account.id,
        decoded.sender,
        decoded.action,
        cursor ? { c: cursor.c, r: cursor.r, i: cursor.i } : null,
        q.limit + 1,
      ),
    ),
  ]);
  const groupRow = (groupRes?.results ?? [])[0] as GroupRow | undefined;
  if (!groupRow) throw new ApiError(404, "not_found", "Group not found");
  const skips: ReasonSkips = { count: 0 };
  const reasons = await topReasonsFor(
    db,
    [{ accountId: account.id, sender: decoded.sender, action: decoded.action }],
    decoded.action,
    skips,
  );
  const rows = (itemsRes?.results ?? []) as GroupItemRow[];
  const pageRows = rows.slice(0, q.limit);
  const last = pageRows[pageRows.length - 1];
  const body: GroupDetail = {
    asOf: toIso(now),
    group: toSenderGroup(groupRow, account, reasons),
    items: {
      items: pageRows.map((row) => toSuggestionItem(row, account, now, skips)),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor({ v: 1, f: key, c: last.confidence ?? 0, r: last.received_at, i: last.message_id })
          : null,
    },
  };
  logSkippedReasons(c, skips);
  return c.json(body);
});
