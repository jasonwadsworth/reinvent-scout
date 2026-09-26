import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../api/types.js";
import { ensureDirWithMode, STORE_DIR_MODE } from "../core/paths.js";
import { writeFileAtomic } from "../core/atomic-write.js";
import type { IndexRecord } from "./index-record.js";

const CATALOG_DIR_NAME = "catalog";
const RAW_FILE_NAME = "raw.json";
const INDEX_FILE_NAME = "index.json";
const META_FILE_NAME = "meta.json";
const FILE_MODE = 0o600;

/** Bumped whenever the on-disk `IndexRecord` shape changes incompatibly; a stored catalog at an
 * older version is reported stale so `catalog sync --reindex`-equivalent logic (task 15) can
 * rebuild the index from the stored raw data without a new API pull. */
export const CURRENT_SCHEMA_VERSION = 1;

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface CatalogMeta {
  schemaVersion: number;
  eventId: string;
  /** Epoch milliseconds. */
  syncedAt: number;
  /** The `totalCount` the API reported for the whole catalog, not just what was stored. */
  totalCount: number;
  /** The number of sessions actually stored -- compare against `totalCount` to detect a
   * partial pull. */
  count: number;
  includedAbstracts: boolean;
}

export interface CatalogStoreDeps {
  storeRoot: string;
}

export interface ClockDeps {
  /** Defaults to `Date.now`. Inject a stub for deterministic staleness tests. */
  now?: () => number;
}

function catalogDir(storeRoot: string): string {
  return join(storeRoot, CATALOG_DIR_NAME);
}

function rawPath(storeRoot: string): string {
  return join(catalogDir(storeRoot), RAW_FILE_NAME);
}

function indexPath(storeRoot: string): string {
  return join(catalogDir(storeRoot), INDEX_FILE_NAME);
}

function metaPath(storeRoot: string): string {
  return join(catalogDir(storeRoot), META_FILE_NAME);
}

type JsonFileState<T> =
  | { status: "absent" }
  | { status: "corrupt" }
  | { status: "present"; value: T };

/**
 * Reads and parses a JSON file, never throwing: a missing file is "absent", and anything else
 * that keeps this from producing a usable value -- invalid JSON, the path being a directory
 * instead of a file, a permissions error, or any other read failure -- is "corrupt". Deliberately
 * reads the file directly rather than checking `existsSync` first: that check-then-read pattern
 * has a race, and does nothing for a path that exists but isn't a readable file (a directory left
 * at a file's path throws `EISDIR` on read regardless of whether it "exists").
 *
 * "absent" and "corrupt" are kept distinct (rather than both collapsing to `null`) because
 * `getCatalogState` needs to tell them apart for `meta.json` specifically: "nothing has ever been
 * synced" and "something was synced but can't be read" are different situations for a user to be
 * told about, even though `readRaw`/`readIndex`/`readMeta` below don't need the distinction and
 * fold both into `null`.
 */
function readJsonFile<T>(path: string): JsonFileState<T> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "absent" };
    }
    return { status: "corrupt" };
  }

  try {
    return { status: "present", value: JSON.parse(raw) as T };
  } catch {
    return { status: "corrupt" };
  }
}

function readJsonFileOrNull<T>(path: string): T | null {
  const state = readJsonFile<T>(path);
  return state.status === "present" ? state.value : null;
}

export interface CatalogData {
  raw: Session[];
  index: IndexRecord[];
  meta: CatalogMeta;
}

/** Persists raw sessions, the derived index, and sync metadata, creating the catalog directory
 * (and the store root above it) at 0700 if needed. Meta is written last, deliberately: it is the
 * one file `getCatalogState` reads to decide freshness, so this ordering guarantees a reader
 * never sees a *new* meta describing raw/index data that only partially landed -- if the process
 * is interrupted before meta lands, the reader still sees the previous meta. That previous meta
 * can by then be describing a mix of old and new raw/index data (if raw and/or index were
 * already replaced before the interruption), which is a real inconsistency, not a hypothetical
 * one -- but it is a safe one: the previous meta's `syncedAt` is unchanged, so it is exactly as
 * stale as it was before this sync started and `getCatalogState` reports it accordingly, driving
 * a re-sync that overwrites all three files again. */
export function writeCatalog(data: CatalogData, deps: CatalogStoreDeps): void {
  ensureDirWithMode(catalogDir(deps.storeRoot), STORE_DIR_MODE);
  writeFileAtomic(rawPath(deps.storeRoot), () => JSON.stringify(data.raw), { mode: FILE_MODE });
  writeFileAtomic(indexPath(deps.storeRoot), () => JSON.stringify(data.index), { mode: FILE_MODE });
  writeFileAtomic(metaPath(deps.storeRoot), () => JSON.stringify(data.meta), { mode: FILE_MODE });
}

/** Reads the stored raw sessions, or null when nothing has been synced (or it can't be read). */
export function readRaw(deps: CatalogStoreDeps): Session[] | null {
  return readJsonFileOrNull<Session[]>(rawPath(deps.storeRoot));
}

/** Reads the stored derived index, or null when nothing has been synced (or it can't be read). */
export function readIndex(deps: CatalogStoreDeps): IndexRecord[] | null {
  return readJsonFileOrNull<IndexRecord[]>(indexPath(deps.storeRoot));
}

/** Reads the stored sync metadata, or null when nothing has been synced (or it can't be read). */
export function readMeta(deps: CatalogStoreDeps): CatalogMeta | null {
  return readJsonFileOrNull<CatalogMeta>(metaPath(deps.storeRoot));
}

export type CatalogState =
  | { status: "missing" }
  | { status: "stale"; reason: "schema-version" | "age"; meta: CatalogMeta }
  // No `meta` here: the whole point of this branch is that meta.json couldn't be read as a
  // valid object, so there is nothing to attach.
  | { status: "stale"; reason: "corrupt" }
  | { status: "fresh"; meta: CatalogMeta };

/**
 * Reports whether the stored catalog is missing, stale, or fresh -- without reading the
 * (potentially large) raw or index files themselves. A schema-version mismatch is checked
 * before age, since an old-shaped index needs rebuilding regardless of how recently it synced.
 *
 * A meta.json that exists but can't be read (invalid JSON, a directory in its place, a
 * permissions error) is reported as "stale"/"corrupt" rather than "missing": something *was*
 * synced, and the caller should say so and prompt a re-sync, rather than silently treating it the
 * same as nothing having been synced at all. "corrupt" is folded into "stale" rather than given
 * its own top-level status because every caller's response to it is identical to every other
 * stale reason: sync again.
 */
export function getCatalogState(deps: CatalogStoreDeps & ClockDeps): CatalogState {
  const metaState = readJsonFile<CatalogMeta>(metaPath(deps.storeRoot));
  if (metaState.status === "absent") {
    return { status: "missing" };
  }
  if (metaState.status === "corrupt") {
    return { status: "stale", reason: "corrupt" };
  }
  const meta = metaState.value;

  if (meta.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    return { status: "stale", reason: "schema-version", meta };
  }

  const now = deps.now ?? Date.now;
  if (now() - meta.syncedAt > STALE_AFTER_MS) {
    return { status: "stale", reason: "age", meta };
  }

  return { status: "fresh", meta };
}
