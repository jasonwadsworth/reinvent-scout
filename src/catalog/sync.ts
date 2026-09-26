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
  /** The `totalCount` the API reported for the whole catalog. On a reindex, this is copied
   * unchanged from the previous sync, since a reindex never contacts the API. */
  totalCount: number;
  /** The number of sessions actually stored. */
  count: number;
  /** `true` when `count` doesn't match `totalCount` -- a partial pull, or the catalog changing
   * mid-sync. The caller (the CLI) decides what to tell the user; `syncCatalog` itself never
   * writes to any stream, since part 3's MCP server can't have anything land on stdout outside
   * the protocol. */
  countMismatch: boolean;
  /** `true` when this call rebuilt the index from stored raw data without contacting the API
   * (either because `reindex` was requested and there was data to reindex from). */
  reindexed: boolean;
}

function toSyncResult(meta: CatalogMeta, reindexed: boolean): SyncResult {
  return {
    eventId: meta.eventId,
    totalCount: meta.totalCount,
    count: meta.count,
    countMismatch: meta.count !== meta.totalCount,
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
  const meta: CatalogMeta = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId: storedMeta?.eventId ?? deps.eventId ?? DEFAULT_EVENT_ID,
    syncedAt: storedMeta?.syncedAt ?? (deps.now ?? Date.now)(),
    totalCount: storedMeta?.totalCount ?? storedRaw.length,
    count: storedRaw.length,
    includedAbstracts: storedMeta?.includedAbstracts ?? (deps.includeAbstracts ?? true),
  };

  writeCatalog({ raw: storedRaw, index, meta }, deps);
  return toSyncResult(meta, true);
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

  const { sessions, totalCount } = await deps.apiClient.listAllSessions(eventId, { includeAbstracts });
  const index = sessions.map(buildIndexRecord);
  const meta: CatalogMeta = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId,
    syncedAt: now(),
    totalCount,
    count: sessions.length,
    includedAbstracts: includeAbstracts,
  };

  writeCatalog({ raw: sessions, index, meta }, deps);

  return toSyncResult(meta, false);
}
