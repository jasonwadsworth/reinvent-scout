import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiClient, ListAllSessionsOptions, ListAllSessionsResult } from "../../src/api/client.js";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { catalogServiceNames } from "../../src/catalog/query.js";
import { buildServiceAliasIndex } from "../../src/catalog/service-aliases.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog, type CatalogMeta } from "../../src/catalog/store.js";
import { DEFAULT_EVENT_ID } from "../../src/catalog/sync.js";
import { NotRegisteredError } from "../../src/core/errors.js";
import { matchSessions } from "../../src/match/match.js";
import { createMcpServer } from "../../src/mcp/server.js";
import type { McpToolDeps } from "../../src/mcp/tools.js";
import { resolveProfile } from "../../src/profile/profile.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

function sampleMeta(overrides: Partial<CatalogMeta> = {}): CatalogMeta {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId: DEFAULT_EVENT_ID,
    syncedAt: 1_700_000_000_000,
    totalCount: fixture.length,
    count: fixture.length,
    includedAbstracts: true,
    ...overrides,
  };
}

function seedFixtureCatalog(storeRoot: string): void {
  writeCatalog(
    { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
    { storeRoot },
  );
}

/** `n` synthetic sessions that all cover AWS Lambda -- same shape as match-command.test.ts's own
 * helper -- needed because the 61-session fixture has no single service covering more than eight
 * sessions, so the default/cap limit tests need a synthetic pool bigger than fifty. */
function manyLambdaSessions(n: number): Session[] {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: `synthetic-${i}`,
    abbreviation: `LAM${String(i).padStart(3, "0")}`,
    title: `Serverless deep dive ${i}`,
    services: ["AWS Lambda"],
  }));
}

function seedCatalog(storeRoot: string, sessions: Session[]): void {
  writeCatalog(
    {
      raw: sessions,
      index: sessions.map(buildIndexRecord),
      meta: sampleMeta({ totalCount: sessions.length, count: sessions.length }),
    },
    { storeRoot },
  );
}

function lambdaProfile(): unknown {
  return {
    schemaVersion: 1,
    repos: [{ root: ".", languages: ["typescript"] }],
    services: [{ name: "lambda", evidence: [{ repo: ".", file: "src/handler.ts", line: 3 }] }],
    patterns: [],
  };
}

/** A pool of service names long enough, and numerous enough per session, to make every
 * candidate's own `reasons` array (one "service" reason per matched service -- see
 * match/score.ts) genuinely large -- deliberately synthetic, not because any real catalog session
 * looks like this, but because the 61-session fixture (and even a session with a realistic
 * handful of services) cannot produce a response anywhere near the 30 KB budget on its own; the
 * lead's truncation decision needs a scenario that actually crosses it to test at all. */
const LONG_SERVICE_NAMES = Array.from(
  { length: 20 },
  (_, i) => `Example Synthetic Cloud Service Number ${String(i).padStart(2, "0")} For Response Size Testing`,
);

function longReasonsSessions(n: number): Session[] {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: `long-${i}`,
    abbreviation: `LNG${String(i).padStart(3, "0")}`,
    title:
      `A deliberately verbose synthetic session title used only to inflate response size for ` +
      `the truncation test, entry number ${i}`,
    services: LONG_SERVICE_NAMES,
  }));
}

function longReasonsProfile(): unknown {
  return {
    schemaVersion: 1,
    repos: [{ root: ".", languages: [] }],
    services: LONG_SERVICE_NAMES.map((name, i) => ({
      name,
      evidence: [{ repo: ".", file: `service-${i}.ts` }],
    })),
    patterns: [],
  };
}

/** A minimal ApiClient stand-in -- catalog_sync only ever calls listAllSessions. */
function fakeApiClient(
  listAllSessions: (eventId: string, options?: ListAllSessionsOptions) => Promise<ListAllSessionsResult>,
): ApiClient {
  return {
    getSchedule: async () => {
      throw new Error("not implemented in this fake");
    },
    listSessions: async () => {
      throw new Error("not implemented in this fake");
    },
    listAllSessions,
    associateFavorites: async () => {
      throw new Error("not implemented in this fake");
    },
    disassociateFavorite: async () => {
      throw new Error("not implemented in this fake");
    },
  };
}

async function connectedClient(deps: McpToolDeps): Promise<Client> {
  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

describe("catalog_sync tool", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("syncs the catalog and returns a count summary rather than any session data", async () => {
    const apiClient = fakeApiClient(async () => ({ sessions: fixture, totalCount: fixture.length }));
    const client = await connectedClient({
      resolveStoreRoot: () => home.path,
      buildApiClient: () => apiClient,
    });

    const result = await client.callTool({ name: "catalog_sync", arguments: {} });

    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.count).toBe(fixture.length);
    expect(parsed.totalCount).toBe(fixture.length);
    // The exact key set, not just "this one literal string is absent" -- a check for fixture[0]'s
    // own title/id would miss any OTHER leaked field (an extra key, a differently-shaped session
    // summary) that doesn't happen to match that one session. SyncResult's own six fields, no
    // more, is what actually proves nothing session-shaped rode along.
    expect(Object.keys(parsed).sort()).toEqual(
      ["count", "countMismatch", "eventId", "reindexed", "totalCount", "totalCountMissing"].sort(),
    );
    // Belt-and-braces on the literal content too, since a key-set check alone wouldn't catch a
    // session's title stuffed into an existing string field.
    expect(text).not.toContain(fixture[0]!.title);
    expect(text).not.toContain(fixture[0]!.sessionId);
  });

  it("surfaces a registration problem through the shared error mapping, not a generic failure", async () => {
    const apiClient = fakeApiClient(async () => {
      throw new NotRegisteredError();
    });
    const client = await connectedClient({
      resolveStoreRoot: () => home.path,
      buildApiClient: () => apiClient,
    });

    const result = await client.callTool({ name: "catalog_sync", arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/will not help/i);
  });
});

describe("validate_profile tool", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("resolves a profile's service names and reports unresolved ones", async () => {
    seedFixtureCatalog(home.path);
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const profile = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: [] }],
      services: [
        { name: "lambda", evidence: [{ repo: ".", file: "a" }] },
        { name: "some-service-with-no-catalog-counterpart", evidence: [{ repo: ".", file: "b" }] },
      ],
      patterns: [],
    };

    const result = await client.callTool({ name: "validate_profile", arguments: { profile } });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(result)) as {
      services: Array<{ name: string; catalogName: string | null }>;
      unresolvedServices: string[];
    };
    expect(parsed.services.find((s) => s.name === "lambda")?.catalogName).toBe("AWS Lambda");
    expect(parsed.unresolvedServices).toEqual(["some-service-with-no-catalog-counterpart"]);
  });

  it("rejects a schema-invalid profile, naming the offending entry rather than failing opaquely", async () => {
    seedFixtureCatalog(home.path);
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const invalidProfile = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: [] }],
      services: [{ name: "lambda", evidence: [] }], // no evidence -- schema requires at least one
      patterns: [],
    };

    const result = await client.callTool({ name: "validate_profile", arguments: { profile: invalidProfile } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/lambda/i);
    expect(textOf(result)).toMatch(/evidence/i);
  });

  it("tells the caller to sync first when no catalog exists instead of failing opaquely", async () => {
    // No seedFixtureCatalog call -- nothing synced at all.
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({
      name: "validate_profile",
      arguments: { profile: lambdaProfile() },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/catalog_sync/);
  });
});

describe("match_sessions tool", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("returns ranked candidates from match_sessions", async () => {
    seedFixtureCatalog(home.path);
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({
      name: "match_sessions",
      arguments: { profile: lambdaProfile() },
    });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(result)) as {
      candidates: Array<{ code: string; title: string; score: number; reasons: unknown[]; offerings: unknown[] }>;
      truncated: boolean;
    };
    expect(parsed.candidates.length).toBeGreaterThan(0);
    expect(parsed.candidates[0]!.score).toBeGreaterThan(0);
    expect(parsed.candidates[0]!.reasons.length).toBeGreaterThan(0);
    expect(parsed.candidates[0]!.offerings.length).toBeGreaterThan(0);
    expect(parsed.truncated).toBe(false);
  });

  it("uses a lean candidate shape, dropping fields offerings already carries", async () => {
    // Measured against the real 2,043-session catalog (not this fixture, which is too small to
    // expose it): the CLI's own full toPublicIndexRecord shape put the default-limit response
    // over the 30 KB budget. This pins the trimmed shape so it can't silently grow back.
    seedFixtureCatalog(home.path);
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({
      name: "match_sessions",
      arguments: { profile: lambdaProfile() },
    });

    const parsed = JSON.parse(textOf(result)) as { candidates: Array<Record<string, unknown>> };
    expect(parsed.candidates.length).toBeGreaterThan(0);
    // `type` is deliberately kept (a caller needs to tell a Workshop from a Chalk talk); it's the
    // response-level truncation in buildMatchResponse, not the candidate shape, that now carries
    // the size guarantee -- see the size test below.
    expect(Object.keys(parsed.candidates[0]!).sort()).toEqual(
      ["code", "levelBand", "offerings", "reasons", "score", "sessionId", "title", "type"].sort(),
    );
  });

  it("defaults match_sessions to twenty-five candidates", async () => {
    seedCatalog(home.path, manyLambdaSessions(60));
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({
      name: "match_sessions",
      arguments: { profile: lambdaProfile() },
    });

    const parsed = JSON.parse(textOf(result)) as { candidates: unknown[]; requested: number };
    expect(parsed.candidates).toHaveLength(25);
    expect(parsed.requested).toBe(25);
  });

  it("caps match_sessions at fifty even when a larger limit is requested", async () => {
    seedCatalog(home.path, manyLambdaSessions(100));
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({
      name: "match_sessions",
      arguments: { profile: lambdaProfile(), limit: 1000 },
    });

    const parsed = JSON.parse(textOf(result)) as { candidates: unknown[]; requested: number };
    expect(parsed.candidates).toHaveLength(50);
    expect(parsed.requested).toBe(50);
  });

  it("never includes abstracts in match_sessions output", async () => {
    seedFixtureCatalog(home.path);
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({
      name: "match_sessions",
      arguments: { profile: lambdaProfile() },
    });

    // The literal substring is the strongest guard here -- proves no candidate object anywhere in
    // the serialized response carries an "abstract" key at all, not just that one field was
    // checked and happened to be absent.
    expect(textOf(result)).not.toContain('"abstract"');
  });

  it("tells the caller to sync first when no catalog exists instead of failing opaquely", async () => {
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({
      name: "match_sessions",
      arguments: { profile: lambdaProfile() },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/catalog_sync/);
  });

  it("keeps the response under thirty kilobytes and reports untruncated when everything fits", async () => {
    seedFixtureCatalog(home.path);
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({
      name: "match_sessions",
      arguments: { profile: lambdaProfile() },
    });

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(30 * 1024);
    const parsed = JSON.parse(textOf(result)) as {
      candidates: unknown[];
      truncated: boolean;
      returned: number;
      omitted: number;
      hint?: string;
    };
    expect(parsed.truncated).toBe(false);
    expect(parsed.returned).toBe(parsed.candidates.length);
    expect(parsed.omitted).toBe(0);
    expect(parsed.hint).toBeUndefined();
  });

  it("truncates and says so, staying under the size budget, when candidates would otherwise exceed it", async () => {
    // Lead's decision: the 30 KB budget is a hard guarantee at every limit, including the cap --
    // enforced mechanically at serialization time rather than by trimming the candidate shape
    // further, so reasons and offerings (the actual explainability) stay intact per candidate.
    seedCatalog(home.path, longReasonsSessions(60));
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({
      name: "match_sessions",
      arguments: { profile: longReasonsProfile(), limit: 50 },
    });

    expect(result.isError).not.toBe(true);
    const envelopeBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(envelopeBytes).toBeLessThan(30 * 1024);

    const parsed = JSON.parse(textOf(result)) as {
      candidates: Array<Record<string, unknown>>;
      truncated: boolean;
      returned: number;
      requested: number;
      omitted: number;
      hint: string;
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.requested).toBe(50);
    // Fewer than requested -- the scenario is deliberately built so 50 genuinely would not fit.
    expect(parsed.returned).toBeLessThan(50);
    expect(parsed.candidates).toHaveLength(parsed.returned);
    // omitted counts only what the budget actually dropped from matchSessions' own ranked set --
    // not requested-minus-returned, which would also (wrongly) count a catalog simply not having
    // `requested` matches at all as an "omission."
    expect(parsed.omitted).toBeGreaterThan(0);
    expect(typeof parsed.hint).toBe("string");
    expect(parsed.hint.length).toBeGreaterThan(0);
    // Every included candidate is whole -- reasons and offerings are never partially serialized
    // to make room; a candidate is either fully in or fully left out.
    for (const candidate of parsed.candidates) {
      expect(Array.isArray(candidate.reasons)).toBe(true);
      expect((candidate.reasons as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("truncates at the default limit too, driven by profile richness rather than the limit requested", async () => {
    // Reviewer's follow-up measurement, against the real catalog: an eight-service profile --
    // not exotic, an ordinary serverless app names Lambda, DynamoDB, S3, SQS, EventBridge, API
    // Gateway, Step Functions and CloudWatch without trying -- already breaches 30 KB at the
    // *default* limit of 25, because each matched service adds its own reason to every candidate.
    // No candidate-count limit fixes that; only a response-level budget does. Reproduced here with
    // a synthetic eight-service profile against forty candidate sessions (more than the default
    // limit, so there's a real ranked set to truncate from), no `limit` argument given at all.
    const services = LONG_SERVICE_NAMES.slice(0, 8);
    const sessions = Array.from({ length: 40 }, (_, i) => ({
      sessionId: `rich-${i}`,
      abbreviation: `RCH${String(i).padStart(3, "0")}`,
      title: `Synthetic session ${i}`,
      services,
    }));
    seedCatalog(home.path, sessions);
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({
      name: "match_sessions",
      arguments: {
        profile: {
          schemaVersion: 1,
          repos: [{ root: ".", languages: [] }],
          services: services.map((name, i) => ({ name, evidence: [{ repo: ".", file: `f${i}.ts` }] })),
          patterns: [],
        },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(30 * 1024);
    const parsed = JSON.parse(textOf(result)) as { truncated: boolean; requested: number; returned: number };
    expect(parsed.requested).toBe(25); // the default -- never explicitly asked for more
    expect(parsed.truncated).toBe(true);
    expect(parsed.returned).toBeLessThan(25);
  });

  it("returns a truncated response's candidates as exactly the ranked prefix an untruncated run would produce", async () => {
    // Guards against a truncation that reorders or re-ranks rather than simply stopping early --
    // computed by calling the core matchSessions directly (bypassing the MCP layer's own
    // truncation entirely) with the same profile and options, so this compares against the real,
    // independently-computed ranking, not a copy of the tool's own logic.
    seedCatalog(home.path, longReasonsSessions(60));
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({
      name: "match_sessions",
      arguments: { profile: longReasonsProfile(), limit: 50 },
    });
    const parsed = JSON.parse(textOf(result)) as { candidates: Array<{ code: string }>; returned: number };
    expect(parsed.returned).toBeGreaterThan(0);
    expect(parsed.returned).toBeLessThan(50); // confirms this scenario actually truncates

    const serviceNames = catalogServiceNames({ storeRoot: home.path });
    const serviceAliasIndex = buildServiceAliasIndex(serviceNames);
    const resolved = resolveProfile(longReasonsProfile(), serviceAliasIndex);
    const fullRanking = matchSessions(resolved, { storeRoot: home.path }, { limit: 50 });

    expect(parsed.candidates.map((c) => c.code)).toEqual(
      fullRanking.slice(0, parsed.returned).map((c) => c.code),
    );
  });
});
