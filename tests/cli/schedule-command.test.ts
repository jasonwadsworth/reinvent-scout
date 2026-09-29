import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiClient } from "../../src/api/client.js";
import type { BulkResult, Schedule, Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog, type CatalogMeta } from "../../src/catalog/store.js";
import { DEFAULT_EVENT_ID } from "../../src/catalog/sync.js";
import { registerScheduleCommands } from "../../src/cli/commands/schedule.js";
import { AuthRequiredError, NotFoundError } from "../../src/core/errors.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);
const ANT301 = fixture.find((session) => session.abbreviation === "ANT301")!;
// Both sit on the same real day (2026-11-30) at two different times -- API303-R at 14:30, ANT301
// at 10:30 -- which is exactly what a within-day ordering test needs: two real fixture sessions on
// one day, not a single one.
const API303_R = fixture.find((session) => session.abbreviation === "API303-R")!;

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

function seedFixtureCatalog(storeRoot: string, metaOverrides: Partial<CatalogMeta> = {}): void {
  writeCatalog(
    { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta(metaOverrides) },
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
    getSchedule: overrides.getSchedule ?? (async (): Promise<Schedule> => ({
      reserved: [],
      favorites: [],
      personalTime: [],
    })),
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

interface Harness {
  run: (args: string[]) => Promise<void>;
  printed: string[];
  client: ApiClient;
}

function harness(storeRoot: string, overrides: ApiClientOverrides = {}): Harness {
  const printed: string[] = [];
  const client = fakeApiClient(overrides);
  const program = new Command().exitOverride();
  registerScheduleCommands(program, {
    resolveStoreRoot: () => storeRoot,
    buildApiClient: () => client,
    print: (message: string) => {
      printed.push(message);
    },
  });

  return {
    run: async (args: string[]) => {
      await program.parseAsync(["node", "reinvent-scout", ...args]);
    },
    printed,
    client,
  };
}

/**
 * Substitutes `process.stdin` with a real `PassThrough` stream for the duration of `fn`, so a
 * command's own real stdin-reading code (an async iteration over `process.stdin`, not an injected
 * "give me a string" callback a test could trivially fake) is what's actually exercised -- the
 * same mechanism a real `match --json | jq ... | reinvent-scout schedule favorite -` pipe drives.
 * `process.stdin`'s own property descriptor is configurable, which is what makes this substitution
 * possible at all; restored unconditionally afterward.
 */
async function withPipedStdin<T>(text: string, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const fake = new PassThrough();
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  try {
    fake.end(text);
    return await fn();
  } finally {
    Object.defineProperty(process, "stdin", original);
  }
}

describe("schedule show", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("prints the schedule grouped by day with times and venues", async () => {
    seedFixtureCatalog(home.path);
    const h = harness(home.path, {
      getSchedule: async () => ({ reserved: [ANT301.sessionId], favorites: [], personalTime: [] }),
    });

    await h.run(["schedule", "show"]);

    const output = h.printed.join("\n");
    expect(output).toContain(ANT301.sessionTime!.date!);
    expect(output).toContain(ANT301.sessionTime!.time!);
    expect(output).toContain(ANT301.venue!);
  });

  it("prints compact JSON under --json", async () => {
    seedFixtureCatalog(home.path);
    const h = harness(home.path, {
      getSchedule: async () => ({ reserved: [ANT301.sessionId], favorites: [], personalTime: [] }),
    });

    await h.run(["schedule", "show", "--json"]);

    expect(h.printed).toHaveLength(1);
    const parsed = JSON.parse(h.printed[0]!);
    expect(parsed.reserved).toHaveLength(1);
    expect(parsed.reserved[0].sessionId).toBe(ANT301.sessionId);
    expect(parsed.reserved[0].resolved).toBe(true);
  });

  it("sorts sessions within a day by time, not by the order the API happened to return them in", async () => {
    // pr-reviewer's finding, reproduced from a real run: within one day, sessions appeared in raw
    // API order, not time order. API303-R (14:30) is fed *before* ANT301 (10:30) here -- the exact
    // shape that only a real time-based sort, not "whatever order came back," gets right.
    seedFixtureCatalog(home.path, { timezone: "America/Los_Angeles" });
    const h = harness(home.path, {
      getSchedule: async () => ({
        reserved: [],
        favorites: [API303_R.sessionId, ANT301.sessionId],
        personalTime: [],
      }),
    });

    await h.run(["schedule", "show"]);

    const output = h.printed.join("\n");
    const ant301Index = output.indexOf(ANT301.abbreviation!);
    const api303Index = output.indexOf(API303_R.abbreviation!);
    expect(ant301Index).toBeGreaterThanOrEqual(0);
    expect(api303Index).toBeGreaterThan(ant301Index);
  });

  it("prints personal time in event-local time, labeled (personal), grouped under the correct local day", async () => {
    // reviewer's own exact repro: a block that's 16:30-16:50 in Las Vegas (America/Los_Angeles) on
    // 2026-11-30 is stored by the API as 2026-12-01T00:30:00 - 2026-12-01T00:50:00 UTC -- printed
    // raw, it looks like it happened after midnight on Dec 1; it did not.
    seedFixtureCatalog(home.path, { timezone: "America/Los_Angeles" });
    const h = harness(home.path, {
      getSchedule: async () => ({
        reserved: [],
        favorites: [],
        personalTime: [
          {
            personalTimeId: "pt1",
            startDateTime: "2026-12-01T00:30:00",
            endDateTime: "2026-12-01T00:50:00",
            title: "Dinner",
            description: "",
          },
        ],
      }),
    });

    await h.run(["schedule", "show"]);

    const output = h.printed.join("\n");
    expect(output).toContain("Personal time:");
    expect(output).toContain("2026-11-30"); // the correct *local* day, not the raw UTC date
    expect(output).not.toContain("2026-12-01");
    expect(output).toContain("16:30 - 16:50 -- Dinner (personal)");
  });

  it("falls back to the raw UTC personal-time value and warns, when the event timezone is unknown", async () => {
    seedFixtureCatalog(home.path); // sampleMeta()'s own default: timezone: null
    const h = harness(home.path, {
      getSchedule: async () => ({
        reserved: [],
        favorites: [],
        personalTime: [
          {
            personalTimeId: "pt1",
            startDateTime: "2026-12-01T00:30:00",
            endDateTime: "2026-12-01T00:50:00",
            title: "Dinner",
            description: "",
          },
        ],
      }),
    });

    await h.run(["schedule", "show"]);

    const output = h.printed.join("\n");
    // reviewer2's nit: the raw value alone could be misread as local time -- label it UTC so it
    // can't be.
    expect(output).toContain("2026-12-01T00:30:00 - 2026-12-01T00:50:00 UTC -- Dinner (personal)");
    expect(output).toMatch(/Warning:.*timezone.*unknown/i);
  });
});

describe("schedule favorite", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("favorites the ids given on the command line and prints what succeeded and what was refused", async () => {
    const h = harness(home.path, {
      associateFavorites: async () => ({
        successful: ["a"],
        failed: [{ sessionId: "b", code: "scheduleConflict", conflictsWith: ["c"] }],
      }),
      getSchedule: async () => ({ reserved: [], favorites: ["a"], personalTime: [] }),
    });

    await h.run(["schedule", "favorite", "a", "b"]);

    const output = h.printed.join("\n");
    expect(output).toContain("a");
    expect(output).toContain("b");
    expect(output).toMatch(/scheduleConflict/);
  });

  it("prints a real success with its abbreviation and title, not a bare session id", async () => {
    // Reviewer's finding: a real run against a shortlist of thirty (the README's own
    // match --json | jq | schedule favorite - pipe) printed thirty bare session ids with nothing
    // to tell them apart at a glance -- scheduleConflict refusals already got resolved titles; a
    // real success deserves the same.
    seedFixtureCatalog(home.path);
    const h = harness(home.path, {
      associateFavorites: async () => ({ successful: [ANT301.sessionId], failed: [] }),
      getSchedule: async () => ({ reserved: [], favorites: [ANT301.sessionId], personalTime: [] }),
    });

    await h.run(["schedule", "favorite", ANT301.sessionId]);

    const output = h.printed.join("\n");
    expect(output).toContain(`${ANT301.abbreviation} -- ${ANT301.title}`);
    expect(output).not.toContain(ANT301.sessionId);
  });

  it("prints an already-favorited id with its abbreviation and title too", async () => {
    seedFixtureCatalog(home.path);
    const h = harness(home.path, {
      associateFavorites: async () => ({
        successful: [],
        failed: [{ sessionId: ANT301.sessionId, code: "alreadyFavorited" }],
      }),
      getSchedule: async () => ({ reserved: [], favorites: [ANT301.sessionId], personalTime: [] }),
    });

    await h.run(["schedule", "favorite", ANT301.sessionId]);

    const output = h.printed.join("\n");
    expect(output).toContain(`${ANT301.abbreviation} -- ${ANT301.title}`);
  });

  it("falls back to the bare session id when the local catalog has no record for it", async () => {
    seedFixtureCatalog(home.path);
    const h = harness(home.path, {
      associateFavorites: async () => ({ successful: ["not-in-any-catalog"], failed: [] }),
      getSchedule: async () => ({ reserved: [], favorites: ["not-in-any-catalog"], personalTime: [] }),
    });

    await h.run(["schedule", "favorite", "not-in-any-catalog"]);

    const output = h.printed.join("\n");
    expect(output).toContain("not-in-any-catalog");
  });

  it("prints a refused id with its abbreviation and title too, not a bare session id -- pr-reviewer-3's finding", async () => {
    // Successes and scheduleConflict's own conflict targets already got resolved titles; a plain
    // refusal (requestFailed here, but the same bare-id shape applied to any code) deserves the
    // same treatment, not just the ones with a `conflictsWith` list.
    seedFixtureCatalog(home.path);
    const h = harness(home.path, {
      associateFavorites: async () => ({
        successful: [],
        failed: [{ sessionId: ANT301.sessionId, code: "requestFailed", reason: "The server exploded." }],
      }),
      getSchedule: async () => ({ reserved: [], favorites: [], personalTime: [] }),
    });

    await h.run(["schedule", "favorite", ANT301.sessionId]);

    const output = h.printed.join("\n");
    expect(output).toContain(`${ANT301.abbreviation} -- ${ANT301.title}`);
    expect(output).not.toContain(ANT301.sessionId);
  });

  it("prints the real successes plus the sign-in instruction, and exits non-zero, when auth is interrupted mid-run", async () => {
    // Lead's decision on reviewer2's own finding: a session-wide auth failure that surfaces after
    // an earlier chunk already wrote something must not make the CLI report nothing happened.
    let callCount = 0;
    const ids = Array.from({ length: 11 }, (_, i) => `s${i}`); // two chunks
    const h = harness(home.path, {
      associateFavorites: async (_eventId, sessionIds) => {
        callCount++;
        if (callCount === 1) {
          return { successful: sessionIds, failed: [] };
        }
        throw new AuthRequiredError();
      },
    });

    await h.run(["schedule", "favorite", ...ids]);

    const output = h.printed.join("\n");
    // No catalog seeded in this test, so each id falls back to its bare form -- one per line.
    for (const id of ids.slice(0, 10)) {
      expect(output).toContain(`  ${id}`);
    }
    expect(output).toContain("Stopped early:");
    expect(output).toMatch(/auth login/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("exits non-zero when any session was refused, in a response that also has a real success", async () => {
    // The mixed case is the one that actually distinguishes "checks the response" from "assumes
    // success" -- an all-refused response would pass under either exit-code implementation.
    const h = harness(home.path, {
      associateFavorites: async () => ({
        successful: ["a"],
        failed: [{ sessionId: "b", code: "sessionFull" }],
      }),
      getSchedule: async () => ({ reserved: [], favorites: ["a"], personalTime: [] }),
    });

    await h.run(["schedule", "favorite", "a", "b"]);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("exits zero when everything succeeded", async () => {
    const h = harness(home.path, {
      associateFavorites: async (_eventId, sessionIds) => ({ successful: sessionIds, failed: [] }),
      getSchedule: async () => ({ reserved: [], favorites: ["a", "b"], personalTime: [] }),
    });

    await h.run(["schedule", "favorite", "a", "b"]);

    expect(process.exitCode ?? 0).toBe(0);
  });

  it("reads ids from stdin when given a dash, so match output can be piped in", async () => {
    let receivedIds: string[] | undefined;
    const h = harness(home.path, {
      associateFavorites: async (_eventId, sessionIds) => {
        receivedIds = [...sessionIds];
        return { successful: sessionIds, failed: [] };
      },
      getSchedule: async () => ({ reserved: [], favorites: ["id-1", "id-2", "id-3"], personalTime: [] }),
    });

    await withPipedStdin("id-1\nid-2\n\nid-3\n", async () => {
      await h.run(["schedule", "favorite", "-"]);
    });

    expect(receivedIds).toEqual(["id-1", "id-2", "id-3"]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("refuses more than one hundred ids in one invocation", async () => {
    let called = false;
    const h = harness(home.path, {
      associateFavorites: async (_eventId, sessionIds) => {
        called = true;
        return { successful: sessionIds, failed: [] };
      },
    });
    const tooManyIds = Array.from({ length: 101 }, (_, i) => `id-${i}`);

    await h.run(["schedule", "favorite", ...tooManyIds]);

    expect(called).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(h.printed.join("\n")).toMatch(/100/);
  });

  it("refuses an empty id list before touching the store root or making an API call", async () => {
    // Reviewer's finding: an empty id list (a profile that matched nothing, or an extraction that
    // yielded nothing, piped through `schedule favorite -`) previously fell through to the auth
    // check first, reporting "Not signed in" -- true, but not the actual problem, and costly for a
    // signed-in caller: favoriteSessions([]) still issues a real GetSchedule call and spends a
    // pacer slot to accomplish nothing. This must be caught before the store root -- and so
    // before any API client -- is even built.
    let resolveStoreRootCalled = false;
    let associateFavoritesCalled = false;
    let getScheduleCalled = false;
    const printed: string[] = [];
    const program = new Command().exitOverride();
    registerScheduleCommands(program, {
      resolveStoreRoot: () => {
        resolveStoreRootCalled = true;
        return home.path;
      },
      buildApiClient: () =>
        fakeApiClient({
          associateFavorites: async (_eventId, sessionIds) => {
            associateFavoritesCalled = true;
            return { successful: sessionIds, failed: [] };
          },
          getSchedule: async () => {
            getScheduleCalled = true;
            return { reserved: [], favorites: [], personalTime: [] };
          },
        }),
      print: (message: string) => {
        printed.push(message);
      },
    });

    await withPipedStdin("", async () => {
      await program.parseAsync(["node", "reinvent-scout", "schedule", "favorite", "-"]);
    });

    expect(resolveStoreRootCalled).toBe(false);
    expect(associateFavoritesCalled).toBe(false);
    expect(getScheduleCalled).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    const output = printed.join("\n");
    expect(output).toMatch(/session ids?/i);
    expect(output).not.toMatch(/signed in/i);
  });
});

describe("schedule unfavorite", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("removes a favorite and reports success", async () => {
    let called: { eventId: string; sessionId: string } | undefined;
    const h = harness(home.path, {
      disassociateFavorite: async (eventId, sessionId) => {
        called = { eventId, sessionId };
      },
    });

    await h.run(["schedule", "unfavorite", "s1"]);

    expect(called).toEqual({ eventId: DEFAULT_EVENT_ID, sessionId: "s1" });
    expect(h.printed.join("\n")).toContain("s1");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("reports that a session was not favorited, without treating it as an error", async () => {
    const h = harness(home.path, {
      disassociateFavorite: async () => {
        throw new NotFoundError("No favorite with that session id.");
      },
    });

    await h.run(["schedule", "unfavorite", "s1"]);

    expect(h.printed.join("\n")).toMatch(/not favorited/i);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("reservation CLI flow", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); process.exitCode = 0; });
  afterEach(() => { home.cleanup(); process.exitCode = 0; });
  it("plans without writes, reserves the printed offering IDs via stdin, and cancels", async () => {
    const raw = [{ sessionId: "future", title: "Future", sessionTime: { date: "2099-12-02", time: "10:00", length: "60" } }];
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: sampleMeta({ timezone: "America/Los_Angeles" }) }, { storeRoot: home.path });
    let writes = 0; let reserved: string[] = [];
    const h = harness(home.path, { reserveSessions: async (_event, ids) => { writes++; reserved = ids; return { successful: ids, failed: [] }; }, cancelReservation: async () => { reserved = []; }, getSchedule: async () => ({ reserved, favorites: [], personalTime: [] }) });
    await h.run(["schedule", "plan", "future", "--json"]);
    expect(writes).toBe(0);
    const selected = JSON.parse(h.printed[0]!).selected.map((value: { sessionId: string }) => value.sessionId);
    expect(selected).toEqual(["future"]);
    await withPipedStdin(selected.join("\n"), () => h.run(["schedule", "reserve", "-", "--json"]));
    expect(JSON.parse(h.printed[1]!)).toMatchObject({ successful: selected, verified: { reserved: selected } });
    await h.run(["schedule", "cancel", selected[0]!, "--json"]);
    expect(JSON.parse(h.printed[2]!)).toMatchObject({ outcome: "cancelled", verifiedAbsent: true });
  });
  it("renders uncertain and partial refusals with failure exit status", async () => {
    const h = harness(home.path, { reserveSessions: async () => { throw new Error("lost response"); }, getSchedule: async () => ({ reserved: ["a"], favorites: [], personalTime: [] }) });
    await h.run(["schedule", "reserve", "a"]);
    expect(h.printed.join("\n")).toMatch(/uncertain/i);
    expect(h.printed.join("\n")).toContain("a"); expect(process.exitCode).toBe(1);
  });
  it("rejects oversized reservation lists before network", async () => {
    let calls = 0;
    const h = harness(home.path, { reserveSessions: async () => { calls++; return { successful: [], failed: [] }; } });
    await h.run(["schedule", "reserve", ...Array.from({ length: 51 }, (_, i) => String(i))]);
    expect(calls).toBe(0); expect(process.exitCode).toBe(1);
  });
});


it("reads and updates on-site config through CLI without account access", async () => {
  const home = createTempHome();
  try {
    const h = harness(home.path);
    await h.run(["schedule", "onsite-config", "--event", "constructor", "--json"]);
    expect(JSON.parse(h.printed.pop()!).allowWalkUp).toBe(false);
    await h.run(["schedule", "onsite-config", "--event", "constructor", "--allow-walk-up", "true", "--json"]);
    expect(JSON.parse(h.printed.pop()!).allowWalkUp).toBe(true);
  } finally { home.cleanup(); }
});


describe("on-site commands: errors and local time", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); process.exitCode = 0; });
  afterEach(() => { home.cleanup(); process.exitCode = 0; });
  const venue = ["--venue", "MGM Grand", "--confirm-venue"];
  const notRawZodJson = (text: string) => expect(text.trimStart().startsWith("[")).toBe(false);

  it("prints a field-path message and exits 1 for an invalid nearby option", async () => {
    seedFixtureCatalog(home.path, { timezone: "America/Los_Angeles" });
    const h = harness(home.path);
    await h.run(["schedule", "nearby", ...venue, "--within", "abc"]);
    expect(h.printed).toHaveLength(1);
    notRawZodJson(h.printed[0]!);
    expect(h.printed[0]).toContain("withinMinutes:");
    expect(process.exitCode).toBe(1);
  });
  it("prints the message and exits 1 for a wrong-event catalog and for auth failures", async () => {
    seedFixtureCatalog(home.path, { timezone: "America/Los_Angeles" });
    const wrongEvent = harness(home.path);
    await wrongEvent.run(["schedule", "nearby", ...venue, "--event", "another-event"]);
    expect(wrongEvent.printed[0]).toMatch(/Sync the catalog for event another-event/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    const auth = harness(home.path, { getSchedule: async () => { throw new AuthRequiredError(); } });
    await auth.run(["schedule", "nearby", ...venue]);
    expect(auth.printed[0]).toBe(new AuthRequiredError().message);
    expect(process.exitCode).toBe(1);
  });
  it.each([
    [["--allow-walk-up", "yes"], "allowWalkUp:"],
    [["--file", "PATCH_BAD_TYPE"], "checkInMinutes:"],
    [["--file", "PATCH_NOT_JSON"], "not valid JSON"],
    [["--file", "PATCH_MISSING"], "Cannot read"],
  ])("prints a readable message and exits 1 for onsite-config %j", async (args, expected) => {
    const files: Record<string, string> = { PATCH_BAD_TYPE: '{"checkInMinutes":"soon"}', PATCH_NOT_JSON: "{oops" };
    const resolved = args.map(arg => {
      if (arg === "PATCH_MISSING") return join(home.path, "missing.json");
      if (arg in files) { const path = join(home.path, `${arg}.json`); writeFileSync(path, files[arg]!); return path; }
      return arg;
    });
    const h = harness(home.path);
    await h.run(["schedule", "onsite-config", ...resolved]);
    expect(h.printed).toHaveLength(1);
    notRawZodJson(h.printed[0]!);
    expect(h.printed[0]).toContain(expected);
    expect(process.exitCode).toBe(1);
  });

  it("prints the refusal and exits 1 when the on-site config path is a symlink", async () => {
    symlinkSync(join(home.path, "elsewhere.json"), join(home.path, "onsite.json"));
    const h = harness(home.path);
    await h.run(["schedule", "onsite-config", "--allow-walk-up", "true"]);
    expect(h.printed).toHaveLength(1);
    expect(h.printed[0]).toMatch(/symlink/i);
    expect(process.exitCode).toBe(1);
  });

  describe("event-local times", () => {
    const early = { sessionId: "early", title: "Early talk", abbreviation: "EAR100", venue: "MGM Grand", isReservable: true, seatAvailability: "available", sessionTime: { date: "2026-12-02", time: "10:30", length: "30" } } as Session;
    const seed = () => writeCatalog({ raw: [early], index: [buildIndexRecord(early)], meta: sampleMeta({ timezone: "America/Los_Angeles", count: 1, totalCount: 1 }) }, { storeRoot: home.path });
    it("shows plan times in the event zone with its abbreviation, not UTC", async () => {
      seed();
      const h = harness(home.path);
      await h.run(["schedule", "plan", "early"]);
      expect(h.printed[0]).toContain("2026-12-02 10:30 PST to 2026-12-02 11:00 PST");
      expect(h.printed[0]).not.toContain("18:30:00Z");
    });
    it("shows nearby start times in the event zone with its abbreviation, not UTC", async () => {
      seed();
      const now = Date.parse("2026-12-02T17:00:00Z");
      const printed: string[] = [];
      const program = new Command().exitOverride();
      registerScheduleCommands(program, { resolveStoreRoot: () => home.path, buildApiClient: () => ({ ...fakeApiClient(), getSession: async () => early }), print: message => { printed.push(message); }, now: () => now });
      await program.parseAsync(["node", "reinvent-scout", "schedule", "nearby", ...venue, "--within", "120"]);
      expect(printed[0]).toContain("starts 2026-12-02 10:30 PST");
      expect(printed[0]).not.toContain("18:30:00Z");
    });
  });
});

describe("padded ids", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); process.exitCode = 0; });
  afterEach(() => { home.cleanup(); process.exitCode = 0; });
  it("cancels the trimmed id and reports it", async () => {
    const deleted: string[] = [];
    const h = harness(home.path, { cancelReservation: async (_e, id) => { deleted.push(id); }, getSchedule: async () => ({ reserved: [], favorites: [], personalTime: [] }) });
    await h.run(["schedule", "cancel", " R "]);
    expect(deleted).toEqual(["R"]);
    expect(h.printed[0]).toMatch(/^R: cancelled; verified absent: true/);
  });
  it("trims favorite ids before sending and refuses a blank one", async () => {
    const sent: string[][] = [];
    const h = harness(home.path, { associateFavorites: async (_e, list) => { sent.push(list); return { successful: list, failed: [] }; }, getSchedule: async () => ({ reserved: [], favorites: ["a"], personalTime: [] }) });
    await h.run(["schedule", "favorite", " a "]);
    expect(sent).toEqual([["a"]]);
    const blank = harness(home.path);
    await blank.run(["schedule", "favorite", "   "]);
    expect(blank.printed[0]).toMatch(/blank/i);
    expect(process.exitCode).toBe(1);
  });
});
