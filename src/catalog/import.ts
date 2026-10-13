import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../core/atomic-write.js";
import { ValidationError } from "../core/errors.js";
import { ensureDirWithMode, STORE_DIR_MODE } from "../core/paths.js";
import { resolveListSessionsPage, SessionItemSchema, type ListSessionsPage, type PageReadOptions } from "./import-page.js";
import { isRecognizedTimeZone } from "./store.js";

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
