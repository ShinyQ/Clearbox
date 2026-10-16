import { beforeEach, describe, expect, it } from "vitest";
import { ProviderMock, expectNoUnhandled, mail, useNetwork } from "../helpers/provider-mock.ts";
import {
  ACCOUNT_A,
  count,
  decryptAccountToken,
  getAccount,
  one,
  resetDb,
  seedMessage,
  seedTickAccount,
} from "../helpers/tick-db.ts";

describe("scan test harness", () => {
  beforeEach(resetDb);

  it("seeds an account with encrypted tokens that decrypt back", async () => {
    await seedTickAccount({ refreshToken: "refresh-x", accessToken: "access-x" });
    expect(await decryptAccountToken(ACCOUNT_A, "refresh")).toBe("refresh-x");
    expect(await decryptAccountToken(ACCOUNT_A, "access")).toBe("access-x");
    expect((await getAccount(ACCOUNT_A)).phase).toBe("inbox_backfill");
  });

  it("seeds a version-2 row with matching AAD and key_version column", async () => {
    await seedTickAccount({ keyVersion: 2, refreshToken: "refresh-v2" });
    expect(await decryptAccountToken(ACCOUNT_A, "refresh")).toBe("refresh-v2");
    expect(
      await one<{ key_version: number }>("SELECT key_version FROM accounts WHERE id = ?1", ACCOUNT_A),
    ).toEqual({
      key_version: 2,
    });
  });

  it("seeds messages with suggestions", async () => {
    await seedTickAccount();
    await seedMessage(ACCOUNT_A, { providerId: "p-1" });
    expect(await count("suggestions", "account_id = ?1", ACCOUNT_A)).toBe(1);
  });

  it("serves a Graph inbox page newest first", async () => {
    const mock = new ProviderMock();
    mock.inbox = [mail(2), mail(0), mail(1)];
    useNetwork(mock.handlers());
    const res = await fetch("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=2");
    const body = (await res.json()) as { value: { id: string }[] };
    expect(body.value.map((m) => m.id)).toEqual(["msg-000", "msg-001"]);
    expect(mock.calls).toEqual(["GET https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages"]);
  });

  it("records unmocked requests and expectNoUnhandled reports them", async () => {
    useNetwork(new ProviderMock().handlers());
    expect(() => expectNoUnhandled()).not.toThrow();
    const res = await fetch("https://unmocked.example.test/some/path?secret=1", { method: "POST" });
    expect(res.status).toBe(500);
    expect(() => expectNoUnhandled()).toThrow("POST https://unmocked.example.test/some/path");
    try {
      expectNoUnhandled();
    } catch (e) {
      expect((e as Error).message).not.toContain("secret");
    }
  });

  it("starts each test with an empty unhandled list", () => {
    expect(() => expectNoUnhandled()).not.toThrow();
  });
});
