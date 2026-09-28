import type { ApiClient } from "../api/client.js";
import type { BulkFailureCode } from "../api/types.js";
import type { IndexRecord } from "../catalog/index-record.js";
import { readIndex, type CatalogStoreDeps } from "../catalog/store.js";
import { DEFAULT_EVENT_ID } from "../catalog/sync.js";
import { AuthRequiredError, NotFoundError, NotRegisteredError, ThrottledError } from "../core/errors.js";

/** The API's own per-request cap on `AssociateFavorites`. */
const MAX_FAVORITES_PER_REQUEST = 10;

/** The write quota this module paces against: 30 session-units per rolling minute, spending one
 * unit per session id in a chunk (plan decision 8 -- the pacer lives next to its only caller
 * rather than being built speculatively into the API client, since only this write path spends
 * the quota). `GetSchedule`'s own re-read at the end of `favoriteSessions` has a separate rate
 * quota entirely and is never paced against this bucket. */
const SESSION_UNITS_PER_MINUTE = 30;
const PACE_WINDOW_MS = 60_000;

/** Reported instead of throwing when a whole chunk's request fails outright (a thrown error --
 * network trouble, an exhausted retry, a sign-in problem) rather than a per-session refusal
 * inside a successful response's own `failed` list. Not one of the API's documented codes, but a
 * valid value under `BulkFailureCode`'s `string` widening -- a caller sees a refusal it can act on
 * for exactly the ids affected, instead of the whole write throwing and losing every other
 * chunk's result. */
const REQUEST_FAILED_CODE = "requestFailed";

/** Reported for an id whose chunk was never even sent -- distinct from `REQUEST_FAILED_CODE`,
 * which means a request for that id's chunk was actually attempted and refused. Used only when a
 * chunk exhausts the API client's own 429 retries (`ThrottledError`): the write quota is
 * exhausted for the whole session at that point, not just the one chunk, so sending another
 * chunk right behind it would just be refused the same way -- pr-reviewer's and the lead's own
 * decision is to stop there and report the truth ("never tried") rather than either attempting a
 * request certain to fail or silently dropping those ids from the result entirely. */
const NOT_ATTEMPTED_CODE = "notAttempted";
const NOT_ATTEMPTED_REASON = "The write rate limit was reached; retry the remaining sessions shortly.";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

interface RateWindowEntry {
  at: number;
  units: number;
}

/**
 * One rolling-window write-quota tracker per store root, kept alive for the lifetime of this
 * process (module-level state, not per-call) -- reviewer's finding: a bucket created fresh inside
 * every `favoriteSessions` call let two back-to-back calls against the *same* store root (the MCP
 * server's long-lived process is exactly this shape) each spend the full thirty-unit budget
 * immediately, doubling the real quota. Keyed by store root, not global, so an unrelated store
 * (a different test, or a second local user profile) never shares -- or is blocked by -- a
 * window it has nothing to do with.
 *
 * This is in-process only: two separate `reinvent-scout` processes writing against the same store
 * root at once are not coordinated here at all -- there is no cross-process lock or shared file.
 * That case relies entirely on the API's own 429 handling (the client's built-in retry-with-backoff,
 * and this module's own stop-after-exhaustion behavior below) as the actual backstop.
 */
const rateWindowsByStoreRoot = new Map<string, RateWindowEntry[]>();

function getRateWindow(storeRoot: string): RateWindowEntry[] {
  let entries = rateWindowsByStoreRoot.get(storeRoot);
  if (entries === undefined) {
    entries = [];
    rateWindowsByStoreRoot.set(storeRoot, entries);
  }
  return entries;
}

/**
 * Spends `cost` session-units from `entries`' rolling 60-second window, sleeping first when
 * sending it now would put more than thirty units' worth of requests in the trailing 60 seconds.
 * A sliding window of individual `(timestamp, units)` entries, not a continuously-refilling token
 * bucket -- reviewer's finding: a bucket that refills continuously as real time passes can let
 * more than the nominal cap out within a rolling window depending on exactly when each request
 * lands relative to the last refill (measured over real stdio: 40 units within the first 20
 * seconds against a nominal 30/minute quota). A sliding window log can't drift that way by
 * construction -- nothing already spent is ever double-counted, and nothing is ever counted as
 * "spent" outside the trailing window it was actually spent in. When the window is full, this
 * waits for exactly as many of its *oldest* entries to age fully out as it takes for `cost` to
 * fit (not a fractional wait computed from a refill rate) -- so, for example, an already-full
 * window doesn't admit ten more units until a full sixty seconds after the oldest ten were spent,
 * not twenty seconds later the way a continuously-refilling bucket would allow. This is computed
 * directly from the entries already on hand -- how many of the oldest must expire, and when the
 * last of those does -- rather than sleeping and re-checking in a loop, so `acquire` calls `sleep`
 * at most once no matter how many entries must expire to make room.
 */
async function acquire(
  entries: RateWindowEntry[],
  cost: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const t = now();
  while (entries.length > 0 && t - entries[0]!.at >= PACE_WINDOW_MS) {
    entries.shift();
  }

  let used = entries.reduce((sum, entry) => sum + entry.units, 0);
  if (used + cost > SESSION_UNITS_PER_MINUTE) {
    let dropCount = 0;
    while (used + cost > SESSION_UNITS_PER_MINUTE && dropCount < entries.length) {
      used -= entries[dropCount]!.units;
      dropCount++;
    }
    const lastToExpire = entries[dropCount - 1]!;
    const waitMs = Math.max(0, lastToExpire.at + PACE_WINDOW_MS - t);
    await sleep(waitMs);
    entries.splice(0, dropCount);
  }

  entries.push({ at: now(), units: cost });
}

export interface ResolvedConflict {
  sessionId: string;
  /** Resolved from the local catalog index; `null` when the index has no record for it --
   * unsynced, or the conflicting session isn't in the local catalog at all. */
  title: string | null;
}

function resolveConflicts(sessionIds: readonly string[], index: IndexRecord[] | null): ResolvedConflict[] {
  return sessionIds.map((sessionId) => ({
    sessionId,
    title: index?.find((record) => record.sessionId === sessionId)?.title ?? null,
  }));
}

export interface FavoriteFailure {
  sessionId: string;
  code: BulkFailureCode;
  /** Present only for a `scheduleConflict` refusal. */
  conflictsWith?: ResolvedConflict[];
  /** Present only for `REQUEST_FAILED_CODE` -- the underlying error's own message (never a
   * token: the API client's own error taxonomy already guarantees its error messages never
   * include one, see api/client.ts's `mapErrorResponse`). A bare "requestFailed" code alone tells
   * a caller nothing about what actually happened; this is what turns "something failed" into
   * "the server exploded" or "you're not registered for this event." */
  reason?: string;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface FavoriteSessionsResult {
  /** Ids the API reported as newly favorited. */
  successful: string[];
  /** Ids the API reported as already favorited -- a non-failure, kept separate from `failed`
   * since the session is on the schedule either way. */
  alreadyFavorited: string[];
  /** Every other per-session refusal, aggregated across every chunk. */
  failed: FavoriteFailure[];
  /** From re-reading `GetSchedule` once, after every chunk has been attempted: the ids, among
   * every one requested, that are actually on the attendee's favorites list now -- the ground
   * truth after the dust settles, independent of what any individual response claimed. `null`
   * when the read-back itself failed (see `verificationError`) -- the writes above already
   * happened and are reported regardless; there is simply nothing to compare them against. */
  verified: { favorited: string[] } | null;
  /** The read-back's own error message, present only when `verified` is `null`. pr-reviewer's
   * finding: the read-back used to run outside any `try`, so a throw there discarded every write
   * result gathered above it -- a caller would be told nothing happened when a great deal did. */
  verificationError?: string;
  /** Ids the API reported as favorited (`successful` or `alreadyFavorited`) that the read-back
   * does not confirm -- a real, visible-in-state partial failure the responses alone would have
   * hidden. Empty in the ordinary case, and always empty when `verified` is `null` (nothing was
   * read back to compare against). */
  mismatch: string[];
}

export interface FavoriteSessionsDeps extends CatalogStoreDeps {
  apiClient: Pick<ApiClient, "associateFavorites" | "getSchedule">;
  /** Defaults to `DEFAULT_EVENT_ID`. */
  eventId?: string;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to a real timer-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Favorites every session id, chunked at the API's own per-request cap of ten and paced to stay
 * within thirty session-units per rolling minute (one unit per id). Never writes anything itself
 * -- every diagnostic (partial failures, the verification mismatch) is a plain field on the
 * returned result, since the MCP server can only write protocol traffic to stdout and a CLI
 * caller decides for itself how to narrate this, exactly like `schedule.ts`'s `getSchedule`.
 *
 * A 200 response's own `failed` list is never treated as a uniform outcome: `alreadyFavorited` is
 * split out as a non-failure, a `scheduleConflict`'s `conflictsWith` ids are resolved to titles
 * via the local catalog index (falling back to `null` per id when the index has no record, or
 * none is synced at all), and every other code -- known or not, since `BulkFailureCode` is
 * deliberately typed as the known union plus `string` -- is reported as a plain refusal rather
 * than causing this function to throw.
 *
 * A chunk's whole request failing outright (a thrown error, not a per-session refusal) is scoped
 * to only that chunk's ids -- reported as `failed` with `REQUEST_FAILED_CODE` -- so one bad chunk
 * never loses every other chunk's result. Two errors are treated specially, since they are never
 * really about just one chunk:
 *
 * - `AuthRequiredError` or `NotRegisteredError`, from any chunk (not only the first): the whole
 *   session is affected, not this one request -- every later chunk would fail the identical way,
 *   burning a real pacer wait each time for no reason (reviewer's own measurement: 40 ids took
 *   20+ real seconds to report "not signed in," over four chunks that were each doomed from the
 *   start). This function stops immediately and rethrows the error as-is, with no further chunk
 *   attempted and no read-back -- the caller's own generic handling (the CLI and MCP tool both
 *   already know how to report "not signed in" or "not registered") is what should run, which
 *   swallowing it into an opaque per-session `requestFailed` would have hidden entirely.
 * - `ThrottledError` -- a chunk that exhausted the API client's own three 429 retries: the write
 *   quota is exhausted for the whole session at that point, not just this chunk, so immediately
 *   sending another would just be refused the same way. This chunk's own ids are still reported
 *   as `requestFailed` (a real request for them really was attempted and really was refused), but
 *   every *remaining*, not-yet-attempted id is reported as `notAttempted` instead, and no further
 *   chunk is sent. The read-back below still runs, since whatever chunks *did* succeed before this
 *   one are still worth confirming.
 *
 * After every chunk has been attempted (or the loop stopped early on a `ThrottledError`), this
 * re-reads `GetSchedule` exactly once (never per chunk, and never paced through the write window
 * above -- `GetSchedule` has its own, separate rate quota) and reports, in `verified.favorited`,
 * which of the *requested* ids are actually on the schedule now. `mismatch` names any id the API
 * claimed was favorited (`successful` or `alreadyFavorited`) that the read-back does not confirm --
 * a real partial failure made visible in state, not just in the response. If the read-back itself
 * throws, every write result gathered above is still returned -- `verified: null` and
 * `verificationError` name what happened, rather than losing real, already-happened writes just
 * because the *confirmation* step failed (pr-reviewer's finding: the read-back used to run
 * outside any `try`, so this case lost every result to an uncaught throw).
 */
export async function favoriteSessions(
  sessionIds: readonly string[],
  deps: FavoriteSessionsDeps,
): Promise<FavoriteSessionsResult> {
  const eventId = deps.eventId ?? DEFAULT_EVENT_ID;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const index = readIndex({ storeRoot: deps.storeRoot });

  const rateWindow = getRateWindow(deps.storeRoot);

  const successful: string[] = [];
  const alreadyFavorited: string[] = [];
  const failed: FavoriteFailure[] = [];

  const chunks = chunk(sessionIds, MAX_FAVORITES_PER_REQUEST);
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const idsChunk = chunks[chunkIndex]!;
    await acquire(rateWindow, idsChunk.length, now, sleep);

    try {
      const result = await deps.apiClient.associateFavorites(eventId, idsChunk);
      successful.push(...result.successful);
      for (const failure of result.failed) {
        if (failure.code === "alreadyFavorited") {
          // Load-bearing for correctness under retry, not just a UX nicety: the API client
          // retries a chunk's whole request on 429/503 (see api/client.ts), so a request that
          // actually succeeded server-side on its first attempt can still come back here on a
          // retried attempt -- and the server reports that as `alreadyFavorited`, not a repeat
          // `successful`. Since this is already treated as a non-failure, a retried write
          // degrades correctly (the session ends up favorited either way). Reclassifying
          // `alreadyFavorited` as a failure later would silently turn every retried
          // AssociateFavorites call that happened to actually succeed on its first attempt into a
          // reported error.
          alreadyFavorited.push(failure.sessionId);
          continue;
        }
        failed.push({
          sessionId: failure.sessionId,
          code: failure.code,
          ...(failure.code === "scheduleConflict" && failure.conflictsWith !== undefined
            ? { conflictsWith: resolveConflicts(failure.conflictsWith, index) }
            : {}),
        });
      }
    } catch (err) {
      if (err instanceof AuthRequiredError || err instanceof NotRegisteredError) {
        throw err;
      }

      // Scoped to this chunk's ids alone -- an independent request failing must not lose every
      // other chunk's result. The underlying error's message rides along as `reason`: a bare
      // "requestFailed" code with nothing else would tell a caller precisely nothing about why.
      const reason = describeError(err);
      for (const sessionId of idsChunk) {
        failed.push({ sessionId, code: REQUEST_FAILED_CODE, reason });
      }

      if (err instanceof ThrottledError) {
        const notAttempted = chunks.slice(chunkIndex + 1).flat();
        for (const sessionId of notAttempted) {
          failed.push({ sessionId, code: NOT_ATTEMPTED_CODE, reason: NOT_ATTEMPTED_REASON });
        }
        break;
      }
    }
  }

  try {
    const schedule = await deps.apiClient.getSchedule(eventId);
    const favoritedNow = new Set(schedule.favorites);
    const verifiedFavorited = sessionIds.filter((sessionId) => favoritedNow.has(sessionId));

    const claimedFavorited = new Set([...successful, ...alreadyFavorited]);
    const verifiedSet = new Set(verifiedFavorited);
    const mismatch = [...claimedFavorited].filter((sessionId) => !verifiedSet.has(sessionId));

    return {
      successful,
      alreadyFavorited,
      failed,
      verified: { favorited: verifiedFavorited },
      mismatch,
    };
  } catch (err) {
    // AuthRequiredError/NotRegisteredError get the same treatment here as in the write loop above
    // -- a session-wide problem, not something specific to the read-back, so it's surfaced as-is
    // rather than folded into a verificationError. Every other read-back failure (network trouble,
    // a 5xx) still returns the real write results gathered above instead of losing them.
    if (err instanceof AuthRequiredError || err instanceof NotRegisteredError) {
      throw err;
    }
    return {
      successful,
      alreadyFavorited,
      failed,
      verified: null,
      verificationError: describeError(err),
      mismatch: [],
    };
  }
}

export interface UnfavoriteSessionDeps {
  apiClient: Pick<ApiClient, "disassociateFavorite">;
  /** Defaults to `DEFAULT_EVENT_ID`. */
  eventId?: string;
}

export type UnfavoriteOutcome = "removed" | "notFavorited";

/**
 * Removes one session from favorites. The API reports both "this session was never favorited"
 * and "this session doesn't exist" as the same 404 (`NotFoundError`), so this can't distinguish
 * them either -- both come back as `"notFavorited"` rather than throwing, since it's the
 * documented, expected shape of "there's nothing to remove," not a real error. Any other error
 * propagates unchanged.
 *
 * This is also what makes a retried `DisassociateFavorite` degrade correctly, not just a bare
 * 404: the API client retries the whole request on 429/503 (see `api/client.ts`), so a DELETE
 * that actually removed the favorite on its first attempt can still come back here as a 404 on
 * the retried attempt -- indistinguishable from "was never favorited" at this layer. Both mean
 * the same thing to the caller (the session is not favorited now, which is what was asked for),
 * so treating every 404 as `"notFavorited"` is correct even when the id genuinely was favorited
 * at the moment the caller asked to remove it.
 */
export async function unfavoriteSession(
  sessionId: string,
  deps: UnfavoriteSessionDeps,
): Promise<UnfavoriteOutcome> {
  const eventId = deps.eventId ?? DEFAULT_EVENT_ID;
  try {
    await deps.apiClient.disassociateFavorite(eventId, sessionId);
    return "removed";
  } catch (err) {
    if (err instanceof NotFoundError) {
      return "notFavorited";
    }
    throw err;
  }
}
