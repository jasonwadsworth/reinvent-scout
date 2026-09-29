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
import { AuthRequiredError, NotFoundError, NotRegisteredError, OperationUnavailableError } from "../../src/core/errors.js";
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
  reserveSessions?: ApiClient["reserveSessions"];
  cancelReservation?: ApiClient["cancelReservation"];
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
    getSession: async () => { throw new Error("unused getSession"); },
    getEvent: async () => {
      throw new Error("not implemented in this fake");
    },
    listSessions: async () => {
      throw new Error("not implemented in this fake");
    },
    listAllSessions: async () => {
      throw new Error("not implemented in this fake");
    },
    reserveSessions: overrides.reserveSessions ?? (async () => { throw new Error("unused reserveSessions"); }),
    cancelReservation: overrides.cancelReservation ?? (async () => { throw new Error("unused cancelReservation"); }),
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

describe("the thirteen registered tools", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("lists exactly the thirteen expected tools, by name", async () => {
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
        "plan_schedule",
        "reserve_sessions",
        "cancel_reservation",
        "nearby_sessions",
        "get_onsite_preferences",
        "set_onsite_preferences",
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

  it("caps the limit at sixty even when a larger one is requested", async () => {
    // Lead's revised cap: adding `kind` and the pagination metadata to each entry means a full
    // page of 100 at realistic entry lengths already exceeds the budget before anything unusually
    // long is involved. 75 turned out not to leave enough headroom once startsAt/endsAt were added
    // (~58 bytes per entry): a full page of 75 realistic-length entries had only ~330 bytes of
    // margin, and a second page was already measured being budget-shortened to 74 -- the
    // shortening path was silently the common case. 60 restores real headroom, so this is chosen
    // to make a full page the normal case. Moderate-length entries here (not the stress-test
    // lengths the byte-budget test below uses) isolate the cap itself: this must return exactly
    // 60, not fewer for a byte reason.
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
    expect(parsed.returned).toBe(60);
    expect(parsed.entries).toHaveLength(60);
  });

  it("keeps the response under thirty kilobytes even within a single page at the cap, shortening it and advancing nextOffset to the first cut entry", async () => {
    // Reviewer's finding: get_schedule had no budget at all and measured ~30.8 KB at a hundred
    // favorites against the real catalog. With the cap now at 60 (down from an initial 75, which
    // left only ~330 bytes of headroom at a full page of realistic-length entries once
    // startsAt/endsAt were added), a full page of *realistic*-length entries fits with real margin
    // -- so this scenario deliberately uses longer, openly-unrealistic entries (labelled as such,
    // not passed off as real re:Invent content) to force the byte-budget path specifically,
    // distinct from the cap test above: a full page of 60 must still be shortened on its own.
    const sessions = Array.from({ length: 60 }, (_, i) => ({
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

    const result = await client.callTool({ name: "get_schedule", arguments: { limit: 60 } });

    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(30 * 1024);
    const parsed = JSON.parse(textOf(result)) as {
      entries: Array<{ sessionId: string }>;
      total: number;
      returned: number;
      offset: number;
      nextOffset?: number;
    };
    expect(parsed.total).toBe(60);
    // Fewer than the requested (and available) 60 -- the scenario is built so a full page
    // genuinely does not fit, exercising the shortening path rather than assuming it works.
    expect(parsed.returned).toBeLessThan(60);
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

  it("always advances past a single entry that alone exceeds the budget, truncating its own long fields rather than returning nothing", async () => {
    // Reviewer's finding: a page whose very first entry alone exceeds the budget returned zero
    // entries with nextOffset === offset -- an agent paging "until nextOffset is absent" loops
    // forever on it. Reproduced with an oversized personal-time description (the OpenAPI schema
    // caps this at 250 characters for a conforming API, but nothing here trusts that at runtime).
    const oversizedPersonalTime: PersonalTime = {
      personalTimeId: "pt-oversized",
      startDateTime: "2026-12-01T08:00:00",
      endDateTime: "2026-12-01T08:30:00",
      title: "Oversized block",
      description: "x".repeat(40 * 1024), // 40 KB alone, well past the 30 KB whole-response budget
    };
    const laterSessions = Array.from({ length: 20 }, (_, i) => ({
      sessionId: `after-oversized-${i}`,
      abbreviation: `AOS${i}`,
      title: `Session after the oversized block ${i}`,
      sessionTime: { date: "2026-12-01", time: `${String(9 + i).padStart(2, "0")}:00`, length: "30" },
    }));
    seedCatalog(home.path, laterSessions);
    const client = await connectedClient(home.path, {
      getSchedule: async () => ({
        reserved: [],
        favorites: laterSessions.map((s) => s.sessionId),
        personalTime: [oversizedPersonalTime],
      }),
    });

    const result = await client.callTool({ name: "get_schedule", arguments: {} });

    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(30 * 1024);
    const parsed = JSON.parse(textOf(result)) as {
      entries: Array<{ kind: string; personalTimeId?: string; description?: string }>;
      offset: number;
      nextOffset?: number;
      total: number;
      warnings?: string[];
    };
    // At least the oversized entry itself must come back -- not an empty page.
    expect(parsed.entries.length).toBeGreaterThanOrEqual(1);
    expect(parsed.entries[0]!.personalTimeId).toBe("pt-oversized");
    // Its own description was shrunk to fit -- the whole-response budget check above already
    // proves it landed under 30 KB; this just confirms it's strictly smaller than the original 40 KB.
    expect(parsed.entries[0]!.description!.length).toBeLessThan(oversizedPersonalTime.description.length);
    expect(parsed.entries[0]!.description!.endsWith("...")).toBe(true);
    // The decisive check: nextOffset must have genuinely advanced past this entry, not equal the
    // offset it started at -- the exact condition that made a naive paging loop forever.
    expect(parsed.nextOffset).toBeDefined();
    expect(parsed.nextOffset).toBeGreaterThan(parsed.offset);
    // reviewer2's own follow-up: the only signal an entry was shortened used to be a trailing
    // "..." on the field itself -- an agent relaying the attendee's own personal-time description
    // verbatim could easily miss that. A warnings entry must name the entry (its title) and which
    // field was shortened, not just the trailing ellipsis alone.
    expect(parsed.warnings).toBeDefined();
    const shrinkWarning = parsed.warnings!.find((w) => w.includes("Oversized block"));
    expect(shrinkWarning).toBeDefined();
    expect(shrinkWarning).toMatch(/description/i);
    expect(shrinkWarning).toMatch(/shorten|truncat/i);

    // Paging must actually reach the sessions after it, not get stuck.
    const continued = await client.callTool({
      name: "get_schedule",
      arguments: { offset: parsed.nextOffset },
    });
    const continuedParsed = JSON.parse(textOf(continued)) as { entries: Array<{ sessionId: string }> };
    expect(continuedParsed.entries.length).toBeGreaterThan(0);
    expect(continuedParsed.entries[0]!.sessionId).toBe(laterSessions[0]!.sessionId);
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

  it("gives sessions a null startsAt and a warnings entry when the event's timezone is unknown (an explicit null, the API omitted it), without falling back to a host or hardcoded zone", async () => {
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
    // This is the genuinely-unfixable case: the message must not name catalog_sync as a remedy,
    // since running it again cannot change what the API itself reported.
    expect(parsed.warnings!.join(" ")).not.toContain("catalog_sync");
  });

  it("gives a distinctly-worded, catalog_sync-naming warning when the stored catalog predates timezone support entirely (no timezone key at all), never conflating it with an explicit null", async () => {
    // Reviewer's finding: a v4 meta.json (synced before the schema-5 bump) has no `timezone` key
    // on disk at all, which `readMeta`'s unvalidated cast reads back as `undefined` -- easy to
    // silently treat the same as an explicit `null` (the API genuinely reporting none). The two
    // need opposite remedies: this one is fixed by one more catalog_sync; an explicit null is not
    // fixable by syncing again. Written directly, since writeCatalog's own CatalogMeta type can't
    // produce a meta object missing a required field.
    const sessions = [
      {
        sessionId: "pre-bump-a",
        abbreviation: "PB1",
        title: "Pre-bump session",
        sessionTime: { date: "2026-12-01", time: "09:00", length: "30" },
      },
    ];
    seedCatalog(home.path, sessions, { timezone: null });
    const metaPath = join(home.path, "catalog", "meta.json");
    const preBumpMeta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    delete preBumpMeta.timezone;
    writeFileSync(metaPath, JSON.stringify(preBumpMeta), "utf8");

    const client = await connectedClient(home.path, {
      getSchedule: async () => ({ reserved: [], favorites: [sessions[0]!.sessionId], personalTime: [] }),
    });

    const result = await client.callTool({ name: "get_schedule", arguments: {} });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(result)) as {
      entries: Array<{ startsAt: string | null }>;
      warnings?: string[];
    };
    expect(parsed.entries[0]!.startsAt).toBeNull();
    expect(parsed.warnings).toBeDefined();
    expect(parsed.warnings!.join(" ")).toContain("catalog_sync");
  });

  it("gives the pre-bump and explicit-null warnings genuinely different text, not one generic message for both", async () => {
    async function warningsFor(prepare: (storeRoot: string) => void): Promise<string[]> {
      prepare(home.path);
      const client = await connectedClient(home.path, {
        getSchedule: async () => ({ reserved: [], favorites: [], personalTime: [] }),
      });
      const result = await client.callTool({ name: "get_schedule", arguments: {} });
      const parsed = JSON.parse(textOf(result)) as { warnings?: string[] };
      return parsed.warnings ?? [];
    }

    const explicitNullWarnings = await warningsFor((storeRoot) => seedCatalog(storeRoot, [], { timezone: null }));

    home.cleanup();
    home = createTempHome();
    const preBumpWarnings = await warningsFor((storeRoot) => {
      seedCatalog(storeRoot, [], { timezone: null });
      const metaPath = join(storeRoot, "catalog", "meta.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
      delete meta.timezone;
      writeFileSync(metaPath, JSON.stringify(meta), "utf8");
    });

    expect(explicitNullWarnings).toHaveLength(1);
    expect(preBumpWarnings).toHaveLength(1);
    expect(explicitNullWarnings[0]).not.toBe(preBumpWarnings[0]);
  });

  it.each([
    ["a string Intl does not recognize as an IANA zone", "Not/AZone"],
    ["a number", 42],
    ["an object", {}],
    ["an empty string", ""],
    ["a single-element array whose toString() coincides with a valid zone", ["America/Los_Angeles"]],
    ["a two-element array", ["America/Los_Angeles", "UTC"]],
    ["a boolean", true],
  ])(
    "degrades to a null startsAt and an unrecognized-timezone warning, never isError, when the stored timezone is %s",
    async (_label, badValue) => {
      // sync.ts stores whatever GetEvent returns verbatim, with no validation on write, so a bad
      // value reaching meta.json is a real possibility this reader must survive rather than crash
      // on -- Intl.DateTimeFormat throws for every one of these, which must never propagate as an
      // isError result: a signed-in attendee's own schedule is still worth returning.
      const sessions = [
        {
          sessionId: "bad-tz-session",
          abbreviation: "BTZ1",
          title: "Bad timezone session",
          sessionTime: { date: "2026-12-01", time: "09:00", length: "30" },
        },
      ];
      seedCatalog(home.path, sessions, { timezone: "America/Los_Angeles" });
      const metaPath = join(home.path, "catalog", "meta.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
      meta.timezone = badValue;
      writeFileSync(metaPath, JSON.stringify(meta), "utf8");

      const client = await connectedClient(home.path, {
        getSchedule: async () => ({
          reserved: [],
          favorites: [sessions[0]!.sessionId],
          personalTime: [],
        }),
      });

      const result = await client.callTool({ name: "get_schedule", arguments: {} });

      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(textOf(result)) as {
        entries: Array<{ startsAt: string | null; endsAt?: string | null }>;
        warnings?: string[];
      };
      expect(parsed.entries[0]!.startsAt).toBeNull();
      expect(parsed.entries[0]!.endsAt).toBeNull();
      expect(parsed.warnings).toBeDefined();
      expect(parsed.warnings!.some((w) => /not a recognized IANA timezone/i.test(w))).toBe(true);
      // Names the stored (bad) value, and the remedy is "sync again", never the unfixable wording
      // used for an explicit API-reported omission.
      expect(parsed.warnings!.join(" ")).toContain("catalog_sync");
      // Reviewer's wording point: readTimezoneAvailability can't tell "the metadata was
      // corrupted" (a re-sync fixes it) apart from "GetEvent genuinely reports this value" (a
      // re-sync stores the same bad value again) -- the warning must hedge, never promise a fix.
      const warningText = parsed.warnings!.join(" ");
      expect(warningText).toMatch(/may resolve|might resolve|likely to resolve/i);
      expect(warningText).not.toMatch(/will (resolve|fix)|will very likely resolve/i);
    },
  );

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

  it("returns isError with the not-registered explanation on a 403 when nothing was written yet", async () => {
    const client = await connectedClient(home.path, {
      associateFavorites: async () => {
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

  it("returns a normal (non-isError) result carrying aborted, not isError, when the 403 surfaces after something was already written", async () => {
    // Lead's decision, on reviewer2's own finding: a 403/401 that lands after an earlier write
    // already landed server-side must not make this look like a plain failure -- the agent still
    // needs to relay the real successes, not just a sign-in instruction.
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

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(result)) as {
      successful: string[];
      verified: unknown;
      aborted?: { reason: string; message: string };
    };
    expect(parsed.successful).toEqual(["a"]);
    expect(parsed.verified).toBeNull();
    expect(parsed.aborted?.reason).toBe("notRegistered");
    expect(parsed.aborted?.message).toMatch(/will not help/i);
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

describe("reservation MCP tools", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); }); afterEach(() => home.cleanup());
  it("plans from the full schedule, then reserves returned IDs with intact ledger", async () => {
    seedCatalog(home.path, [{ sessionId: "future", title: "Future", sessionTime: { date: "2099-12-02", time: "10:00", length: "60" } }], { timezone: "America/Los_Angeles" });
    let calls = 0; let reserved: string[] = [];
    const client = await connectedClient(home.path, { reserveSessions: async (_event, ids) => { calls++; reserved = ids; return { successful: ids, failed: [] }; }, cancelReservation: async () => { reserved = []; }, getSchedule: async () => ({ reserved, favorites: [], personalTime: [] }) });
    const plan = await client.callTool({ name: "plan_schedule", arguments: { sessionIds: ["future"] } });
    expect(plan.isError).not.toBe(true); expect(calls).toBe(0);
    const ids = JSON.parse(textOf(plan)).selected.map((value: { sessionId: string }) => value.sessionId);
    const result = await client.callTool({ name: "reserve_sessions", arguments: { sessionIds: ids } });
    expect(JSON.parse(textOf(result))).toMatchObject({ successful: ids, verified: { reserved: ids } });
    expect(result.isError).not.toBe(true);
    const cancelled = await client.callTool({ name: "cancel_reservation", arguments: { sessionId: ids[0] } });
    expect(JSON.parse(textOf(cancelled))).toMatchObject({ outcome: "cancelled", verifiedAbsent: true });
  });
  it("rejects Unicode mandatory ledgers before write and reports uncertainty as error with intact JSON", async () => {
    let calls = 0;
    const client = await connectedClient(home.path, { reserveSessions: async () => { calls++; throw new Error("lost response"); } });
    const large = await client.callTool({ name: "reserve_sessions", arguments: { sessionIds: Array.from({ length: 50 }, (_, i) => `${i}${"界".repeat(126)}`) } });
    expect(large.isError).toBe(true); expect(calls).toBe(0);
    const result = await client.callTool({ name: "reserve_sessions", arguments: { sessionIds: ["constructor"] } });
    expect(result.isError).toBe(true); expect(JSON.parse(textOf(result)).uncertain).toEqual(["constructor"]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(30 * 1024);
  });
});

it("bounds a first409 tool error without replaying the operation", async () => {
  const home = createTempHome(); let calls = 0;
  try {
    const client = await connectedClient(home.path, { reserveSessions: async () => { calls++; throw new OperationUnavailableError("closed " + "界".repeat(50000)); } });
    const result = await client.callTool({ name: "reserve_sessions", arguments: { sessionIds: ["a"] } });
    expect(result.isError).toBe(true); expect(calls).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(30 * 1024);
    expect(textOf(result)).toContain("shortened");
  } finally { home.cleanup(); }
});

it("planning does not hide a hard commitment beyond display-page limits", async () => {
  const home = createTempHome();
  try {
    seedCatalog(home.path, [{ sessionId: "future", title: "Future", sessionTime: { date: "2099-12-02", time: "10:00", length: "60" } }], { timezone: "America/Los_Angeles" });
    const personalTime = Array.from({ length: 101 }, (_, i) => ({ personalTimeId: String(i), title: "Block", description: "", startDateTime: "2099-12-02T15:00:00", endDateTime: "2099-12-02T16:00:00" }));
    personalTime.push({ personalTimeId: "last", title: "Last block", description: "", startDateTime: "2099-12-02T18:00:00", endDateTime: "2099-12-02T19:00:00" });
    const client = await connectedClient(home.path, { getSchedule: async () => ({ reserved: [], favorites: [], personalTime }) });
    const result = await client.callTool({ name: "plan_schedule", arguments: { sessionIds: ["future"] } });
    expect(JSON.parse(textOf(result)).selected).toEqual([]);
    expect(JSON.parse(textOf(result)).rejected[0].conflictsWith).toEqual(["last"]);
  } finally { home.cleanup(); }
});


it("reads and updates event walk-up preferences through MCP without account reads", async () => {
  const home = createTempHome();
  try {
    const client = await connectedClient(home.path);
    const initial = await client.callTool({ name: "get_onsite_preferences", arguments: { eventId: "constructor" } });
    expect(JSON.parse(textOf(initial)).allowWalkUp).toBe(false);
    const updated = await client.callTool({ name: "set_onsite_preferences", arguments: { eventId: "constructor", patch: { allowWalkUp: true, sessionWalkUp: [{ sessionId: "constructor", allowWalkUp: false }] } } });
    expect(JSON.parse(textOf(updated)).sessionWalkUp).toEqual([{ sessionId: "constructor", allowWalkUp: false }]);
    const invalid = await client.callTool({ name: "nearby_sessions", arguments: { location: { venue: "alien", source: "user", confirmed: true } } });
    expect(invalid.isError).toBe(true);
  } finally { home.cleanup(); }
});

describe("per-call write cap", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); });
  afterEach(() => home.cleanup());
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);

  it.each(["reserve_sessions", "favorite_sessions"])("%s refuses more than thirty ids before any request, so a call never outlasts the MCP timeout", async name => {
    let calls = 0;
    const client = await connectedClient(home.path, {
      reserveSessions: async () => { calls++; return { successful: [], failed: [] }; },
      associateFavorites: async () => { calls++; return { successful: [], failed: [] }; },
    });
    const result = await client.callTool({ name, arguments: { sessionIds: ids(31) } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/30/);
    expect(calls).toBe(0);
  });
  it.each(["reserve_sessions", "favorite_sessions"])("%s accepts exactly thirty ids in one call", async name => {
    const all = ids(30);
    const client = await connectedClient(home.path, {
      reserveSessions: async (_e, list) => ({ successful: list, failed: [] }),
      associateFavorites: async (_e, list) => ({ successful: list, failed: [] }),
      getSchedule: async () => ({ reserved: all, favorites: all, personalTime: [] }),
    });
    const result = await client.callTool({ name, arguments: { sessionIds: all } });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result)).successful).toEqual(all);
  });
  it("still lets plan_schedule take fifty, since it never writes", async () => {
    const client = await connectedClient(home.path, {});
    const result = await client.callTool({ name: "plan_schedule", arguments: { sessionIds: ids(50) } });
    expect(textOf(result)).not.toMatch(/Expected 0–50|too_big|at most 30/i);
  });
  it.each(["reserve_sessions", "favorite_sessions"])("%s trims padded ids before sending them", async name => {
    const sent: string[][] = [];
    const client = await connectedClient(home.path, {
      reserveSessions: async (_e, list) => { sent.push(list); return { successful: list, failed: [] }; },
      associateFavorites: async (_e, list) => { sent.push(list); return { successful: list, failed: [] }; },
      getSchedule: async () => ({ reserved: ["a"], favorites: ["a"], personalTime: [] }),
    });
    await client.callTool({ name, arguments: { sessionIds: [" a "] } });
    expect(sent).toEqual([["a"]]);
  });
});
