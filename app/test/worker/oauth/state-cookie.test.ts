import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { base64ToBytes } from "../../../src/worker/crypto/base64.ts";
import { importSigningKey } from "../../../src/worker/crypto/hmac.ts";
import {
  CLEAR_OAUTH_COOKIE,
  createOAuthState,
  OAUTH_COOKIE_NAME,
  readCookie,
  verifyOAuthState,
} from "../../../src/worker/oauth/state-cookie.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
const key = () => importSigningKey(base64ToBytes(env.STATE_SIGNING_KEY));

async function issued() {
  const created = await createOAuthState(await key(), "gmail", NOW);
  const cookie = created.setCookie.split(";")[0] ?? "";
  return { created, cookie };
}

describe("OAuth state cookie", () => {
  it("sets a __Host- cookie with the contracts 7.12 attributes and payload", async () => {
    const { created } = await issued();
    expect(created.setCookie).toMatch(/^__Host-clearbox_oauth=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; /);
    expect(created.setCookie).toContain("Max-Age=600");
    expect(created.setCookie).toContain("Path=/");
    expect(created.setCookie).toContain("HttpOnly");
    expect(created.setCookie).toContain("Secure");
    expect(created.setCookie).toContain("SameSite=Lax");
    expect(created.payload.p).toBe("gmail");
    expect(created.payload.n).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.payload.v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.payload.e).toBe(NOW + 600_000);
  });

  it("verifies a matching callback", async () => {
    const { created, cookie } = await issued();
    const result = await verifyOAuthState(
      await key(),
      `other=1; ${cookie}`,
      "gmail",
      created.payload.n,
      NOW + 1_000,
    );
    expect(result).toEqual({ ok: true, payload: created.payload });
  });

  it("rejects missing, malformed, tampered, expired, mismatched provider and mismatched state", async () => {
    const { created, cookie } = await issued();
    const k = await key();
    const [name, value] = cookie.split("=");
    const [body, sig] = (value ?? "").split(".");
    const flip = (v: string) => (v.startsWith("A") ? "B" : "A") + v.slice(1);
    const tamperedBody = `${name}=${flip(body ?? "")}.${sig}`;
    const tamperedSig = `${name}=${body}.${flip(sig ?? "")}`;
    const cases: [string | null, "gmail" | "outlook", string | null, number, string][] = [
      [null, "gmail", created.payload.n, NOW, "missing"],
      [`${OAUTH_COOKIE_NAME}=nodot`, "gmail", created.payload.n, NOW, "malformed"],
      [tamperedBody, "gmail", created.payload.n, NOW, "bad_signature"],
      [tamperedSig, "gmail", created.payload.n, NOW, "bad_signature"],
      [cookie, "gmail", created.payload.n, NOW + 600_001, "expired"],
      [cookie, "outlook", created.payload.n, NOW, "provider_mismatch"],
      [cookie, "gmail", "different-state", NOW, "state_mismatch"],
      [cookie, "gmail", null, NOW, "state_mismatch"],
    ];
    for (const [header, provider, state, now, reason] of cases) {
      expect(await verifyOAuthState(k, header, provider, state, now)).toEqual({ ok: false, reason });
    }
  });

  it("parses cookies and clears with Max-Age=0", () => {
    expect(readCookie("a=1; __Host-clearbox_oauth=x.y; b=2", OAUTH_COOKIE_NAME)).toBe("x.y");
    expect(readCookie("a=1", OAUTH_COOKIE_NAME)).toBeNull();
    expect(readCookie(null, OAUTH_COOKIE_NAME)).toBeNull();
    expect(CLEAR_OAUTH_COOKIE).toBe(
      "__Host-clearbox_oauth=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
  });
});
