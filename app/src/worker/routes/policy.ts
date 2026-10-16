import { DEFAULT_POLICY, PolicySchema, scanHistoryWidened } from "@clearbox/core";
import type { Policy } from "@clearbox/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { PatchSenderBodySchema, PutPolicyBodySchema } from "../../shared/api.ts";
import type { PolicyResponse } from "../../shared/api.ts";
import { readSettings, writePolicy } from "../db/settings.ts";
import type { AppEnv } from "../env.ts";
import { ApiError, parseWith, readJsonBody } from "../middleware/errors.ts";

export const policyRoutes = new Hono<AppEnv>();

const PATCH_ATTEMPTS = 3;

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
  const version = await writePolicy(c.env.DB, body.policy, body.expectedVersion, c.get("deps").now(), {
    resumeBackfill,
  });
  if (version === null) throw new ApiError(409, "conflict", "The policy changed; reload and try again");
  return policyResponse(c);
});

policyRoutes.patch("/senders", async (c) => {
  const body = parseWith(PatchSenderBodySchema, await readJsonBody(c));
  for (let attempt = 0; attempt < PATCH_ATTEMPTS; attempt++) {
    const settings = await readSettings(c.env.DB);
    const next = parseWith(PolicySchema, applySenderPatch(settings.policy, body.entry, body.list));
    const version = await writePolicy(c.env.DB, next, settings.policyVersion, c.get("deps").now());
    if (version !== null) return policyResponse(c);
  }
  throw new ApiError(409, "conflict", "The policy changed; reload and try again");
});
