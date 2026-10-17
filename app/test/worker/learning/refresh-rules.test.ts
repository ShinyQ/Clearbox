import { DEFAULT_POLICY } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CleanupPreview, PolicyResponse, RuleSuggestionsResponse } from "../../../src/shared/api.ts";
import { refreshPending, refreshScoped } from "../../../src/worker/actions/refresh.ts";
import { createApp } from "../../../src/worker/app.ts";
import { priorUpsertStmt } from "../../../src/worker/db/priors.ts";
import { readSettings } from "../../../src/worker/db/settings.ts";
import { changedSenderEntries } from "../../../src/worker/routes/policy.ts";
import { openRuleCandidates, pickRuleSuggestions } from "../../../src/worker/routes/rules.ts";
import { FakeProvider, fakeOAuth } from "../helpers/fake-provider.ts";
import { apiFetch, jsonInit, readJson } from "../helpers/request.ts";
import { SEED_NOW, getSuggestionRow, seedAccount, seedLabels, seedSuggestions } from "../helpers/seed.ts";

const DAY = 86_400_000;
const KEEP_LEANING = { delete: 0.2, archive: 0.1, keep: 0.6, unsure: 0.1 };

function setup() {
  const fake = new FakeProvider();
  const app = createApp({ now: () => SEED_NOW, providerFactory: fake.factory(), oauth: fakeOAuth().oauth });
  return { app, fake };
}

/** Pending keep suggestions that kept their raw model output (written by a tick after migration 0003). */
async function seedKeeps(
  accountId: string,
  sender: string,
  n: number,
  ceiling: "delete" | "archive" = "delete",
) {
  const ids = await seedSuggestions(accountId, n, (i) => ({
    sender,
    senderDomain: sender.split("@")[1] ?? "",
    action: "keep",
    confidence: 0.6,
    distribution: KEEP_LEANING,
    ceiling,
    receivedAt: SEED_NOW - (10 + i) * DAY,
    reasons: [],
  }));
  for (const id of ids) {
    await env.DB.prepare(
      "UPDATE suggestions SET model_action_json = ?2, segment = 'other' WHERE message_id = ?1",
    )
      .bind(id, JSON.stringify(KEEP_LEANING))
      .run();
  }
  return ids;
}

async function prior(accountId: string, key: string, deletes: number, keeps: number) {
  await priorUpsertStmt(env.DB, accountId, key, { deletes, keeps }, SEED_NOW).run();
}

describe("refreshPending (contracts 12.10)", () => {
  it("turns stale keeps into trash once owner decisions agree, and writes only changed rows", async () => {
    const acc = await seedAccount();
    const ids = await seedKeeps(acc.id, "alerts@notify.example.com", 3);
    const [capped] = await seedKeeps(acc.id, "alerts@notify.example.com", 1, "archive");
    const settings = await readSettings(env.DB);

    // The first pass normalizes the seeded rows; a second pass with nothing new writes nothing.
    await refreshPending(env.DB, { accountId: acc.id }, settings, SEED_NOW);
    const idle = await refreshPending(env.DB, { accountId: acc.id }, settings, SEED_NOW);
    expect(idle).toMatchObject({ scanned: 4, updated: 0, rowsWritten: 0 });

    await prior(acc.id, "alerts@notify.example.com", 40, 0);
    const out = await refreshPending(
      env.DB,
      { accountId: acc.id, senders: ["alerts@notify.example.com"] },
      settings,
      SEED_NOW,
    );
    expect(out).toMatchObject({ scanned: 4, updated: 4 });
    for (const id of ids) {
      expect(await getSuggestionRow(id)).toMatchObject({ action: "delete", segment: "sender" });
    }
    // A refresh never lifts a stored ceiling: the attachment cap stays at archive.
    expect(await getSuggestionRow(capped ?? 0)).toMatchObject({ ceiling: "archive" });
    expect((await getSuggestionRow(capped ?? 0))?.action).not.toBe("delete");
  });

  it("skips rows without a stored model output", async () => {
    const acc = await seedAccount();
    await seedSuggestions(acc.id, 2, { sender: "legacy@old.example.com", action: "keep" });
    const out = await refreshPending(env.DB, { accountId: acc.id }, await readSettings(env.DB), SEED_NOW);
    expect(out.scanned).toBe(0);
  });
});

describe("owner actions refresh the rest of the sender", () => {
  it("moves the remaining keeps off Keep after the owner trashes the sender's emails", async () => {
    const { app } = setup();
    const acc = await seedAccount();
    const ids = await seedKeeps(acc.id, "digest@feed.example.org", 12);
    const res = await apiFetch(
      "/api/override",
      jsonInit("POST", { ids: ids.slice(0, 10), action: "delete" }),
      { app },
    );
    expect(res.status).toBe(200);
    for (const id of ids.slice(10)) expect((await getSuggestionRow(id))?.action).not.toBe("keep");
  });
});

describe("PATCH /api/policy/senders refreshes pending suggestions", () => {
  it("applies Always OK to trash to what is already in Review", async () => {
    const { app } = setup();
    const acc = await seedAccount();
    const [id] = await seedKeeps(acc.id, "promo@deals.example.net", 1);
    const res = await apiFetch(
      "/api/policy/senders",
      jsonInit("PATCH", { entry: "promo@deals.example.net", list: "deny" }),
      { app },
    );
    expect((await readJson<PolicyResponse>(res)).policy.denylist).toContain("promo@deals.example.net");
    expect(await getSuggestionRow(id ?? 0)).toMatchObject({
      action: "delete",
      segment: "rule",
      delete_tau: 0,
    });
  });
});

describe("Clean up uses each trash suggestion's own threshold", () => {
  it("takes a trash suggestion that passed its segment threshold even below tau_delete; archive still needs it", async () => {
    const { app } = setup();
    const acc = await seedAccount();
    await env.DB.prepare("UPDATE settings SET value = '0.99' WHERE key = 'tau_delete'").run();
    const [trash] = await seedSuggestions(acc.id, 1, {
      sender: "a@bulk.example.com",
      action: "delete",
      confidence: 0.85,
    });
    await seedSuggestions(acc.id, 1, { sender: "b@bulk.example.com", action: "archive", confidence: 0.85 });
    await seedSuggestions(acc.id, 1, { sender: "c@bulk.example.com", action: "delete", confidence: 0.85 });
    await env.DB.prepare("UPDATE suggestions SET delete_tau = 0.8, segment = 'bulk' WHERE message_id = ?1")
      .bind(trash)
      .run();
    const preview = await readJson<CleanupPreview>(
      await apiFetch(`/api/cleanup/preview?accountId=${acc.id}`, {}, { app }),
    );
    // Legacy trash at 0.85 (no delete_tau) and archive at 0.85 still need 0.99.
    expect(preview.byAction).toMatchObject({ delete: 1, archive: 0 });
  });
});

describe("GET /api/rules/suggestions", () => {
  async function trashes(
    accountId: string,
    sender: string,
    n: number,
    ownerAction: "delete" | "keep" = "delete",
  ) {
    await seedLabels(accountId, n, (i) => ({
      sender,
      senderDomain: sender.split("@")[1] ?? "",
      ownerAction,
      createdAt: SEED_NOW - 40 * DAY - i * 1_000,
    }));
    await prior(accountId, sender, ownerAction === "delete" ? n : 0, ownerAction === "delete" ? 0 : n);
  }

  it("offers Always OK to trash after 10 consistent trashes, and Always keep after 10 keeps", async () => {
    const { app } = setup();
    const acc = await seedAccount();
    await trashes(acc.id, "spam1@rules.example.com", 12);
    await trashes(acc.id, "few@rules.example.com", 9);
    await trashes(acc.id, "friend@rules.example.org", 11, "keep");
    const body = await readJson<RuleSuggestionsResponse>(
      await apiFetch("/api/rules/suggestions", {}, { app }),
    );
    const ours = body.suggestions.filter((s) => s.entry.includes("@rules.example."));
    expect(ours.map((s) => [s.entry, s.list, s.agreeing])).toEqual([
      ["spam1@rules.example.com", "deny", 12],
      ["friend@rules.example.org", "allow", 11],
    ]);
  });

  it("skips senders with a recent contrary decision, listed senders and dismissed suggestions", async () => {
    const { app } = setup();
    const acc = await seedAccount();
    await trashes(acc.id, "mixed@skip.example.com", 12);
    await seedLabels(acc.id, 1, {
      sender: "mixed@skip.example.com",
      senderDomain: "skip.example.com",
      ownerAction: "keep",
      createdAt: SEED_NOW - DAY,
    });
    await trashes(acc.id, "listed@skip.example.com", 12);
    await trashes(acc.id, "dismiss@skip.example.com", 12);
    await apiFetch("/api/policy/senders", jsonInit("PATCH", { entry: "@skip.example.com", list: "none" }), {
      app,
    });
    await apiFetch(
      "/api/policy/senders",
      jsonInit("PATCH", { entry: "listed@skip.example.com", list: "deny" }),
      {
        app,
      },
    );
    const dismissed = await apiFetch(
      "/api/rules/suggestions/dismiss",
      jsonInit("POST", { entry: "dismiss@skip.example.com", list: "deny" }),
      { app },
    );
    expect(dismissed.status).toBe(204);
    const body = await readJson<RuleSuggestionsResponse>(
      await apiFetch("/api/rules/suggestions", {}, { app }),
    );
    expect(body.suggestions.map((s) => s.entry).filter((e) => e.endsWith("@skip.example.com"))).toEqual([]);
  });
});

describe("PUT /api/policy refreshes changed list entries", () => {
  it("finds added and removed entries in either list", () => {
    const base = { ...DEFAULT_POLICY, allowlist: ["a@x.example"], denylist: ["@y.example"] };
    expect(
      changedSenderEntries(base, { ...base, allowlist: [], denylist: ["@y.example", "b@z.example"] }),
    ).toEqual(["a@x.example", "b@z.example"]);
  });

  it("re-fuses suggestions of a sender added on a full save", async () => {
    const { app } = setup();
    const acc = await seedAccount();
    const [id] = await seedKeeps(acc.id, "promo@save.example.net", 1);
    const current = await readJson<PolicyResponse>(await apiFetch("/api/policy", {}, { app }));
    const res = await apiFetch(
      "/api/policy",
      jsonInit("PUT", {
        policy: { ...current.policy, denylist: [...current.policy.denylist, "promo@save.example.net"] },
        expectedVersion: current.version,
      }),
      { app },
    );
    expect(res.status).toBe(200);
    expect(await getSuggestionRow(id ?? 0)).toMatchObject({ action: "delete", segment: "rule" });
  });
});

describe("review fixes", () => {
  it("refreshes every decided domain, past the first parameter chunk", async () => {
    await env.DB.prepare("UPDATE settings SET value = '0.8' WHERE key = 'tau_delete'").run();
    const acc = await seedAccount();
    const [id] = await seedKeeps(acc.id, "alerts@d100.example.com", 1);
    await prior(acc.id, "alerts@d100.example.com", 40, 0);
    const domains = Array.from({ length: 120 }, (_, i) => `d${i}.example.com`);
    const out = await refreshScoped(
      env.DB,
      acc.id,
      { senders: [], domains },
      await readSettings(env.DB),
      SEED_NOW,
    );
    expect(out.d1Calls).toBeGreaterThanOrEqual(2);
    expect(await getSuggestionRow(id ?? 0)).toMatchObject({ action: "delete" });
  });

  it("offers Always keep at 95% keeps, and listed senders never crowd out others", () => {
    const settings = {
      policy: { ...DEFAULT_POLICY, denylist: ["@bulk.example.com"] },
      ruleDismissals: [{ entry: "gone@x.example.com", list: "deny" as const, at: 0 }],
    };
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => ({ sender: `s${i}@bulk.example.com`, deletes: 99, keeps: 0 })),
      { sender: "gone@x.example.com", deletes: 50, keeps: 0 },
      { sender: "open@y.example.com", deletes: 12, keeps: 0 },
    ];
    expect(openRuleCandidates(rows, settings)).toEqual(["open@y.example.com"]);
    const picked = pickRuleSuggestions(
      [
        {
          sender: "friend@z.example.org",
          deletes: 1,
          keeps: 40,
          archives: 0,
          last_at: SEED_NOW,
          last_not_delete: SEED_NOW,
          last_not_keep: SEED_NOW - 60 * DAY,
        },
      ],
      { policy: DEFAULT_POLICY, ruleDismissals: [] },
      SEED_NOW,
    );
    expect(picked.map((p) => [p.entry, p.list])).toEqual([["friend@z.example.org", "allow"]]);
  });
});
