import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SECRET_NAMES,
  SECRET_SPECS,
  SetupError,
  accessInstructions,
  compareVersions,
  extractDatabases,
  extractSecretNames,
  extractWorkerId,
  normalizeEndpoint,
  normalizeOrigin,
  normalizeTeamDomain,
  oauthInstructions,
  parseJsonOutput,
  parseLocalConfig,
  redirectUris,
  renderSecretsFile,
  serializeLocalConfig,
  specFor,
  validateDeploymentName,
  validateEndpoint,
  validateTeamDomain,
} from "../lib/setup-config.ts";

describe("SECRET_SPECS", () => {
  it("covers every secret from contracts 3.7 exactly once, in order", () => {
    assert.deepEqual(
      SECRET_SPECS.map((s) => s.name),
      [...SECRET_NAMES],
    );
  });

  it("generates only the two keys", () => {
    assert.deepEqual(
      SECRET_SPECS.filter((s) => s.source === "generated").map((s) => s.name),
      ["TOKEN_ENC_KEY", "STATE_SIGNING_KEY"],
    );
  });

  it("hides every credential prompt", () => {
    for (const name of ["AZURE_DECISION_KEY", "GOOGLE_CLIENT_SECRET", "MS_CLIENT_SECRET"] as const) {
      assert.equal(specFor(name).hidden, true, name);
    }
  });
});

describe("endpoint", () => {
  it("normalizes a trailing slash and case", () => {
    assert.equal(
      normalizeEndpoint(" https://My-Acct.services.ai.azure.com/ "),
      "https://my-acct.services.ai.azure.com",
    );
  });

  it("accepts only the account root", () => {
    assert.equal(validateEndpoint("https://acct.services.ai.azure.com"), null);
    assert.notEqual(validateEndpoint("https://acct.services.ai.azure.com/api/projects/p"), null);
    assert.notEqual(validateEndpoint("https://acct.cognitiveservices.azure.com"), null);
    assert.notEqual(validateEndpoint("http://acct.services.ai.azure.com"), null);
  });
});

describe("validateDeploymentName", () => {
  it("rejects the reserved model name", () => {
    assert.match(validateDeploymentName("Microsoft-Decision-1") ?? "", /deployment name/);
    assert.equal(validateDeploymentName("decision-1"), null);
    assert.notEqual(validateDeploymentName("bad name"), null);
  });
});

describe("team domain", () => {
  it("expands short forms", () => {
    assert.equal(normalizeTeamDomain("my-team"), "https://my-team.cloudflareaccess.com");
    assert.equal(
      normalizeTeamDomain("My-Team.cloudflareaccess.com/"),
      "https://my-team.cloudflareaccess.com",
    );
    assert.equal(
      normalizeTeamDomain("https://my-team.cloudflareaccess.com"),
      "https://my-team.cloudflareaccess.com",
    );
    assert.equal(validateTeamDomain("https://my-team.cloudflareaccess.com"), null);
    assert.notEqual(validateTeamDomain("https://example.com"), null);
  });
});

describe("secret validators", () => {
  it("validates client ids", () => {
    assert.equal(specFor("GOOGLE_CLIENT_ID").validate("1234-abc.apps.googleusercontent.com"), null);
    assert.notEqual(specFor("GOOGLE_CLIENT_ID").validate("not-a-client"), null);
    assert.equal(specFor("MS_CLIENT_ID").validate("0d9f1c2e-1111-4222-8333-444455556666"), null);
    assert.notEqual(specFor("MS_CLIENT_ID").validate("0d9f1c2e"), null);
  });

  it("lowercases the owner email", () => {
    const spec = specFor("OWNER_EMAIL");
    assert.equal(spec.normalize(" Owner@Example.TEST "), "owner@example.test");
    assert.equal(spec.validate("owner@example.test"), null);
    assert.notEqual(spec.validate("owner"), null);
  });
});

describe("compareVersions", () => {
  it("compares numerically and ignores prerelease tags", () => {
    assert.equal(compareVersions("24.13.1", "24.13.0"), 1);
    assert.equal(compareVersions("v24.9.0", "24.13.0"), -1);
    assert.equal(compareVersions("12.11.2\n", "12.0.0"), 1);
    assert.equal(compareVersions("1.0.0-beta.17", "1.0.0"), 0);
  });
});

describe("parseJsonOutput", () => {
  it("parses plain JSON and JSON after a banner", () => {
    assert.deepEqual(parseJsonOutput('[{"a":1}]'), [{ a: 1 }]);
    assert.deepEqual(parseJsonOutput('Fetching...\n{"id":"x"}'), { id: "x" });
  });

  it("throws SetupError on garbage", () => {
    assert.throws(() => parseJsonOutput("not json"), SetupError);
  });
});

describe("extractors", () => {
  it("reads databases from arrays, wrapped results and single objects", () => {
    const db = { uuid: "11111111-2222-4333-8444-555555555555", name: "clearbox", jurisdiction: "eu" };
    assert.deepEqual(extractDatabases([db]), [db]);
    assert.deepEqual(extractDatabases({ result: [db] }), [db]);
    assert.deepEqual(extractDatabases({ uuid: db.uuid, name: "clearbox" }), [{ ...db, jurisdiction: null }]);
    assert.deepEqual(extractDatabases([{ name: "no-id" }]), []);
  });

  it("reads secret names and worker ids", () => {
    assert.deepEqual(
      [...extractSecretNames([{ name: "A", type: "secret_text" }, { name: "B" }])],
      ["A", "B"],
    );
    assert.equal(extractWorkerId({ id: "w-1", name: "clearbox" }), "w-1");
    assert.equal(extractWorkerId({}), null);
  });
});

describe("local config", () => {
  it("round-trips and drops invalid fields", () => {
    const config = {
      d1DatabaseId: "11111111-2222-4333-8444-555555555555",
      appOrigin: "https://c.example.workers.dev",
    };
    assert.deepEqual(parseLocalConfig(serializeLocalConfig(config)), config);
    assert.deepEqual(parseLocalConfig('{"d1DatabaseId":"nope","appOrigin":"http://x"}'), {});
    assert.deepEqual(parseLocalConfig(null), {});
    assert.throws(() => parseLocalConfig("{"), SetupError);
  });
});

describe("origin and redirect URIs", () => {
  it("normalizes origins", () => {
    assert.equal(normalizeOrigin("https://clearbox.sub.workers.dev/"), "https://clearbox.sub.workers.dev");
    assert.equal(normalizeOrigin("https://clearbox.sub.workers.dev/path"), null);
    assert.equal(normalizeOrigin("http://clearbox.sub.workers.dev"), null);
    assert.equal(normalizeOrigin("nonsense"), null);
  });

  it("derives the callback paths from contracts 7.12", () => {
    assert.deepEqual(redirectUris("https://c.example.workers.dev"), {
      google: "https://c.example.workers.dev/oauth/google/callback",
      microsoft: "https://c.example.workers.dev/oauth/microsoft/callback",
    });
    assert.match(oauthInstructions("https://c.example.workers.dev"), /oauth\/microsoft\/callback/);
  });
});

describe("renderSecretsFile", () => {
  it("writes only provided values in contract order", () => {
    const text = renderSecretsFile({
      OWNER_EMAIL: "o@example.test",
      AZURE_DECISION_DEPLOYMENT: "decision-1",
    });
    assert.deepEqual(Object.keys(JSON.parse(text) as object), ["AZURE_DECISION_DEPLOYMENT", "OWNER_EMAIL"]);
  });
});

describe("accessInstructions", () => {
  it("fills in the worker id and owner email", () => {
    const text = accessInstructions({ workerId: "w-1", ownerEmail: "o@example.test", teamDomain: null });
    assert.match(text, /"worker_id":"w-1"/);
    assert.match(text, /"email":"o@example.test"/);
    assert.match(text, /All traffic/);
    assert.match(text, /AUD/);
  });

  it("uses placeholders when values are unknown", () => {
    assert.match(
      accessInstructions({ workerId: null, ownerEmail: null, teamDomain: null }),
      /<you@example.com>/,
    );
  });
});
