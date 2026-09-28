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
    timezone: null,
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

/** A minimal ApiClient stand-in -- catalog_sync calls listAllSessions and getEvent (through the
 * real syncCatalog, not a fake), so getEvent must return a value rather than throw like the truly
 * unused methods below. No timezone: these tests don't exercise timezone handling. */
function fakeApiClient(
  listAllSessions: (eventId: string, options?: ListAllSessionsOptions) => Promise<ListAllSessionsResult>,
): ApiClient {
  return {
    getSchedule: async () => {
      throw new Error("not implemented in this fake");
    },
    getEvent: async (eventId) => ({ eventId }),
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

  it("returns a compact result -- pattern names and counts, never an evidence echo of the agent's own input", async () => {
    // pr-reviewer's finding: echoing the whole resolved profile (evidence, repos, usage notes and
    // all) breaks the README's own "every tool holds its response to a 30 KB budget" claim for a
    // large profile. The tool only needs to report what it actually resolved.
    seedFixtureCatalog(home.path);
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const profile = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: ["typescript"] }],
      services: [{ name: "lambda", usage: "the order handler", evidence: [{ repo: ".", file: "a.ts", line: 12 }] }],
      patterns: [{ name: "serverless", note: "API Gateway in front", evidence: [{ repo: ".", file: "b.ts" }] }],
    };

    const result = await client.callTool({ name: "validate_profile", arguments: { profile } });

    expect(result.isError).not.toBe(true);
    const raw = textOf(result);
    // The evidence file paths and the usage/note text must not appear anywhere in the response --
    // a substring check across the whole raw text, not just the parsed shape, since an evidence
    // echo could in principle hide under a differently-named field.
    expect(raw).not.toMatch(/a\.ts/);
    expect(raw).not.toMatch(/b\.ts/);
    expect(raw).not.toMatch(/order handler/);
    expect(raw).not.toMatch(/API Gateway in front/);
    expect(raw).not.toMatch(/"repos"/);

    const parsed = JSON.parse(raw) as {
      services: Array<{ name: string; catalogName: string | null }>;
      patterns: string[];
      unresolvedServices: string[];
      counts: { services: number; patterns: number; unresolvedServices: number };
    };
    expect(parsed.services).toEqual([{ name: "lambda", catalogName: "AWS Lambda" }]);
    expect(parsed.patterns).toEqual(["serverless"]);
    expect(parsed.counts).toEqual({ services: 1, patterns: 1, unresolvedServices: 0 });
  });

  it("stays under the thirty-kilobyte response budget for a profile naming 120 services", async () => {
    // pr-reviewer's own measurement: the old full-echo response for a 120-service profile was
    // 45,439 bytes -- comfortably over budget. The compact shape must stay under it, and truncate
    // (reporting how many were omitted) on the rare case it somehow doesn't.
    seedFixtureCatalog(home.path);
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const profile = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: ["typescript"] }],
      services: Array.from({ length: 120 }, (_, i) => ({
        name: `unresolvable-service-number-${i}`,
        evidence: [{ repo: ".", file: `src/service-${i}.ts`, line: i + 1 }],
      })),
      patterns: [],
    };

    const result = await client.callTool({ name: "validate_profile", arguments: { profile } });

    expect(result.isError).not.toBe(true);
    const raw = textOf(result);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(30 * 1024);
    const parsed = JSON.parse(raw) as { services: unknown[]; counts: { services: number } };
    expect(parsed.counts.services).toBe(120); // the true count, even if services[] itself is truncated
    expect(parsed.services).toHaveLength(120); // 120 tiny entries comfortably fit; nothing truncated
  });

  it("truncates the services list, reporting the true count and an omitted count, when even the compact shape doesn't fit", async () => {
    // Directly exercises the truncation branch itself (unlike the 120-service test above, which
    // stays under budget without ever needing it) -- long enough service names, enough of them,
    // that the compact shape genuinely can't all fit in 30 KB.
    seedFixtureCatalog(home.path);
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const profile = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: ["typescript"] }],
      services: Array.from({ length: 600 }, (_, i) => ({
        name: `a-fairly-long-and-specific-unresolvable-service-name-number-${i}`,
        evidence: [{ repo: ".", file: `src/service-${i}.ts`, line: i + 1 }],
      })),
      patterns: [],
    };

    const result = await client.callTool({ name: "validate_profile", arguments: { profile } });

    expect(result.isError).not.toBe(true);
    const raw = textOf(result);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(30 * 1024);
    const parsed = JSON.parse(raw) as {
      services: Array<{ name: string; catalogName: string | null }>;
      unresolvedServices: string[];
      truncated: boolean;
      omitted: number;
      hint?: string;
      counts: { services: number; unresolvedServices: number };
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.counts.services).toBe(600); // the true total, not the truncated length
    expect(parsed.counts.unresolvedServices).toBe(600); // every one of them is unresolvable
    expect(parsed.services.length).toBeLessThan(600);
    expect(parsed.omitted).toBe(600 - parsed.services.length);
    expect(parsed.hint).toBeDefined();
    // unresolvedServices must shrink along with services, not stay at the full 600 -- otherwise it
    // alone could still blow the budget even with services itself truncated.
    expect(parsed.unresolvedServices).toHaveLength(parsed.services.length);
    const serviceNames = new Set(parsed.services.map((s) => s.name));
    expect(parsed.unresolvedServices.every((name) => serviceNames.has(name))).toBe(true);
  });

  it("truncates patterns too, not just services, when many long pattern names alone would blow the budget", async () => {
    // reviewer2's finding on the first version of this fix: patterns were never truncated at all,
    // on the assumption a hackathon-scale profile's own pattern list is small by construction. A
    // profile naming few services but many long patterns (as plausible as many long service
    // names -- neither is length-validated, and both are equally the agent's own free text) proved
    // that assumption wrong: patterns alone reached 33,889 bytes at 600 of them, over budget
    // regardless of services being truncated to nothing.
    seedFixtureCatalog(home.path);
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const profile = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: ["typescript"] }],
      services: [{ name: "lambda", evidence: [{ repo: ".", file: "a.ts", line: 1 }] }],
      patterns: Array.from({ length: 600 }, (_, i) => ({
        name: `pattern-${"p".repeat(40)}-${i}`,
        evidence: [{ repo: ".", file: `src/pattern-${i}.ts`, line: i + 1 }],
      })),
    };

    const result = await client.callTool({ name: "validate_profile", arguments: { profile } });

    expect(result.isError).not.toBe(true);
    const raw = textOf(result);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(30 * 1024);
    const parsed = JSON.parse(raw) as {
      patterns: string[];
      truncated: boolean;
      omitted: number;
      counts: { services: number; patterns: number };
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.counts.patterns).toBe(600); // the true total, not the truncated length
    expect(parsed.patterns.length).toBeLessThan(600);
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

  it("distinguishes an unusable (outdated-schema) catalog from a missing one, through a real tool call", async () => {
    // toToolError's CatalogMissingError/CatalogUnusableError branches were unit-testable in
    // isolation, but a mapper being correct and a tool handler actually routing an error through
    // it are different properties -- reviewer's ask. A schema-version mismatch is the same
    // established trigger tests/catalog/query.test.ts's own CatalogUnusableError coverage uses.
    writeCatalog(
      {
        raw: fixture,
        index: fixture.map(buildIndexRecord),
        meta: sampleMeta({ schemaVersion: CURRENT_SCHEMA_VERSION - 1 }),
      },
      { storeRoot: home.path },
    );
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({
      name: "match_sessions",
      arguments: { profile: lambdaProfile() },
    });

    expect(result.isError).toBe(true);
    // "local rebuild" (CatalogUnusableError's own annotation) is the distinguishing phrase from
    // "catalog_sync and a signed-in session" (CatalogMissingError's), so this also pins that the
    // two error types stay textually distinguishable through the real tool call, not just in the
    // mapper's own source.
    expect(textOf(result)).toMatch(/local rebuild/i);
    expect(textOf(result)).not.toMatch(/signed-in session/i);
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

  it("names the omitted count in the truncation hint and never suggests lowering limit, which cannot reach the omitted ranks", async () => {
    // Lead's decision: the original hint ("Ask again with a smaller limit or a narrower lens to
    // see the rest.") was actionable advice that doesn't work -- a smaller `limit` only asks for
    // fewer of the same top-ranked candidates; there is no `offset` to reach the omitted,
    // lower-ranked ones. The only things that actually change which candidates rank highest are a
    // narrower lens or a more specific profile.
    seedCatalog(home.path, longReasonsSessions(60));
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({
      name: "match_sessions",
      arguments: { profile: longReasonsProfile(), limit: 50 },
    });

    const parsed = JSON.parse(textOf(result)) as { truncated: boolean; omitted: number; hint: string };
    expect(parsed.truncated).toBe(true); // sanity: this scenario must actually truncate
    expect(parsed.omitted).toBeGreaterThan(0);
    expect(parsed.hint).toBe(
      `${parsed.omitted} lower-ranked candidates were omitted to fit the response budget. ` +
        "A narrower lens or a more specific profile changes what ranks highest.",
    );
    expect(parsed.hint).not.toMatch(/limit/i);
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
