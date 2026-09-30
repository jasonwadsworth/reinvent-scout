import { describe, expect, it } from "vitest";
import { buildServiceAliasIndex, type ServiceAliasIndex } from "../../src/catalog/service-aliases.js";
import { parseProfile, resolveProfile } from "../../src/profile/profile.js";

/** A synthetic but realistically-named catalog -- confirmed elsewhere in this codebase (see
 * catalog/service-aliases.test.ts and catalog/service-keys.test.ts) that these exact spellings
 * derive and override correctly against the real 170-name catalog. */
const CATALOG_SERVICE_NAMES = [
  "Amazon DynamoDB",
  "AWS Step Functions",
  "Amazon Bedrock",
  "Amazon ElastiCache",
  "Amazon ElastiCache Serverless",
  "AWS Lambda",
  "Amazon Athena",
];

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
    // Seven spellings of one service (DynamoDB), plus sfn and bedrock-runtime for the two
    // curated cross-ecosystem overrides -- every real-world form an agent transcribing code
    // might reasonably write, in one table.
    const spellingToCatalogName: Array<[string, string]> = [
      ["dynamodb", "Amazon DynamoDB"],
      ["Amazon DynamoDB", "Amazon DynamoDB"],
      ["@aws-sdk/client-dynamodb", "Amazon DynamoDB"],
      ["aws-cdk-lib/aws-dynamodb", "Amazon DynamoDB"],
      ["aws_cdk.aws_dynamodb", "Amazon DynamoDB"],
      ["software.amazon.awssdk.services.dynamodb", "Amazon DynamoDB"],
      ["github.com/aws/aws-sdk-go-v2/service/dynamodb", "Amazon DynamoDB"],
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

  it("resolves a Terraform-style compound resource type by longest-prefix match after stripping aws_", () => {
    // "aws_dynamodb_table" isn't itself a catalog alias -- only "dynamodb", the segment left
    // after "table" is dropped, is. This is the case that needs segment-based shortening rather
    // than a single normalize-and-look-up.
    const raw = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: [] }],
      services: [{ name: "aws_dynamodb_table", evidence: [{ repo: ".", file: "main.tf" }] }],
      patterns: [],
    };

    const resolved = resolveProfile(raw, testAliasIndex());

    expect(resolved.services[0]?.catalogName).toBe("Amazon DynamoDB");
  });

  it("prefers the longer, more specific catalog match over a shorter one that also resolves", () => {
    // The catalog carries both "Amazon ElastiCache" and "Amazon ElastiCache Serverless" as
    // distinct entries. Shortest-first segment matching would stop at "elasticache" (wrong: too
    // eager); longest-first correctly finds "elasticache_serverless" first. This is the case
    // that actually distinguishes the two orders -- most names (aws_dynamodb_table, for
    // instance) resolve identically either way and prove nothing about which order is used.
    const raw = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: [] }],
      services: [
        { name: "aws_elasticache_serverless_cache", evidence: [{ repo: ".", file: "main.tf" }] },
      ],
      patterns: [],
    };

    const resolved = resolveProfile(raw, testAliasIndex());

    expect(resolved.services[0]?.catalogName).toBe("Amazon ElastiCache Serverless");
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

  it("does not let affix-stripping or segment-shortening rescue a genuinely unresolvable name", () => {
    // "sns" has no catalog counterpart and no affix to strip -- it must come back unresolved
    // rather than the new stripping/shortening pipeline over-reaching and resolving it to
    // something adjacent.
    const raw = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: [] }],
      services: [{ name: "aws_sns_topic", evidence: [{ repo: ".", file: "main.tf" }] }],
      patterns: [],
    };

    const resolved = resolveProfile(raw, testAliasIndex());

    expect(resolved.services[0]?.catalogName).toBeNull();
    expect(resolved.unresolvedServices).toEqual(["aws_sns_topic"]);
  });

  it("does not shorten a plain hyphenated name that never had a wrapper affix to strip", () => {
    // Segment shortening is a recovery strategy for a name that arrived in a known code shape
    // (an SDK package, a Terraform resource type) -- not a general prefix match on arbitrary
    // text. Without gating it on an affix actually having been stripped, "lambda-labs-gpu" would
    // shorten all the way down to "lambda" and wrongly resolve to AWS Lambda; "athena-health"
    // would wrongly resolve to Amazon Athena the same way. Neither name has any relationship to
    // the AWS service it happens to start with.
    for (const name of ["lambda-labs-gpu", "athena-health"]) {
      const raw = {
        schemaVersion: 1,
        repos: [{ root: ".", languages: [] }],
        services: [{ name, evidence: [{ repo: ".", file: "package.json" }] }],
        patterns: [],
      };

      const resolved = resolveProfile(raw, testAliasIndex());

      expect(resolved.services[0]?.catalogName).toBeNull();
      expect(resolved.unresolvedServices).toEqual([name]);
    }
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
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
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

describe("service role", () => {
  const withRole = (role: unknown): unknown => {
    const raw = validRawProfile() as { services: Array<Record<string, unknown>> };
    raw.services[0]!.role = role;
    return raw;
  };
  it("accepts core and supporting and keeps the role through parse and resolve", () => {
    expect(parseProfile(withRole("supporting")).services[0]?.role).toBe("supporting");
    expect(parseProfile(withRole("core")).services[0]?.role).toBe("core");
    expect(resolveProfile(withRole("supporting"), testAliasIndex()).services[0]?.role).toBe("supporting");
    expect(parseProfile(validRawProfile()).services[0]?.role).toBeUndefined();
  });
  it("rejects any other role", () => {
    expect(() => parseProfile(withRole("primary"))).toThrow();
  });
});
