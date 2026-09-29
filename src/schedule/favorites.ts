import { isDefiniteWriteRejection } from "./reservations.js";
import { acquireWriteQuota, type WriteQuotaDeps } from "./write-quota.js";
import type { ApiClient } from "../api/client.js";
import type { BulkFailureCode } from "../api/types.js";
import { OAuthError } from "../auth/oauth.js";
import type { IndexRecord } from "../catalog/index-record.js";
import { readIndex, type CatalogStoreDeps } from "../catalog/store.js";
import { DEFAULT_EVENT_ID } from "../catalog/sync.js";
import { AuthRequiredError, isRequestNotSent, NotFoundError, NotRegisteredError, OperationUnavailableError, ThrottledError } from "../core/errors.js";

/** The API's own per-request cap on `AssociateFavorites`. */
const MAX_FAVORITES_PER_REQUEST = 10;

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
const NOT_ATTEMPTED_THROTTLED_REASON =
  "The write rate limit was reached; retry the remaining sessions shortly.";
/** reviewer2's finding on the first version of the auth-abort fix: the message must not just
 * repeat "not attempted" -- a caller reading one entry among many notAttempted ids needs to know
 * this is because the whole session stopped (see `aborted`), not that this one id was somehow
 * special. pr-reviewer-3's own follow-up finding: a single shared reason text for both
 * `AuthRequiredError` and `NotRegisteredError` told a not-registered caller to "sign in again,"
 * directly contradicting `NotRegisteredError`'s own message ("signing in again will not help") --
 * the two need genuinely different remedies, the same way `aborted.reason` itself already
 * distinguishes them. */
function notAttemptedAuthReason(err: AuthRequiredError | NotRegisteredError | OperationUnavailableError): string {
  if (err instanceof OperationUnavailableError) return err.message;
  if (err instanceof AuthRequiredError) {
    return (
      "The session was interrupted before this could be attempted; sign in again " +
      "(`reinvent-scout auth login`), then retry."
    );
  }
  return (
    "The session was interrupted before this could be attempted; the account is not registered " +
    "for this event, and signing in again will not help -- register for the event, then retry."
  );
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
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
  /** Ambiguous requests: observed state does not prove this call caused a write. */
  uncertain?: string[];
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
  /** Present when `AuthRequiredError`/`NotRegisteredError` stopped the operation early *after* at
   * least one earlier chunk had already written something -- `reason` is a coarse code a caller
   * can branch on without string-matching `message`, which carries the error's own text (a real
   * sign-in instruction, e.g. "Not signed in. Run `reinvent-scout auth login`."). Everything else
   * on this result (`successful`, `alreadyFavorited`, `failed`) is still real: the writes already
   * happened before the interruption. `verified` is always `null` when this is present -- the
   * read-back is skipped entirely, since it would fail the identical way. reviewer2's finding: the
   * first version of this fix rethrew unconditionally on any chunk, discarding writes that had
   * already landed server-side (a refresh token expiring mid-run, most realistically) -- the exact
   * class of bug the original read-back fix (see `verificationError`) closed, just one step
   * earlier. When nothing was written yet, this function still throws instead (see below), since
   * there's nothing real to report. */
  aborted?: { reason: "authRequired" | "notRegistered" | "operationUnavailable"; message: string };
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
 * - `AuthRequiredError` or `NotRegisteredError`, from any chunk (not only the first) or from the
 *   read-back: the whole session is affected, not this one request -- every later chunk would fail
 *   the identical way, burning a real pacer wait each time for no reason (reviewer's own
 *   measurement: 40 ids took 20+ real seconds to report "not signed in," over four chunks that
 *   were each doomed from the start). This function stops immediately, with no further chunk
 *   attempted and no read-back. If nothing has been written yet, it rethrows the error as-is -- the
 *   caller's own generic handling (the CLI and MCP tool both already know how to report "not signed
 *   in" or "not registered") is what should run, which swallowing it into an opaque per-session
 *   `requestFailed` would have hidden entirely. If an earlier chunk *did* already write something,
 *   throwing would discard it -- reviewer's own follow-up finding, the same "real writes silently
 *   lost" shape as the read-back's own fix below, one step earlier -- so instead this returns the
 *   real results gathered so far, marks every not-yet-attempted id `notAttempted`, and reports why
 *   through `aborted` (`verified` is always `null` here; the read-back is skipped, since it would
 *   fail the identical way).
 * - `ThrottledError` -- a chunk that exhausted the API client's own three 429 retries: the write
 *   quota is exhausted for the whole session at that point, not just this chunk, so immediately
 *   sending another would just be refused the same way. This chunk's own ids are still reported
 *   as `requestFailed` (a real request for them really was attempted and really was refused), but
 *   every *remaining*, not-yet-attempted id is reported as `notAttempted` instead, and no further
 *   chunk is sent. The read-back below still runs, since whatever chunks *did* succeed before this
 *   one are still worth confirming.
 * - `OAuthError` -- a token-provider failure that is *not* `invalid_grant` (a 5xx or network
 *   trouble from the token endpoint itself, see `token-provider.ts`'s own `performRefresh`
 *   comment): the stored refresh token isn't invalidated, so this is deliberately not treated as
 *   a session-wide `AuthRequiredError`/`NotRegisteredError` (no `aborted`, nothing thrown even
 *   when nothing has been written yet) -- but every later chunk calls the identical token
 *   provider and is doomed the identical way until whatever's wrong with the token endpoint
 *   clears, so this gets the same stop-early, mark-the-rest-`notAttempted` treatment as
 *   `ThrottledError` above, just with the real error message as the reason instead of a fixed
 *   string (there's no single well-known cause here).
 *
 * After every chunk has been attempted (or the loop stopped early on a `ThrottledError` or
 * `OAuthError`), this
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
  const index = readIndex({ storeRoot: deps.storeRoot });


  const uncertain: string[] = [];
  const successful: string[] = [];
  const alreadyFavorited: string[] = [];
  const failed: FavoriteFailure[] = [];

  /** `true` once at least one chunk has produced a real, confirmed write -- the only thing that
   * decides whether an `AuthRequiredError`/`NotRegisteredError` (from any chunk, or the read-back)
   * aborts with a partial result or throws outright. Deliberately not "has any chunk been
   * attempted": a chunk whose whole response was per-session refusals (`failed` only, zero
   * `successful`/`alreadyFavorited`) has genuinely written nothing, so an auth failure right after
   * it still has nothing real to report and should throw, the same as failing on the very first
   * chunk. */
  const hasWrittenAnything = (): boolean => successful.length > 0 || alreadyFavorited.length > 0 || uncertain.length > 0;

  /** reviewer2's finding on the first version of this fix: rethrowing unconditionally on any
   * chunk's `AuthRequiredError`/`NotRegisteredError` discarded whatever had already been written
   * server-side by an earlier chunk (a refresh token expiring mid-run, most realistically) -- the
   * exact "real writes silently lost" class of bug the read-back's own `verificationError` handling
   * already closed one step later. Lead's decision: throw only when nothing has been written yet;
   * otherwise return everything gathered so far, with `aborted` naming why and `verified: null`
   * since the read-back is skipped entirely (it would fail the identical way). */
  function abortOrThrow(err: AuthRequiredError | NotRegisteredError | OperationUnavailableError): FavoriteSessionsResult {
    if (!hasWrittenAnything()) {
      throw err;
    }
    return {
      ...(uncertain.length ? { uncertain } : {}),
      successful,
      alreadyFavorited,
      failed,
      verified: null,
      mismatch: [],
      aborted: {
        reason: err instanceof AuthRequiredError ? "authRequired" : err instanceof NotRegisteredError ? "notRegistered" : "operationUnavailable",
        message: err.message,
      },
    };
  }

  const chunks = chunk(sessionIds, MAX_FAVORITES_PER_REQUEST);
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const idsChunk = chunks[chunkIndex]!;
    await acquireWriteQuota("favorite", idsChunk.length, deps);

    try {
      const result = await deps.apiClient.associateFavorites(eventId, idsChunk);
      for (const id of idsChunk) {
        const acknowledged = Array.isArray(result?.successful) ? result.successful.filter(value => value === id).length : 0;
        const failures = Array.isArray(result?.failed) ? result.failed.filter(value => value?.sessionId === id) : [];
        if (acknowledged + failures.length !== 1 || (failures[0] && typeof failures[0].code !== "string")) {
          uncertain.push(id); continue;
        }
        if (acknowledged === 1) { successful.push(id); continue; }
        const failure = failures[0]!;
        if (failure.code === "alreadyFavorited") {
          // Load-bearing for correctness under retry, not just a UX nicety: the API client
          // retries a chunk's whole request on 429 (see api/client.ts), so a request that
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
      if (err instanceof AuthRequiredError || err instanceof NotRegisteredError || err instanceof OperationUnavailableError) {
        // This chunk's own ids: a real request really was attempted and really was refused, same
        // as any other requestFailed. Everything strictly after it never got the chance.
        const reason = describeError(err);
        const notAttemptedReason = notAttemptedAuthReason(err);
        for (const sessionId of idsChunk) {
          // A token failure means this chunk's request never left: not attempted, not failed.
          failed.push(isRequestNotSent(err)
            ? { sessionId, code: NOT_ATTEMPTED_CODE, reason: notAttemptedReason }
            : { sessionId, code: REQUEST_FAILED_CODE, reason });
        }
        const notAttempted = chunks.slice(chunkIndex + 1).flat();
        for (const sessionId of notAttempted) {
          failed.push({ sessionId, code: NOT_ATTEMPTED_CODE, reason: notAttemptedReason });
        }
        return abortOrThrow(err);
      }

      // Scoped to this chunk's ids alone -- an independent request failing must not lose every
      // other chunk's result. The underlying error's message rides along as `reason`: a bare
      // "requestFailed" code with nothing else would tell a caller precisely nothing about why.
      // Each id is listed once: a token failure never sent the request (not attempted), a definite
      // rejection proves nothing was written (failed), anything else is ambiguous (uncertain).
      const reason = describeError(err);
      if (isRequestNotSent(err)) {
        for (const sessionId of idsChunk) failed.push({ sessionId, code: NOT_ATTEMPTED_CODE, reason });
      } else if (isDefiniteWriteRejection(err)) {
        for (const sessionId of idsChunk) failed.push({ sessionId, code: REQUEST_FAILED_CODE, reason });
      } else {
        uncertain.push(...idsChunk);
      }

      if (err instanceof ThrottledError) {
        const notAttempted = chunks.slice(chunkIndex + 1).flat();
        for (const sessionId of notAttempted) {
          failed.push({ sessionId, code: NOT_ATTEMPTED_CODE, reason: NOT_ATTEMPTED_THROTTLED_REASON });
        }
        break;
      }

      if (err instanceof OAuthError) {
        // pr-reviewer-3's finding: a non-invalid_grant token-provider failure (a 5xx or network
        // trouble from the token endpoint itself) propagates out of performRefresh as-is -- see
        // token-provider.ts's own comment -- since it doesn't invalidate the stored refresh token,
        // so it's genuinely not a session-wide AuthRequiredError/NotRegisteredError and shouldn't
        // abort the whole result. But it isn't scoped to just this chunk either: every later chunk
        // calls the identical token provider and is doomed to fail the identical way until whatever
        // is wrong with the token endpoint clears, so pacing through them one by one burns a real
        // wait for nothing (reviewer3's own measurement: 40 ids took over a minute, every chunk
        // after the first requestFailed). Same stop-early treatment as ThrottledError, but with the
        // real error message as the reason -- unlike the throttled case there's no single
        // well-known cause here, it could be anything from a 500 to a DNS failure.
        const notAttempted = chunks.slice(chunkIndex + 1).flat();
        for (const sessionId of notAttempted) {
          failed.push({ sessionId, code: NOT_ATTEMPTED_CODE, reason });
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
      ...(uncertain.length ? { uncertain } : {}),
      successful,
      alreadyFavorited,
      failed,
      verified: { favorited: verifiedFavorited },
      mismatch,
    };
  } catch (err) {
    // AuthRequiredError/NotRegisteredError get the same treatment here as in the write loop above
    // -- a session-wide problem, not something specific to the read-back, so it applies the same
    // "throw only when nothing was written" rule rather than either always throwing (losing real
    // writes) or always folding it into a verificationError (which implies the writes themselves
    // are still trustworthy and merely unconfirmed, not that the session itself was interrupted).
    // Every other read-back failure (network trouble, a 5xx) still returns the real write results
    // gathered above instead of losing them.
    if (err instanceof AuthRequiredError || err instanceof NotRegisteredError || err instanceof OperationUnavailableError) {
      return abortOrThrow(err);
    }
    return {
      ...(uncertain.length ? { uncertain } : {}),
      successful,
      alreadyFavorited,
      failed,
      verified: null,
      verificationError: describeError(err),
      mismatch: [],
    };
  }
}

export interface UnfavoriteSessionDeps extends WriteQuotaDeps {
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
 * 404: the API client retries this endpoint on 429/503 (see `api/client.ts`), so a DELETE
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
  await acquireWriteQuota("unfavorite", 1, deps);
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
