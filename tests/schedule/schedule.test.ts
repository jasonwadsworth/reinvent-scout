import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiClient } from "../../src/api/client.js";
import type { PersonalTime, Schedule, Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import {
  CURRENT_SCHEMA_VERSION,
  writeCatalog,
  type CatalogMeta,
} from "../../src/catalog/store.js";
import { DEFAULT_EVENT_ID } from "../../src/catalog/sync.js";
import { NotRegisteredError } from "../../src/core/errors.js";
import { getSchedule } from "../../src/schedule/schedule.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

const ANT301 = fixture.find((session) => session.abbreviation === "ANT301")!;
const ANT301_RECORD = buildIndexRecord(ANT301);

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

/** A minimal ApiClient stand-in -- schedule.ts only ever calls getSchedule. */
function fakeApiClient(getScheduleImpl: (eventId: string) => Promise<Schedule>): ApiClient {
  return {
    getSchedule: getScheduleImpl,
    listSessions: async () => {
      throw new Error("fakeApiClient: listSessions is not implemented, schedule.ts should never call it");
    },
    listAllSessions: async () => {
      throw new Error(
        "fakeApiClient: listAllSessions is not implemented, schedule.ts should never call it",
      );
    },
    associateFavorites: async () => {
      throw new Error(
        "fakeApiClient: associateFavorites is not implemented, schedule.ts should never call it",
      );
    },
    disassociateFavorite: async () => {
      throw new Error(
        "fakeApiClient: disassociateFavorite is not implemented, schedule.ts should never call it",
      );
    },
  };
}

const PERSONAL_TIME: PersonalTime = {
  personalTimeId: "pt-1",
  startDateTime: "2026-12-01T18:00:00",
  endDateTime: "2026-12-01T19:00:00",
  title: "Dinner",
  description: "Team dinner",
};

describe("getSchedule", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("returns reserved, favorite and personal time entries from GetSchedule", async () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );
    const apiClient = fakeApiClient(async () => ({
      reserved: [ANT301.sessionId],
      favorites: [],
      personalTime: [PERSONAL_TIME],
    }));

    const result = await getSchedule({ apiClient, storeRoot: home.path });

    expect(result.reserved).toHaveLength(1);
    expect(result.favorites).toEqual([]);
    expect(result.personalTime).toEqual([PERSONAL_TIME]);
  });

  it("resolves each session id against the local index into title, abbreviation, day, time, venue and room", async () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );
    const apiClient = fakeApiClient(async () => ({
      reserved: [],
      favorites: [ANT301.sessionId],
      personalTime: [],
    }));

    const result = await getSchedule({ apiClient, storeRoot: home.path });

    expect(result.favorites).toEqual([
      {
        sessionId: ANT301.sessionId,
        resolved: true,
        title: ANT301_RECORD.title,
        abbreviation: ANT301_RECORD.abbreviation,
        startDate: ANT301_RECORD.startDate,
        startTime: ANT301_RECORD.startTime,
        venue: ANT301_RECORD.venue,
        room: ANT301_RECORD.room,
      },
    ]);
  });

  it("marks an id that is not in the local index as unresolved rather than dropping it", async () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );
    // Not present anywhere in the fixture -- simulates a session favorited before the last sync.
    const goneSessionId = "session-not-in-any-local-index";
    const apiClient = fakeApiClient(async () => ({
      reserved: [],
      favorites: [ANT301.sessionId, goneSessionId],
      personalTime: [],
    }));

    const result = await getSchedule({ apiClient, storeRoot: home.path });

    expect(result.favorites).toHaveLength(2);
    // The resolved entry is unaffected by its unresolved neighbour...
    expect(result.favorites[0]).toMatchObject({ sessionId: ANT301.sessionId, resolved: true });
    // ...and the unresolved one is present in the output, not silently dropped -- a session
    // favorited before the last sync must still show up on the schedule, even without details.
    expect(result.favorites[1]).toEqual({ sessionId: goneSessionId, resolved: false });
  });

  it("resolves a favorited session with no scheduled time as resolved with a null date and time, not unresolved", async () => {
    // ANT407 has neither `room` nor `sessionTime` in the fixture (47 real sessions are like this,
    // per tests/fixtures/README.md) -- it IS in the local index, just not yet scheduled, which is
    // a different state from "the index has no record for this id at all" and callers act on the
    // two differently (a resolved-but-unscheduled session still has a title to show).
    const ant407 = fixture.find((session) => session.abbreviation === "ANT407")!;
    const ant407Record = buildIndexRecord(ant407);
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );
    const apiClient = fakeApiClient(async () => ({
      reserved: [],
      favorites: [ant407.sessionId],
      personalTime: [],
    }));

    const result = await getSchedule({ apiClient, storeRoot: home.path });

    expect(result.favorites).toEqual([
      {
        sessionId: ant407.sessionId,
        resolved: true,
        title: ant407Record.title,
        abbreviation: "ANT407",
        startDate: null,
        startTime: null,
        venue: null,
        room: null,
      },
    ]);
  });

  it("returns empty lists without error for an attendee with an empty schedule", async () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );
    const apiClient = fakeApiClient(async () => ({
      reserved: [],
      favorites: [],
      personalTime: [],
    }));

    const result = await getSchedule({ apiClient, storeRoot: home.path });

    expect(result).toEqual({ reserved: [], favorites: [], personalTime: [], warning: null });
  });

  it("surfaces NotRegisteredError when GetSchedule returns 403", async () => {
    // schedule.ts must not catch and re-wrap this -- part 1's `auth status` command, and the
    // future MCP status tool, both build their own event-specific message around this exact
    // error type, so it has to reach the caller unchanged.
    const apiClient = fakeApiClient(async () => {
      throw new NotRegisteredError();
    });

    await expect(getSchedule({ apiClient, storeRoot: home.path })).rejects.toThrow(NotRegisteredError);
    await expect(getSchedule({ apiClient, storeRoot: home.path })).rejects.toThrow(
      "not registered for this event",
    );
  });

  it("works with no catalog synced, returning bare ids and a warning", async () => {
    // No writeCatalog call at all -- home.path has no catalog directory.
    const apiClient = fakeApiClient(async () => ({
      reserved: [ANT301.sessionId],
      favorites: [],
      personalTime: [],
    }));

    const result = await getSchedule({ apiClient, storeRoot: home.path });

    expect(result.reserved).toEqual([{ sessionId: ANT301.sessionId, resolved: false }]);
    // The warning is a plain result field, not printed -- the MCP server can't write anything but
    // protocol traffic to stdout, so a caller has to be able to observe this without capturing
    // console output.
    expect(result.warning).not.toBeNull();
    expect(typeof result.warning).toBe("string");
  });
});
