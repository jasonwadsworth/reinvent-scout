import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiClient } from "../../src/api/client.js";
import type { BulkResult, PersonalTime, Schedule, Session } from "../../src/api/types.js";
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

function seedCatalog(storeRoot: string, sessions: Session[], metaOverrides: Partial<CatalogMeta> = {}): void {
  writeCatalog(
    {
      raw: sessions,
      index: sessions.map(buildIndexRecord),
      meta: sampleMeta({ totalCount: sessions.length, count: sessions.length, ...metaOverrides }),
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
    // get_schedule reads the event timezone from catalog meta.json (seeded per test via
    // seedFixtureCatalog), never by calling the API directly -- so this is never reached.
    getEvent: async () => {
      throw new Error("not implemented in this fake");
    },
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

  it("caps the limit at seventy-five even when a larger one is requested", async () => {
    // Lead's revised cap: adding `kind` and the pagination metadata to each entry means a full
    // page of 100 at realistic entry lengths already exceeds the budget before anything unusually
    // long is involved, so 75 is chosen to make a full page the normal case. Moderate-length
    // entries here (not the stress-test lengths the byte-budget test below uses) isolate the cap
    // itself: this must return exactly 75, not fewer for a byte reason.
    const sessions = Array.from({ length: 100 }, (_, i) => ({
      sessionId: `cap-${i}`,
      abbreviation: `CAP${String(i).padStart(3, "0")}`,
      title: `Cap session ${i}`,
      sessionTime: { date: "2026-12-01", time: `${String(9 + (i % 8)).padStart(2, "0")}:00`, length: "30" },
    }));
    seedCatalog(home.path, sessions);
    const client = await connectedClient(home.path, {
      getSchedule: async () => ({
        reserved: [],
        favorites: sessions.map((s) => s.sessionId),
        personalTime: [],
      }),
    });

    const result = await client.callTool({ name: "get_schedule", arguments: { limit: 1000 } });

    const parsed = JSON.parse(textOf(result)) as { returned: number; entries: unknown[] };
    expect(parsed.returned).toBe(75);
    expect(parsed.entries).toHaveLength(75);
  });

  it("keeps the response under thirty kilobytes even within a single page at the cap, shortening it and advancing nextOffset to the first cut entry", async () => {
    // Reviewer's finding: get_schedule had no budget at all and measured ~30.8 KB at a hundred
    // favorites against the real catalog. With the cap now at 75, a full page of *realistic*-
    // length entries fits (measured ~27.8 KB) -- so this scenario deliberately uses longer,
    // openly-unrealistic entries (labelled as such, not passed off as real re:Invent content) to
    // force the byte-budget path specifically, distinct from the cap test above: a full page of
    // 75 must still be shortened on its own.
    const sessions = Array.from({ length: 75 }, (_, i) => ({
      sessionId: `long-sched-${i}`,
      abbreviation: `LSC${String(i).padStart(3, "0")}`,
      title:
        `A deliberately extremely long and unrealistically verbose synthetic session title ` +
        `constructed specifically to inflate response size well beyond what a real re:Invent ` +
        `session title would ever be, for schedule pagination byte-budget shortening test ` +
        `purposes, entry number ${i}`,
      venue: "MGM Grand Convention Center Extended Wing",
      room: "Level 3 | Chairman's Ballroom 363 | Content Hub Annex | White Theater Overflow Area",
      // Strictly increasing minute-of-day, one per entry (not cycling like other tests' `% 8`
      // patterns) -- this test relies on `sessions` being in exact sorted order by construction to
      // predict which entry `nextOffset` should point at next.
      sessionTime: {
        date: "2026-12-01",
        time: `${String(8 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
        length: "10",
      },
    }));
    seedCatalog(home.path, sessions);
    const client = await connectedClient(home.path, {
      getSchedule: async () => ({
        reserved: [],
        favorites: sessions.map((s) => s.sessionId),
        personalTime: [],
      }),
    });

    const result = await client.callTool({ name: "get_schedule", arguments: { limit: 75 } });

    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(30 * 1024);
    const parsed = JSON.parse(textOf(result)) as {
      entries: Array<{ sessionId: string }>;
      total: number;
      returned: number;
      offset: number;
      nextOffset?: number;
    };
    expect(parsed.total).toBe(75);
    // Fewer than the requested (and available) 75 -- the scenario is built so a full page
    // genuinely does not fit, exercising the shortening path rather than assuming it works.
    expect(parsed.returned).toBeLessThan(75);
    expect(parsed.entries).toHaveLength(parsed.returned);
    // nextOffset must reflect what was actually returned (so the next call resumes exactly where
    // this one stopped), not the full requested limit -- the bug a naive "advance by limit
    // regardless of what fit" implementation would produce.
    expect(parsed.nextOffset).toBe(parsed.offset + parsed.returned);

    // The decisive check: nextOffset genuinely points at the first entry that was cut, not just
    // an arithmetically-plausible number. Following it up (offset: nextOffset) must yield exactly
    // the entry immediately after the last one already returned, sessions being chronologically
    // ordered by construction.
    const continued = await client.callTool({
      name: "get_schedule",
      arguments: { limit: 1, offset: parsed.nextOffset },
    });
    const continuedParsed = JSON.parse(textOf(continued)) as { entries: Array<{ sessionId: string }> };
    expect(continuedParsed.entries[0]!.sessionId).toBe(sessions[parsed.returned]!.sessionId);
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

  it("sorts entries with a real date but a null time after entries with a known time, unresolved entries last of all", async () => {
    // Reviewer's finding: "unscheduled last" covers two different cases a naive comparator
    // conflates -- an unresolved entry (no time fields at all) and a resolved entry whose own
    // startTime happens to be null (the index record's field is nullable independently of
    // startDate). A fixture mixing all three is what exposes a `a ?? ""` or bare `<` bug; a
    // fixture where every session has a real time (as every earlier test in this file uses)
    // cannot.
    const withTime = {
      sessionId: "with-time",
      abbreviation: "WT1",
      title: "Has a real time",
      sessionTime: { date: "2026-12-01", time: "09:00", length: "30" },
    };
    const dateOnly = {
      sessionId: "date-only",
      abbreviation: "DO1",
      title: "Has a date but no time",
      // No `sessionTime` at all still leaves startDate/startTime both null via buildIndexRecord --
      // resolved-with-a-date-but-null-time specifically requires touching the record after the
      // fact, since the real API never actually reports one without the other in practice.
    };
    seedCatalog(home.path, [withTime, dateOnly]);
    // Force the "resolved, date present, time null" case the API doesn't naturally produce, by
    // patching the already-written index directly -- this is the one state a fixture alone can't
    // reach, and it's exactly the state the reviewer's finding is about.
    const indexPath = join(home.path, "catalog", "index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as Array<{ sessionId: string; startDate: string | null; startTime: string | null }>;
    const dateOnlyRecord = index.find((r) => r.sessionId === dateOnly.sessionId)!;
    dateOnlyRecord.startDate = "2026-12-01";
    dateOnlyRecord.startTime = null;
    writeFileSync(indexPath, JSON.stringify(index), "utf8");

    const unresolvedId = "not-in-any-catalog";
    const client = await connectedClient(home.path, {
      getSchedule: async () => ({
        reserved: [],
        favorites: [unresolvedId, withTime.sessionId, dateOnly.sessionId],
        personalTime: [],
      }),
    });

    const result = await client.callTool({ name: "get_schedule", arguments: {} });
    const parsed = JSON.parse(textOf(result)) as { entries: Array<{ sessionId: string }> };

    expect(parsed.entries.map((e) => e.sessionId)).toEqual([
      withTime.sessionId,
      dateOnly.sessionId,
      unresolvedId,
    ]);
  });

  it("stays consistent and complete across pages even when the API reorders favorites between calls", async () => {
    // Reviewer's finding: get_schedule re-reads the schedule from the API on every call, and
    // Array.prototype.sort is stable, so entries tied at date+time would otherwise keep whatever
    // order the API happened to return them in on that particular call -- if that order changes
    // between two calls of a multi-page walk, pages can overlap or skip an entry. All six sessions
    // here share the exact same date and time, so without the kind+tiebreaker levels of the
    // comparator, every one of them would be a tie.
    const sessions = Array.from({ length: 6 }, (_, i) => ({
      sessionId: `tied-${i}`,
      abbreviation: `TIE${i}`,
      title: `Tied-time session ${i}`,
      sessionTime: { date: "2026-12-01", time: "09:00", length: "30" },
    }));
    seedCatalog(home.path, sessions);
    let call = 0;
    const client = await connectedClient(home.path, {
      getSchedule: async () => {
        call++;
        const ids = sessions.map((s) => s.sessionId);
        // Second call (the second page's own re-read) sees a different API order than the first.
        return { reserved: [], favorites: call === 1 ? ids : [...ids].reverse(), personalTime: [] };
      },
    });

    async function page(limit: number, offset: number): Promise<string[]> {
      const result = await client.callTool({ name: "get_schedule", arguments: { limit, offset } });
      const parsed = JSON.parse(textOf(result)) as { entries: Array<{ sessionId: string }> };
      return parsed.entries.map((e) => e.sessionId);
    }

    const firstPage = await page(3, 0);
    const secondPage = await page(3, 3);

    expect(call).toBe(2); // confirms the API really was re-read with a different order the second time
    const combined = [...firstPage, ...secondPage];
    // Complete (every session appears) and disjoint (no session appears twice) regardless of the
    // API's own reordering -- the tiebreaker gives every entry a fixed position independent of
    // input order.
    expect(new Set(combined).size).toBe(6);
    expect(combined.sort()).toEqual(sessions.map((s) => s.sessionId).sort());
  });

  it("walks every page at four hundred favorites and reaches everything exactly once, in order, every page under budget", async () => {
    const sessions = Array.from({ length: 400 }, (_, i) => ({
      sessionId: `walk-${String(i).padStart(3, "0")}`,
      abbreviation: `WLK${String(i).padStart(3, "0")}`,
      title: `Walk session ${i}`,
      sessionTime: {
        date: `2026-12-${String(1 + (i % 5)).padStart(2, "0")}`,
        time: `${String(8 + (i % 10)).padStart(2, "0")}:00`,
        length: "30",
      },
    }));
    seedCatalog(home.path, sessions);
    const client = await connectedClient(home.path, {
      getSchedule: async () => ({
        reserved: [],
        favorites: sessions.map((s) => s.sessionId),
        personalTime: [],
      }),
    });

    const collected: string[] = [];
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const result = await client.callTool({ name: "get_schedule", arguments: { offset } });
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(30 * 1024);
      const parsed = JSON.parse(textOf(result)) as {
        entries: Array<{ sessionId: string }>;
        nextOffset?: number;
      };
      collected.push(...parsed.entries.map((e) => e.sessionId));
      offset = parsed.nextOffset;
      pages++;
      expect(pages).toBeLessThan(20); // sanity bound against an infinite loop if nextOffset ever misbehaves
    }

    expect(pages).toBeGreaterThan(1); // confirms this genuinely walked more than one page
    // Complete and in the same chronological order the sessions were constructed in -- no entry
    // missing, none repeated, none out of place.
    expect(collected).toEqual([...sessions].sort((a, b) => a.sessionTime.date.localeCompare(b.sessionTime.date) || a.sessionTime.time.localeCompare(b.sessionTime.time) || a.sessionId.localeCompare(b.sessionId)).map((s) => s.sessionId));
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

  it("computes startsAt from the event's real IANA timezone and sorts a personal-time block correctly against a session across a UTC day boundary", async () => {
    // The reviewer's discriminating case: a session at 20:00 Pacific local time on Dec 1 (which
    // is 04:00 UTC on Dec 2) versus a personal-time block at 2026-12-02T03:00:00 UTC (19:00
    // Pacific on Dec 1, an hour before the session). The personal-time block must sort FIRST.
    // Comparing the raw UTC *date* portion of the personal-time string ("2026-12-02") against the
    // session's raw local date ("2026-12-01") would put it AFTER the session instead -- the bug
    // this test exists to catch.
    const eveningSession = {
      sessionId: "evening-session",
      abbreviation: "EVE1",
      title: "Evening session",
      sessionTime: { date: "2026-12-01", time: "20:00", length: "60" },
    };
    seedCatalog(home.path, [eveningSession], { timezone: "America/Los_Angeles" });
    const personalTime: PersonalTime = {
      personalTimeId: "pt-dinner",
      startDateTime: "2026-12-02T03:00:00",
      endDateTime: "2026-12-02T04:00:00",
      title: "Dinner",
      description: "Team dinner",
    };
    const client = await connectedClient(home.path, {
      getSchedule: async () => ({
        reserved: [],
        favorites: [eveningSession.sessionId],
        personalTime: [personalTime],
      }),
    });

    const result = await client.callTool({ name: "get_schedule", arguments: {} });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(result)) as {
      entries: Array<{ kind: string; sessionId?: string; personalTimeId?: string; startsAt: string | null; endsAt?: string | null }>;
    };
    expect(parsed.entries.map((e) => e.kind)).toEqual(["personalTime", "favorite"]);
    expect(parsed.entries[0]!.personalTimeId).toBe("pt-dinner");
    expect(parsed.entries[0]!.startsAt).toBe("2026-12-02T03:00:00Z");
    expect(parsed.entries[0]!.endsAt).toBe("2026-12-02T04:00:00Z");
    expect(parsed.entries[1]!.sessionId).toBe(eveningSession.sessionId);
    expect(parsed.entries[1]!.startsAt).toBe("2026-12-02T04:00:00Z");
    // 60-minute session starting at startsAt.
    expect(parsed.entries[1]!.endsAt).toBe("2026-12-02T05:00:00Z");
    expect(parsed.entries[1]!.startsAt! > parsed.entries[0]!.startsAt!).toBe(true);
  });

  it("gives sessions a null startsAt and a warnings entry when the event's timezone is unknown, without falling back to a host or hardcoded zone", async () => {
    const sessions = [
      {
        sessionId: "no-tz-a",
        abbreviation: "NTZ1",
        title: "No timezone A",
        sessionTime: { date: "2026-12-01", time: "09:00", length: "30" },
      },
      {
        sessionId: "no-tz-b",
        abbreviation: "NTZ2",
        title: "No timezone B",
        sessionTime: { date: "2026-12-01", time: "10:00", length: "30" },
      },
    ];
    // timezone: null is sampleMeta's own default (an event whose GetEvent response omitted it) --
    // stated explicitly here anyway so this test doesn't depend on that default silently.
    seedCatalog(home.path, sessions, { timezone: null });
    const client = await connectedClient(home.path, {
      getSchedule: async () => ({
        reserved: [],
        favorites: sessions.map((s) => s.sessionId),
        personalTime: [],
      }),
    });

    const result = await client.callTool({ name: "get_schedule", arguments: {} });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(result)) as {
      entries: Array<{ sessionId: string; startsAt: string | null; endsAt?: string | null }>;
      warnings?: string[];
    };
    expect(parsed.entries.every((e) => e.startsAt === null)).toBe(true);
    expect(parsed.entries.every((e) => e.endsAt === null)).toBe(true);
    // Sessions still sort correctly relative to EACH OTHER via the raw local date/time fallback.
    expect(parsed.entries.map((e) => e.sessionId)).toEqual(["no-tz-a", "no-tz-b"]);
    expect(parsed.warnings).toBeDefined();
    expect(parsed.warnings!.some((w) => /timezone/i.test(w) && /unreliable/i.test(w))).toBe(true);
  });

  it("does not include a warnings entry when the event timezone is known", async () => {
    seedCatalog(home.path, [], { timezone: "America/Los_Angeles" });
    const client = await connectedClient(home.path, {
      getSchedule: async () => ({ reserved: [], favorites: [], personalTime: [] }),
    });

    const result = await client.callTool({ name: "get_schedule", arguments: {} });

    const parsed = JSON.parse(textOf(result)) as { warnings?: string[] };
    expect(parsed.warnings).toBeUndefined();
  });

  it("stays consistent and complete across pages when the API reorders favorites between calls, using the startsAt-based sort key when the event timezone is known", async () => {
    // The same reordering-determinism scenario as the existing null-timezone test above, but with
    // a real event timezone so every session's tie is on `startsAt` (all six share one local
    // date+time, so once converted they share one identical startsAt too) rather than on the raw
    // sortDate/sortTime fallback -- proving the kind+tiebreaker levels still work underneath the
    // new primary sort key, not just underneath the old one.
    const sessions = Array.from({ length: 6 }, (_, i) => ({
      sessionId: `tz-tied-${i}`,
      abbreviation: `TZT${i}`,
      title: `Timezone tied-time session ${i}`,
      sessionTime: { date: "2026-12-01", time: "09:00", length: "30" },
    }));
    seedCatalog(home.path, sessions, { timezone: "America/Los_Angeles" });
    let call = 0;
    const client = await connectedClient(home.path, {
      getSchedule: async () => {
        call++;
        const ids = sessions.map((s) => s.sessionId);
        return { reserved: [], favorites: call === 1 ? ids : [...ids].reverse(), personalTime: [] };
      },
    });

    async function page(limit: number, offset: number): Promise<string[]> {
      const result = await client.callTool({ name: "get_schedule", arguments: { limit, offset } });
      const parsed = JSON.parse(textOf(result)) as { entries: Array<{ sessionId: string }> };
      return parsed.entries.map((e) => e.sessionId);
    }

    const firstPage = await page(3, 0);
    const secondPage = await page(3, 3);

    expect(call).toBe(2);
    const combined = [...firstPage, ...secondPage];
    expect(new Set(combined).size).toBe(6);
    expect(combined.sort()).toEqual(sessions.map((s) => s.sessionId).sort());
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
