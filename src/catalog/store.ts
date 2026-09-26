import { existsSync, readFileSync } from "node:fs";
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

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export interface CatalogData {
  raw: Session[];
  index: IndexRecord[];
  meta: CatalogMeta;
}

/** Persists raw sessions, the derived index, and sync metadata, creating the catalog directory
 * (and the store root above it) at 0700 if needed. */
export function writeCatalog(data: CatalogData, deps: CatalogStoreDeps): void {
  ensureDirWithMode(catalogDir(deps.storeRoot), STORE_DIR_MODE);
  writeFileAtomic(rawPath(deps.storeRoot), () => JSON.stringify(data.raw), { mode: FILE_MODE });
  writeFileAtomic(indexPath(deps.storeRoot), () => JSON.stringify(data.index), { mode: FILE_MODE });
  writeFileAtomic(metaPath(deps.storeRoot), () => JSON.stringify(data.meta), { mode: FILE_MODE });
}

/** Reads the stored raw sessions, or null when nothing has been synced. */
export function readRaw(deps: CatalogStoreDeps): Session[] | null {
  return readJsonFile<Session[]>(rawPath(deps.storeRoot));
}

/** Reads the stored derived index, or null when nothing has been synced. */
export function readIndex(deps: CatalogStoreDeps): IndexRecord[] | null {
  return readJsonFile<IndexRecord[]>(indexPath(deps.storeRoot));
}

/** Reads the stored sync metadata, or null when nothing has been synced. */
export function readMeta(deps: CatalogStoreDeps): CatalogMeta | null {
  return readJsonFile<CatalogMeta>(metaPath(deps.storeRoot));
}

export type CatalogState =
  | { status: "missing" }
  | { status: "stale"; reason: "schema-version" | "age"; meta: CatalogMeta }
  | { status: "fresh"; meta: CatalogMeta };

/**
 * Reports whether the stored catalog is missing, stale, or fresh -- without reading the
 * (potentially large) raw or index files themselves. A schema-version mismatch is checked
 * before age, since an old-shaped index needs rebuilding regardless of how recently it synced.
 */
export function getCatalogState(deps: CatalogStoreDeps & ClockDeps): CatalogState {
  const meta = readMeta(deps);
  if (meta === null) {
    return { status: "missing" };
  }

  if (meta.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    return { status: "stale", reason: "schema-version", meta };
  }

  const now = deps.now ?? Date.now;
  if (now() - meta.syncedAt > STALE_AFTER_MS) {
    return { status: "stale", reason: "age", meta };
  }

  return { status: "fresh", meta };
}
