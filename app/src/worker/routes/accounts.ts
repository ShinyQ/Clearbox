import { MICROSOFT_CONSENT_URLS } from "@clearbox/core";
import { Hono } from "hono";
import { routePath } from "hono/route";
import { PatchAccountBodySchema } from "../../shared/api.ts";
import type { AccountsResponse, AccountView, DisconnectResponse } from "../../shared/api.ts";
import { decryptToken, importEncKey } from "../crypto/aead.ts";
import {
  disconnectAccountStmt,
  getAccount,
  listAccounts,
  setPausedStmt,
  toAccountView,
} from "../db/accounts.ts";
import type { Account } from "../db/accounts.ts";
import { auditStmt } from "../db/audit.ts";
import { countOpenByAccount, dismissOpenStmt } from "../db/suggestions.ts";
import type { AppEnv } from "../env.ts";
import { logEvent } from "../log.ts";
import { ApiError, parseWith, readJsonBody } from "../middleware/errors.ts";
import { runTick } from "../scan/tick.ts";

export const accountsRoutes = new Hono<AppEnv>();

/** Non-disconnected account or 404 not_found. */
export async function loadVisibleAccount(db: D1Database, id: string): Promise<Account> {
  const account = await getAccount(db, id);
  if (!account || account.status === "disconnected")
    throw new ApiError(404, "not_found", "Account not found");
  return account;
}

export async function accountViews(db: D1Database, accounts: readonly Account[]): Promise<AccountView[]> {
  const visible = accounts.filter((a) => a.status !== "disconnected");
  const counts = await countOpenByAccount(
    db,
    visible.map((a) => a.id),
  );
  return visible.map((a) => toAccountView(a, counts.get(a.id) ?? { pending: 0, awaitingModel: 0 }));
}

accountsRoutes.get("/", async (c) => {
  const accounts = await listAccounts(c.env.DB, { includeDisconnected: false });
  const body: AccountsResponse = { accounts: await accountViews(c.env.DB, accounts) };
  return c.json(body);
});

accountsRoutes.patch("/:id", async (c) => {
  const body = parseWith(PatchAccountBodySchema, await readJsonBody(c));
  const db = c.env.DB;
  const account = await loadVisibleAccount(db, c.req.param("id"));
  if (account.paused !== body.paused) {
    const now = c.get("deps").now();
    await db.batch([
      setPausedStmt(db, account.id, body.paused, now),
      auditStmt(db, {
        ts: now,
        accountId: account.id,
        kind: body.paused ? "account_paused" : "account_resumed",
        batchId: null,
        count: 0,
        result: {},
      }),
    ]);
  }
  const [view] = await accountViews(db, [await loadVisibleAccount(db, account.id)]);
  if (!view) throw new ApiError(404, "not_found", "Account not found");
  return c.json(view);
});

accountsRoutes.delete("/:id", async (c) => {
  const db = c.env.DB;
  const deps = c.get("deps");
  const config = c.get("config");
  const account = await loadVisibleAccount(db, c.req.param("id"));

  // Contracts 7.5: Gmail revoke is best effort and runs before the batch; Microsoft has no revoke endpoint.
  let revocation: DisconnectResponse["revocation"] = "not_supported";
  const revoke = deps.oauth[account.provider].revoke;
  if (revoke) {
    revocation = "failed";
    try {
      if (account.refreshToken) {
        const token = await decryptToken(await importEncKey(config.tokenEncKey), account.refreshToken, {
          accountId: account.id,
          kind: "refresh",
          keyVersion: account.keyVersion,
        });
        revocation = (await revoke(deps.fetch, token)) ? "revoked" : "failed";
      }
    } catch (err) {
      // Same fields as onApiError's request.error: never the message, which may carry token data.
      logEvent("request.error", {
        requestId: c.get("requestId"),
        route: routePath(c),
        errorName: err instanceof Error ? err.name : "unknown",
      });
      revocation = "failed";
    }
  }

  const now = deps.now();
  await db.batch([
    disconnectAccountStmt(db, account.id, now),
    dismissOpenStmt(db, account.id, now),
    auditStmt(db, {
      ts: now,
      accountId: account.id,
      kind: "account_disconnected",
      batchId: null,
      count: 0,
      result: {},
    }),
  ]);
  logEvent("account.status", {
    accountId: account.id,
    from: account.status,
    to: "disconnected",
    reason: "owner",
  });

  const body: DisconnectResponse = {
    accountId: account.id,
    revocation,
    consentUrls:
      account.provider === "outlook"
        ? { personal: MICROSOFT_CONSENT_URLS.personal, work: MICROSOFT_CONSENT_URLS.work }
        : null,
  };
  return c.json(body);
});

/** Contracts 7.5: one forced tick for this account. A failed claim throws ApiError (404, 409, 429) for onApiError. */
accountsRoutes.post("/:id/scan", async (c) => {
  const deps = c.get("deps");
  const report = await runTick(c.env, {
    trigger: "scan_now",
    accountId: c.req.param("id"),
    now: deps.now(),
    fetch: deps.fetch,
  });
  return c.json(report);
});
