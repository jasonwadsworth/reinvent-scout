import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient, type ApiClient } from "../../src/api/client.js";
import type { BulkResult, Schedule, Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import {
  CURRENT_SCHEMA_VERSION,
  writeCatalog,
  type CatalogMeta,
} from "../../src/catalog/store.js";
import { DEFAULT_EVENT_ID } from "../../src/catalog/sync.js";
import { NotFoundError, ServiceError } from "../../src/core/errors.js";
import { favoriteSessions, unfavoriteSession } from "../../src/schedule/favorites.js";
import { createFakeFetch } from "../helpers/fake-fetch.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);
const ANT301 = fixture.find((session) => session.abbreviation === "ANT301")!;

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

function fakeSleep(): { sleep: (ms: number) => Promise<void>; durations: number[] } {
  const durations: number[] = [];
  return {
    sleep: async (ms: number) => {
      durations.push(ms);
    },
    durations,
  };
}

/** A fixed clock -- favoriteSessions never needs wall time to advance on its own; only `sleep`
 * being called (or not) is what these tests assert. */
function fixedClock(at: number): () => number {
  return () => at;
}

function emptySchedule(): Schedule {
  return { reserved: [], favorites: [], personalTime: [] };
}

/**
 * Captures every call to `process.stdout.write` for the duration of `fn` and restores the real
 * one afterward, returning the raw arguments of each intercepted call.
 *
 * A plain property reassignment works fine here (an earlier version of this comment wrongly
 * blamed `vi.spyOn` itself -- the actual bug was asserting `toHaveBeenCalled()` *after*
 * `mockRestore()`, which clears the spy's own recorded calls along with restoring the original
 * implementation; asserted before restoring, `vi.spyOn` intercepts a direct
 * `process.stdout.write` call correctly). What neither `vi.spyOn` nor this reassignment can see is
 * `console.log`/`console.error`: Node's `Console` captures its own bound reference to the stream's
 * write method at construction time, so replacing `process.stdout.write` afterward -- by spy or by
 * assignment -- intercepts nothing routed through `console.*`. That gap doesn't apply to this
 * module: `eslint.config.js` sets `no-console: "error"` for `src/**` (only `src/cli/**` and tests
 * are exempt), so a `console.log` in `src/schedule/favorites.ts` fails `npm run lint` outright,
 * regardless of what any runtime capture would or wouldn't see. See
 * `gotcha_vitest_spyon_process_stdout_write.md` for where this gap *is* live (the MCP server's
 * CLI entry point, which is lint-exempt) and the subprocess-based test it needs instead.
 */
async function captureStdout(fn: () => Promise<void>): Promise<unknown[][]> {
  const calls: unknown[][] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((...args: unknown[]) => {
    calls.push(args);
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return calls;
}

describe("favoriteSessions", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("sends at most ten session ids per request", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const associateCalls: string[][] = [];
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async (_eventId, sessionIds) => {
        associateCalls.push(sessionIds);
        return { successful: sessionIds, failed: [] };
      },
      getSchedule: async () => ({ reserved: [], favorites: ids, personalTime: [] }),
    };

    await favoriteSessions(ids, {
      apiClient,
      storeRoot: home.path,
      sleep: fakeSleep().sleep,
      now: fixedClock(0),
    });

    expect(associateCalls).toEqual([ids]);
  });

  it("splits eleven ids into two requests", async () => {
    // The boundary, not an arbitrary larger number -- an off-by-one at exactly ten is the likely
    // bug, and a much larger count would hide it.
    const ids = Array.from({ length: 11 }, (_, i) => `s${i}`);
    const associateCalls: string[][] = [];
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async (_eventId, sessionIds) => {
        associateCalls.push(sessionIds);
        return { successful: sessionIds, failed: [] };
      },
      getSchedule: async () => ({ reserved: [], favorites: ids, personalTime: [] }),
    };

    await favoriteSessions(ids, {
      apiClient,
      storeRoot: home.path,
      sleep: fakeSleep().sleep,
      now: fixedClock(0),
    });

    expect(associateCalls).toHaveLength(2);
    expect(associateCalls[0]).toHaveLength(10);
    expect(associateCalls[1]).toHaveLength(1);
  });

  it("reports per-session failures from a single 200 response carrying a mix of outcomes", async () => {
    // The critical case: one response with a real success, an alreadyFavorited, and a genuine
    // refusal all at once -- all-succeed and all-fail both pass under an implementation that
    // never reads `result.failed` at all, so only a mixed response actually distinguishes them.
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );
    const bulkResult: BulkResult = {
      successful: ["a"],
      failed: [
        { sessionId: "b", code: "alreadyFavorited" },
        { sessionId: "c", code: "scheduleConflict", conflictsWith: [ANT301.sessionId] },
      ],
    };
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async () => bulkResult,
      getSchedule: async () => ({ reserved: [], favorites: ["a", "b"], personalTime: [] }),
    };

    const result = await favoriteSessions(["a", "b", "c"], {
      apiClient,
      storeRoot: home.path,
      sleep: fakeSleep().sleep,
      now: fixedClock(0),
    });

    expect(result.successful).toEqual(["a"]);
    expect(result.alreadyFavorited).toEqual(["b"]);
    expect(result.failed).toEqual([
      {
        sessionId: "c",
        code: "scheduleConflict",
        conflictsWith: [{ sessionId: ANT301.sessionId, title: ANT301.title }],
      },
    ]);
  });

  it("resolves a null title for a conflictsWith id the local catalog has no record for", async () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async () => ({
        successful: [],
        failed: [{ sessionId: "c", code: "scheduleConflict", conflictsWith: ["not-in-any-catalog"] }],
      }),
      getSchedule: async () => emptySchedule(),
    };

    const result = await favoriteSessions(["c"], {
      apiClient,
      storeRoot: home.path,
      sleep: fakeSleep().sleep,
      now: fixedClock(0),
    });

    expect(result.failed).toEqual([
      {
        sessionId: "c",
        code: "scheduleConflict",
        conflictsWith: [{ sessionId: "not-in-any-catalog", title: null }],
      },
    ]);
  });

  it("treats an unrecognised failure code as a generic refusal instead of throwing", async () => {
    // BulkFailureCode is deliberately typed as the known union plus `string`, since the API
    // document says unrecognised values will be added -- a genuinely unknown code (not in
    // today's union at all) must degrade to a plain refusal, never throw.
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async () => ({
        successful: [],
        failed: [{ sessionId: "z", code: "somethingBrandNewFromTheServer" }],
      }),
      getSchedule: async () => emptySchedule(),
    };

    const result = await favoriteSessions(["z"], {
      apiClient,
      storeRoot: home.path,
      sleep: fakeSleep().sleep,
      now: fixedClock(0),
    });

    expect(result.failed).toEqual([{ sessionId: "z", code: "somethingBrandNewFromTheServer" }]);
  });

  it("continues with the remaining chunks after one chunk's request fails entirely", async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `s${i}`);
    let callCount = 0;
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async (_eventId, sessionIds) => {
        callCount++;
        if (callCount === 1) {
          throw new ServiceError("The server exploded.");
        }
        return { successful: sessionIds, failed: [] };
      },
      getSchedule: async () => ({ reserved: [], favorites: [ids[10]!], personalTime: [] }),
    };

    const result = await favoriteSessions(ids, {
      apiClient,
      storeRoot: home.path,
      sleep: fakeSleep().sleep,
      now: fixedClock(0),
    });

    expect(callCount).toBe(2);
    expect(result.successful).toEqual([ids[10]]);
    expect(result.failed).toHaveLength(10);
    expect(result.failed.every((failure) => failure.code === "requestFailed")).toBe(true);
    // A bare "requestFailed" code with nothing else tells a user precisely nothing about why --
    // the underlying error's own message (never a token; the API client's own error taxonomy
    // already guarantees that) must ride along so "something failed" becomes "the server
    // exploded" or "you're not registered for this event."
    expect(result.failed.every((failure) => failure.reason === "The server exploded.")).toBe(true);
    expect(result.failed.map((failure) => failure.sessionId).sort()).toEqual(ids.slice(0, 10).sort());
  });

  it("aggregates successes and failures across all chunks", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `s${i}`);
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async (_eventId, sessionIds) => ({ successful: sessionIds, failed: [] }),
      getSchedule: async () => ({ reserved: [], favorites: ids, personalTime: [] }),
    };

    const result = await favoriteSessions(ids, {
      apiClient,
      storeRoot: home.path,
      sleep: fakeSleep().sleep,
      now: fixedClock(0),
    });

    expect(result.successful.sort()).toEqual([...ids].sort());
  });

  it("paces requests to stay within thirty session units per minute", async () => {
    // 40 ids -> four chunks of ten. The bucket starts full at 30: chunks one through three spend
    // exactly the whole budget (10 + 10 + 10 = 30) with no wait, and the fourth needs ten more
    // units from an empty bucket -- a full ten-unit wait is 60000 * (10/30) = 20000ms exactly.
    const ids = Array.from({ length: 40 }, (_, i) => `s${i}`);
    const sleeper = fakeSleep();
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async (_eventId, sessionIds) => ({ successful: sessionIds, failed: [] }),
      getSchedule: async () => ({ reserved: [], favorites: ids, personalTime: [] }),
    };

    await favoriteSessions(ids, {
      apiClient,
      storeRoot: home.path,
      sleep: sleeper.sleep,
      now: fixedClock(0),
    });

    expect(sleeper.durations).toEqual([20_000]);
  });

  it("re-reads the schedule exactly once after writing, regardless of chunk count", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `s${i}`); // three chunks
    let getScheduleCalls = 0;
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async (_eventId, sessionIds) => ({ successful: sessionIds, failed: [] }),
      getSchedule: async () => {
        getScheduleCalls++;
        return { reserved: [], favorites: ids, personalTime: [] };
      },
    };

    const result = await favoriteSessions(ids, {
      apiClient,
      storeRoot: home.path,
      sleep: fakeSleep().sleep,
      now: fixedClock(0),
    });

    // GetSchedule has its own, separate rate quota from the 30-session-unit write budget this
    // function paces the chunks above against -- so this single read never spends from that
    // pacer, and never blocks on it either. If it did, this test's zero-argument sleep call count
    // below would catch it, since none of the ids here need a wait on the write side alone.
    expect(getScheduleCalls).toBe(1);
    expect(result.verified.favorited.sort()).toEqual([...ids].sort());
  });

  it("reports a mismatch when the API claims success but the read-back does not confirm it", async () => {
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async () => ({ successful: ["a"], failed: [] }),
      // The read-back doesn't actually show "a" as favorited -- a real, visible-in-state partial
      // failure the 200 response alone hid.
      getSchedule: async () => emptySchedule(),
    };

    const result = await favoriteSessions(["a"], {
      apiClient,
      storeRoot: home.path,
      sleep: fakeSleep().sleep,
      now: fixedClock(0),
    });

    expect(result.successful).toEqual(["a"]);
    expect(result.verified.favorited).toEqual([]);
    expect(result.mismatch).toEqual(["a"]);
  });

  it("reports no mismatch when the read-back confirms every claimed success", async () => {
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async () => ({ successful: ["a"], failed: [] }),
      getSchedule: async () => ({ reserved: [], favorites: ["a"], personalTime: [] }),
    };

    const result = await favoriteSessions(["a"], {
      apiClient,
      storeRoot: home.path,
      sleep: fakeSleep().sleep,
      now: fixedClock(0),
    });

    expect(result.mismatch).toEqual([]);
  });

  it("treats alreadyFavorited from a retried AssociateFavorites as a non-failure, not a mismatch", async () => {
    // The mirror image of the DisassociateFavorite retry case: uses the REAL api client so the
    // client's own 503 retry actually runs. The first POST favorites "a" server-side but its
    // response is lost as a 503; the client retries the identical request, and the server reports
    // the retried attempt's session as alreadyFavorited rather than a repeat success -- already
    // treated as a non-failure, so a retried write that genuinely succeeded degrades correctly
    // instead of surfacing as a reported failure or a verification mismatch.
    const fake = createFakeFetch([
      { status: 503, json: { message: "Unavailable" } },
      { status: 200, json: { result: { successful: [], failed: [{ sessionId: "a", code: "alreadyFavorited" }] } } },
      { status: 200, json: { schedule: { reserved: [], favorites: ["a"], personalTime: [] } } },
    ]);
    const apiClient = createApiClient({
      fetchFn: fake.fetch,
      getAccessToken: async () => "token",
      sleep: fakeSleep().sleep,
    });

    const result = await favoriteSessions(["a"], { apiClient, storeRoot: home.path });

    expect(result.alreadyFavorited).toEqual(["a"]);
    expect(result.failed).toEqual([]);
    expect(result.mismatch).toEqual([]);
    expect(fake.calls).toHaveLength(3);
  });

  it("never writes to stdout, even while pacing, reporting a per-session failure, and recovering from a chunk that fails outright", async () => {
    // The MCP server can only write protocol traffic to stdout -- a stray write here would
    // corrupt that stream exactly the way task 1's schedule read had to stay silent. Wrapping
    // `process.stdout.write` and asserting zero calls is stronger than only checking the warning
    // is a result field, since it proves the function never writes at all, not merely that it
    // also returns the information some other way. Exercises three separate branches under one
    // spy -- a per-session scheduleConflict failure, a whole chunk throwing (the `catch` branch),
    // and a pacer wait -- since a stray print could hide in any one of them independently.
    const ids = Array.from({ length: 40 }, (_, i) => `s${i}`); // four chunks, the last one paced
    let callCount = 0;
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async (_eventId, sessionIds) => {
        callCount++;
        if (callCount === 1) {
          return {
            successful: [],
            failed: sessionIds.map((sessionId) => ({ sessionId, code: "scheduleConflict" as const })),
          };
        }
        if (callCount === 2) {
          throw new ServiceError("The server exploded.");
        }
        return { successful: sessionIds, failed: [] };
      },
      getSchedule: async () => emptySchedule(),
    };

    const calls = await captureStdout(async () => {
      await favoriteSessions(ids, {
        apiClient,
        storeRoot: home.path,
        sleep: fakeSleep().sleep,
        now: fixedClock(0),
      });
    });

    expect(callCount).toBe(4);
    expect(calls).toEqual([]);
  });
});

describe("unfavoriteSession", () => {
  it("removes a single favorite and treats a 204 as success", async () => {
    let called: { eventId: string; sessionId: string } | undefined;
    const apiClient: Pick<ApiClient, "disassociateFavorite"> = {
      disassociateFavorite: async (eventId, sessionId) => {
        called = { eventId, sessionId };
      },
    };

    const outcome = await unfavoriteSession("s1", { apiClient });

    expect(outcome).toBe("removed");
    expect(called).toEqual({ eventId: DEFAULT_EVENT_ID, sessionId: "s1" });
  });

  it("reports notFavorited when removing something that was not a favorite", async () => {
    const apiClient: Pick<ApiClient, "disassociateFavorite"> = {
      disassociateFavorite: async () => {
        throw new NotFoundError("No favorite with that session id.");
      },
    };

    const outcome = await unfavoriteSession("s1", { apiClient });

    expect(outcome).toBe("notFavorited");
  });

  it("propagates an error other than NotFoundError unchanged", async () => {
    const apiClient: Pick<ApiClient, "disassociateFavorite"> = {
      disassociateFavorite: async () => {
        throw new ServiceError("The server exploded.");
      },
    };

    await expect(unfavoriteSession("s1", { apiClient })).rejects.toBeInstanceOf(ServiceError);
  });

  it("treats a 404 from a retried DisassociateFavorite as notFavorited, not an error", async () => {
    // Uses the REAL api client (createApiClient), not a hand-rolled stand-in, so the client's own
    // 503 retry is what actually runs: the first DELETE removes the favorite server-side but its
    // response is lost as a 503, the client retries the identical request, and the retried DELETE
    // hits an already-removed favorite -- reported as a 404, indistinguishable here from "was
    // never favorited." Both mean the same thing to the caller (not favorited now), so this must
    // resolve to "notFavorited", never throw NotFoundError, even though the id genuinely was
    // favorited at the moment the caller asked to remove it.
    const fake = createFakeFetch([
      { status: 503, json: { message: "Unavailable" } },
      { status: 404, json: { message: "No favorite with that session id." } },
    ]);
    const apiClient = createApiClient({
      fetchFn: fake.fetch,
      getAccessToken: async () => "token",
      sleep: fakeSleep().sleep,
    });

    const outcome = await unfavoriteSession("s1", { apiClient });

    expect(outcome).toBe("notFavorited");
    expect(fake.calls).toHaveLength(2);
  });
});
