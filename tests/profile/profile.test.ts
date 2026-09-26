import { describe, expect, it } from "vitest";
import { buildServiceAliasIndex, type ServiceAliasIndex } from "../../src/catalog/service-aliases.js";
import { parseProfile, resolveProfile } from "../../src/profile/profile.js";

/** A synthetic but realistically-named catalog -- confirmed elsewhere in this codebase (see
 * catalog/service-aliases.test.ts and profile/service-keys.test.ts) that these exact spellings
 * derive and override correctly against the real 170-name catalog. */
const CATALOG_SERVICE_NAMES = ["Amazon DynamoDB", "AWS Step Functions", "Amazon Bedrock"];

function testAliasIndex(): ServiceAliasIndex {
  return buildServiceAliasIndex(CATALOG_SERVICE_NAMES);
}

function validRawProfile(): unknown {
  return {
    schemaVersion: 1,
    repos: [{ root: ".", languages: ["typescript"] }],
    services: [
      {
        name: "dynamodb",
        usage: "orders table",
        evidence: [
          { repo: ".", file: "src/db.ts", line: 10, snippet: "new DynamoDBClient({})" },
        ],
      },
    ],
    patterns: [
      {
        name: "serverless",
        note: "lambda plus api gateway",
        evidence: [{ repo: ".", file: "src/stack.ts" }],
      },
    ],
  };
}

describe("resolveProfile", () => {
  it("accepts a valid profile and resolves each service name to its catalog display name", () => {
    const resolved = resolveProfile(validRawProfile(), testAliasIndex());

    expect(resolved.services).toHaveLength(1);
    expect(resolved.services[0]?.name).toBe("dynamodb");
    expect(resolved.services[0]?.catalogName).toBe("Amazon DynamoDB");
    expect(resolved.unresolvedServices).toEqual([]);
  });

  it("resolves any spelling: dynamodb, Amazon DynamoDB, @aws-sdk/client-dynamodb, sfn, bedrock-runtime", () => {
    const spellingToCatalogName: Array<[string, string]> = [
      ["dynamodb", "Amazon DynamoDB"],
      ["Amazon DynamoDB", "Amazon DynamoDB"],
      ["@aws-sdk/client-dynamodb", "Amazon DynamoDB"],
      ["sfn", "AWS Step Functions"],
      ["bedrock-runtime", "Amazon Bedrock"],
    ];

    for (const [spelling, expectedCatalogName] of spellingToCatalogName) {
      const raw = {
        schemaVersion: 1,
        repos: [{ root: ".", languages: [] }],
        services: [{ name: spelling, evidence: [{ repo: ".", file: "src/x.ts" }] }],
        patterns: [],
      };

      const resolved = resolveProfile(raw, testAliasIndex());

      expect(resolved.services[0]?.catalogName).toBe(expectedCatalogName);
    }
  });

  it("reports a service with no catalog counterpart as unresolved rather than dropping it", () => {
    const raw = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: [] }],
      services: [{ name: "sns", evidence: [{ repo: ".", file: "src/notify.ts" }] }],
      patterns: [],
    };

    const resolved = resolveProfile(raw, testAliasIndex());

    expect(resolved.services).toHaveLength(1);
    expect(resolved.services[0]?.name).toBe("sns");
    expect(resolved.services[0]?.catalogName).toBeNull();
    expect(resolved.unresolvedServices).toEqual(["sns"]);
  });

  it("rejects a service with no evidence, naming the entry", () => {
    const raw = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: [] }],
      services: [{ name: "dynamodb", evidence: [] }],
      patterns: [],
    };

    let caught: unknown;
    try {
      resolveProfile(raw, testAliasIndex());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(String(caught)).toContain("dynamodb");
  });

  it("rejects a pattern with no evidence, naming the entry", () => {
    const raw = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: [] }],
      services: [],
      patterns: [{ name: "serverless", evidence: [] }],
    };

    let caught: unknown;
    try {
      resolveProfile(raw, testAliasIndex());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(String(caught)).toContain("serverless");
  });

  it("rejects evidence without a file", () => {
    const raw = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: [] }],
      services: [{ name: "dynamodb", evidence: [{ repo: "." }] }],
      patterns: [],
    };

    expect(() => resolveProfile(raw, testAliasIndex())).toThrow();
  });

  it("rejects an unknown schemaVersion", () => {
    const raw = { ...validRawProfile() as Record<string, unknown>, schemaVersion: 2 };

    expect(() => resolveProfile(raw, testAliasIndex())).toThrow();
  });

  it("treats prototype-key service names as ordinary strings", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const raw = {
        schemaVersion: 1,
        repos: [{ root: ".", languages: [] }],
        services: [{ name, evidence: [{ repo: ".", file: "src/x.ts" }] }],
        patterns: [],
      };

      const resolved = resolveProfile(raw, testAliasIndex());

      expect(resolved.services).toHaveLength(1);
      expect(resolved.services[0]?.name).toBe(name);
      expect(resolved.services[0]?.catalogName).toBeNull();
      expect(resolved.unresolvedServices).toEqual([name]);
    }
  });

  it("accepts optional intents and interests and keeps them verbatim", () => {
    const raw = {
      ...(validRawProfile() as Record<string, unknown>),
      interests: ["serverless", "observability"],
      intents: [{ kind: "issue", text: "add retries", ref: "https://example.com/issues/1" }],
    };

    const resolved = resolveProfile(raw, testAliasIndex());

    expect(resolved.interests).toEqual(["serverless", "observability"]);
    expect(resolved.intents).toEqual([
      { kind: "issue", text: "add retries", ref: "https://example.com/issues/1" },
    ]);
  });
});

describe("parseProfile", () => {
  it("round-trips through JSON unchanged", () => {
    const parsed = parseProfile(validRawProfile());

    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed));

    expect(roundTripped).toEqual(parsed);
  });
});
