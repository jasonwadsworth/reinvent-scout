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
 * rebuild the index from the stored raw data without a new API pull.
 *
 * Bumped 1 -> 2: `titleTerms`/`bodyTerms` built before this version can hold a poisoned entry for
 * any term that collides with an `Object.prototype` member (`constructor`, `hasOwnProperty`,
 * ...), from tokenizing into a plain object literal instead of one with a null prototype. The
 * read-side fix (`query.ts`'s `Object.hasOwn` guard) handles a poisoned map safely, but a stale
 * index still round-trips whatever bad value was written for that term the last time it synced;
 * this bump forces every existing index to rebuild from raw data with the fixed tokenizer rather
 * than carrying that forward indefinitely.
 *
 * Bumped 2 -> 3: `index-record.ts`'s `tokenize` changed what it puts in `titleTerms`/`bodyTerms` --
 * it now strips a trailing possessive `'s`/`'s` before splitting into words (so "agent's" no
 * longer also produces a stray one-letter "s" term) and drops any resulting token shorter than
 * three characters unless the source text wrote it as an all-caps acronym ("S3", "ML"). A stale
 * index built before this version still carries the old fragment terms; this bump forces a
 * rebuild so `match`'s text-overlap reasons stop citing them as evidence.
 *
 * Bumped 3 -> 4: `tokenize` now also strips English contraction suffixes (`n't`, `'ll`, `'re`,
 * `'ve`, `'d`, `'m`) before splitting into words. Without this, an un-stripped `n't` often leaves
 * behind a word long enough to survive the short-token filter on its own -- "don't" left "don",
 * measured at document frequency 68 in the real catalog, an idf nearly identical to "dynamodb"'s --
 * so a stale index built before this version still carries those fragments as real-looking terms
 * for `match` to cite as evidence.
 *
 * Bumped 4 -> 5: `CatalogMeta` gained `timezone`, the event's IANA timezone (or `null` when the
 * API response omits it), fetched from `GetEvent` and stored at sync time. `get_schedule` needs
 * it to convert each session's local wall-clock start time into a real UTC instant (`startsAt`)
 * so sessions and personal-time blocks -- which are already UTC -- sort correctly against each
 * other across a day boundary; without it there is no way to tell a resolved session's local time
 * apart from one synced before this field existed, and both would otherwise read as
 * `timezone: undefined`, which `tools.ts` cannot distinguish from "the API told us the event has
 * no timezone" (`null`). Forcing a re-sync keeps that distinction meaningful: a catalog synced
 * before this version has literally never asked the API for the timezone, so it must not be
 * treated the same as one that asked and got told there isn't one. */
export const CURRENT_SCHEMA_VERSION = 5;

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
  /** The event's IANA timezone (e.g. `"America/Los_Angeles"`), fetched from `GetEvent` at sync
   * time. `null` when the API response omitted it -- the field is not required by the API, and
   * callers must not fall back to the host machine's timezone or a hardcoded offset when it is
   * absent. */
  timezone: string | null;
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

export type TimezoneAvailability =
  | { status: "known"; timezone: string }
  | {
      status: "unavailable";
      /** `omittedByApi`: `GetEvent`'s response genuinely didn't report one -- syncing again
       * cannot fix this. `syncedBeforeTimezoneSupport`: this catalog was synced before the
       * `timezone` field existed at all, so the API was never even asked -- one more
       * `catalog_sync` will very likely resolve it. Callers must give these two different advice;
       * conflating them tells a user "nothing can be done" in a case a sync would fix. */
      reason: "omittedByApi" | "syncedBeforeTimezoneSupport";
    }
  | {
      /** The stored `timezone` is present and non-null, but isn't a string `Intl.DateTimeFormat`
       * accepts as a timezone -- the wrong JSON type, or a string that just isn't a recognized
       * IANA identifier. `sync.ts` stores whatever `GetEvent` returns verbatim, with no
       * validation on write (so `meta.json` stays a faithful record of the API's actual
       * response), so this can genuinely happen if the API ever reports something Node's bundled
       * ICU data doesn't recognize. `value` is the raw stored value, for a caller to report back
       * (a caller must never hand it to `Intl` or any date/time API directly -- that's exactly
       * what already broke before this state existed). */
      status: "unrecognized";
      value: unknown;
    };

/** Whether `Intl.DateTimeFormat` accepts `value` as a `timeZone` -- the only reliable way to
 * validate an IANA identifier without hand-maintaining the tz database. Never throws itself:
 * `Intl.DateTimeFormat` throws `RangeError` for a value it can't resolve to a known zone, which
 * this reports as `false` rather than letting propagate.
 *
 * The explicit `typeof value === "string"` check matters on its own, not just as a defensive
 * extra: `Intl`'s own `timeZone` option is coerced via `ToString` before validation, so some
 * non-string values make the constructor call itself succeed without throwing -- a single-element
 * array (`["America/Los_Angeles"].toString()` joins to just the element) or a boxed `String`
 * object both pass straight through a bare try/catch around the construction alone. Checking the
 * *original* value's type, not the coerced string, is what catches both. Exported so this can be
 * unit-tested directly against cases (like a boxed `String`) that can never actually reach
 * `readTimezoneAvailability` in practice, since `JSON.parse` -- the only way a value gets into
 * `meta.json` in the first place -- never produces a boxed wrapper object, only plain primitives. */
export function isRecognizedTimeZone(value: unknown): value is string {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value as string });
    return typeof value === "string" && value.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * Reads the event's timezone availability, distinguishing an explicit `null` (the API's response
 * omitted `timezone`) from a catalog synced before this field existed at all, and from a stored
 * value that isn't actually usable as a timezone. `readMeta`'s cast is not runtime-validated, so a
 * pre-schema-5 `meta.json` -- which genuinely has no `timezone` key on disk, despite
 * `CatalogMeta`'s type promising `string | null` -- reads back as `undefined` there,
 * indistinguishable from an explicit `null` under `??`, and any other stored JSON value reads back
 * exactly as stored, despite the type promising only `string | null`. This reads the raw stored
 * object and checks the key's presence with `Object.hasOwn` instead of branching on falsiness (the
 * only way to tell a missing key apart from an explicit `null`), and validates a present value
 * against `Intl` before ever calling it `known` (the only way to keep a caller from handing an
 * unusable value straight to a date/time API and failing the whole tool over it). Returns `null`
 * when nothing has been synced (same as `readMeta`).
 */
export function readTimezoneAvailability(deps: CatalogStoreDeps): TimezoneAvailability | null {
  const raw = readJsonFileOrNull<Record<string, unknown>>(metaPath(deps.storeRoot));
  if (raw === null) {
    return null;
  }
  if (!Object.hasOwn(raw, "timezone")) {
    return { status: "unavailable", reason: "syncedBeforeTimezoneSupport" };
  }
  const timezone = raw.timezone;
  if (timezone === null) {
    return { status: "unavailable", reason: "omittedByApi" };
  }
  if (!isRecognizedTimeZone(timezone)) {
    return { status: "unrecognized", value: timezone };
  }
  return { status: "known", timezone };
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
