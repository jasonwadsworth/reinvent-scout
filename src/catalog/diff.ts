import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Session } from "../api/types.js";
import { writeFileAtomic } from "../core/atomic-write.js";
import { ensureDirWithMode, STORE_DIR_MODE } from "../core/paths.js";
import { catalogDir, readMeta, type CatalogStoreDeps } from "./store.js";
import { OUTPUT_BUDGET_BYTES, outputBytes, shortenDescription } from "../commands/output-budget.js";

/** Fields that change all the time and say nothing about the catalog itself. */
export const VOLATILE_FIELDS: readonly string[] = ["seatAvailability"];
/** A change to any of these moves the user's day, so it sorts first among changes. */
const SCHEDULE_FIELDS: readonly string[] = ["sessionTime", "venue", "room"];

export type CatalogChangeKind = "added" | "removed" | "changed";
export interface CatalogChange {
  kind: CatalogChangeKind;
  sessionId: string;
  code: string | null;
  title: string;
  fields?: string[] | undefined;
}
export interface CatalogDiff {
  counts: { added: number; removed: number; changed: number; unchanged: number };
  abstractsCompared: boolean;
  changes: CatalogChange[];
}
export interface DiffOptions {
  /** True only when both pulls included abstracts; otherwise an abstract difference is not a change. */
  compareAbstracts: boolean;
}

/** JSON with sorted keys, and string arrays sorted, so ordering never counts as a change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.every(entry => typeof entry === "string") ? [...value].sort() : value;
    return `[${items.map(canonical).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter(key => record[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function changedFields(prev: Session, next: Session, options: DiffOptions): string[] {
  const a = prev as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const fields: string[] = [];
  for (const key of [...keys].sort()) {
    if (VOLATILE_FIELDS.includes(key)) continue;
    if (key === "abstract" && !options.compareAbstracts) continue;
    if (canonical(a[key]) !== canonical(b[key])) fields.push(key);
  }
  return fields;
}

const rowOf = (kind: CatalogChangeKind, session: Session, fields?: string[]): CatalogChange => ({
  kind, sessionId: session.sessionId, code: session.abbreviation ?? null, title: session.title, ...(fields === undefined ? {} : { fields }),
});

function rank(change: CatalogChange): number {
  if (change.kind === "removed") return 0;
  if (change.kind === "changed" && change.fields!.some(field => SCHEDULE_FIELDS.includes(field))) return 1;
  if (change.kind === "added") return 2;
  return 3;
}

/** Compares two pulls of the catalog. Most actionable first: removed, schedule changes, added, other changes. */
export function diffCatalogs(prev: readonly Session[], next: readonly Session[], options: DiffOptions): CatalogDiff {
  const before = new Map(prev.map(session => [session.sessionId, session]));
  const after = new Map(next.map(session => [session.sessionId, session]));
  const changes: CatalogChange[] = [];
  let unchanged = 0;
  for (const [id, session] of before) if (!after.has(id)) changes.push(rowOf("removed", session));
  for (const [id, session] of after) {
    const old = before.get(id);
    if (old === undefined) { changes.push(rowOf("added", session)); continue; }
    const fields = changedFields(old, session, options);
    if (fields.length === 0) unchanged++;
    else changes.push(rowOf("changed", session, fields));
  }
  changes.sort((x, y) => rank(x) - rank(y) || (x.code ?? "").localeCompare(y.code ?? "", "en") || x.sessionId.localeCompare(y.sessionId, "en"));
  return {
    counts: {
      added: changes.filter(change => change.kind === "added").length,
      removed: changes.filter(change => change.kind === "removed").length,
      changed: changes.filter(change => change.kind === "changed").length,
      unchanged,
    },
    abstractsCompared: options.compareAbstracts,
    changes,
  };
}

const MAX_HIGHLIGHTS = 20;
const MAX_HIGHLIGHT_TITLE = 100;
export interface CatalogChangeSummary {
  counts: CatalogDiff["counts"];
  abstractsCompared: boolean;
  highlights: CatalogChange[];
  omitted: number;
}

/** The part of a diff that is safe to put in a command's output: counts, up to 20 rows, the rest counted. */
export function summarizeCatalogChanges(diff: CatalogDiff): CatalogChangeSummary {
  const highlights = diff.changes.slice(0, MAX_HIGHLIGHTS).map(change => ({ ...change, title: shortenDescription(change.title, MAX_HIGHLIGHT_TITLE) }));
  const summary: CatalogChangeSummary = { counts: diff.counts, abstractsCompared: diff.abstractsCompared, highlights, omitted: diff.changes.length - highlights.length };
  while (outputBytes(summary) > OUTPUT_BUDGET_BYTES && summary.highlights.length > 0) {
    summary.highlights.pop();
    summary.omitted++;
  }
  return summary;
}

const CHANGES_FILE = "changes.json";
const ChangeSchema = z.object({
  kind: z.enum(["added", "removed", "changed"]),
  sessionId: z.string(),
  code: z.string().nullable(),
  title: z.string(),
  fields: z.array(z.string()).optional(),
});
const StoredChangesSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string(),
  fromSyncedAt: z.number().nullable(),
  toSyncedAt: z.number(),
  firstImport: z.literal(true).optional(),
  replacedEventId: z.string().optional(),
  counts: z.object({ added: z.number(), removed: z.number(), changed: z.number(), unchanged: z.number() }),
  abstractsCompared: z.boolean(),
  changes: z.array(ChangeSchema),
});
/** The full diff of the last import, kept beside the catalog (the command output only carries a summary). */
export type StoredCatalogChanges = z.infer<typeof StoredChangesSchema>;
export type CatalogChangesUnavailable = "noImport" | "firstImport" | "eventReplaced" | "superseded";

export function writeCatalogChanges(stored: StoredCatalogChanges, deps: CatalogStoreDeps): void {
  ensureDirWithMode(catalogDir(deps.storeRoot), STORE_DIR_MODE);
  writeFileAtomic(join(catalogDir(deps.storeRoot), CHANGES_FILE), () => JSON.stringify(stored), { mode: 0o600 });
}

function readStoredChanges(deps: CatalogStoreDeps): { stored: StoredCatalogChanges; matchesCatalog: boolean } | null {
  let parsed;
  try { parsed = StoredChangesSchema.safeParse(JSON.parse(readFileSync(join(catalogDir(deps.storeRoot), CHANGES_FILE), "utf8"))); }
  catch { return null; }
  if (!parsed.success) return null;
  const meta = readMeta(deps);
  return { stored: parsed.data, matchesCatalog: meta !== null && meta.syncedAt === parsed.data.toSyncedAt };
}

/** Reads the last import's diff. It is only valid while it describes the stored catalog: if its
 * `toSyncedAt` no longer matches the meta (a crash between the two writes, or a later sync), it is superseded. */
export function readCatalogChanges(deps: CatalogStoreDeps): ({ available: true } & StoredCatalogChanges) | { available: false; reason: CatalogChangesUnavailable } {
  const read = readStoredChanges(deps);
  if (read === null) return { available: false, reason: "noImport" };
  if (!read.matchesCatalog) return { available: false, reason: "superseded" };
  if (read.stored.firstImport) return { available: false, reason: "firstImport" };
  if (read.stored.replacedEventId !== undefined) return { available: false, reason: "eventReplaced" };
  return { available: true, ...read.stored };
}

export interface LastImport {
  toSyncedAt: number;
  counts: CatalogDiff["counts"];
  firstImport?: true;
  replacedEventId?: string;
}
/** A short account of the last import, only while it still describes the stored catalog. */
export function readLastImport(deps: CatalogStoreDeps): LastImport | null {
  const read = readStoredChanges(deps);
  if (read === null || !read.matchesCatalog) return null;
  return { toSyncedAt: read.stored.toSyncedAt, counts: read.stored.counts, ...(read.stored.firstImport ? { firstImport: true as const } : {}), ...(read.stored.replacedEventId === undefined ? {} : { replacedEventId: read.stored.replacedEventId }) };
}

const DEFAULT_CHANGES_LIMIT = 25;
const CHANGE_TITLE_MAX = 200;
export interface ChangesQuery {
  sessionIds?: readonly string[];
  kinds?: readonly CatalogChangeKind[];
  offset?: number;
  limit?: number;
}
export type ChangesPage =
  | { available: false; reason: CatalogChangesUnavailable }
  | { available: true; eventId: string; fromSyncedAt: number | null; toSyncedAt: number; counts: CatalogDiff["counts"]; abstractsCompared: boolean; total: number; changes: CatalogChange[]; offset: number; nextOffset?: number };

/** One page of the last import's changes, optionally only for some sessions (by id or code) or kinds,
 * shortened until it fits the output budget; `nextOffset` says where the rest starts. */
export function queryCatalogChanges(query: ChangesQuery, deps: CatalogStoreDeps): ChangesPage {
  const last = readCatalogChanges(deps);
  if (!last.available) return last;
  const wanted = query.sessionIds === undefined ? null : new Set(query.sessionIds.map(id => id.trim().toLowerCase()));
  const kinds = query.kinds === undefined ? null : new Set(query.kinds);
  const matching = last.changes.filter(change =>
    (wanted === null || wanted.has(change.sessionId.toLowerCase()) || (change.code !== null && wanted.has(change.code.toLowerCase()))) &&
    (kinds === null || kinds.has(change.kind)));
  const offset = query.offset ?? 0;
  const page = matching.slice(offset, offset + (query.limit ?? DEFAULT_CHANGES_LIMIT)).map(change => ({ ...change, title: shortenDescription(change.title, CHANGE_TITLE_MAX) }));
  const build = (rows: CatalogChange[]): ChangesPage => ({
    available: true, eventId: last.eventId, fromSyncedAt: last.fromSyncedAt, toSyncedAt: last.toSyncedAt, counts: last.counts, abstractsCompared: last.abstractsCompared,
    total: matching.length, changes: rows, offset, ...(offset + rows.length < matching.length ? { nextOffset: offset + rows.length } : {}),
  });
  let result = build(page);
  while (outputBytes(result) > OUTPUT_BUDGET_BYTES && page.length > 0) {
    page.pop();
    result = build(page);
  }
  return result;
}
