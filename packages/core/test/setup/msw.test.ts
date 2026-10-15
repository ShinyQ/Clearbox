import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "./msw.ts";

describe("shared MSW server", () => {
  it("serves handlers added with server.use", async () => {
    server.use(http.get("https://api.example.test/ping", () => HttpResponse.json({ pong: true })));
    const res = await fetch("https://api.example.test/ping");
    expect(await res.json()).toEqual({ pong: true });
  });
});
