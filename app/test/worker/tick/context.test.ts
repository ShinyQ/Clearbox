import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  freshContextStatements,
  parseContext,
  redecideContextStatements,
} from "../../../src/worker/scan/context.ts";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  NOW,
  MINUTE,
  all,
  resetDb,
  seedLabel,
  seedMessage,
  seedTickAccount,
} from "../helpers/tick-db.ts";

async function exec(tagged: ReturnType<typeof freshContextStatements>) {
  const res = await env.DB.batch(tagged.map((t) => env.DB.prepare(t.stmt.sql).bind(...t.stmt.params)));
  return parseContext(tagged, res);
}

describe("context reads", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTickAccount({ id: ACCOUNT_A });
    await seedTickAccount({ id: ACCOUNT_B, email: "other@example.test" });
  });

  it("loads known ids, priors, sender stats, correspondents, threads and newest five labels, for this account only", async () => {
    await seedMessage(ACCOUNT_A, { providerId: "known-1" });
    await seedMessage(ACCOUNT_B, { providerId: "known-2" });
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sender_priors (account_id, key, deletes, keeps, updated_at) VALUES (?1, 'news@shop.example', 4, 1, 0), (?1, '@shop.example', 9, 2, 0)",
      ).bind(ACCOUNT_A),
      env.DB.prepare(
        "INSERT INTO senders (account_id, address, domain, seen_count, read_count, last_seen_at) VALUES (?1, 'news@shop.example', 'shop.example', 7, 1, 0)",
      ).bind(ACCOUNT_A),
      env.DB.prepare(
        "INSERT INTO correspondents (account_id, address, last_sent_at) VALUES (?1, 'news@shop.example', 0)",
      ).bind(ACCOUNT_A),
      env.DB.prepare(
        "INSERT INTO sent_threads (account_id, thread_id, last_sent_at) VALUES (?1, 't-1', 0)",
      ).bind(ACCOUNT_A),
    ]);
    for (let i = 0; i < 7; i++)
      await seedLabel(ACCOUNT_A, { subject: `L${i}`, pDelete: 0.9, margin: 0.8, ownerAction: "delete" });
    const { ctx } = await exec(
      freshContextStatements(ACCOUNT_A, {
        providerIds: ["known-1", "known-2", "new"],
        senders: ["news@shop.example"],
        domains: ["shop.example"],
        threadIds: ["t-1", "t-2"],
      }),
    );
    expect([...ctx.known]).toEqual(["known-1"]);
    expect(ctx.priors.get("news@shop.example")).toEqual({ deletes: 4, keeps: 1 });
    expect(ctx.priors.get("@shop.example")).toEqual({ deletes: 9, keeps: 2 });
    expect(ctx.senders.get("news@shop.example")).toEqual({ seen: 7, read: 1 });
    expect(ctx.correspondents.has("news@shop.example")).toBe(true);
    expect([...ctx.repliedThreads]).toEqual(["t-1"]);
    expect(ctx.labelsBySender.get("news@shop.example")?.map((l) => l.subject_trunc)).toEqual([
      "L6",
      "L5",
      "L4",
      "L3",
      "L2",
    ]);
    expect(ctx.labelsByDomain.get("shop.example")).toHaveLength(5);
  });

  it("chunks IN lists at 90 values, always scopes by account_id and skips empty lists", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `id-${i}`);
    const tagged = freshContextStatements(ACCOUNT_A, {
      providerIds: ids,
      senders: [],
      domains: [],
      threadIds: [],
    });
    expect(tagged.map((t) => t.tag)).toEqual(["known", "known", "known"]);
    for (const t of tagged) {
      expect(t.stmt.sql).toContain("account_id = ?1");
      expect(t.stmt.params.length).toBeLessThanOrEqual(91);
    }
  });

  it("emits no statement for any empty key list and parses an empty page", () => {
    const empty = freshContextStatements(ACCOUNT_A, {
      providerIds: [],
      senders: [],
      domains: [],
      threadIds: [],
    });
    expect(empty).toEqual([]);
    const noThreads = freshContextStatements(ACCOUNT_A, {
      providerIds: ["m"],
      senders: [],
      domains: [],
      threadIds: [],
    });
    expect(noThreads.map((t) => t.tag)).toEqual(["known"]);
    for (const t of noThreads) expect(t.stmt.sql).not.toMatch(/IN \(\s*\)/);
    const parsed = parseContext(empty, []);
    expect(parsed.ctx.known.size).toBe(0);
    expect(parsed.redecideRows).toEqual([]);
  });

  it("chunks sender, domain, thread and prior key lists within the 90 value limit", () => {
    const many = (prefix: string) => Array.from({ length: 100 }, (_, i) => `${prefix}${i}`);
    const tagged = freshContextStatements(ACCOUNT_A, {
      providerIds: [],
      senders: many("s"),
      domains: many("d"),
      threadIds: many("t"),
    });
    const count = (tag: string) => tagged.filter((t) => t.tag === tag).length;
    expect(count("priors")).toBe(3);
    expect(count("senders")).toBe(2);
    expect(count("correspondents")).toBe(2);
    expect(count("threads")).toBe(2);
    expect(count("labels_sender")).toBe(2);
    expect(count("labels_domain")).toBe(2);
    for (const t of tagged) expect(t.stmt.params.length).toBeLessThanOrEqual(91);
  });

  it("loads only due awaiting_model rows for redecide, using the open-suggestions index", async () => {
    await seedMessage(ACCOUNT_A, {
      providerId: "due",
      status: "awaiting_model",
      retryAfter: NOW - 1,
      decisionAttempts: 1,
    });
    await seedMessage(ACCOUNT_A, {
      providerId: "later",
      status: "awaiting_model",
      retryAfter: NOW + MINUTE,
      decisionAttempts: 1,
    });
    await seedMessage(ACCOUNT_A, { providerId: "pending" });
    const tagged = redecideContextStatements(ACCOUNT_A, NOW, 25);
    const { redecideRows } = await exec(tagged);
    expect(redecideRows.map((r) => r.provider_msg_id)).toEqual(["due"]);
    expect(redecideRows[0]?.decision_attempts).toBe(1);
    const first = tagged[0];
    if (first === undefined) throw new Error("no redecide statement");
    const plan = await all<{ detail: string }>(`EXPLAIN QUERY PLAN ${first.stmt.sql}`, ...first.stmt.params);
    expect(plan.map((p) => p.detail).join("\n")).toMatch(/USING (COVERING )?INDEX suggestions_open/);
  });
});
