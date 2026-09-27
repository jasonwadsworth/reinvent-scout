import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiClient } from "../../src/api/client.js";
import type { BulkResult, Schedule, Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog, type CatalogMeta } from "../../src/catalog/store.js";
import { DEFAULT_EVENT_ID } from "../../src/catalog/sync.js";
import { AuthRequiredError, NotFoundError, NotRegisteredError } from "../../src/core/errors.js";
import { createMcpServer } from "../../src/mcp/server.js";
import type { McpToolDeps } from "../../src/mcp/tools.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);
const ANT301 = fixture.find((session) => session.abbreviation === "ANT301")!;

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

interface ApiClientOverrides {
  getSchedule?: ApiClient["getSchedule"];
  associateFavorites?: ApiClient["associateFavorites"];
  disassociateFavorite?: ApiClient["disassociateFavorite"];
}

function fakeApiClient(overrides: ApiClientOverrides = {}): ApiClient {
  return {
    getSchedule:
      overrides.getSchedule ??
      (async (): Promise<Schedule> => ({ reserved: [], favorites: [], personalTime: [] })),
    listSessions: async () => {
      throw new Error("not implemented in this fake");
    },
    listAllSessions: async () => {
      throw new Error("not implemented in this fake");
    },
    associateFavorites:
      overrides.associateFavorites ??
      (async (): Promise<BulkResult> => {
        throw new Error("not implemented in this fake");
      }),
    disassociateFavorite:
      overrides.disassociateFavorite ??
      (async () => {
        throw new Error("not implemented in this fake");
      }),
  };
}

async function connectedClient(
  storeRoot: string,
  overrides: ApiClientOverrides = {},
): Promise<Client> {
  const deps: McpToolDeps = {
    resolveStoreRoot: () => storeRoot,
    buildApiClient: () => fakeApiClient(overrides),
  };
  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

describe("the seven registered tools", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("lists exactly the seven expected tools, by name", async () => {
    // Asserted as a set, not a count: the plan's own task 5 text still names `profile_repo`,
    // superseded by `validate_profile` in the rescope -- swapping one tool for another leaves the
    // count at seven, so a length-only assertion would pass with the wrong membership.
    const client = await connectedClient(home.path);

    const tools = await client.listTools();

    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      [
        "status",
        "catalog_sync",
        "validate_profile",
        "match_sessions",
        "get_schedule",
        "favorite_sessions",
        "unfavorite_session",
      ].sort(),
    );
  });
});

describe("get_schedule tool", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("returns the resolved schedule from get_schedule, merged and tagged by kind", async () => {
    seedFixtureCatalog(home.path);
    const client = await connectedClient(home.path, {
      getSchedule: async () => ({ reserved: [ANT301.sessionId], favorites: [], personalTime: [] }),
    });

    const result = await client.callTool({ name: "get_schedule", arguments: {} });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(result)) as {
      entries: Array<{ kind: string; sessionId: string; resolved: boolean; title?: string }>;
      total: number;
      totals: { reserved: number; favorites: number; personalTime: number };
      returned: number;
      offset: number;
      nextOffset?: number;
    };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.kind).toBe("reserved");
    expect(parsed.entries[0]!.resolved).toBe(true);
    expect(parsed.entries[0]!.title).toBe(ANT301.title);
    expect(parsed.total).toBe(1);
    expect(parsed.totals).toEqual({ reserved: 1, favorites: 0, personalTime: 0 });
    expect(parsed.returned).toBe(1);
    expect(parsed.offset).toBe(0);
    expect(parsed.nextOffset).toBeUndefined();
  });

  it("paginates with limit and offset, reporting nextOffset only when more entries remain", async () => {
    // Five sessions with distinct, known start times so the boundary math (and later, the
    // ordering test) has an unambiguous expected sequence to check against.
    const sessions = Array.from({ length: 5 }, (_, i) => ({
      sessionId: `page-${i}`,
      abbreviation: `PG${i}`,
      title: `Pagination session ${i}`,
      sessionTime: { date: "2026-12-01", time: `${String(9 + i).padStart(2, "0")}:00`, length: "30" },
    }));
    seedCatalog(home.path, sessions);
    const client = await connectedClient(home.path, {
      getSchedule: async () => ({
        reserved: [],
        favorites: sessions.map((s) => s.sessionId),
        personalTime: [],
      }),
    });

    async function page(limit: number, offset: number) {
      const result = await client.callTool({ name: "get_schedule", arguments: { limit, offset } });
      return JSON.parse(textOf(result)) as {
        entries: Array<{ sessionId: string }>;
        returned: number;
        offset: number;
        nextOffset?: number;
        total: number;
      };
    }

    const first = await page(2, 0);
    expect(first.entries.map((e) => e.sessionId)).toEqual(["page-0", "page-1"]);
    expect(first.returned).toBe(2);
    expect(first.nextOffset).toBe(2);

    const second = await page(2, 2);
    expect(second.entries.map((e) => e.sessionId)).toEqual(["page-2", "page-3"]);
    expect(second.nextOffset).toBe(4);

    // The boundary: exactly one entry left, so this is the last page -- nextOffset must be
    // absent, not present-and-equal-to-total, since "absent" is the documented end-of-pages
    // signal a caller loops on.
    const third = await page(2, 4);
    expect(third.entries.map((e) => e.sessionId)).toEqual(["page-4"]);
    expect(third.returned).toBe(1);
    expect(third.nextOffset).toBeUndefined();
    expect(third.total).toBe(5);
  });

  it("keeps the response under thirty kilobytes at a hundred favorites, shortening the page and advancing nextOffset to match", async () => {
    // Reviewer's finding: get_schedule had no budget at all and measured ~30.8 KB at a hundred
    // favorites against the real catalog -- not a stress case, since favorite_sessions accepts
    // fifty per call (two ordinary calls reach it). Reproduced with realistic-length synthetic
    // entries (long title, real-length venue/room strings) rather than tiny ids, since short
    // synthetic entries could not expose this any more than the small fixture could.
    const sessions = Array.from({ length: 100 }, (_, i) => ({
      sessionId: `sched-${i}`,
      abbreviation: `SCH${String(i).padStart(3, "0")}`,
      title:
        `A deliberately long and realistic-sounding synthetic session title for schedule ` +
        `pagination size testing, entry number ${i}`,
      venue: "MGM Grand",
      room: "Level 3 | Chairman's 363 | Content Hub | White Theater",
      sessionTime: { date: "2026-12-01", time: `${String(9 + (i % 8)).padStart(2, "0")}:00`, length: "60" },
    }));
    seedCatalog(home.path, sessions);
    const client = await connectedClient(home.path, {
      getSchedule: async () => ({
        reserved: [],
        favorites: sessions.map((s) => s.sessionId),
        personalTime: [],
      }),
    });

    const result = await client.callTool({ name: "get_schedule", arguments: { limit: 100 } });

    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(30 * 1024);
    const parsed = JSON.parse(textOf(result)) as {
      entries: unknown[];
      total: number;
      returned: number;
      offset: number;
      nextOffset?: number;
    };
    expect(parsed.total).toBe(100);
    // Fewer than the requested 100 -- the scenario is built so a full page of 100 genuinely does
    // not fit, exercising the shortening path rather than assuming it works.
    expect(parsed.returned).toBeLessThan(100);
    expect(parsed.entries).toHaveLength(parsed.returned);
    // nextOffset must reflect what was actually returned (so the next call resumes exactly where
    // this one stopped), not the full requested limit -- the bug a naive "advance by limit
    // regardless of what fit" implementation would produce.
    expect(parsed.nextOffset).toBe(parsed.offset + parsed.returned);
  });

  it("returns entries in stable sorted order across pages", async () => {
    const sessions = Array.from({ length: 6 }, (_, i) => ({
      sessionId: `order-${i}`,
      abbreviation: `ORD${i}`,
      title: `Ordering session ${i}`,
      sessionTime: { date: "2026-12-01", time: `${String(9 + i).padStart(2, "0")}:00`, length: "30" },
    }));
    seedCatalog(home.path, sessions);
    const client = await connectedClient(home.path, {
      getSchedule: async () => ({
        reserved: [],
        // Shuffled input order -- the tool must sort by start time regardless of the order the
        // API happened to list favorites in.
        favorites: [sessions[3]!.sessionId, sessions[0]!.sessionId, sessions[5]!.sessionId, sessions[1]!.sessionId, sessions[4]!.sessionId, sessions[2]!.sessionId],
        personalTime: [],
      }),
    });

    async function page(limit: number, offset: number): Promise<string[]> {
      const result = await client.callTool({ name: "get_schedule", arguments: { limit, offset } });
      const parsed = JSON.parse(textOf(result)) as { entries: Array<{ sessionId: string }> };
      return parsed.entries.map((e) => e.sessionId);
    }

    const firstPage = await page(3, 0);
    const secondPage = await page(3, 3);

    expect([...firstPage, ...secondPage]).toEqual(
      sessions.map((s) => s.sessionId), // sessions is already in chronological order by construction
    );
  });

  it("returns isError with the not-registered explanation on a 403", async () => {
    const client = await connectedClient(home.path, {
      getSchedule: async () => {
        throw new NotRegisteredError();
      },
    });

    const result = await client.callTool({ name: "get_schedule", arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/will not help/i);
  });

  it("returns isError telling the agent it can run auth login itself when no session is stored", async () => {
    const client = await connectedClient(home.path, {
      getSchedule: async () => {
        throw new AuthRequiredError();
      },
    });

    const result = await client.callTool({ name: "get_schedule", arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("reinvent-scout auth login");
    expect(textOf(result)).toMatch(/the skill can run it for you/i);
  });
});

describe("favorite_sessions tool", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("favorites up to fifty sessions and reports refusals per session -- a 200 with a non-empty failed list is never read as success", async () => {
    // The lead's own structural guard, restated for the MCP layer: read the tool's composed
    // output (the JSON a caller actually gets), not just that favoriteSessions was called.
    seedFixtureCatalog(home.path);
    const client = await connectedClient(home.path, {
      associateFavorites: async () => ({
        successful: ["a"],
        failed: [{ sessionId: "b", code: "sessionFull" }],
      }),
      getSchedule: async () => ({ reserved: [], favorites: ["a"], personalTime: [] }),
    });

    const result = await client.callTool({
      name: "favorite_sessions",
      arguments: { sessionIds: ["a", "b"] },
    });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(result)) as {
      successful: string[];
      failed: Array<{ sessionId: string; code: string }>;
    };
    expect(parsed.successful).toEqual(["a"]);
    expect(parsed.failed).toEqual([{ sessionId: "b", code: "sessionFull" }]);
  });

  it("reports a schedule conflict with the conflicting session titles resolved from the local index", async () => {
    seedFixtureCatalog(home.path);
    const client = await connectedClient(home.path, {
      associateFavorites: async () => ({
        successful: [],
        failed: [{ sessionId: "b", code: "scheduleConflict", conflictsWith: [ANT301.sessionId] }],
      }),
      getSchedule: async () => ({ reserved: [], favorites: [], personalTime: [] }),
    });

    const result = await client.callTool({
      name: "favorite_sessions",
      arguments: { sessionIds: ["b"] },
    });

    const parsed = JSON.parse(textOf(result)) as {
      failed: Array<{ sessionId: string; conflictsWith?: Array<{ sessionId: string; title: string | null }> }>;
    };
    expect(parsed.failed[0]!.conflictsWith).toEqual([{ sessionId: ANT301.sessionId, title: ANT301.title }]);
  });

  it("rejects a favorite_sessions call with an empty id list at the schema level", async () => {
    let called = false;
    const client = await connectedClient(home.path, {
      associateFavorites: async () => {
        called = true;
        return { successful: [], failed: [] };
      },
    });

    const result = await client.callTool({ name: "favorite_sessions", arguments: { sessionIds: [] } });

    expect(result.isError).toBe(true);
    expect(called).toBe(false);
  });

  it("returns isError with the not-registered explanation on a 403", async () => {
    const client = await connectedClient(home.path, {
      associateFavorites: async () => ({ successful: ["a"], failed: [] }),
      getSchedule: async () => {
        throw new NotRegisteredError();
      },
    });

    const result = await client.callTool({
      name: "favorite_sessions",
      arguments: { sessionIds: ["a"] },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/will not help/i);
  });
});

describe("unfavorite_session tool", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("removes a favorite through unfavorite_session", async () => {
    let called: { eventId: string; sessionId: string } | undefined;
    const client = await connectedClient(home.path, {
      disassociateFavorite: async (eventId, sessionId) => {
        called = { eventId, sessionId };
      },
    });

    const result = await client.callTool({
      name: "unfavorite_session",
      arguments: { sessionId: "s1" },
    });

    expect(result.isError).not.toBe(true);
    expect(called).toEqual({ eventId: DEFAULT_EVENT_ID, sessionId: "s1" });
    const parsed = JSON.parse(textOf(result)) as { outcome: string };
    expect(parsed.outcome).toBe("removed");
  });

  it("reports notFavorited without treating it as an error", async () => {
    const client = await connectedClient(home.path, {
      disassociateFavorite: async () => {
        throw new NotFoundError("No favorite with that session id.");
      },
    });

    const result = await client.callTool({
      name: "unfavorite_session",
      arguments: { sessionId: "s1" },
    });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(result)) as { outcome: string };
    expect(parsed.outcome).toBe("notFavorited");
  });

  it("returns isError with the not-registered explanation on a 403", async () => {
    const client = await connectedClient(home.path, {
      disassociateFavorite: async () => {
        throw new NotRegisteredError();
      },
    });

    const result = await client.callTool({
      name: "unfavorite_session",
      arguments: { sessionId: "s1" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/will not help/i);
  });
});
