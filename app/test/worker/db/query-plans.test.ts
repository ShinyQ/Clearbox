import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  awaitingCountQuery,
  cleanupCountsQuery,
  groupItemsQuery,
  groupsQuery,
  pendingByActionQuery,
} from "../../../src/worker/db/suggestions.ts";
import type { SqlQuery } from "../../../src/worker/db/sql.ts";

const ACC = "acc_0000000000000001";

async function plan(q: SqlQuery): Promise<string> {
  const res = await env.DB.prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
    .bind(...q.params)
    .run<{ detail: string }>();
  return res.results.map((r) => r.detail).join("\n");
}

describe("open-suggestion queries use suggestions_open (contracts 6.1)", () => {
  it.each([
    ["queue summary", pendingByActionQuery([ACC])],
    ["awaiting count", awaitingCountQuery([ACC])],
    ["cleanup counts", cleanupCountsQuery([ACC], ["delete", "archive"], 0.8)],
    [
      "groups",
      groupsQuery([ACC], { action: null, minConfidence: null, sender: null }, "confidence_desc", null, 50),
    ],
    ["group items", groupItemsQuery(ACC, "news@example.com", "delete", null, 50)],
  ])("%s", async (_name, q) => {
    expect(await plan(q)).toMatch(/USING (?:COVERING )?INDEX suggestions_open/);
  });
});
