import { DEFAULT_POLICY } from "@clearbox/core";
import { describe, expect, it } from "vitest";
import {
  ApproveBodySchema,
  CleanupBodySchema,
  CleanupPreviewQuerySchema,
  GroupsQuerySchema,
  OAUTH_CALLBACK_ERRORS,
  PageQuerySchema,
  PatchSenderBodySchema,
  PutPolicyBodySchema,
  SuggestionIdsSchema,
} from "../../../src/shared/api.ts";

describe("PageQuerySchema", () => {
  it("coerces limit and defaults to 50", () => {
    expect(PageQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(PageQuerySchema.parse({ limit: "10", cursor: "abc" })).toEqual({ limit: 10, cursor: "abc" });
  });
  it("rejects limit above 100", () => {
    expect(PageQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });
});

describe("SuggestionIdsSchema", () => {
  it("rejects duplicates, empty lists and more than 100 ids", () => {
    expect(SuggestionIdsSchema.safeParse([1, 1]).success).toBe(false);
    expect(SuggestionIdsSchema.safeParse([]).success).toBe(false);
    expect(SuggestionIdsSchema.safeParse(Array.from({ length: 101 }, (_, i) => i + 1)).success).toBe(false);
    expect(SuggestionIdsSchema.safeParse([1, 2, 3]).success).toBe(true);
  });
});

describe("ApproveBodySchema", () => {
  it("accepts ids or a group key with asOf, nothing else", () => {
    expect(ApproveBodySchema.safeParse({ ids: [1] }).success).toBe(true);
    expect(ApproveBodySchema.safeParse({ groupKey: "k", asOf: "2026-10-15T10:00:00.000Z" }).success).toBe(
      true,
    );
    expect(ApproveBodySchema.safeParse({ groupKey: "k" }).success).toBe(false);
    expect(ApproveBodySchema.safeParse({ ids: [1], extra: true }).success).toBe(false);
  });
});

describe("Groups and cleanup queries", () => {
  it("defaults the group sort", () => {
    expect(GroupsQuerySchema.parse({}).sort).toBe("confidence_desc");
  });
  it("validates the cleanup actions CSV", () => {
    expect(CleanupPreviewQuerySchema.safeParse({ actions: "delete,archive" }).success).toBe(true);
    expect(CleanupPreviewQuerySchema.safeParse({ actions: "delete,unsure" }).success).toBe(false);
  });
  it("requires asOf on cleanup", () => {
    expect(CleanupBodySchema.safeParse({ threshold: 0.9 }).success).toBe(false);
  });
});

describe("Policy bodies", () => {
  it("lowercases sender entries", () => {
    expect(PatchSenderBodySchema.parse({ entry: " News@Example.COM ", list: "deny" })).toEqual({
      entry: "news@example.com",
      list: "deny",
    });
  });
  it("requires expectedVersion >= 1", () => {
    expect(PutPolicyBodySchema.safeParse({ policy: DEFAULT_POLICY, expectedVersion: 0 }).success).toBe(false);
    expect(PutPolicyBodySchema.safeParse({ policy: DEFAULT_POLICY, expectedVersion: 1 }).success).toBe(true);
  });
});

describe("OAUTH_CALLBACK_ERRORS", () => {
  it("lists the contracts 7.13 codes", () => {
    expect([...OAUTH_CALLBACK_ERRORS]).toEqual([
      "access_denied",
      "admin_consent_required",
      "state_invalid",
      "token_exchange_failed",
      "provider_config_error",
      "scope_missing",
      "no_refresh_token",
      "profile_failed",
      "provider_not_configured",
    ]);
  });
});
