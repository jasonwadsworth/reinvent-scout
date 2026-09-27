import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  getCatalogState,
  readIndex,
  readMeta,
  readRaw,
  readTimezoneAvailability,
  writeCatalog,
  type CatalogMeta,
} from "../../src/catalog/store.js";
import type { Session } from "../../src/api/types.js";
import type { IndexRecord } from "../../src/catalog/index-record.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const SAMPLE_RAW: Session[] = [{ sessionId: "s1", title: "A session" }];
const SAMPLE_INDEX: IndexRecord[] = [
  {
    sessionId: "s1",
    abbreviation: null,
    title: "A session",
    type: null,
    level: null,
    levelBand: null,
    venue: null,
    room: null,
    startDate: null,
    startTime: null,
    lengthMinutes: null,
    services: [],
    topics: [],
    areasOfInterest: [],
    roles: [],
    features: [],
    industries: [],
    speakerCount: 0,
    isReservable: false,
    seatAvailability: null,
    titleTerms: { session: 1 },
    bodyTerms: {},
  },
];

function sampleMeta(overrides: Partial<CatalogMeta> = {}): CatalogMeta {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId: "reinvent2026",
    syncedAt: 1_700_000_000_000,
    totalCount: 1,
    count: 1,
    includedAbstracts: true,
    timezone: "America/Los_Angeles",
    ...overrides,
  };
}

describe("catalog store", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("writes raw, index and meta files under the store root", () => {
    writeCatalog({ raw: SAMPLE_RAW, index: SAMPLE_INDEX, meta: sampleMeta() }, { storeRoot: home.path });

    expect(existsSync(join(home.path, "catalog", "raw.json"))).toBe(true);
    expect(existsSync(join(home.path, "catalog", "index.json"))).toBe(true);
    expect(existsSync(join(home.path, "catalog", "meta.json"))).toBe(true);
  });

  it("round-trips the index", () => {
    writeCatalog({ raw: SAMPLE_RAW, index: SAMPLE_INDEX, meta: sampleMeta() }, { storeRoot: home.path });

    expect(readIndex({ storeRoot: home.path })).toEqual(SAMPLE_INDEX);
  });

  it("round-trips the raw sessions", () => {
    writeCatalog({ raw: SAMPLE_RAW, index: SAMPLE_INDEX, meta: sampleMeta() }, { storeRoot: home.path });

    expect(readRaw({ storeRoot: home.path })).toEqual(SAMPLE_RAW);
  });

  it("round-trips the event timezone", () => {
    writeCatalog(
      { raw: SAMPLE_RAW, index: SAMPLE_INDEX, meta: sampleMeta({ timezone: "America/Los_Angeles" }) },
      { storeRoot: home.path },
    );

    expect(readMeta({ storeRoot: home.path })?.timezone).toBe("America/Los_Angeles");
  });

  it("round-trips a null event timezone, for an event whose API response omits it", () => {
    writeCatalog(
      { raw: SAMPLE_RAW, index: SAMPLE_INDEX, meta: sampleMeta({ timezone: null }) },
      { storeRoot: home.path },
    );

    expect(readMeta({ storeRoot: home.path })?.timezone).toBeNull();
  });

  describe("readTimezoneAvailability", () => {
    it("reports a known timezone", () => {
      writeCatalog(
        { raw: SAMPLE_RAW, index: SAMPLE_INDEX, meta: sampleMeta({ timezone: "America/Los_Angeles" }) },
        { storeRoot: home.path },
      );

      expect(readTimezoneAvailability({ storeRoot: home.path })).toEqual({
        status: "known",
        timezone: "America/Los_Angeles",
      });
    });

    it("reports omittedByApi when meta explicitly stores a null timezone", () => {
      writeCatalog(
        { raw: SAMPLE_RAW, index: SAMPLE_INDEX, meta: sampleMeta({ timezone: null }) },
        { storeRoot: home.path },
      );

      expect(readTimezoneAvailability({ storeRoot: home.path })).toEqual({
        status: "unavailable",
        reason: "omittedByApi",
      });
    });

    it("reports syncedBeforeTimezoneSupport when the stored meta has no timezone key at all, distinct from an explicit null", () => {
      // A pre-schema-5 meta.json, written directly (writeCatalog can't produce this shape, since
      // CatalogMeta's own type requires the field -- this is exactly what readMeta's cast lets
      // through unvalidated in practice, from a catalog synced before this field existed).
      writeCatalog(
        { raw: SAMPLE_RAW, index: SAMPLE_INDEX, meta: sampleMeta({ timezone: null }) },
        { storeRoot: home.path },
      );
      const metaPath = join(home.path, "catalog", "meta.json");
      const withoutTimezoneKey = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
      delete withoutTimezoneKey.timezone;
      writeFileSync(metaPath, JSON.stringify(withoutTimezoneKey));

      expect(readTimezoneAvailability({ storeRoot: home.path })).toEqual({
        status: "unavailable",
        reason: "syncedBeforeTimezoneSupport",
      });
    });

    it("returns null when nothing has been synced", () => {
      expect(readTimezoneAvailability({ storeRoot: home.path })).toBeNull();
    });
  });

  it("reports the catalog as missing when nothing has been synced", () => {
    expect(getCatalogState({ storeRoot: home.path })).toEqual({ status: "missing" });
  });

  it("reports the index as stale when the schema version differs from the current one", () => {
    const meta = sampleMeta({ schemaVersion: CURRENT_SCHEMA_VERSION - 1 });
    writeCatalog({ raw: SAMPLE_RAW, index: SAMPLE_INDEX, meta }, { storeRoot: home.path });

    const state = getCatalogState({ storeRoot: home.path });
    expect(state).toEqual({ status: "stale", reason: "schema-version", meta });
  });

  it("reports the catalog as stale when it was synced more than 24 hours ago", () => {
    const meta = sampleMeta({ syncedAt: 0 });
    writeCatalog({ raw: SAMPLE_RAW, index: SAMPLE_INDEX, meta }, { storeRoot: home.path });

    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
    const state = getCatalogState({ storeRoot: home.path, now: () => TWENTY_FOUR_HOURS_MS + 1 });
    expect(state).toEqual({ status: "stale", reason: "age", meta });
  });

  it("does not report a fresh catalog as stale", () => {
    const meta = sampleMeta({ syncedAt: 1_000_000 });
    writeCatalog({ raw: SAMPLE_RAW, index: SAMPLE_INDEX, meta }, { storeRoot: home.path });

    const state = getCatalogState({ storeRoot: home.path, now: () => 1_000_000 + 60_000 });
    expect(state).toEqual({ status: "fresh", meta });
  });

  it("reports the catalog as stale with reason corrupt rather than throwing when meta.json is not valid JSON", () => {
    mkdirSync(join(home.path, "catalog"), { recursive: true });
    writeFileSync(join(home.path, "catalog", "meta.json"), "{ not valid json", { mode: 0o600 });

    expect(() => getCatalogState({ storeRoot: home.path })).not.toThrow();
    expect(getCatalogState({ storeRoot: home.path })).toEqual({ status: "stale", reason: "corrupt" });
  });

  it("reports the catalog as stale with reason corrupt rather than throwing when the meta file path is a directory", () => {
    // A directory where meta.json should be. readFileSync throws EISDIR for this; an
    // exists-then-read check does not protect against it, since the path does exist.
    mkdirSync(join(home.path, "catalog", "meta.json"), { recursive: true });

    expect(() => getCatalogState({ storeRoot: home.path })).not.toThrow();
    expect(getCatalogState({ storeRoot: home.path })).toEqual({ status: "stale", reason: "corrupt" });
  });
});
