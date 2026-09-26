import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { CatalogMissingError } from "../../src/core/errors.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog, type CatalogMeta } from "../../src/catalog/store.js";
import { getIndexRecord, queryCatalog } from "../../src/catalog/query.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

/** The four fixture sessions confirmed to have neither `room` nor `sessionTime` (see
 * tests/fixtures/README.md) -- these must never appear in a day-filtered result, since they
 * have no day to match against. */
const UNSCHEDULED_SESSION_IDS = [
  "1780441461602001Ge7H",
  "1780441467570001GW41",
  "1780441467622001GM4k",
  "1780441473347001G7EU",
];

function sampleMeta(overrides: Partial<CatalogMeta> = {}): CatalogMeta {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId: "reinvent2026",
    syncedAt: 1_700_000_000_000,
    totalCount: fixture.length,
    count: fixture.length,
    includedAbstracts: true,
    ...overrides,
  };
}

describe("queryCatalog", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  function seedCatalog(): void {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );
  }

  it("matches on a title term", () => {
    seedCatalog();

    // ANT301's title is "Graviton. Serverless. Apache Iceberg. ..." -- "graviton" appears only
    // in the title, nowhere in the abstract or taxonomy fields of that session.
    const results = queryCatalog({ storeRoot: home.path }, { query: "graviton" });

    expect(results.some((r) => r.record.abbreviation === "ANT301")).toBe(true);
  });

  it("matches on an abstract term", () => {
    seedCatalog();

    // INV501's abstract contains "answering", which appears in no fixture title.
    const results = queryCatalog({ storeRoot: home.path }, { query: "answering" });

    expect(results.some((r) => r.record.abbreviation === "INV501")).toBe(true);
  });

  it("filters by session type", () => {
    seedCatalog();

    const results = queryCatalog({ storeRoot: home.path }, { type: "Chalk talk" });

    expect(results.map((r) => r.record.abbreviation).sort()).toEqual(["IND391", "INV501"]);
  });

  it("filters by venue including a derived venue", () => {
    seedCatalog();

    // GHJ308-S has no `venue` field but a room starting "Caesars Palace | ..." -- its venue is
    // derived, not reported directly, so this also proves the filter reads the derived value on
    // the index record rather than the raw API field.
    const results = queryCatalog({ storeRoot: home.path }, { venue: "Caesars Palace" });

    expect(results.some((r) => r.record.abbreviation === "GHJ308-S")).toBe(true);
    expect(results.every((r) => r.record.venue === "Caesars Palace")).toBe(true);
  });

  it("filters by level band range", () => {
    seedCatalog();

    const results = queryCatalog({ storeRoot: home.path }, { levelBand: { min: 100, max: 200 } });

    const abbreviations = results.map((r) => r.record.abbreviation);
    expect(abbreviations).toContain("BIZ109"); // level band 100
    expect(abbreviations).toContain("TNC213"); // level band 200
    expect(abbreviations).not.toContain("ANT401"); // level band 400
    expect(abbreviations).not.toContain("INV501"); // level band 500
  });

  it("filters by day", () => {
    seedCatalog();

    const results = queryCatalog({ storeRoot: home.path }, { day: "2026-12-01" });

    expect(results.map((r) => r.record.abbreviation).sort()).toEqual([
      "ANT335",
      "API318",
      "ARC405",
      "COP303",
    ]);
  });

  it("excludes unscheduled sessions when a day filter is given", () => {
    seedCatalog();

    const results = queryCatalog({ storeRoot: home.path }, { day: "2026-12-01" });

    // Asserted against the specific sessions known to have no room and no sessionTime, not just
    // "the result is non-empty" -- a fixture with few unscheduled sessions would pass a weaker
    // assertion by accident even if the day filter didn't exclude them at all.
    const resultIds = results.map((r) => r.record.sessionId);
    for (const unscheduledId of UNSCHEDULED_SESSION_IDS) {
      expect(resultIds).not.toContain(unscheduledId);
    }
  });

  it("orders results deterministically by score then abbreviation", () => {
    seedCatalog();

    // No query text, so every result scores 0 -- a genuine tie across the whole result set,
    // which is what actually exercises the abbreviation tiebreak for every adjacent pair.
    // "IND391" sorts before "INV501" (the third character, 'D' vs 'V', decides it).
    const results = queryCatalog({ storeRoot: home.path }, { type: "Chalk talk" });

    expect(results.map((r) => r.record.abbreviation)).toEqual(["IND391", "INV501"]);
  });

  it("caps results at the requested limit", () => {
    seedCatalog();

    const results = queryCatalog({ storeRoot: home.path }, { type: "Breakout session", limit: 3 });

    expect(results).toHaveLength(3);
  });

  it("returns a clear CatalogMissingError when nothing has been synced", () => {
    expect(() => queryCatalog({ storeRoot: home.path })).toThrow(CatalogMissingError);
  });
});

describe("getIndexRecord", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("returns the record for a known session id", () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );

    const record = getIndexRecord({ storeRoot: home.path }, "1780441461150001GGoc");

    expect(record?.abbreviation).toBe("ANT301");
  });

  it("returns null for a session id that is not in the catalog", () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );

    expect(getIndexRecord({ storeRoot: home.path }, "does-not-exist")).toBeNull();
  });

  it("throws CatalogMissingError when nothing has been synced", () => {
    expect(() => getIndexRecord({ storeRoot: home.path }, "any-id")).toThrow(CatalogMissingError);
  });
});
