import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/aws/types.js";
import { LOOKUP_MAX_QUERY_LENGTH, lookupSessions } from "../../src/catalog/lookup.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { requireCurrentIndex } from "../../src/catalog/query.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { OUTPUT_BUDGET_BYTES, outputBytes } from "../../src/commands/output-budget.js";
import { ValidationError } from "../../src/core/errors.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const s = (sessionId: string, abbreviation: string, extra: Partial<Session> = {}): Session => ({
  sessionId, abbreviation, title: `Title ${abbreviation}`, abstract: `Abstract of ${abbreviation}`, type: "Chalk talk", level: "400 – Advanced", venue: "MGM Grand", room: "Room 7",
  sessionTime: { date: "2026-12-02", time: "10:30", length: "60" }, ...extra,
});

describe("lookupSessions", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); }); afterEach(() => home.cleanup());
  const seed = (raw: Session[], timezone: string | null = "America/Los_Angeles") => writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: raw.length, count: raw.length, includedAbstracts: true, timezone } }, { storeRoot: home.path });
  const deps = () => ({ storeRoot: home.path });

  it("resolves ids and codes mixed, each query keeping its own row", () => {
    seed([s("id-1", "ARC330"), s("id-2", "SEC419")]);
    const result = lookupSessions({ ids: ["id-1", "sec419"] }, deps());
    expect(result.rows.map(row => [row.query, row.sessionId, row.code])).toEqual([["id-1", "id-1", "ARC330"], ["sec419", "id-2", "SEC419"]]);
    expect(result).toMatchObject({ notFound: [], ambiguous: [], notReturned: [] });
    expect(result.rows[0]).toMatchObject({ title: "Title ARC330", type: "Chalk talk", level: "400 – Advanced", venue: "MGM Grand", room: "Room 7", startDate: "2026-12-02", startTime: "10:30", endTime: "11:30" });
    expect(result.rows[0]).not.toHaveProperty("abstract");
  });
  it("derives UTC times from the event timezone (10:30 Pacific on 2 December is 18:30Z, 60 minutes long)", () => {
    seed([s("id-1", "ARC330")]);
    expect(lookupSessions({ ids: ["id-1"] }, deps()).rows[0]).toMatchObject({ startsAt: "2026-12-02T18:30:00Z", endsAt: "2026-12-02T19:30:00Z" });
  });
  it("gives null UTC times and the timezone warning when the timezone is unknown", () => {
    seed([s("id-1", "ARC330")], null);
    const result = lookupSessions({ ids: ["id-1"] }, deps());
    expect(result.rows[0]).toMatchObject({ startsAt: null, endsAt: null, startTime: "10:30" });
    expect(result.warnings?.join(" ")).toMatch(/timezone/i);
  });
  it("lists up to 5 other sittings of a repeated talk", () => {
    const sittings = Array.from({ length: 8 }, (_, i) => s(`rep-${i}`, i === 0 ? "API303" : `API303-R${i}`, { sessionTime: { date: `2026-12-0${(i % 4) + 1}`, time: "10:30", length: "60" } }));
    seed(sittings);
    const row = lookupSessions({ ids: ["rep-0"] }, deps()).rows[0]!;
    expect(row.otherSittings).toHaveLength(5);
    expect(row.otherSittings[0]).toMatchObject({ sessionId: expect.any(String), code: expect.any(String), startDate: expect.any(String) });
  });
  it("reports unknown ids as notFound and a repeated abbreviation as ambiguous, dropping nothing", () => {
    seed([s("id-1", "DUP100"), s("id-2", "DUP100"), s("id-3", "OK200")]);
    const result = lookupSessions({ ids: ["nope", "dup100", "OK200"] }, deps());
    expect(result.notFound).toEqual(["nope"]);
    expect(result.ambiguous).toEqual([{ query: "dup100", sessionIds: ["id-1", "id-2"] }]);
    expect(result.rows.map(row => row.query)).toEqual(["OK200"]);
  });
  it("reads the index once for the whole call", () => {
    seed([s("id-1", "ARC330"), s("id-2", "SEC419")]);
    let reads = 0;
    lookupSessions({ ids: ["id-1", "id-2", "arc330"] }, { ...deps(), readIndexFn: d => { reads++; return requireCurrentIndex(d); } });
    expect(reads).toBe(1);
  });
  describe("abstracts", () => {
    it("returns the abstract only on request, cut to 1,500 characters", () => {
      seed([s("id-1", "ARC330", { abstract: "x".repeat(5000) })]);
      const row = lookupSessions({ ids: ["id-1"], includeAbstract: true }, deps()).rows[0]!;
      expect(row.abstract!.startsWith("x".repeat(1500))).toBe(true);
      expect(row.abstract!.length).toBeLessThan(1600);
      expect(row.abstract).toContain("[shortened]");
    });
    it("refuses more than 10 ids with abstracts", () => {
      seed([s("id-1", "ARC330")]);
      expect(() => lookupSessions({ ids: Array.from({ length: 11 }, (_, i) => `id-${i}`), includeAbstract: true }, deps())).toThrow(ValidationError);
    });
  });
  it("keeps to the budget even when ambiguous entries dominate, moving whole entries to notReturned", () => {
    const raw = Array.from({ length: 1000 }, (_, i) => s(`${"i".repeat(100)}-${i}`, `CODE${String(Math.floor(i / 10)).padStart(3, "0")}`));
    seed(raw);
    const ids = Array.from({ length: 100 }, (_, i) => `CODE${String(i).padStart(3, "0")}`);
    const result = lookupSessions({ ids }, deps());
    expect(outputBytes(result)).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
    const accounted = [...result.rows.map(row => row.query), ...result.notFound, ...result.ambiguous.map(entry => entry.query), ...result.notReturned];
    expect(accounted.sort()).toEqual([...ids].sort());
    expect(result.notReturned.length).toBeGreaterThan(0);
  });
  it("fits the budget by construction in the worst case: 100 maximum-length queries that all resolve to nothing", () => {
    seed([s("id-1", "ARC330")]);
    const ids = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, "0")}${"界".repeat(LOOKUP_MAX_QUERY_LENGTH - 3)}`);
    const result = lookupSessions({ ids }, deps());
    expect(result.notFound).toHaveLength(100);
    expect(outputBytes(result)).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
  });
  it("refuses a query longer than the limit that keeps the worst case within the budget", () => {
    seed([s("id-1", "ARC330")]);
    expect(() => lookupSessions({ ids: ["x".repeat(LOOKUP_MAX_QUERY_LENGTH + 1)] }, deps())).toThrow(ValidationError);
    expect(lookupSessions({ ids: ["x".repeat(LOOKUP_MAX_QUERY_LENGTH)] }, deps()).notFound).toHaveLength(1);
  });
  it("refuses 0 or more than 100 ids", () => {
    seed([s("id-1", "ARC330")]);
    expect(() => lookupSessions({ ids: [] }, deps())).toThrow(ValidationError);
    expect(() => lookupSessions({ ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) }, deps())).toThrow(ValidationError);
  });
  it("stays within the output budget for 100 ids with 2,000-character titles, and accounts for every query exactly once", () => {
    const raw = Array.from({ length: 100 }, (_, i) => s(`id-${i}`, `ABC${String(i).padStart(3, "0")}`, { title: "界".repeat(2000) }));
    seed(raw);
    const ids = [...raw.map(session => session.sessionId), ];
    const result = lookupSessions({ ids }, deps());
    expect(outputBytes(result)).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
    const accounted = [...result.rows.map(row => row.query), ...result.notFound, ...result.ambiguous.map(entry => entry.query), ...result.notReturned];
    expect(accounted.sort()).toEqual([...ids].sort());
    expect(result.notReturned.length).toBeGreaterThan(0);
  });
});
