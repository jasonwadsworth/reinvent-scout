import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { CatalogMissingError, CatalogUnusableError } from "../../src/core/errors.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog, type CatalogMeta } from "../../src/catalog/store.js";
import { catalogServiceNames, queryCatalog, resolveSessionRecord } from "../../src/catalog/query.js";
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

  it("does not match every session on a query term that collides with Object.prototype", () => {
    // None of the 60 fixture sessions contains "constructor" anywhere (confirmed against the
    // fixture directly). A bare `record.titleTerms[term]` read would resolve to the inherited
    // Object constructor function for every one of them regardless, since JSON.parse always
    // produces Object.prototype-inheriting objects on the read side no matter how the index was
    // built -- so this must return nothing, not the whole catalog scored NaN.
    seedCatalog();

    const results = queryCatalog({ storeRoot: home.path }, { query: "constructor" });

    expect(results).toEqual([]);
  });

  it("scores a genuine constructor match correctly and excludes sessions that do not contain it", () => {
    const constructorSession: Session = {
      sessionId: "synthetic-constructor-session",
      abbreviation: "SYN001",
      title: "A deep dive into the constructor pattern",
    };
    const augmentedRaw = [...fixture, constructorSession];
    writeCatalog(
      {
        raw: augmentedRaw,
        index: augmentedRaw.map(buildIndexRecord),
        meta: sampleMeta({ totalCount: augmentedRaw.length, count: augmentedRaw.length }),
      },
      { storeRoot: home.path },
    );

    const results = queryCatalog({ storeRoot: home.path }, { query: "constructor" });

    expect(results).toHaveLength(1);
    expect(results[0]?.record.sessionId).toBe("synthetic-constructor-session");
    expect(Number.isFinite(results[0]?.score)).toBe(true);
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it("refuses to search an index built at an older schema version rather than silently serving it", () => {
    // A schema-version mismatch means the on-disk index may have been built by a version of this
    // tool with a fixed bug since (see CURRENT_SCHEMA_VERSION 1 -> 2's history: a stale index can
    // hold a genuinely corrupted own-property value for any term that collided with
    // Object.prototype, which the read-side Object.hasOwn guard alone cannot repair -- it only
    // protects against a *false* match, not a term that really was poisoned on write). Confirmed
    // this is a real gap: Object.hasOwn(poisonedMap, "constructor") is true for a record actually
    // affected by the old bug, and multiplying its stored garbage string by the score weight
    // still produces NaN. Refusing outright, rather than serving possibly-wrong results, is the
    // only thing that actually makes the schema bump "cause existing indexes to rebuild".
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta({ schemaVersion: CURRENT_SCHEMA_VERSION - 1 }) },
      { storeRoot: home.path },
    );

    let caught: unknown;
    try {
      queryCatalog({ storeRoot: home.path });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CatalogUnusableError);
    expect((caught as CatalogUnusableError).reason).toBe("outdated");
    expect((caught as CatalogUnusableError).message).toMatch(/catalog sync/);
  });

  it("refuses to search when meta.json is corrupt, even beside a genuinely poisoned index", () => {
    // The reason to refuse an outdated-schema index is that it may be poisoned. When meta.json
    // can't be parsed, the schema version is unknowable, so the index may equally be poisoned --
    // there is no evidence either way, which makes refusing the consistent answer, not serving it
    // through on the theory that "corrupt" and "outdated" are different problems. Verified this
    // was a real gap before fixing it: a poisoned index behind a corrupt meta returned a NaN
    // score, exactly as if the schema-version guard didn't exist.
    const poisonedRecord = buildIndexRecord({
      sessionId: "poisoned-session",
      title: "the constructor pattern",
    });
    // Simulate the actual pre-fix write bug's output directly, since the current (fixed)
    // buildIndexRecord can no longer produce it.
    // Assign through a string-typed key so the index signature applies, rather than the
    // `constructor: Function` member TypeScript would otherwise resolve the literal to.
    const poisonedKey: string = "constructor";
    (poisonedRecord.titleTerms as unknown as Record<string, string>)[poisonedKey] =
      "function Object() { [native code] }1";
    writeCatalog(
      { raw: fixture, index: [poisonedRecord], meta: sampleMeta() },
      { storeRoot: home.path },
    );
    // Corrupt meta.json in place, leaving the just-written (poisoned) index.json untouched.
    writeFileSync(join(home.path, "catalog", "meta.json"), "{ truncated", "utf8");

    let caught: unknown;
    try {
      queryCatalog({ storeRoot: home.path }, { query: "constructor" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CatalogUnusableError);
    expect((caught as CatalogUnusableError).reason).toBe("corrupt");
  });

  it("does not refuse a catalog that is merely stale by age, only one with an outdated schema", () => {
    // Age staleness ("it's been a while since the last sync") says nothing about whether the
    // index's own data is trustworthy -- refusing to search here would defeat the point of
    // syncing the catalog locally in the first place.
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta({ syncedAt: 0 }) },
      { storeRoot: home.path },
    );

    expect(() => queryCatalog({ storeRoot: home.path })).not.toThrow();
    expect(queryCatalog({ storeRoot: home.path }, { query: "graviton" }).length).toBeGreaterThan(0);
  });
});

describe("resolveSessionRecord", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("resolves an exact session id", () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );

    const result = resolveSessionRecord({ storeRoot: home.path }, "1780441461150001GGoc");

    expect(result).toEqual({
      status: "found",
      record: expect.objectContaining({ abbreviation: "ANT301" }),
    });
  });

  it("resolves an abbreviation case-insensitively when the id does not match", () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );

    const result = resolveSessionRecord({ storeRoot: home.path }, "ant301");

    expect(result.status).toBe("found");
    expect(result.status === "found" && result.record.sessionId).toBe("1780441461150001GGoc");
  });

  it("reports not-found for a token that matches neither an id nor an abbreviation", () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );

    expect(resolveSessionRecord({ storeRoot: home.path }, "NOPE999")).toEqual({ status: "not-found" });
  });

  it("reports every candidate as ambiguous when an abbreviation matches more than one session", () => {
    const dupA: Session = { sessionId: "dup-session-a", abbreviation: "DUP100", title: "First" };
    const dupB: Session = { sessionId: "dup-session-b", abbreviation: "DUP100", title: "Second" };
    writeCatalog(
      {
        raw: [dupA, dupB],
        index: [dupA, dupB].map(buildIndexRecord),
        meta: sampleMeta({ totalCount: 2, count: 2 }),
      },
      { storeRoot: home.path },
    );

    const result = resolveSessionRecord({ storeRoot: home.path }, "DUP100");

    expect(result.status).toBe("ambiguous");
    expect(result.status === "ambiguous" && result.candidates.map((c) => c.sessionId).sort()).toEqual([
      "dup-session-a",
      "dup-session-b",
    ]);
  });

  it("throws CatalogMissingError when nothing has been synced", () => {
    expect(() => resolveSessionRecord({ storeRoot: home.path }, "anything")).toThrow(
      CatalogMissingError,
    );
  });
});

describe("catalogServiceNames", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("returns every distinct service name across the whole index", () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );

    const names = catalogServiceNames({ storeRoot: home.path });

    expect(names).toContain("AWS Lambda");
    expect(names).toContain("Amazon DynamoDB");
    // No duplicates, however many sessions share a service.
    expect(new Set(names).size).toBe(names.length);
  });

  it("throws CatalogMissingError when nothing has been synced", () => {
    expect(() => catalogServiceNames({ storeRoot: home.path })).toThrow(CatalogMissingError);
  });
});
