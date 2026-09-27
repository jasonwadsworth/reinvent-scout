import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiClient, ListAllSessionsOptions, ListAllSessionsResult } from "../../src/api/client.js";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog, type CatalogMeta } from "../../src/catalog/store.js";
import { DEFAULT_EVENT_ID } from "../../src/catalog/sync.js";
import { NotRegisteredError } from "../../src/core/errors.js";
import { createMcpServer } from "../../src/mcp/server.js";
import type { McpToolDeps } from "../../src/mcp/tools.js";
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
    const candidates = JSON.parse(textOf(result)) as Array<{
      code: string;
      title: string;
      score: number;
      reasons: unknown[];
      offerings: unknown[];
    }>;
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.score).toBeGreaterThan(0);
    expect(candidates[0]!.reasons.length).toBeGreaterThan(0);
    expect(candidates[0]!.offerings.length).toBeGreaterThan(0);
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

    const candidates = JSON.parse(textOf(result)) as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThan(0);
    expect(Object.keys(candidates[0]!).sort()).toEqual(
      ["code", "levelBand", "offerings", "reasons", "score", "sessionId", "title"].sort(),
    );
  });

  it("defaults match_sessions to twenty-five candidates", async () => {
    seedCatalog(home.path, manyLambdaSessions(60));
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({
      name: "match_sessions",
      arguments: { profile: lambdaProfile() },
    });

    const candidates = JSON.parse(textOf(result)) as unknown[];
    expect(candidates).toHaveLength(25);
  });

  it("caps match_sessions at fifty even when a larger limit is requested", async () => {
    seedCatalog(home.path, manyLambdaSessions(100));
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({
      name: "match_sessions",
      arguments: { profile: lambdaProfile(), limit: 1000 },
    });

    const candidates = JSON.parse(textOf(result)) as unknown[];
    expect(candidates).toHaveLength(50);
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

  it("keeps every tool response under thirty kilobytes for the fixture catalog", async () => {
    seedFixtureCatalog(home.path);
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({
      name: "match_sessions",
      arguments: { profile: lambdaProfile() },
    });

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(30 * 1024);
  });
});
