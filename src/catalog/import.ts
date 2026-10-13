import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../core/atomic-write.js";
import { ValidationError } from "../core/errors.js";
import { ensureDirWithMode, STORE_DIR_MODE } from "../core/paths.js";
import type { Session } from "../api/types.js";
import { CatalogMissingError } from "../core/errors.js";
import { diffCatalogs, summarizeCatalogChanges, writeCatalogChanges, type CatalogChangeSummary, type StoredCatalogChanges } from "./diff.js";
import { resolveListSessionsPage, SessionItemSchema, type ListSessionsPage, type PageReadOptions } from "./import-page.js";
import { buildIndexRecord } from "./index-record.js";
import { CURRENT_SCHEMA_VERSION, DEFAULT_EVENT_ID, isRecognizedTimeZone, readMeta, readRaw, readTimezoneAvailability, writeCatalog, type CatalogMeta } from "./store.js";

const STAGING_DIR = ["catalog", "staging"] as const;
const FILE_MODE = 0o600;
const MANIFEST_NAME = "manifest.json";

/** A sync id becomes a directory name, so it is checked against this before it is ever joined into a path. */
export const SYNC_ID_PATTERN = /^[a-z0-9-]{8,64}$/;

export type ImportRejectReason = "overlap" | "alreadyComplete" | "nothingStaged" | "incomplete" | "empty" | "partial" | "shrunk";

/** An import that was refused and left the stored catalog untouched. `reason` is machine-readable. */
export class CatalogImportRejectedError extends ValidationError {
  constructor(readonly reason: ImportRejectReason, message: string) {
    super(message);
    this.name = "CatalogImportRejectedError";
  }
}

export interface ImportDeps {
  storeRoot: string;
  /** Replaces `writeCatalog`; tests use it to simulate a crash after `changes.json` is written. */
  writeCatalogFn?: typeof writeCatalog;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to `crypto.randomUUID`. */
  randomId?: () => string;
}

const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  syncId: z.string().regex(SYNC_ID_PATTERN),
  eventId: z.string().min(1).max(128),
  timezone: z.string().nullable(),
  createdAt: z.number(),
  pages: z.array(z.object({ number: z.number().int().positive(), count: z.number().int().nonnegative(), totalCount: z.number().int().nonnegative(), nextToken: z.string().nullable() })),
});
export type ImportManifest = z.infer<typeof ManifestSchema>;

export interface StagePageInput {
  /** Present only on the first page of a sync. */
  eventId?: string;
  /** Required on the first page: the event's IANA timezone, or `null` when GetEvent omitted it. */
  timezone?: string | null;
  /** Absent on the first page; required on every later one. */
  syncId?: string;
  path?: string;
  page?: unknown;
}
export interface StagePageResult {
  syncId: string;
  pageNumber: number;
  stagedCount: number;
  totalCount: number;
  nextToken?: string;
  complete: boolean;
  totalCountChanged?: true;
}

export function stagingRoot(storeRoot: string): string {
  return join(storeRoot, ...STAGING_DIR);
}
export function stagingDirFor(storeRoot: string, syncId: string): string {
  if (!SYNC_ID_PATTERN.test(syncId)) throw new ValidationError("syncId must be 8-64 characters of lowercase letters, digits and hyphens.");
  return join(stagingRoot(storeRoot), syncId);
}
const pageFileName = (number: number): string => `page-${String(number).padStart(4, "0")}.json`;

export function readManifest(storeRoot: string, syncId: string): ImportManifest {
  const dir = stagingDirFor(storeRoot, syncId);
  const unknown = new ValidationError("Unknown syncId: start a new sync with a first page.");
  try { if (!lstatSync(dir).isDirectory()) throw unknown; } catch { throw unknown; }
  let parsed;
  try { parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(join(dir, MANIFEST_NAME), "utf8"))); } catch { throw unknown; }
  if (!parsed.success || parsed.data.syncId !== syncId) throw unknown;
  return parsed.data;
}
const StagedPageSchema = z.array(SessionItemSchema);
export function readStagedPage(storeRoot: string, syncId: string, number: number): ListSessionsPage["items"] {
  // A corrupt staged file must not surface a parse error: Node quotes the text it choked on.
  const unreadable = new ValidationError("Staged pages for this sync are unreadable; start a new sync.");
  let parsed;
  try { parsed = StagedPageSchema.safeParse(JSON.parse(readFileSync(join(stagingDirFor(storeRoot, syncId), pageFileName(number)), "utf8"))); } catch { throw unreadable; }
  if (!parsed.success) throw unreadable;
  return parsed.data as ListSessionsPage["items"];
}

const STALE_STAGING_MS = 24 * 60 * 60 * 1000;

/** Removes abandoned syncs: those whose manifest `createdAt` (or, if the manifest is unreadable,
 * directory mtime) is more than 24 hours old. Only ever deletes `staging/<validated name>`, and
 * never follows or removes a symlink. */
export function pruneStaleStaging(deps: ImportDeps): void {
  const root = stagingRoot(deps.storeRoot);
  let names: string[];
  try {
    if (!lstatSync(root).isDirectory()) return;
    names = readdirSync(root);
  } catch { return; }
  const now = (deps.now ?? Date.now)();
  for (const name of names) {
    if (!SYNC_ID_PATTERN.test(name)) continue;
    const dir = join(root, name);
    try {
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      let createdAt = stat.mtimeMs;
      try {
        const manifest = ManifestSchema.safeParse(JSON.parse(readFileSync(join(dir, MANIFEST_NAME), "utf8")));
        if (manifest.success) createdAt = manifest.data.createdAt;
      } catch { /* unreadable manifest: fall back to the directory mtime */ }
      if (now - createdAt > STALE_STAGING_MS) rmSync(dir, { recursive: true, force: true });
    } catch { /* a concurrent removal or a permissions problem is not worth failing a sync for */ }
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, () => JSON.stringify(value), { mode: FILE_MODE });
}

function startManifest(input: StagePageInput, deps: ImportDeps): ImportManifest {
  if (input.eventId === undefined || input.eventId.length === 0 || input.eventId.length > 128) throw new ValidationError("The first page needs `eventId`.");
  if (input.timezone === undefined) throw new ValidationError("The first page needs `timezone`: the event's IANA timezone from GetEvent, or null when it has none.");
  if (input.timezone !== null && !isRecognizedTimeZone(input.timezone)) throw new ValidationError("`timezone` is not a recognized IANA timezone.");
  const syncId = (deps.randomId ?? randomUUID)();
  if (!SYNC_ID_PATTERN.test(syncId)) throw new ValidationError("Generated syncId is invalid.");
  return { schemaVersion: 1, syncId, eventId: input.eventId, timezone: input.timezone, createdAt: (deps.now ?? Date.now)(), pages: [] };
}

/** Validates one ListSessions page and stages it under a sync. The stored catalog is never touched. */
export function stageCatalogPage(input: StagePageInput, deps: ImportDeps, options: PageReadOptions = {}): StagePageResult {
  let manifest: ImportManifest;
  const isFirst = input.syncId === undefined;
  if (isFirst) {
    manifest = startManifest(input, deps);
  } else {
    if (input.eventId !== undefined) throw new ValidationError("`eventId` is only allowed on the first page.");
    if (input.timezone !== undefined) throw new ValidationError("`timezone` is only allowed on the first page.");
    manifest = readManifest(deps.storeRoot, input.syncId!);
  }
  const page = resolveListSessionsPage({ ...(input.path === undefined ? {} : { path: input.path }), ...(input.page === undefined ? {} : { page: input.page }) }, options);
  const last = manifest.pages.at(-1);
  if (last !== undefined && last.nextToken === null) {
    throw new CatalogImportRejectedError("alreadyComplete", "The previous page already ended the list; commit instead of staging more pages.");
  }
  const staged = new Set<string>();
  for (const entry of manifest.pages) for (const stagedItem of readStagedPage(deps.storeRoot, manifest.syncId, entry.number)) staged.add(stagedItem.sessionId);
  if (page.items.some(row => staged.has(row.sessionId))) {
    throw new CatalogImportRejectedError("overlap", "This page repeats sessions that are already staged; each page must be imported once.");
  }
  const number = manifest.pages.length + 1;
  const next: ImportManifest = { ...manifest, pages: [...manifest.pages, { number, count: page.items.length, totalCount: page.totalCount, nextToken: page.nextToken ?? null }] };
  if (isFirst) pruneStaleStaging(deps);
  const dir = stagingDirFor(deps.storeRoot, manifest.syncId);
  ensureDirWithMode(dir, STORE_DIR_MODE);
  writeJson(join(dir, pageFileName(number)), page.items);
  writeJson(join(dir, MANIFEST_NAME), next);
  return {
    syncId: manifest.syncId,
    pageNumber: number,
    stagedCount: next.pages.reduce((sum, entry) => sum + entry.count, 0),
    totalCount: page.totalCount,
    ...(page.nextToken === undefined ? {} : { nextToken: page.nextToken }),
    complete: page.nextToken === undefined,
    ...(last !== undefined && last.totalCount !== page.totalCount ? { totalCountChanged: true as const } : {}),
  };
}

/** The shrink guard: a pull below this fraction of the previous catalog is refused unless the user approves. */
const SHRINK_FLOOR = 0.9;

export interface CommitInput {
  syncId: string;
  /** Pass only after the user has seen both counts and said yes. */
  allowShrink?: boolean;
}
export interface CommitResult {
  committed: true;
  eventId: string;
  count: number;
  totalCount: number;
  syncedAt: number;
  firstImport?: true;
  replacedEventId?: string;
  warnings?: string[];
  summary?: CatalogChangeSummary;
}

function readStagedItems(manifest: ImportManifest, storeRoot: string): Session[] {
  return manifest.pages.flatMap(entry => readStagedPage(storeRoot, manifest.syncId, entry.number)) as Session[];
}

/** Turns a completed staged sync into the stored catalog, refusing anything that looks wrong first.
 * Every rejection leaves the stored catalog byte-identical (nothing is written before the last check). */
export function commitCatalogImport(input: CommitInput, deps: ImportDeps): CommitResult {
  const manifest = readManifest(deps.storeRoot, input.syncId);
  const last = manifest.pages.at(-1);
  if (last === undefined) throw new CatalogImportRejectedError("nothingStaged", "No pages are staged for this sync; stage the pages first.");
  if (last.nextToken !== null) throw new CatalogImportRejectedError("incomplete", "The last staged page still has a nextToken; stage the remaining pages before committing.");
  const items = readStagedItems(manifest, deps.storeRoot);
  if (items.length === 0) throw new CatalogImportRejectedError("empty", "The import contains no sessions; the existing local data was left unchanged.");
  const count = items.length;
  const warnings: string[] = [];
  if (count < last.totalCount) {
    throw new CatalogImportRejectedError("partial", `Only ${count} of ${last.totalCount} sessions were staged (a page is missing); the existing local data was left unchanged.`);
  }
  if (count > last.totalCount) warnings.push("catalog grew during the import");

  const previousMeta = readMeta(deps);
  const storedRaw = readRaw(deps);
  const eventMatches = previousMeta === null ? storedRaw !== null : previousMeta.eventId === manifest.eventId;
  // meta.json is unreadable but raw.json is not: the event is unknown, so the guard still applies
  // (skipping it would let a tiny pull overwrite a good catalog), counting the stored sessions.
  const previousCount = typeof previousMeta?.count === "number" ? previousMeta.count : storedRaw?.length ?? 0;
  if (eventMatches && previousCount > 0 && count < Math.floor(previousCount * SHRINK_FLOOR) && input.allowShrink !== true) {
    throw new CatalogImportRejectedError("shrunk", `The import has ${count} sessions, down from ${previousCount} (more than 10% fewer); the existing local data was left unchanged. Ask the user, then commit again with allowShrink.`);
  }
  const previousRaw = previousMeta === null ? null : storedRaw;
  const sameEvent = previousMeta !== null && previousMeta.eventId === manifest.eventId;

  const syncedAt = (deps.now ?? Date.now)();
  const includedAbstracts = items.some(session => typeof session.abstract === "string" && session.abstract.length > 0);
  const compareAbstracts = includedAbstracts && previousMeta?.includedAbstracts === true;
  const base = { schemaVersion: 1 as const, eventId: manifest.eventId, toSyncedAt: syncedAt };
  let stored: StoredCatalogChanges;
  let summary: CatalogChangeSummary | undefined;
  if (previousMeta === null || previousRaw === null) {
    stored = { ...base, fromSyncedAt: null, firstImport: true, counts: { added: 0, removed: 0, changed: 0, unchanged: 0 }, abstractsCompared: false, changes: [] };
  } else if (!sameEvent) {
    stored = { ...base, fromSyncedAt: previousMeta.syncedAt, replacedEventId: previousMeta.eventId, counts: { added: 0, removed: 0, changed: 0, unchanged: 0 }, abstractsCompared: false, changes: [] };
  } else {
    const diff = diffCatalogs(previousRaw, items, { compareAbstracts });
    stored = { ...base, fromSyncedAt: previousMeta.syncedAt, counts: diff.counts, abstractsCompared: diff.abstractsCompared, changes: diff.changes };
    summary = summarizeCatalogChanges(diff);
  }
  const meta: CatalogMeta = { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: manifest.eventId, syncedAt, totalCount: last.totalCount, count, includedAbstracts, timezone: manifest.timezone };
  // changes.json first: if the catalog write then fails, its toSyncedAt no longer matches the meta and the diff reads as superseded.
  writeCatalogChanges(stored, deps);
  (deps.writeCatalogFn ?? writeCatalog)({ raw: items, index: items.map(buildIndexRecord), meta }, deps);
  rmSync(stagingDirFor(deps.storeRoot, manifest.syncId), { recursive: true, force: true });
  pruneStaleStaging(deps);
  return {
    committed: true, eventId: manifest.eventId, count, totalCount: last.totalCount, syncedAt,
    ...(stored.firstImport ? { firstImport: true as const } : {}),
    ...(stored.replacedEventId === undefined ? {} : { replacedEventId: stored.replacedEventId }),
    ...(warnings.length === 0 ? {} : { warnings }),
    ...(summary === undefined ? {} : { summary }),
  };
}

export interface ReindexResult {
  reindexed: true;
  eventId: string;
  count: number;
  totalCount: number;
  timezone: string | null;
}

/** Rebuilds the index from the stored raw sessions without any AWS call: the remedy for a stale schema version. */
export function reindexCatalog(input: { timezone?: string | null }, deps: ImportDeps): ReindexResult {
  if (input.timezone !== undefined && input.timezone !== null && !isRecognizedTimeZone(input.timezone)) {
    throw new ValidationError("`timezone` is not a recognized IANA timezone.");
  }
  const raw = readRaw(deps);
  if (raw === null) throw new CatalogMissingError();
  const stored = readMeta(deps);
  const availability = readTimezoneAvailability(deps);
  let timezone: string | null;
  if (availability === null || (availability.status === "unavailable" && availability.reason === "syncedBeforeTimezoneSupport")) {
    // The stored meta never asked the API for a timezone, and a reindex must not guess one.
    if (input.timezone === undefined) throw new ValidationError("This catalog was imported before timezones were stored; call GetEvent and pass its `timezone` (or null when it has none).");
    timezone = input.timezone;
  } else {
    timezone = stored?.timezone ?? null;
  }
  const meta: CatalogMeta = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId: stored?.eventId ?? DEFAULT_EVENT_ID,
    syncedAt: stored?.syncedAt ?? (deps.now ?? Date.now)(),
    totalCount: typeof stored?.totalCount === "number" && Number.isFinite(stored.totalCount) ? stored.totalCount : raw.length,
    count: raw.length,
    includedAbstracts: stored?.includedAbstracts ?? raw.some(session => typeof session.abstract === "string" && session.abstract.length > 0),
    timezone,
  };
  (deps.writeCatalogFn ?? writeCatalog)({ raw, index: raw.map(buildIndexRecord), meta }, deps);
  return { reindexed: true, eventId: meta.eventId, count: meta.count, totalCount: meta.totalCount, timezone };
}

export interface ImportCommandInput {
  action: "page" | "commit" | "reindex";
  eventId?: string;
  timezone?: string | null;
  syncId?: string;
  path?: string;
  page?: unknown;
  allowShrink?: boolean;
}

function forbid(input: ImportCommandInput, label: string, keys: readonly (keyof ImportCommandInput)[]): void {
  for (const key of keys) {
    if (input[key] !== undefined) throw new ValidationError(`\`${key}\` is not allowed for ${label}.`);
  }
}

/** Dispatches one `catalog_import` call, enforcing which fields each action takes. */
export function importCatalog(input: ImportCommandInput, deps: ImportDeps, options: PageReadOptions = {}): StagePageResult | CommitResult | ReindexResult {
  switch (input.action) {
    case "page": {
      const first = input.syncId === undefined;
      forbid(input, first ? "the first page" : "a later page", first ? ["allowShrink"] : ["eventId", "timezone", "allowShrink"]);
      return stageCatalogPage({
        ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        ...(input.syncId === undefined ? {} : { syncId: input.syncId }),
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.page === undefined ? {} : { page: input.page }),
      }, deps, options);
    }
    case "commit":
      forbid(input, "commit", ["path", "page", "eventId", "timezone"]);
      if (input.syncId === undefined) throw new ValidationError("`commit` needs `syncId`.");
      return commitCatalogImport({ syncId: input.syncId, ...(input.allowShrink === undefined ? {} : { allowShrink: input.allowShrink }) }, deps);
    case "reindex":
      forbid(input, "reindex", ["syncId", "path", "page", "eventId", "allowShrink"]);
      return reindexCatalog(input.timezone === undefined ? {} : { timezone: input.timezone }, deps);
  }
}
