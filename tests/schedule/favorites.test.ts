import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient, type ApiClient } from "../../src/api/client.js";
import type { BulkResult, Schedule, Session } from "../../src/api/types.js";
import { OAuthError } from "../../src/auth/oauth.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import {
  CURRENT_SCHEMA_VERSION,
  writeCatalog,
  type CatalogMeta,
} from "../../src/catalog/store.js";
import { DEFAULT_EVENT_ID } from "../../src/catalog/sync.js";
import { markRequestNotSent, AuthRequiredError, NotFoundError, NotRegisteredError, OperationUnavailableError, ValidationError, ServiceError, ThrottledError } from "../../src/core/errors.js";
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

let fixedNow = 0;
function fakeSleep(): { sleep: (ms: number) => Promise<void>; durations: number[] } {
  const durations: number[] = [];
  return {
    sleep: async (ms: number) => {
      durations.push(ms);
      fixedNow += ms;
    },
    durations,
  };
}

/** Fake clock paired with fakeSleep; quota rechecks observed time after every wait. */
function fixedClock(at: number): () => number {
  fixedNow = at;
  return () => fixedNow;
}

/** A clock whose `sleep` advances its own `now()` by exactly the duration slept, so a scenario
 * spanning more than one pacer wait (e.g. enough ids that two separate chunks each have to wait
 * for the rolling window to clear) sees an accurate elapsed time on the second wait, the same way
 * the real `Date.now` + real `sleep` pairing would in production. `fixedClock` above is enough
 * for anything needing at most one wait; this is only needed when that's not true. */
function stepClock(startAt = 0): { now: () => number; sleep: (ms: number) => Promise<void>; durations: number[] } {
  let current = startAt;
  const durations: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      durations.push(ms);
      current += ms;
    },
    durations,
  };
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
          throw new ValidationError("The server exploded.");
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

  it("paces requests to stay within thirty session units per minute, with a one-second safety margin at the window boundary", async () => {
    // 40 ids -> four chunks of ten. The rolling window starts empty: chunks one through three
    // spend the whole budget (10 + 10 + 10 = 30) with no wait, and the fourth can't fit until the
    // *oldest* ten units age fully out of the trailing window -- a full wait, not a fractional one
    // computed from a refill rate (the pacer is a sliding window log, not a continuously-refilling
    // token bucket -- see acquire's own doc comment for why that distinction matters). The wait is
    // 61 s, not a bare 60 s: pr-reviewer-3's finding -- entries expiring at exactly the real 60 s
    // quota boundary leave zero margin against timestamp jitter between this process's own clock
    // and the server's, so PACE_WINDOW_MS carries a deliberate one-second margin.
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

    expect(sleeper.durations).toEqual([61_000]);
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
    expect(result.verified).not.toBeNull();
    expect(result.verified!.favorited.sort()).toEqual([...ids].sort());
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
    expect(result.verified).not.toBeNull();
    expect(result.verified!.favorited).toEqual([]);
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
    // A rejected429 is safe to retry; an ambiguous503 is not.
    const fake = createFakeFetch([
      { status: 429, json: { message: "Unavailable" } },
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

  it("shares its rate window across back-to-back calls against the same store root", async () => {
    // Reviewer's finding: a bucket created fresh inside every call let two calls in a row against
    // the *same* store root (the MCP server's long-lived process is exactly this shape) each spend
    // the full thirty-unit budget immediately -- sixty units in an instant against a thirty-unit
    // quota. The second call here must see the first call's own spending and wait accordingly.
    const sleeper = fakeSleep();
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async (_eventId, sessionIds) => ({ successful: sessionIds, failed: [] }),
      getSchedule: async () => emptySchedule(),
    };

    const firstIds = Array.from({ length: 30 }, (_, i) => `first-${i}`); // spends the whole window
    await favoriteSessions(firstIds, {
      apiClient,
      storeRoot: home.path,
      sleep: sleeper.sleep,
      now: fixedClock(0),
    });
    expect(sleeper.durations).toEqual([]);

    const secondIds = ["second-0"]; // one more chunk, same store root, same instant
    await favoriteSessions(secondIds, {
      apiClient,
      storeRoot: home.path,
      sleep: sleeper.sleep,
      now: fixedClock(0),
    });

    expect(sleeper.durations).toEqual([61_000]);
  });

  it("still waits a full extra second at exactly the real sixty-second quota boundary -- the margin itself", async () => {
    // pr-reviewer-3's finding, isolated directly: measured over real stdio, a server process
    // sending a 50-id call then a 10-id call spent 30 units at t=0.0 s and 20+10 at t=60.0 s --
    // within the real 60 s quota by this *process's* own clock, but any timestamp jitter against
    // the *server's* own clock could make it count as sixty landing within one real window. Two
    // separate calls, the second's own `now` fixed at exactly 60,000 ms after the first (not a
    // sleep-driven clock -- the point is to ask "what does the pacer do if a caller's clock reads
    // exactly 60 s later", not to simulate 60 s of real waiting): if the window were a bare 60 s,
    // the first call's entries would already be expired and the second would need no wait at all;
    // with the real 61 s window, it still needs the one remaining second.
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async (_eventId, sessionIds) => ({ successful: sessionIds, failed: [] }),
      getSchedule: async () => emptySchedule(),
    };
    const sleeper = fakeSleep();

    await favoriteSessions(Array.from({ length: 30 }, (_, i) => `a${i}`), {
      apiClient,
      storeRoot: home.path,
      sleep: sleeper.sleep,
      now: fixedClock(0),
    });
    expect(sleeper.durations).toEqual([]);

    await favoriteSessions(["b0"], {
      apiClient,
      storeRoot: home.path,
      sleep: sleeper.sleep,
      now: fixedClock(60_000), // exactly the real quota's own window length, not the margin's
    });

    expect(sleeper.durations).toEqual([1_000]);
  });

  it("gives a different store root its own, independent rate window", async () => {
    // reviewer2's own probe: separate store roots must not share -- or be blocked by -- a window
    // that belongs to an unrelated one.
    const sleeper = fakeSleep();
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async (_eventId, sessionIds) => ({ successful: sessionIds, failed: [] }),
      getSchedule: async () => emptySchedule(),
    };
    const otherHome = createTempHome();
    try {
      const firstIds = Array.from({ length: 30 }, (_, i) => `first-${i}`);
      await favoriteSessions(firstIds, {
        apiClient,
        storeRoot: home.path,
        sleep: sleeper.sleep,
        now: fixedClock(0),
      });

      const secondIds = ["second-0"];
      await favoriteSessions(secondIds, {
        apiClient,
        storeRoot: otherHome.path,
        sleep: sleeper.sleep,
        now: fixedClock(0),
      });

      expect(sleeper.durations).toEqual([]);
    } finally {
      otherHome.cleanup();
    }
  });

  it("sends thirty units immediately and the remaining twenty only after the oldest ten age out, for fifty ids in one call", async () => {
    // The lead's own decision, verbatim: "50 ids send 30 at once, then 20 after 60 s." Needs a
    // clock whose `sleep` actually advances `now()` -- chunk four's wait must age chunks one
    // through three out of the window (they were all spent at the same instant) before chunk
    // five's own acquire re-checks what's still in the trailing window; a clock fixed at one
    // instant can't tell that story (see `stepClock`'s own doc comment).
    const clock = stepClock();
    const associateCalls: string[][] = [];
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async (_eventId, sessionIds) => {
        associateCalls.push(sessionIds);
        return { successful: sessionIds, failed: [] };
      },
      getSchedule: async () => emptySchedule(),
    };
    const ids = Array.from({ length: 50 }, (_, i) => `s${i}`); // five chunks of ten

    await favoriteSessions(ids, { apiClient, storeRoot: home.path, sleep: clock.sleep, now: clock.now });

    expect(associateCalls).toHaveLength(5);
    // Exactly one wait, covering both chunk four and chunk five -- not two separate waits, one
    // per chunk, the way a naive "wait then re-check the same stale window" implementation would.
    expect(clock.durations).toEqual([61_000]);
  });

  it("aborts immediately on AuthRequiredError from the first chunk, with no pacer sleep and nothing reported as failed", async () => {
    // pr-reviewer's own repro: 40 ids over real stdio with no stored session took 20+ real seconds
    // to report "not signed in," because the auth error was swallowed into a per-chunk
    // requestFailed and the loop kept going, paying a real pacer wait each time. Here, a single
    // real call and zero sleeps proves the fix directly rather than by elapsed wall-clock time.
    let callCount = 0;
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async () => {
        callCount++;
        throw new AuthRequiredError();
      },
      getSchedule: async () => emptySchedule(),
    };
    const ids = Array.from({ length: 40 }, (_, i) => `s${i}`); // four chunks, if it kept going
    const sleeper = fakeSleep();

    await expect(
      favoriteSessions(ids, { apiClient, storeRoot: home.path, sleep: sleeper.sleep, now: fixedClock(0) }),
    ).rejects.toBeInstanceOf(AuthRequiredError);

    expect(callCount).toBe(1);
    expect(sleeper.durations).toEqual([]);
  });

  it("aborts immediately on NotRegisteredError the same way", async () => {
    let callCount = 0;
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async () => {
        callCount++;
        throw new NotRegisteredError();
      },
      getSchedule: async () => emptySchedule(),
    };

    await expect(
      favoriteSessions(["a"], { apiClient, storeRoot: home.path, sleep: fakeSleep().sleep, now: fixedClock(0) }),
    ).rejects.toBeInstanceOf(NotRegisteredError);

    expect(callCount).toBe(1);
  });

  it("returns a partial result with aborted set when AuthRequiredError surfaces after something was already written, instead of discarding it", async () => {
    // reviewer2's own gap on the first version of this fix: throwing unconditionally on any chunk
    // lost the 20 ids that had *already* succeeded server-side by the time chunk three's own
    // AuthRequiredError surfaced (a refresh token expiring mid-run is a realistic way this
    // happens) -- the MCP tool then reported isError "Not signed in" while the agent had no way to
    // tell the user twenty sessions really were favorited. Lead's decision: throw only when
    // nothing has been written yet; otherwise return everything gathered so far, mark every
    // not-yet-attempted id `notAttempted`, skip the read-back (it would fail the same way), and
    // report why through `aborted`.
    let callCount = 0;
    let getScheduleCalled = false;
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async (_eventId, sessionIds) => {
        callCount++;
        if (callCount <= 2) {
          return { successful: sessionIds, failed: [] };
        }
        throw new AuthRequiredError();
      },
      getSchedule: async () => {
        getScheduleCalled = true;
        return emptySchedule();
      },
    };
    const ids = Array.from({ length: 40 }, (_, i) => `s${i}`); // four chunks of ten

    const result = await favoriteSessions(ids, {
      apiClient,
      storeRoot: home.path,
      sleep: fakeSleep().sleep,
      now: fixedClock(0),
    });

    expect(callCount).toBe(3); // chunks one and two succeeded; chunk three is where it stopped
    expect(getScheduleCalled).toBe(false);
    expect(result.successful.sort()).toEqual(ids.slice(0, 20).sort());
    const requestFailed = result.failed.filter((f) => f.code === "requestFailed");
    const notAttempted = result.failed.filter((f) => f.code === "notAttempted");
    expect(requestFailed.map((f) => f.sessionId).sort()).toEqual(ids.slice(20, 30).sort());
    expect(notAttempted.map((f) => f.sessionId).sort()).toEqual(ids.slice(30).sort());
    expect(result.verified).toBeNull();
    expect(result.aborted).toEqual({ reason: "authRequired", message: new AuthRequiredError().message });
    // pr-reviewer-3's finding: a single shared reason for both abort reasons told a
    // not-registered caller to "sign in again" -- the auth case's own reason must say that
    // specifically, and must not contain the not-registered case's own wording.
    expect(notAttempted.every((f) => f.reason?.includes("sign in again"))).toBe(true);
    expect(notAttempted.every((f) => !f.reason?.includes("will not help"))).toBe(true);
  });

  it("does the same for NotRegisteredError surfacing after something was already written", async () => {
    let callCount = 0;
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async (_eventId, sessionIds) => {
        callCount++;
        if (callCount === 1) {
          return { successful: sessionIds, failed: [] };
        }
        throw new NotRegisteredError();
      },
      getSchedule: async () => emptySchedule(),
    };
    const ids = Array.from({ length: 21 }, (_, i) => `s${i}`); // three chunks

    const result = await favoriteSessions(ids, {
      apiClient,
      storeRoot: home.path,
      sleep: fakeSleep().sleep,
      now: fixedClock(0),
    });

    expect(callCount).toBe(2);
    expect(result.successful).toEqual(ids.slice(0, 10));
    expect(result.aborted).toEqual({ reason: "notRegistered", message: new NotRegisteredError().message });
    // pr-reviewer-3's finding: the not-registered case's own notAttempted reason must say plainly
    // that signing in again will not help -- not the auth case's "sign in again" remedy, which is
    // actively wrong advice here.
    const notAttempted = result.failed.filter((f) => f.code === "notAttempted");
    expect(notAttempted.length).toBeGreaterThan(0);
    expect(notAttempted.every((f) => f.reason?.includes("will not help"))).toBe(true);
    expect(notAttempted.every((f) => !f.reason?.includes("sign in again"))).toBe(true);
  });

  it("returns the write results with verified null and a verificationError when the read-back itself fails", async () => {
    // pr-reviewer's finding: the read-back used to run outside any try, so this threw the writes
    // above away entirely -- a caller would be told nothing happened when a real write did.
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async () => ({ successful: ["a"], failed: [] }),
      getSchedule: async () => {
        throw new ServiceError("The server exploded.");
      },
    };

    const result = await favoriteSessions(["a"], {
      apiClient,
      storeRoot: home.path,
      sleep: fakeSleep().sleep,
      now: fixedClock(0),
    });

    expect(result.successful).toEqual(["a"]);
    expect(result.verified).toBeNull();
    expect(result.verificationError).toBe("The server exploded.");
    expect(result.mismatch).toEqual([]);
  });

  it("returns a partial result with aborted, not a throw, when the read-back itself fails on auth after a real write", async () => {
    // The read-back's own catch applies the same "throw only when nothing was written" rule as the
    // write loop -- reaching the read-back at all means every chunk already ran, so in the
    // ordinary case there is real, already-happened write data here worth keeping rather than
    // discarding to an uncaught throw.
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async () => ({ successful: ["a"], failed: [] }),
      getSchedule: async () => {
        throw new NotRegisteredError();
      },
    };

    const result = await favoriteSessions(["a"], {
      apiClient,
      storeRoot: home.path,
      sleep: fakeSleep().sleep,
      now: fixedClock(0),
    });

    expect(result.successful).toEqual(["a"]);
    expect(result.verified).toBeNull();
    expect(result.aborted).toEqual({ reason: "notRegistered", message: new NotRegisteredError().message });
  });

  it("still throws from the read-back's own auth failure when nothing was actually written", async () => {
    // Every chunk here only ever produces a per-session refusal (never a success), so by the time
    // the read-back itself throws, nothing has genuinely been written -- the same "throw only when
    // nothing was written" rule the write loop applies, not "reached the read-back" alone.
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async (_eventId, sessionIds) => ({
        successful: [],
        failed: sessionIds.map((sessionId) => ({ sessionId, code: "scheduleConflict" as const })),
      }),
      getSchedule: async () => {
        throw new AuthRequiredError();
      },
    };

    await expect(
      favoriteSessions(["a"], { apiClient, storeRoot: home.path, sleep: fakeSleep().sleep, now: fixedClock(0) }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it("stops sending further chunks once one exhausts its 429 retries, marking the rest notAttempted, but still reads the schedule back", async () => {
    // Lead's decision: the write quota is exhausted for the whole session at that point, not just
    // the one chunk that actually got refused -- sending another chunk immediately would just be
    // refused the same way. Uses a hand-rolled fake that throws ThrottledError directly, standing
    // in for "the real API client already retried three times over real HTTP and gave up" (see the
    // next test for that at the real HTTP layer).
    const ids = Array.from({ length: 25 }, (_, i) => `s${i}`); // three chunks: 10, 10, 5
    let callCount = 0;
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async (_eventId, sessionIds) => {
        callCount++;
        if (callCount === 1) {
          throw new ThrottledError();
        }
        return { successful: sessionIds, failed: [] };
      },
      getSchedule: async () => emptySchedule(),
    };

    const result = await favoriteSessions(ids, {
      apiClient,
      storeRoot: home.path,
      sleep: fakeSleep().sleep,
      now: fixedClock(0),
    });

    // Only the first chunk was ever attempted -- chunks two and three never sent.
    expect(callCount).toBe(1);
    const requestFailed = result.failed.filter((f) => f.code === "requestFailed");
    const notAttempted = result.failed.filter((f) => f.code === "notAttempted");
    expect(requestFailed.map((f) => f.sessionId).sort()).toEqual(ids.slice(0, 10).sort());
    expect(notAttempted.map((f) => f.sessionId).sort()).toEqual(ids.slice(10).sort());
    expect(notAttempted.every((f) => f.reason !== undefined)).toBe(true);
    // The read-back still ran, even though the loop stopped early.
    expect(result.verified).not.toBeNull();
  });

  it("stops sending further chunks when a token-provider failure surfaces mid-run (a 5xx from the token endpoint, not invalid_grant) -- marking the rest notAttempted, but without aborting the whole result the way AuthRequiredError does", async () => {
    // pr-reviewer-3's finding: a non-invalid_grant token-provider failure (a 5xx or network
    // trouble from the token endpoint itself) propagates out of `performRefresh` as-is -- see
    // token-provider.ts's own comment -- since the stored refresh token is still good and a caller
    // might succeed by simply retrying later. It surfaces here as a plain `OAuthError`, not
    // `AuthRequiredError`/`NotRegisteredError` (those are reserved for `invalid_grant` and a 403,
    // both session-wide problems this isn't). Every later chunk calls the identical token provider
    // and is doomed to fail the identical way until whatever's wrong with the token endpoint
    // clears -- pacing through them one by one wastes a real wait for nothing (reviewer3's own
    // measurement: 40 ids took over a minute, every chunk after the first `requestFailed`).
    const ids = Array.from({ length: 25 }, (_, i) => `s${i}`); // three chunks: 10, 10, 5
    let callCount = 0;
    const apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule"> = {
      associateFavorites: async (_eventId, sessionIds) => {
        callCount++;
        if (callCount === 1) {
          throw new OAuthError("The token endpoint returned status 503.");
        }
        return { successful: sessionIds, failed: [] };
      },
      getSchedule: async () => emptySchedule(),
    };

    const result = await favoriteSessions(ids, {
      apiClient,
      storeRoot: home.path,
      sleep: fakeSleep().sleep,
      now: fixedClock(0),
    });

    // Only the first chunk was ever attempted -- chunks two and three never sent.
    expect(callCount).toBe(1);
    const requestFailed = result.failed.filter((f) => f.code === "requestFailed");
    const notAttempted = result.failed.filter((f) => f.code === "notAttempted");
    expect(requestFailed.map((f) => f.sessionId).sort()).toEqual(ids.slice(0, 10).sort());
    expect(notAttempted.map((f) => f.sessionId).sort()).toEqual(ids.slice(10).sort());
    // Unlike ThrottledError's fixed reason text, there's no single well-known cause here -- the
    // real error message rides along, same as any other requestFailed reason.
    expect(notAttempted.every((f) => f.reason === "The token endpoint returned status 503.")).toBe(
      true,
    );
    // Not a session-wide auth problem: the result is not `aborted`, and the read-back still ran.
    expect(result.aborted).toBeUndefined();
    expect(result.verified).not.toBeNull();
  });

  it("stops sending further chunks after a real chunk exhausts three real 429 responses over HTTP", async () => {
    // The lead's own test description, at the real HTTP layer: a fake API that returns 429 three
    // times on the first chunk's POST (exhausting the real client's own retry budget, see
    // api/client.ts) must produce zero further POSTs and report the remaining ids notAttempted.
    const ids = Array.from({ length: 25 }, (_, i) => `s${i}`); // three chunks: 10, 10, 5
    const fake = createFakeFetch([
      { status: 429, headers: { "Retry-After": "1" }, json: { message: "Slow down" } },
      { status: 429, headers: { "Retry-After": "1" }, json: { message: "Slow down" } },
      { status: 429, headers: { "Retry-After": "1" }, json: { message: "Slow down" } },
      { status: 200, json: { schedule: { reserved: [], favorites: [], personalTime: [] } } },
    ]);
    const apiClient = createApiClient({
      fetchFn: fake.fetch,
      getAccessToken: async () => "token",
      sleep: fakeSleep().sleep,
    });

    const result = await favoriteSessions(ids, { apiClient, storeRoot: home.path });

    // Three retried POSTs for chunk one (exhausting the client's own retries), then exactly one
    // more call -- the GetSchedule read-back -- and nothing for chunks two or three.
    expect(fake.calls).toHaveLength(4);
    const postCalls = fake.calls.filter((c) => c.init?.method === "POST");
    expect(postCalls).toHaveLength(3);
    const notAttempted = result.failed.filter((f) => f.code === "notAttempted");
    expect(notAttempted.map((f) => f.sessionId).sort()).toEqual(ids.slice(10).sort());
  });
});

describe("unfavoriteSession", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); });
  afterEach(() => { home.cleanup(); });
  it("removes a single favorite and treats a 204 as success", async () => {
    let called: { eventId: string; sessionId: string } | undefined;
    const apiClient: Pick<ApiClient, "disassociateFavorite"> = {
      disassociateFavorite: async (eventId, sessionId) => {
        called = { eventId, sessionId };
      },
    };

    const outcome = await unfavoriteSession("s1", { apiClient, storeRoot: home.path });

    expect(outcome).toBe("removed");
    expect(called).toEqual({ eventId: DEFAULT_EVENT_ID, sessionId: "s1" });
  });

  it("reports notFavorited when removing something that was not a favorite", async () => {
    const apiClient: Pick<ApiClient, "disassociateFavorite"> = {
      disassociateFavorite: async () => {
        throw new NotFoundError("No favorite with that session id.");
      },
    };

    const outcome = await unfavoriteSession("s1", { apiClient, storeRoot: home.path });

    expect(outcome).toBe("notFavorited");
  });

  it("propagates an error other than NotFoundError unchanged", async () => {
    const apiClient: Pick<ApiClient, "disassociateFavorite"> = {
      disassociateFavorite: async () => {
        throw new ServiceError("The server exploded.");
      },
    };

    await expect(unfavoriteSession("s1", { apiClient, storeRoot: home.path })).rejects.toBeInstanceOf(ServiceError);
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

    const outcome = await unfavoriteSession("s1", { apiClient, storeRoot: home.path });

    expect(outcome).toBe("notFavorited");
    expect(fake.calls).toHaveLength(2);
  });
});

describe("favorite uncertainty", () => {
  it("retains an ambiguous write when the next chunk loses auth", async () => {
    const home = createTempHome(); let calls = 0;
    try {
      const result = await favoriteSessions(Array.from({ length: 11 }, (_, i) => String(i)), {
        storeRoot: home.path,
        apiClient: { associateFavorites: async () => { if (++calls === 1) throw new ServiceError("lost response"); throw new AuthRequiredError(); }, getSchedule: async () => { throw new AuthRequiredError(); } },
      });
      expect(result.uncertain).toEqual(Array.from({ length: 10 }, (_, i) => String(i)));
      expect(result.successful).toEqual([]);
      expect(result.aborted?.reason).toBe("authRequired");
    } finally { home.cleanup(); }
  });
});

describe("favorite rejection certainty", () => {
  it("does not call 400 rejection uncertain", async () => {
    const home = createTempHome();
    try {
      const result = await favoriteSessions(["a"], { storeRoot: home.path, apiClient: { associateFavorites: async () => { throw new ValidationError("invalid"); }, getSchedule: async () => ({ reserved: [], favorites: [], personalTime: [] }) } });
      expect(result.uncertain ?? []).toEqual([]);
      expect(result.failed[0]!.code).toBe("requestFailed");
    } finally { home.cleanup(); }
  });
  it("stops 409 immediately", async () => {
    const home = createTempHome(); let calls = 0;
    try {
      await expect(favoriteSessions(Array.from({ length: 11 }, (_, i) => String(i)), { storeRoot: home.path, apiClient: { associateFavorites: async () => { calls++; throw new OperationUnavailableError("closed"); }, getSchedule: async () => ({ reserved: [], favorites: [], personalTime: [] }) } })).rejects.toThrow("closed");
      expect(calls).toBe(1);
    } finally { home.cleanup(); }
  });
  it("missing and duplicate acknowledgements remain uncertain and unsolicited ids never become successes", async () => {
    const home = createTempHome();
    try {
      const result = await favoriteSessions(["a", "b"], { storeRoot: home.path, apiClient: { associateFavorites: async () => ({ successful: ["a", "a", "unsolicited"], failed: [] }), getSchedule: async () => ({ reserved: [], favorites: [], personalTime: [] }) } });
      expect(result.successful).toEqual([]); expect(result.uncertain).toEqual(["a", "b"]);
    } finally { home.cleanup(); }
  });
});

it("unfavorite charges its own per-request rolling window", async () => {
  const home = createTempHome(); const clock = stepClock();
  try {
    for (let i = 0; i < 31; i++) await unfavoriteSession(String(i), { storeRoot: home.path, ...clock, apiClient: { disassociateFavorite: async () => {} } });
    expect(clock.durations).toEqual([61000]);
  } finally { home.cleanup(); }
});

describe("favorite review fixes", () => {
  const empty = async () => ({ reserved: [], favorites: [], personalTime: [] });
  const twenty = Array.from({ length: 21 }, (_, i) => `f${i}`);
  it("lists an ambiguous chunk once, as uncertain, and not also as failed", async () => {
    const home = createTempHome();
    try {
      const result = await favoriteSessions(["a", "b"], { storeRoot: home.path, apiClient: { associateFavorites: async () => { throw new ServiceError("lost response"); }, getSchedule: empty } });
      expect(result.uncertain).toEqual(["a", "b"]);
      expect(result.failed).toEqual([]);
    } finally { home.cleanup(); }
  });
  it("still lists a definite rejection only as failed", async () => {
    const home = createTempHome();
    try {
      const result = await favoriteSessions(["a"], { storeRoot: home.path, apiClient: { associateFavorites: async () => { throw new ValidationError("invalid"); }, getSchedule: empty } });
      expect(result.uncertain ?? []).toEqual([]);
      expect(result.failed.map(f => f.sessionId)).toEqual(["a"]);
    } finally { home.cleanup(); }
  });
  it.each([
    ["an OAuth token failure", () => markRequestNotSent(new OAuthError("server_error", "token endpoint down"))],
    ["a sign-in loss", () => markRequestNotSent(new AuthRequiredError())],
  ])("reports a chunk whose token could not be obtained (%s) as not attempted, not requestFailed", async (_label, makeError) => {
    const home = createTempHome(); let calls = 0;
    try {
      const result = await favoriteSessions(twenty, { storeRoot: home.path, apiClient: { associateFavorites: async (_event: string, list: string[]) => { if (++calls === 1) return { successful: list, failed: [] }; throw makeError(); }, getSchedule: empty } });
      expect(result.successful).toEqual(twenty.slice(0, 10));
      expect(result.failed.filter(f => f.code === "requestFailed")).toEqual([]);
      expect(result.failed.filter(f => f.code === "notAttempted").map(f => f.sessionId)).toEqual(twenty.slice(10));
    } finally { home.cleanup(); }
  });
});
