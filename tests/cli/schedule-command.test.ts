import { readFileSync } from "node:fs";
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
    getEvent: async () => {
      throw new Error("not implemented in this fake");
    },
    listSessions: async () => {
      throw new Error("not implemented in this fake");
    },
    listAllSessions: async () => {
      throw new Error("not implemented in this fake");
    },
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
    expect(output).toContain("Favorited: " + ids.slice(0, 10).join(", "));
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
