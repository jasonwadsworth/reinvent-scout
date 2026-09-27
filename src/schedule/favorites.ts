import type { ApiClient } from "../api/client.js";
import type { BulkFailureCode } from "../api/types.js";
import type { IndexRecord } from "../catalog/index-record.js";
import { readIndex, type CatalogStoreDeps } from "../catalog/store.js";
import { DEFAULT_EVENT_ID } from "../catalog/sync.js";
import { NotFoundError } from "../core/errors.js";

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

interface TokenBucket {
  tokens: number;
  lastRefillAt: number;
}

function refill(bucket: TokenBucket, now: number): void {
  const elapsedMs = now - bucket.lastRefillAt;
  if (elapsedMs <= 0) {
    return;
  }
  const replenished = (elapsedMs / PACE_WINDOW_MS) * SESSION_UNITS_PER_MINUTE;
  bucket.tokens = Math.min(SESSION_UNITS_PER_MINUTE, bucket.tokens + replenished);
  bucket.lastRefillAt = now;
}

/** Spends `cost` units from the bucket, sleeping first when there aren't enough available yet.
 * The wait is computed directly from the deficit and the refill rate, not polled in a loop, so
 * exactly one `sleep` call ever covers one `acquire`. */
async function acquire(
  bucket: TokenBucket,
  cost: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  refill(bucket, now());
  if (bucket.tokens < cost) {
    const deficit = cost - bucket.tokens;
    const waitMs = Math.ceil((deficit / SESSION_UNITS_PER_MINUTE) * PACE_WINDOW_MS);
    await sleep(waitMs);
    refill(bucket, now());
  }
  bucket.tokens -= cost;
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
   * truth after the dust settles, independent of what any individual response claimed. */
  verified: { favorited: string[] };
  /** Ids the API reported as favorited (`successful` or `alreadyFavorited`) that the read-back
   * does not confirm -- a real, visible-in-state partial failure the responses alone would have
   * hidden. Empty in the ordinary case. */
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
 * never loses every other chunk's result.
 *
 * After every chunk has been attempted, this re-reads `GetSchedule` exactly once (never per
 * chunk, and never paced through the write bucket above -- `GetSchedule` has its own, separate
 * rate quota) and reports, in `verified.favorited`, which of the *requested* ids are actually on
 * the schedule now. `mismatch` names any id the API claimed was favorited (`successful` or
 * `alreadyFavorited`) that the read-back does not confirm -- a real partial failure made visible
 * in state, not just in the response.
 */
export async function favoriteSessions(
  sessionIds: readonly string[],
  deps: FavoriteSessionsDeps,
): Promise<FavoriteSessionsResult> {
  const eventId = deps.eventId ?? DEFAULT_EVENT_ID;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const index = readIndex({ storeRoot: deps.storeRoot });

  const bucket: TokenBucket = { tokens: SESSION_UNITS_PER_MINUTE, lastRefillAt: now() };

  const successful: string[] = [];
  const alreadyFavorited: string[] = [];
  const failed: FavoriteFailure[] = [];

  for (const idsChunk of chunk(sessionIds, MAX_FAVORITES_PER_REQUEST)) {
    await acquire(bucket, idsChunk.length, now, sleep);

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
    } catch {
      // Scoped to this chunk's ids alone -- an independent request failing must not lose every
      // other chunk's result.
      for (const sessionId of idsChunk) {
        failed.push({ sessionId, code: REQUEST_FAILED_CODE });
      }
    }
  }

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
