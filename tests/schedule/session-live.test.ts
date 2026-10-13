import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { DEFAULT_EVENT_ID } from "../../src/catalog/sync.js";
import { NotFoundError } from "../../src/core/errors.js";
import { getLiveSession } from "../../src/schedule/session-live.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const NOW = Date.parse("2026-12-01T00:00:00Z");
const live: Session = {
  sessionId: "abc123",
  abbreviation: "ARC330",
  title: "SaaS agents",
  abstract: "A long abstract that must never be returned.",
  isReservable: true,
  seatAvailability: "limited",
  venue: "MGM Grand",
  room: "Room 1",
  sessionTime: { date: "2026-12-02", time: "10:30", length: "60" },
};

describe("getLiveSession", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); }); afterEach(() => home.cleanup());
  const seedTimezone = (timezone: string | null) => writeCatalog(
    { raw: [], index: [], meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: DEFAULT_EVENT_ID, syncedAt: 1, totalCount: 0, count: 0, includedAbstracts: true, timezone } },
    { storeRoot: home.path },
  );
  const deps = (session: Session | Error, seen: string[] = []) => ({
    storeRoot: home.path, now: () => NOW,
    apiClient: { getSession: async (event: string, id: string) => { seen.push(`${event}:${id}`); if (session instanceof Error) throw session; return session; } },
  });

  it("returns a bounded record from the live read, without the abstract", async () => {
    seedTimezone("America/Los_Angeles");
    const seen: string[] = [];
    const result = await getLiveSession("abc123", deps(live, seen));
    expect(seen).toEqual([`${DEFAULT_EVENT_ID}:abc123`]);
    expect(result).toEqual({
      sessionId: "abc123", abbreviation: "ARC330", title: "SaaS agents",
      date: "2026-12-02", time: "10:30", lengthMinutes: 60,
      startsAt: "2026-12-02T18:30:00Z", endsAt: "2026-12-02T19:30:00Z",
      venue: buildIndexRecord(live).venue, room: "Room 1",
      isReservable: true, seatAvailability: "limited", fetchedAt: "2026-12-01T00:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("abstract");
  });
  it("leaves startsAt and endsAt null when the event timezone is unknown, keeping date and time", async () => {
    const result = await getLiveSession("abc123", deps(live));
    expect(result).toMatchObject({ date: "2026-12-02", time: "10:30", lengthMinutes: 60, startsAt: null, endsAt: null });
  });
  it("reports unknown fields as null rather than inventing them", async () => {
    const result = await getLiveSession("x", deps({ sessionId: "x", title: "Bare" }));
    expect(result).toMatchObject({ abbreviation: null, isReservable: null, seatAvailability: null, date: null, time: null, lengthMinutes: null, venue: null, room: null });
  });
  it("passes a custom event through and lets a 404 propagate", async () => {
    const seen: string[] = [];
    await expect(getLiveSession("gone", { ...deps(new NotFoundError("nope"), seen), eventId: "other" })).rejects.toThrow(NotFoundError);
    expect(seen).toEqual(["other:gone"]);
  });
});
