import { DEFAULT_POLICY, PolicySchema, scanHistoryWidened } from "@clearbox/core";
import type { Policy } from "@clearbox/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { PatchSenderBodySchema, PutPolicyBodySchema } from "../../shared/api.ts";
import type { PolicyResponse } from "../../shared/api.ts";
import { refreshForEntries } from "../actions/refresh.ts";
import { readSettings, writePolicy } from "../db/settings.ts";
import type { AppEnv } from "../env.ts";
import { logEvent } from "../log.ts";
import { ApiError, parseWith, readJsonBody } from "../middleware/errors.ts";

export const policyRoutes = new Hono<AppEnv>();

const PATCH_ATTEMPTS = 3;
/** Contracts 12.10: list entries re-fused right away on a full save; the nightly job covers the rest. */
export const PUT_REFRESH_MAX_ENTRIES = 10;

/** Entries added to or removed from either list between two policies, in a stable order. */
export function changedSenderEntries(prev: Policy, next: Policy): string[] {
  const out = new Set<string>();
  for (const [a, b] of [
    [prev.allowlist, next.allowlist],
    [prev.denylist, next.denylist],
  ] as const) {
    for (const e of a) if (!b.includes(e)) out.add(e);
    for (const e of b) if (!a.includes(e)) out.add(e);
  }
  return [...out].sort();
}

async function refreshEntries(
  c: Context<AppEnv>,
  entries: readonly string[],
  settings: Parameters<typeof refreshForEntries>[2],
  now: number,
  route: string,
): Promise<void> {
  try {
    await refreshForEntries(c.env.DB, entries, settings, now);
  } catch (err) {
    // Best effort: the rules are already saved, and the nightly job re-fuses everything pending.
    logEvent("request.error", {
      requestId: c.get("requestId"),
      route,
      errorName: err instanceof Error ? err.name : "unknown",
    });
  }
}

async function policyResponse(c: Context<AppEnv>): Promise<Response> {
  const settings = await readSettings(c.env.DB);
  const body: PolicyResponse = {
    policy: settings.policy,
    version: settings.policyVersion,
    defaults: DEFAULT_POLICY,
  };
  return c.json(body);
}

/** Contracts 7.11: adding to one list removes the entry from the other; "none" removes it from both. */
export function applySenderPatch(policy: Policy, entry: string, list: "allow" | "deny" | "none"): Policy {
  const allowlist = policy.allowlist.filter((e) => e !== entry);
  const denylist = policy.denylist.filter((e) => e !== entry);
  if (list === "allow") allowlist.push(entry);
  if (list === "deny") denylist.push(entry);
  return { ...policy, allowlist, denylist };
}

policyRoutes.get("/", (c) => policyResponse(c));

policyRoutes.put("/", async (c) => {
  const body = parseWith(PutPolicyBodySchema, await readJsonBody(c));
  // If the stored policy changes after this read, expectedVersion no longer matches and the whole batch is a no-op.
  const current = await readSettings(c.env.DB);
  const resumeBackfill = scanHistoryWidened(current.policy.scanHistoryDays, body.policy.scanHistoryDays);
  const now = c.get("deps").now();
  const version = await writePolicy(c.env.DB, body.policy, body.expectedVersion, now, {
    resumeBackfill,
  });
  if (version === null) throw new ApiError(409, "conflict", "The policy changed; reload and try again");
  const changed = changedSenderEntries(current.policy, body.policy).slice(0, PUT_REFRESH_MAX_ENTRIES);
  await refreshEntries(c, changed, { ...current, policy: body.policy }, now, "/api/policy");
  return policyResponse(c);
});

policyRoutes.patch("/senders", async (c) => {
  const body = parseWith(PatchSenderBodySchema, await readJsonBody(c));
  for (let attempt = 0; attempt < PATCH_ATTEMPTS; attempt++) {
    const settings = await readSettings(c.env.DB);
    const next = parseWith(PolicySchema, applySenderPatch(settings.policy, body.entry, body.list));
    const now = c.get("deps").now();
    const version = await writePolicy(c.env.DB, next, settings.policyVersion, now);
    if (version !== null) {
      // contracts 12.10: the new rule reaches pending suggestions now.
      await refreshEntries(c, [body.entry], { ...settings, policy: next }, now, "/api/policy/senders");
      return policyResponse(c);
    }
  }
  throw new ApiError(409, "conflict", "The policy changed; reload and try again");
});
