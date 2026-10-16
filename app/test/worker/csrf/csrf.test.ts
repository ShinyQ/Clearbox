import { describe, expect, it } from "vitest";
import type { ApiErrorBody } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import { apiFetch, jsonInit, readJson } from "../helpers/request.ts";

function testApp() {
  const app = createApp();
  app.get("/api/test/item", (c) => c.json({ ok: true }));
  app.post("/api/test/item", (c) => c.json({ ok: true }));
  app.put("/api/test/item", (c) => c.json({ ok: true }));
  app.patch("/api/test/item", (c) => c.json({ ok: true }));
  app.delete("/api/test/item", (c) => c.json({ ok: true }));
  return app;
}

describe("csrfGuard", () => {
  it("allows GET without the header", async () => {
    expect((await apiFetch("/api/test/item", {}, { app: testApp() })).status).toBe(200);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "requires X-Clearbox-CSRF: 1 on %s",
    async (method) => {
      const missing = await apiFetch("/api/test/item", jsonInit(method, {}), { app: testApp(), csrf: null });
      expect(missing.status).toBe(403);
      expect((await readJson<ApiErrorBody>(missing)).error.code).toBe("csrf_required");
      const wrong = await apiFetch("/api/test/item", jsonInit(method, {}), { app: testApp(), csrf: "0" });
      expect(wrong.status).toBe(403);
      const ok = await apiFetch("/api/test/item", jsonInit(method, {}), { app: testApp() });
      expect(ok.status).toBe(200);
    },
  );

  it("never sends CORS headers", async () => {
    const res = await apiFetch(
      "/api/test/item",
      { headers: { Origin: "https://evil.example" } },
      { app: testApp() },
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
