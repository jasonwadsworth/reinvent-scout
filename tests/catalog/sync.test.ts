import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiClient, ListAllSessionsOptions, ListAllSessionsResult } from "../../src/api/client.js";
import type { Event, Session } from "../../src/api/types.js";
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

/** A minimal ApiClient stand-in -- sync.ts only ever calls listAllSessions and getEvent, so the
 * other three methods just throw if a test somehow reaches them, making a mistaken call obvious.
 * `getEventImpl` defaults to an event with no timezone at all -- a neutral stand-in most tests in
 * this file don't care about -- rather than a real IANA zone, so a test that never overrides it
 * can't accidentally pass because of a value it never asked for. */
function fakeApiClient(
  listAllSessions: (eventId: string, options?: ListAllSessionsOptions) => Promise<ListAllSessionsResult>,
  getEventImpl: (eventId: string) => Promise<Event> = async (eventId) => ({ eventId }),
): ApiClient {
  return {
    getSchedule: async () => {
      throw new Error("fakeApiClient: getSchedule is not implemented, sync.ts should never call it");
    },
    getSession: async () => { throw new Error("unused getSession"); },
    getEvent: getEventImpl,
    listSessions: async () => {
      throw new Error("fakeApiClient: listSessions is not implemented, sync.ts should never call it");
    },
    listAllSessions,
    reserveSessions: async () => { throw new Error("unused reserveSessions"); },
    cancelReservation: async () => { throw new Error("unused cancelReservation"); },
    associateFavorites: async () => {
      throw new Error("fakeApiClient: associateFavorites is not implemented, sync.ts should never call it");
    },
    disassociateFavorite: async () => {
      throw new Error("fakeApiClient: disassociateFavorite is not implemented, sync.ts should never call it");
    },
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
    timezone: null,
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

  it("stores the event's IANA timezone from getEvent in meta", async () => {
    const client = fakeApiClient(
      async () => ({ sessions: fixture, totalCount: fixture.length }),
      async (eventId) => ({ eventId, timezone: "America/Los_Angeles" }),
    );

    await syncCatalog({ apiClient: client, storeRoot: home.path });

    expect(readMeta({ storeRoot: home.path })?.timezone).toBe("America/Los_Angeles");
  });

  it("stores a null timezone, never a host or hardcoded fallback, when getEvent's response omits it", async () => {
    const client = fakeApiClient(
      async () => ({ sessions: fixture, totalCount: fixture.length }),
      async (eventId) => ({ eventId }),
    );

    await syncCatalog({ apiClient: client, storeRoot: home.path });

    expect(readMeta({ storeRoot: home.path })?.timezone).toBeNull();
  });

  it("passes the same event id to getEvent as to listAllSessions", async () => {
    let seenGetEventId: string | undefined;
    const client = fakeApiClient(
      async () => ({ sessions: [], totalCount: 0 }),
      async (eventId) => {
        seenGetEventId = eventId;
        return { eventId };
      },
    );

    await syncCatalog({ apiClient: client, storeRoot: home.path, eventId: "reinvent2027-summit" });

    expect(seenGetEventId).toBe("reinvent2027-summit");
  });

  it("preserves the previously-stored timezone across a reindex, since a reindex never contacts the API", async () => {
    writeCatalog(
      {
        raw: fixture,
        index: [],
        meta: sampleMeta({ schemaVersion: CURRENT_SCHEMA_VERSION - 1, timezone: "America/Los_Angeles" }),
      },
      { storeRoot: home.path },
    );
    const client = fakeApiClient(
      async () => {
        throw new Error("fakeApiClient: listAllSessions must not be called on a reindex");
      },
      async () => {
        throw new Error("fakeApiClient: getEvent must not be called on a reindex");
      },
    );

    await syncCatalog({ apiClient: client, storeRoot: home.path, reindex: true });

    expect(readMeta({ storeRoot: home.path })?.timezone).toBe("America/Los_Angeles");
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

  it("reindex fetches the event (no session pull) when the stored meta has no timezone key at all, and stores the real value", async () => {
    // A genuinely pre-schema-5 meta.json has no `timezone` key on disk at all -- writeCatalog's
    // own CatalogMeta type can't produce that, so it's written directly, then the key deleted.
    // This is the ordinary upgrade path the reviewer flagged: `status` reports schema-version
    // staleness for exactly this catalog, and --reindex is the documented remedy for it.
    writeCatalog(
      { raw: fixture, index: [], meta: sampleMeta({ schemaVersion: CURRENT_SCHEMA_VERSION - 1 }) },
      { storeRoot: home.path },
    );
    const metaPath = join(home.path, "catalog", "meta.json");
    const preBumpMeta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    delete preBumpMeta.timezone;
    writeFileSync(metaPath, JSON.stringify(preBumpMeta), "utf8");

    let listAllSessionsCalls = 0;
    let getEventCalls = 0;
    const client = fakeApiClient(
      async () => {
        listAllSessionsCalls++;
        return { sessions: [], totalCount: 0 };
      },
      async (eventId) => {
        getEventCalls++;
        return { eventId, timezone: "America/Los_Angeles" };
      },
    );

    const result = await syncCatalog({ apiClient: client, storeRoot: home.path, reindex: true });

    expect(listAllSessionsCalls).toBe(0);
    expect(getEventCalls).toBe(1);
    expect(result.reindexed).toBe(true);
    const meta = readMeta({ storeRoot: home.path });
    expect(meta?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(meta?.timezone).toBe("America/Los_Angeles");
  });

  it("reindex never calls getEvent when the stored meta already has a timezone key, even when its value is null", async () => {
    writeCatalog(
      {
        raw: fixture,
        index: [],
        meta: sampleMeta({ schemaVersion: CURRENT_SCHEMA_VERSION - 1, timezone: null }),
      },
      { storeRoot: home.path },
    );

    let getEventCalls = 0;
    const client = fakeApiClient(
      async () => ({ sessions: [], totalCount: 0 }),
      async (eventId) => {
        getEventCalls++;
        return { eventId, timezone: "America/Los_Angeles" };
      },
    );

    const result = await syncCatalog({ apiClient: client, storeRoot: home.path, reindex: true });

    expect(getEventCalls).toBe(0);
    expect(result.reindexed).toBe(true);
    expect(readMeta({ storeRoot: home.path })?.timezone).toBeNull();
  });

  it("aborts a reindex when getEvent fails for a pre-timezone catalog, leaving meta byte-identical", async () => {
    writeCatalog(
      { raw: fixture, index: [], meta: sampleMeta({ schemaVersion: CURRENT_SCHEMA_VERSION - 1 }) },
      { storeRoot: home.path },
    );
    const metaPath = join(home.path, "catalog", "meta.json");
    const preBumpMeta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    delete preBumpMeta.timezone;
    const preBumpMetaJson = JSON.stringify(preBumpMeta);
    writeFileSync(metaPath, preBumpMetaJson, "utf8");

    const client = fakeApiClient(
      async () => ({ sessions: [], totalCount: 0 }),
      async () => {
        throw new ServiceError("simulated GetEvent 500");
      },
    );

    await expect(
      syncCatalog({ apiClient: client, storeRoot: home.path, reindex: true }),
    ).rejects.toBeInstanceOf(ServiceError);

    expect(readFileSync(metaPath, "utf8")).toBe(preBumpMetaJson);
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

  it("fetches the event before pulling sessions, so a getEvent failure aborts the sync without a single listAllSessions call -- never wasting a completed paced pull", async () => {
    // Reviewer's point: getEvent is a cheap, unauthenticated-shaped call, while listAllSessions is
    // a paced, potentially multi-page pull of the whole catalog. Fetching the event first means a
    // transient getEvent failure fails fast rather than discarding a completed session pull.
    let listAllSessionsCalls = 0;
    const client = fakeApiClient(
      async () => {
        listAllSessionsCalls++;
        return { sessions: fixture, totalCount: fixture.length };
      },
      async () => {
        throw new ServiceError("simulated GetEvent 500");
      },
    );

    await expect(
      syncCatalog({ apiClient: client, storeRoot: home.path }),
    ).rejects.toBeInstanceOf(ServiceError);

    expect(listAllSessionsCalls).toBe(0);
    expect(readRaw({ storeRoot: home.path })).toBeNull();
  });

  it("leaves the previous catalog completely untouched when getEvent fails, same as any other aborted sync", async () => {
    const previousIndex = fixture.map(buildIndexRecord);
    const previousMeta = sampleMeta({ syncedAt: 1_600_000_000_000, timezone: "America/Los_Angeles" });
    writeCatalog({ raw: fixture, index: previousIndex, meta: previousMeta }, { storeRoot: home.path });

    const client = fakeApiClient(
      async () => ({ sessions: fixture, totalCount: fixture.length }),
      async () => {
        throw new ServiceError("simulated GetEvent 500");
      },
    );

    await expect(
      syncCatalog({ apiClient: client, storeRoot: home.path }),
    ).rejects.toBeInstanceOf(ServiceError);

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
