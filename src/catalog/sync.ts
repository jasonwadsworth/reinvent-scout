import type { ApiClient } from "../api/client.js";
import { buildIndexRecord } from "./index-record.js";
import {
  CURRENT_SCHEMA_VERSION,
  readMeta,
  readRaw,
  writeCatalog,
  type CatalogMeta,
  type CatalogStoreDeps,
} from "./store.js";

/** The event this CLI targets when nothing else is specified. The API is multi-event (Summits
 * appear in ListEvents today), so every command that takes an event id treats this as only a
 * default, never a hard-coded assumption -- see the lead's amendment in the plan. */
export const DEFAULT_EVENT_ID = "reinvent2026";

export interface SyncCatalogDeps extends CatalogStoreDeps {
  apiClient: ApiClient;
  /** Defaults to `DEFAULT_EVENT_ID`. */
  eventId?: string;
  /** Defaults to `true`: abstracts are the main text signal the matcher (part 2) uses. */
  includeAbstracts?: boolean;
  /**
   * Rebuilds the local index from the already-stored raw sessions instead of pulling from the
   * API again -- for picking up an index-shape change (a bumped `CURRENT_SCHEMA_VERSION`)
   * without waiting on a fresh pull. Requires a previous sync's raw data to be on disk; falls
   * back to a normal full sync when there is none, since there is nothing to reindex from.
   */
  reindex?: boolean;
  /** Stamped as the new meta's `syncedAt` on a full sync. Defaults to `Date.now`. Irrelevant to
   * a reindex, which preserves the previous sync's `syncedAt` unchanged (a reindex never talks
   * to the API, so nothing was newly "synced"). */
  now?: () => number;
}

export interface SyncResult {
  eventId: string;
  /** The `totalCount` treated as authoritative: the API's reported value when it was a usable
   * finite number, otherwise the count actually stored (see `totalCountMissing`). On a reindex,
   * this is copied from the previous sync, since a reindex never contacts the API. */
  totalCount: number;
  /** The number of sessions actually stored. */
  count: number;
  /** `true` when `count` doesn't match `totalCount` -- a partial pull, or the catalog changing
   * mid-sync. Always `false` when `totalCountMissing` is `true`, since there is nothing real to
   * compare `count` against in that case. The caller (the CLI) decides what to tell the user;
   * `syncCatalog` itself never writes to any stream, since part 3's MCP server can't have
   * anything land on stdout outside the protocol. */
  countMismatch: boolean;
  /** `true` when the API's response never carried a usable `totalCount` at all (missing, or not
   * a finite number) -- despite `ListAllSessionsResult.totalCount`'s type declaring it required,
   * runtime success responses are deliberately not validated (task 10's decision), so this can
   * genuinely happen. This is a more serious signal than `countMismatch`: the mismatch check
   * itself can't run without a real total to compare against, so conflating the two would
   * misdiagnose "the canary didn't fire" as "a partial pull". */
  totalCountMissing: boolean;
  /** `true` when this call rebuilt the index from stored raw data without contacting the API
   * (either because `reindex` was requested and there was data to reindex from). */
  reindexed: boolean;
}

/** Resolves a reported `totalCount` to a value safe to persist in `CatalogMeta`'s typed field --
 * `undefined` is not valid JSON (`JSON.stringify` would silently drop the key), and a `NaN` or
 * `Infinity` would compare unpredictably against `count` forever after. Anything that isn't a
 * finite number is treated as "not reported": `fallbackCount` (the count actually available) is
 * the best approximation of the total when the real one is unknown, and `totalCountMissing: true`
 * flags that this fallback happened, distinctly from a genuine mismatch. */
function resolveTotalCount(
  reported: number | undefined,
  fallbackCount: number,
): { totalCount: number; totalCountMissing: boolean } {
  if (typeof reported === "number" && Number.isFinite(reported)) {
    return { totalCount: reported, totalCountMissing: false };
  }
  return { totalCount: fallbackCount, totalCountMissing: true };
}

function toSyncResult(meta: CatalogMeta, reindexed: boolean, totalCountMissing: boolean): SyncResult {
  return {
    eventId: meta.eventId,
    totalCount: meta.totalCount,
    count: meta.count,
    countMismatch: meta.count !== meta.totalCount,
    totalCountMissing,
    reindexed,
  };
}

/** Rebuilds the index from whatever raw sessions are already on disk, preserving every other
 * fact in the previous meta (nothing here talks to the API, so nothing else changed). Returns
 * null when there is no raw data to reindex from. */
function tryReindexFromStoredRaw(deps: SyncCatalogDeps): SyncResult | null {
  const storedRaw = readRaw(deps);
  if (storedRaw === null) {
    return null;
  }

  const storedMeta = readMeta(deps);
  const index = storedRaw.map(buildIndexRecord);
  const { totalCount, totalCountMissing } = resolveTotalCount(storedMeta?.totalCount, storedRaw.length);
  const meta: CatalogMeta = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId: storedMeta?.eventId ?? deps.eventId ?? DEFAULT_EVENT_ID,
    syncedAt: storedMeta?.syncedAt ?? (deps.now ?? Date.now)(),
    totalCount,
    count: storedRaw.length,
    includedAbstracts: storedMeta?.includedAbstracts ?? (deps.includeAbstracts ?? true),
    // A reindex never contacts the API, so the timezone can only come from whatever the previous
    // sync already stored -- `null` when there was none, same as `timezone` being absent from a
    // pre-schema-5 meta (readMeta casts blindly; `?? null` treats both the same way).
    timezone: storedMeta?.timezone ?? null,
  };

  writeCatalog({ raw: storedRaw, index, meta }, deps);
  return toSyncResult(meta, true, totalCountMissing);
}

/**
 * Pulls the full session catalog, builds the local index, and persists both alongside sync
 * metadata -- or, with `reindex: true` and a previous sync's raw data on disk, rebuilds only the
 * index from the already-stored sessions without contacting the API at all.
 *
 * Nothing is written until every page of a full pull has been received: `apiClient.listAllSessions`
 * either resolves with the complete list or rejects (a mid-pagination failure, `NotRegisteredError`,
 * exhausting the 429/503 retries), and `writeCatalog` is only ever called after it resolves. So a
 * pull that fails partway leaves the previously-stored catalog completely untouched -- this
 * function never starts a write on an incomplete pull, which is a stronger guarantee than
 * `writeCatalog`'s own write-ordering (meta written last protects a crash *during* a write that
 * has already started; this is about never starting one on bad input in the first place).
 *
 * Errors from `apiClient` propagate unchanged (never caught or rewrapped here) so the CLI layer
 * can give the user a specific, accurate explanation for each one.
 */
export async function syncCatalog(deps: SyncCatalogDeps): Promise<SyncResult> {
  const eventId = deps.eventId ?? DEFAULT_EVENT_ID;
  const includeAbstracts = deps.includeAbstracts ?? true;
  const now = deps.now ?? Date.now;

  if (deps.reindex) {
    const reindexResult = tryReindexFromStoredRaw({ ...deps, eventId, includeAbstracts });
    if (reindexResult !== null) {
      return reindexResult;
    }
    // No stored raw data to reindex from -- fall through to a normal full sync below. This is a
    // defensible judgment call, not specified by the plan: erroring here would need a
    // CatalogMissingError-shaped type, which doesn't exist until task 16, and doing a full sync
    // instead is strictly more useful to the user than refusing.
  }

  // Both calls are independent reads of the same event, so they run concurrently; either
  // rejecting propagates unchanged (same as a listAllSessions-only failure did before this event
  // fetch existed) and writeCatalog below is never reached, leaving the previous catalog
  // untouched -- consistent with the rest of this function never starting a write on bad input.
  const [{ sessions, totalCount: reportedTotalCount }, event] = await Promise.all([
    deps.apiClient.listAllSessions(eventId, { includeAbstracts }),
    deps.apiClient.getEvent(eventId),
  ]);
  const index = sessions.map(buildIndexRecord);
  const { totalCount, totalCountMissing } = resolveTotalCount(reportedTotalCount, sessions.length);
  const meta: CatalogMeta = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId,
    syncedAt: now(),
    totalCount,
    count: sessions.length,
    includedAbstracts: includeAbstracts,
    // `event.timezone` is `undefined` when the API response omits it (not required by the
    // schema); normalized to `null` here since `undefined` is not valid JSON -- JSON.stringify
    // would silently drop the key, and a caller reading it back could not tell "the field is
    // absent because this meta predates the timezone feature" from "the event genuinely has
    // none". Never falls back to the host machine's timezone or a hardcoded zone.
    timezone: event.timezone ?? null,
  };

  writeCatalog({ raw: sessions, index, meta }, deps);

  return toSyncResult(meta, false, totalCountMissing);
}
