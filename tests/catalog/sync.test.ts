import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiClient, ListAllSessionsOptions, ListAllSessionsResult } from "../../src/api/client.js";
import type { Session } from "../../src/api/types.js";
import { NotRegisteredError, ServiceError } from "../../src/core/errors.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import {
  CURRENT_SCHEMA_VERSION,
  readIndex,
  readMeta,
  readRaw,
  writeCatalog,
  type CatalogMeta,
} from "../../src/catalog/store.js";
import { DEFAULT_EVENT_ID, syncCatalog } from "../../src/catalog/sync.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

/** A minimal ApiClient stand-in -- sync.ts only ever calls listAllSessions, so the other two
 * methods just throw if a test somehow reaches them, making a mistaken call obvious. */
function fakeApiClient(
  listAllSessions: (eventId: string, options?: ListAllSessionsOptions) => Promise<ListAllSessionsResult>,
): ApiClient {
  return {
    getSchedule: async () => {
      throw new Error("fakeApiClient: getSchedule is not implemented, sync.ts should never call it");
    },
    listSessions: async () => {
      throw new Error("fakeApiClient: listSessions is not implemented, sync.ts should never call it");
    },
    listAllSessions,
  };
}

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

describe("syncCatalog", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("pulls every page and persists raw, index and meta", async () => {
    const client = fakeApiClient(async () => ({ sessions: fixture, totalCount: fixture.length }));

    await syncCatalog({ apiClient: client, storeRoot: home.path });

    expect(readRaw({ storeRoot: home.path })).toEqual(fixture);
    expect(readIndex({ storeRoot: home.path })).toEqual(fixture.map(buildIndexRecord));
    expect(readMeta({ storeRoot: home.path })).toEqual(
      sampleMeta({ syncedAt: readMeta({ storeRoot: home.path })!.syncedAt }),
    );
  });

  it("records the totalCount the API reported alongside the count it stored", async () => {
    const partial = fixture.slice(0, 50);
    const client = fakeApiClient(async () => ({ sessions: partial, totalCount: fixture.length }));

    const result = await syncCatalog({ apiClient: client, storeRoot: home.path });

    expect(result.count).toBe(50);
    expect(result.totalCount).toBe(fixture.length);
    const meta = readMeta({ storeRoot: home.path });
    expect(meta?.count).toBe(50);
    expect(meta?.totalCount).toBe(fixture.length);
  });

  it("warns when the stored count does not match the reported totalCount", async () => {
    const client = fakeApiClient(async () => ({
      sessions: fixture.slice(0, 50),
      totalCount: fixture.length,
    }));

    const result = await syncCatalog({ apiClient: client, storeRoot: home.path });

    expect(result.countMismatch).toBe(true);
  });

  it("does not warn when the stored count matches the reported totalCount", async () => {
    const client = fakeApiClient(async () => ({ sessions: fixture, totalCount: fixture.length }));

    const result = await syncCatalog({ apiClient: client, storeRoot: home.path });

    expect(result.countMismatch).toBe(false);
  });

  it("treats a missing totalCount as unreported rather than persisting an invalid value, and flags it distinctly from a mismatch", async () => {
    const client = fakeApiClient(async () => ({
      sessions: fixture,
      // Simulates the real API's success response omitting totalCount despite the type
      // declaring it required -- task 10's trust-the-response policy means nothing upstream of
      // sync.ts catches this. Comparing `count` against `undefined` would otherwise report a
      // false countMismatch, misdiagnosing "the canary itself didn't fire" as "a partial pull".
      totalCount: undefined as unknown as number,
    }));

    const result = await syncCatalog({ apiClient: client, storeRoot: home.path });

    expect(result.totalCountMissing).toBe(true);
    expect(result.countMismatch).toBe(false);
    // The count actually stored is the best available total when the server never reported one --
    // meta.json's totalCount field stays a real number rather than becoming undefined (which
    // JSON.stringify would silently drop, leaving the key missing entirely).
    expect(result.totalCount).toBe(fixture.length);
    const meta = readMeta({ storeRoot: home.path });
    expect(meta?.totalCount).toBe(fixture.length);
  });

  it("treats a non-finite totalCount the same as a missing one", async () => {
    const client = fakeApiClient(async () => ({ sessions: fixture, totalCount: Number.NaN }));

    const result = await syncCatalog({ apiClient: client, storeRoot: home.path });

    expect(result.totalCountMissing).toBe(true);
    expect(result.totalCount).toBe(fixture.length);
  });

  it("rebuilds the index from the stored raw data when the schema version is stale, without re-fetching", async () => {
    // Seed a previously-synced catalog at a stale schema version, with a deliberately wrong
    // index -- if the reindex path fell through to a real re-fetch (or did nothing), the index
    // would not come back matching the fixture, and fetchCount would not be zero either.
    writeCatalog(
      {
        raw: fixture,
        index: [],
        meta: sampleMeta({ schemaVersion: CURRENT_SCHEMA_VERSION - 1 }),
      },
      { storeRoot: home.path },
    );
    let fetchCount = 0;
    const client = fakeApiClient(async () => {
      fetchCount++;
      return { sessions: [], totalCount: 0 };
    });

    const result = await syncCatalog({ apiClient: client, storeRoot: home.path, reindex: true });

    expect(fetchCount).toBe(0);
    expect(result.reindexed).toBe(true);
    expect(readIndex({ storeRoot: home.path })).toEqual(fixture.map(buildIndexRecord));
    expect(readRaw({ storeRoot: home.path })).toEqual(fixture);
    const meta = readMeta({ storeRoot: home.path });
    expect(meta?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    // Everything else about the sync (when it happened, what the server reported) is preserved
    // from the previous sync, since a reindex never talks to the API.
    expect(meta?.totalCount).toBe(fixture.length);
    expect(meta?.syncedAt).toBe(1_700_000_000_000);
  });

  it("falls back to a full sync when --reindex is given but nothing has ever been synced", async () => {
    // A defensible judgment call, not specified by the plan: --reindex with no stored raw data
    // has nothing to reindex from, so it does a normal full sync instead of erroring, since a
    // CatalogMissingError-style type doesn't exist until task 16.
    let fetchCount = 0;
    const client = fakeApiClient(async () => {
      fetchCount++;
      return { sessions: fixture, totalCount: fixture.length };
    });

    const result = await syncCatalog({ apiClient: client, storeRoot: home.path, reindex: true });

    expect(fetchCount).toBe(1);
    expect(result.reindexed).toBe(false);
    expect(readRaw({ storeRoot: home.path })).toEqual(fixture);
  });

  it("leaves the previous catalog untouched when the pull fails part way", async () => {
    const previousIndex = fixture.map(buildIndexRecord);
    const previousMeta = sampleMeta({ syncedAt: 1_600_000_000_000 });
    writeCatalog({ raw: fixture, index: previousIndex, meta: previousMeta }, { storeRoot: home.path });

    const client = fakeApiClient(async () => {
      throw new ServiceError("simulated partial pull failure on page 4");
    });

    await expect(
      syncCatalog({ apiClient: client, storeRoot: home.path }),
    ).rejects.toBeInstanceOf(ServiceError);

    // Nothing about the previous, successful sync was touched -- not raw, not index, not meta.
    // apiClient.listAllSessions either resolves with the complete pull or rejects; writeCatalog
    // is only ever reached after it resolves, so a pull that fails partway never starts a write.
    expect(readRaw({ storeRoot: home.path })).toEqual(fixture);
    expect(readIndex({ storeRoot: home.path })).toEqual(previousIndex);
    expect(readMeta({ storeRoot: home.path })).toEqual(previousMeta);
  });

  it("surfaces NotRegisteredError unchanged so the CLI can explain it", async () => {
    const client = fakeApiClient(async () => {
      throw new NotRegisteredError();
    });

    await expect(
      syncCatalog({ apiClient: client, storeRoot: home.path }),
    ).rejects.toBeInstanceOf(NotRegisteredError);
  });

  it("defaults the event to reinvent2026", async () => {
    let seenEventId: string | undefined;
    const client = fakeApiClient(async (eventId) => {
      seenEventId = eventId;
      return { sessions: [], totalCount: 0 };
    });

    await syncCatalog({ apiClient: client, storeRoot: home.path });

    expect(seenEventId).toBe("reinvent2026");
    expect(readMeta({ storeRoot: home.path })?.eventId).toBe("reinvent2026");
  });

  it("uses the given event id instead of the default", async () => {
    let seenEventId: string | undefined;
    const client = fakeApiClient(async (eventId) => {
      seenEventId = eventId;
      return { sessions: [], totalCount: 0 };
    });

    await syncCatalog({ apiClient: client, storeRoot: home.path, eventId: "reinvent2027-summit" });

    expect(seenEventId).toBe("reinvent2027-summit");
    expect(readMeta({ storeRoot: home.path })?.eventId).toBe("reinvent2027-summit");
  });

  it("defaults includeAbstracts to true and passes it to the api client", async () => {
    let seenOptions: ListAllSessionsOptions | undefined;
    const client = fakeApiClient(async (_eventId, options) => {
      seenOptions = options;
      return { sessions: [], totalCount: 0 };
    });

    await syncCatalog({ apiClient: client, storeRoot: home.path });

    expect(seenOptions?.includeAbstracts).toBe(true);
    expect(readMeta({ storeRoot: home.path })?.includedAbstracts).toBe(true);
  });

  it("passes includeAbstracts: false through and records it in meta", async () => {
    let seenOptions: ListAllSessionsOptions | undefined;
    const client = fakeApiClient(async (_eventId, options) => {
      seenOptions = options;
      return { sessions: [], totalCount: 0 };
    });

    await syncCatalog({ apiClient: client, storeRoot: home.path, includeAbstracts: false });

    expect(seenOptions?.includeAbstracts).toBe(false);
    expect(readMeta({ storeRoot: home.path })?.includedAbstracts).toBe(false);
  });
});
