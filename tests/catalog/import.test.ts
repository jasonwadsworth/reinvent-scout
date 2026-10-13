import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitCatalogImport, importCatalog, pruneStaleStaging, reindexCatalog, stageCatalogPage, CatalogImportRejectedError, SYNC_ID_PATTERN } from "../../src/catalog/import.js";
import { readCatalogChanges } from "../../src/catalog/diff.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, readIndex, readMeta, readRaw, writeCatalog, type CatalogMeta } from "../../src/catalog/store.js";
import type { Session } from "../../src/api/types.js";
import { CatalogMissingError } from "../../src/core/errors.js";
import { ValidationError } from "../../src/core/errors.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const NOW = Date.parse("2026-12-01T00:00:00Z");
const item = (n: number) => ({ sessionId: `id-${n}`, title: `Session ${n}`, abstract: `Abstract ${n}`, sessionTime: { date: "2026-12-01", time: "10:30", length: "60" } });
const pageOf = (from: number, count: number, extra: Record<string, unknown> = {}) => ({ items: Array.from({ length: count }, (_, i) => item(from + i)), totalCount: 4, ...extra });

describe("stageCatalogPage", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); }); afterEach(() => home.cleanup());
  let counter = 0;
  const deps = () => ({ storeRoot: home.path, now: () => NOW, randomId: () => `sync-${String(++counter).padStart(8, "0")}` });
  const stagingDir = () => join(home.path, "catalog", "staging");
  const mode = (path: string) => statSync(path).mode & 0o777;
  const first = (page: unknown, extra: Record<string, unknown> = {}) => stageCatalogPage({ eventId: "reinvent2026", timezone: "America/Los_Angeles", page, ...extra }, deps());

  it("stages the first page with a manifest, private modes and a summary-only result", () => {
    const result = first(pageOf(1, 2, { nextToken: "t1" }));
    expect(result).toMatchObject({ pageNumber: 1, stagedCount: 2, totalCount: 4, nextToken: "t1", complete: false });
    expect(SYNC_ID_PATTERN.test(result.syncId)).toBe(true);
    const dir = join(stagingDir(), result.syncId);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "manifest.json"))).toBe(0o600);
    expect(mode(join(dir, "page-0001.json"))).toBe(0o600);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ schemaVersion: 1, syncId: result.syncId, eventId: "reinvent2026", timezone: "America/Los_Angeles", createdAt: NOW, pages: [{ number: 1, count: 2, totalCount: 4, nextToken: "t1" }] });
    expect(JSON.parse(readFileSync(join(dir, "page-0001.json"), "utf8"))).toEqual(pageOf(1, 2).items);
    expect(JSON.stringify(result)).not.toContain("Session 1");
  });
  it("does not touch a stored catalog", () => {
    const catalogDir = join(home.path, "catalog");
    first(pageOf(1, 2, { nextToken: "t1" }));
    expect(readdirSync(catalogDir)).toEqual(["staging"]);
  });
  it("marks the last page complete", () => {
    const one = first(pageOf(1, 2, { nextToken: "t1" }));
    const two = stageCatalogPage({ syncId: one.syncId, page: pageOf(3, 2) }, deps());
    expect(two).toMatchObject({ syncId: one.syncId, pageNumber: 2, stagedCount: 4, complete: true });
    expect(two.nextToken).toBeUndefined();
  });
  it("reads a later page from a saved file", () => {
    const one = first(pageOf(1, 2, { nextToken: "t1" }));
    const path = join(home.path, "p2.json");
    writeFileSync(path, JSON.stringify(pageOf(3, 2)));
    expect(stageCatalogPage({ syncId: one.syncId, path }, deps()).complete).toBe(true);
  });

  describe("field rules", () => {
    it("needs a timezone on the first page, accepting null", () => {
      expect(() => stageCatalogPage({ eventId: "reinvent2026", page: pageOf(1, 2) }, deps())).toThrow(/timezone/);
      expect(() => stageCatalogPage({ eventId: "reinvent2026", timezone: "Mars/Olympus", page: pageOf(1, 2) }, deps())).toThrow(ValidationError);
      expect(first(pageOf(1, 2), { timezone: null }).syncId).toBeDefined();
    });
    it("needs an eventId on the first page", () => {
      expect(() => stageCatalogPage({ timezone: null, page: pageOf(1, 2) }, deps())).toThrow(/eventId/);
    });
    it("refuses eventId or timezone on a later page", () => {
      const one = first(pageOf(1, 2, { nextToken: "t1" }));
      expect(() => stageCatalogPage({ syncId: one.syncId, eventId: "x", page: pageOf(3, 2) }, deps())).toThrow(/eventId/);
      expect(() => stageCatalogPage({ syncId: one.syncId, timezone: null, page: pageOf(3, 2) }, deps())).toThrow(/timezone/);
    });
  });

  describe("bad syncs", () => {
    it("rejects an unknown syncId and tells the caller to start again", () => {
      expect(() => stageCatalogPage({ syncId: "does-not-exist-1", page: pageOf(1, 2) }, deps())).toThrow(/start/i);
    });
    it("rejects a traversal syncId before any path is built", () => {
      expect(() => stageCatalogPage({ syncId: "../x", page: pageOf(1, 2) }, deps())).toThrow(/lowercase letters, digits and hyphens/);
      expect(() => stageCatalogPage({ syncId: "../../escape-abcdef", page: pageOf(1, 2) }, deps())).toThrow(/lowercase letters, digits and hyphens/);
      expect(existsSync(join(home.path, "catalog", "x"))).toBe(false);
      expect(existsSync(stagingDir())).toBe(false);
    });
    it("rejects the same page twice as overlap and leaves the manifest byte-identical", () => {
      const one = first(pageOf(1, 2, { nextToken: "t1" }));
      const manifestPath = join(stagingDir(), one.syncId, "manifest.json");
      const before = readFileSync(manifestPath);
      let thrown: unknown;
      try { stageCatalogPage({ syncId: one.syncId, page: pageOf(1, 2, { nextToken: "t2" }) }, deps()); } catch (err) { thrown = err; }
      expect(thrown).toBeInstanceOf(CatalogImportRejectedError);
      expect((thrown as CatalogImportRejectedError).reason).toBe("overlap");
      expect(readFileSync(manifestPath).equals(before)).toBe(true);
      expect(readdirSync(join(stagingDir(), one.syncId)).sort()).toEqual(["manifest.json", "page-0001.json"]);
    });
    it("rejects a page after a complete one as alreadyComplete", () => {
      const one = first(pageOf(1, 4));
      let thrown: unknown;
      try { stageCatalogPage({ syncId: one.syncId, page: pageOf(10, 2) }, deps()); } catch (err) { thrown = err; }
      expect((thrown as CatalogImportRejectedError).reason).toBe("alreadyComplete");
    });
  });

  it.each([["non-JSON", "SECRET-MARKER {not json"], ["the wrong shape", JSON.stringify({ SECRET: "SECRET-MARKER" })]])("reports %s staged data as unreadable without echoing it", (_name, content) => {
    const one = first(pageOf(1, 2, { nextToken: "t1" }));
    writeFileSync(join(stagingDir(), one.syncId, "page-0001.json"), content);
    let message = "";
    try { stageCatalogPage({ syncId: one.syncId, page: pageOf(3, 2) }, deps()); } catch (err) { expect(err).toBeInstanceOf(ValidationError); message = (err as Error).message; }
    expect(message).toMatch(/unreadable.*start a new sync/);
    expect(message).not.toContain("SECRET");
  });
  it("flags a changed totalCount", () => {
    const one = first(pageOf(1, 2, { nextToken: "t1" }));
    const two = stageCatalogPage({ syncId: one.syncId, page: pageOf(3, 2, { totalCount: 5 }) }, deps());
    expect(two.totalCountChanged).toBe(true);
    expect(one.totalCountChanged).toBeUndefined();
  });
});

describe("pruneStaleStaging", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); }); afterEach(() => home.cleanup());
  const HOUR = 3_600_000;
  const NOW = Date.parse("2026-12-02T00:00:00Z");
  const staging = () => join(home.path, "catalog", "staging");
  let n = 0;
  const stageAt = (at: number) => stageCatalogPage({ eventId: "reinvent2026", timezone: null, page: { items: [{ sessionId: `s-${++n}`, title: "t" }], totalCount: 1 } }, { storeRoot: home.path, now: () => at, randomId: () => `sync-${String(n + 100).padStart(8, "0")}` }).syncId;
  const names = () => (existsSync(staging()) ? readdirSync(staging()).sort() : []);

  it("removes a sync whose manifest is more than 24 hours old, and keeps a recent one", () => {
    const old = stageAt(NOW - 25 * HOUR);
    const recent = stageAt(NOW - 1 * HOUR);
    pruneStaleStaging({ storeRoot: home.path, now: () => NOW });
    expect(names()).toEqual([recent]);
    expect(names()).not.toContain(old);
  });
  it("removes an unreadable sync by its directory mtime", () => {
    const stale = join(staging(), "stale-unreadable-1");
    const fresh = join(staging(), "fresh-unreadable-1");
    for (const dir of [stale, fresh]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "manifest.json"), "{ broken"); }
    utimesSync(stale, (NOW - 25 * HOUR) / 1000, (NOW - 25 * HOUR) / 1000);
    utimesSync(fresh, (NOW - 1 * HOUR) / 1000, (NOW - 1 * HOUR) / 1000);
    pruneStaleStaging({ storeRoot: home.path, now: () => NOW });
    expect(names()).toEqual(["fresh-unreadable-1"]);
  });
  it("never follows a symlink out of staging, and leaves the link alone", () => {
    const outside = join(home.path, "outside"); mkdirSync(outside); writeFileSync(join(outside, "keep.txt"), "keep");
    utimesSync(outside, (NOW - 48 * HOUR) / 1000, (NOW - 48 * HOUR) / 1000);
    mkdirSync(staging(), { recursive: true });
    symlinkSync(outside, join(staging(), "link-to-outside-1"));
    pruneStaleStaging({ storeRoot: home.path, now: () => NOW });
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(names()).toEqual(["link-to-outside-1"]);
  });
  it("ignores entries whose names are not valid sync ids", () => {
    mkdirSync(join(staging(), "Not A Sync"), { recursive: true });
    utimesSync(join(staging(), "Not A Sync"), (NOW - 48 * HOUR) / 1000, (NOW - 48 * HOUR) / 1000);
    pruneStaleStaging({ storeRoot: home.path, now: () => NOW });
    expect(names()).toEqual(["Not A Sync"]);
  });
  it("does nothing when there is no staging directory", () => {
    expect(() => pruneStaleStaging({ storeRoot: home.path, now: () => NOW })).not.toThrow();
  });
  it("runs when a new sync starts", () => {
    const old = stageAt(NOW - 25 * HOUR);
    const fresh = stageAt(NOW);
    expect(names()).toEqual([fresh]);
    expect(names()).not.toContain(old);
  });
});

const sessionN = (n: number, prefix = "id", extra: { [K in keyof Session]?: Session[K] | undefined } = {}): Session => ({ sessionId: `${prefix}-${n}`, abbreviation: `A${n}`, title: `Session ${n}`, abstract: `Abstract ${n}`, sessionTime: { date: "2026-12-01", time: "10:30", length: "60" }, ...extra }) as Session;
const sessions = (count: number, prefix = "id", extra: { [K in keyof Session]?: Session[K] | undefined } = {}) => Array.from({ length: count }, (_, i) => sessionN(i + 1, prefix, extra));

describe("commitCatalogImport", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); }); afterEach(() => home.cleanup());
  const T0 = Date.parse("2026-12-01T00:00:00Z");
  const T1 = Date.parse("2026-12-02T00:00:00Z");
  let ids = 0;
  const deps = (now = T1) => ({ storeRoot: home.path, now: () => now, randomId: () => `sync-${String(++ids).padStart(8, "0")}` });
  const seed = (count: number, over: Partial<CatalogMeta> = {}, raw: Session[] = sessions(count, "old")) => writeCatalog(
    { raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: T0, totalCount: count, count, includedAbstracts: true, timezone: "America/Los_Angeles", ...over } },
    { storeRoot: home.path },
  );
  /** Stages `pages` (arrays of sessions), the last one without a nextToken unless `complete` is false. */
  const stage = (pages: Session[][], opts: { totalCount?: number; complete?: boolean; eventId?: string } = {}) => {
    let syncId = "";
    pages.forEach((items, i) => {
      const last = i === pages.length - 1;
      const body = { items, totalCount: opts.totalCount ?? pages.flat().length, ...(last && opts.complete !== false ? {} : { nextToken: `t${i}` }) };
      syncId = i === 0
        ? stageCatalogPage({ eventId: opts.eventId ?? "reinvent2026", timezone: "America/Los_Angeles", page: body }, deps()).syncId
        : stageCatalogPage({ syncId, page: body }, deps()).syncId;
    });
    return syncId;
  };
  const catalogBytes = () => ["raw.json", "index.json", "meta.json"].map(name => { const p = join(home.path, "catalog", name); return existsSync(p) ? readFileSync(p).toString("base64") : null; });
  const reasonOf = (fn: () => unknown): { reason: string; message: string } => {
    try { fn(); } catch (err) { if (err instanceof CatalogImportRejectedError) return { reason: err.reason, message: err.message }; throw err; }
    throw new Error("expected a rejection");
  };

  it("commits a two-page sync: raw field for field, a rebuilt index, meta, changes.json, no staging", () => {
    const all = sessions(4);
    const syncId = stage([all.slice(0, 2), all.slice(2)]);
    const result = commitCatalogImport({ syncId }, deps());
    expect(result).toMatchObject({ committed: true, eventId: "reinvent2026", count: 4, totalCount: 4, firstImport: true });
    expect(readRaw({ storeRoot: home.path })).toEqual(all);
    expect(readIndex({ storeRoot: home.path })).toEqual(all.map(buildIndexRecord));
    expect(readMeta({ storeRoot: home.path })).toEqual({ schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: T1, totalCount: 4, count: 4, includedAbstracts: true, timezone: "America/Los_Angeles" });
    expect(existsSync(join(home.path, "catalog", "changes.json"))).toBe(true);
    expect(existsSync(join(home.path, "catalog", "staging", syncId))).toBe(false);
  });
  it("reports a diff against the previous catalog of the same event", () => {
    seed(3, {}, [sessionN(1, "id"), sessionN(2, "id"), sessionN(3, "id")]);
    const syncId = stage([[sessionN(1, "id"), sessionN(2, "id", { room: "New room" }), sessionN(4, "id")]], { totalCount: 3 });
    const result = commitCatalogImport({ syncId }, deps());
    expect(result).toMatchObject({ summary: { counts: { added: 1, removed: 1, changed: 1, unchanged: 1 } } });
    expect(result).not.toHaveProperty("firstImport");
    const changes = readCatalogChanges({ storeRoot: home.path });
    expect(changes).toMatchObject({ available: true, fromSyncedAt: T0, toSyncedAt: T1, counts: { added: 1, removed: 1, changed: 1 } });
  });
  it("accepts a count above the final totalCount with a warning", () => {
    const syncId = stage([sessions(5)], { totalCount: 4 });
    expect(commitCatalogImport({ syncId }, deps())).toMatchObject({ count: 5, warnings: ["catalog grew during the import"] });
  });
  it("replaces another event's catalog without the shrink check and says so", () => {
    seed(100, { eventId: "other2026" });
    const syncId = stage([sessions(10)]);
    expect(commitCatalogImport({ syncId }, deps())).toMatchObject({ committed: true, replacedEventId: "other2026" });
    expect(readCatalogChanges({ storeRoot: home.path })).toEqual({ available: false, reason: "eventReplaced" });
  });
  it("records includedAbstracts from the staged items", () => {
    const syncId = stage([sessions(3, "id", { abstract: undefined })]);
    commitCatalogImport({ syncId }, deps());
    expect(readMeta({ storeRoot: home.path })?.includedAbstracts).toBe(false);
  });

  describe("rejections leave the stored catalog byte-identical", () => {
    it("nothingStaged", () => {
      seed(5);
      const syncId = "sync-empty-0001";
      const dir = join(home.path, "catalog", "staging", syncId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, syncId, eventId: "reinvent2026", timezone: null, createdAt: T1, pages: [] }));
      const before = catalogBytes();
      expect(reasonOf(() => commitCatalogImport({ syncId }, deps())).reason).toBe("nothingStaged");
      expect(catalogBytes()).toEqual(before);
    });
    it("incomplete", () => {
      seed(5);
      const syncId = stage([sessions(2)], { totalCount: 4, complete: false });
      const before = catalogBytes();
      expect(reasonOf(() => commitCatalogImport({ syncId }, deps())).reason).toBe("incomplete");
      expect(catalogBytes()).toEqual(before);
    });
    it("empty, keeping the existing-data wording", () => {
      seed(5);
      const syncId = stage([[]], { totalCount: 0 });
      const before = catalogBytes();
      const rejection = reasonOf(() => commitCatalogImport({ syncId }, deps()));
      expect(rejection.reason).toBe("empty");
      expect(rejection.message).toContain("existing local data was left unchanged");
      expect(catalogBytes()).toEqual(before);
    });
    it("partial (3 of 4)", () => {
      seed(5);
      const syncId = stage([sessions(3)], { totalCount: 4 });
      const before = catalogBytes();
      expect(reasonOf(() => commitCatalogImport({ syncId }, deps())).reason).toBe("partial");
      expect(catalogBytes()).toEqual(before);
    });
    it("shrunk (85 of 100), then succeeds with allowShrink and keeps staging until then", () => {
      seed(100);
      const syncId = stage([sessions(85)]);
      const before = catalogBytes();
      const rejection = reasonOf(() => commitCatalogImport({ syncId }, deps()));
      expect(rejection.reason).toBe("shrunk");
      expect(rejection.message).toMatch(/85/);
      expect(rejection.message).toMatch(/100/);
      expect(rejection.message).toContain("allowShrink");
      expect(catalogBytes()).toEqual(before);
      expect(existsSync(join(home.path, "catalog", "staging", syncId))).toBe(true);
      expect(commitCatalogImport({ syncId, allowShrink: true }, deps())).toMatchObject({ committed: true, count: 85 });
    });
    it("accepts exactly 90 percent of the previous count", () => {
      seed(100);
      const syncId = stage([sessions(90)]);
      expect(commitCatalogImport({ syncId }, deps())).toMatchObject({ committed: true });
    });
  });

  it("reports changes.json as superseded when the catalog write crashed after it", () => {
    seed(3, {}, [sessionN(1, "id"), sessionN(2, "id"), sessionN(3, "id")]);
    const syncId = stage([[sessionN(1, "id"), sessionN(2, "id"), sessionN(5, "id")]], { totalCount: 3 });
    expect(() => commitCatalogImport({ syncId }, { ...deps(), writeCatalogFn: () => { throw new Error("disk full"); } })).toThrow(/disk full/);
    expect(readCatalogChanges({ storeRoot: home.path })).toEqual({ available: false, reason: "superseded" });
    expect(readMeta({ storeRoot: home.path })?.syncedAt).toBe(T0);
  });
  it("prunes stale staging after a successful commit", () => {
    const fresh = stage([sessions(3, "new")]);
    const staleId = "sync-stale-0001";
    const staleDir = join(home.path, "catalog", "staging", staleId);
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "manifest.json"), JSON.stringify({ schemaVersion: 1, syncId: staleId, eventId: "reinvent2026", timezone: null, createdAt: T1 - 48 * 3_600_000, pages: [] }));
    commitCatalogImport({ syncId: fresh }, deps());
    expect(readdirSync(join(home.path, "catalog", "staging"))).toEqual([]);
  });
});

describe("reindexCatalog", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); }); afterEach(() => home.cleanup());
  const raw = sessions(3);
  const meta = (over: Partial<CatalogMeta> = {}): CatalogMeta => ({ schemaVersion: CURRENT_SCHEMA_VERSION - 1, eventId: "reinvent2026", syncedAt: 1_700_000_000_000, totalCount: 3, count: 3, includedAbstracts: true, timezone: "America/Los_Angeles", ...over });
  const seed = (m: CatalogMeta) => writeCatalog({ raw, index: [], meta: m }, { storeRoot: home.path });
  const metaPath = () => join(home.path, "catalog", "meta.json");
  const dropTimezoneKey = () => { const m = JSON.parse(readFileSync(metaPath(), "utf8")); delete m.timezone; writeFileSync(metaPath(), JSON.stringify(m)); };

  it("rebuilds a stale index from stored raw data, keeping syncedAt and timezone", () => {
    seed(meta());
    const result = reindexCatalog({}, { storeRoot: home.path });
    expect(result).toMatchObject({ reindexed: true, eventId: "reinvent2026", count: 3 });
    expect(readIndex({ storeRoot: home.path })).toEqual(raw.map(buildIndexRecord));
    expect(readMeta({ storeRoot: home.path })).toEqual({ ...meta(), schemaVersion: CURRENT_SCHEMA_VERSION });
  });
  it("needs a timezone argument when the stored meta predates timezone support, and stores it", () => {
    seed(meta()); dropTimezoneKey();
    const before = readFileSync(metaPath(), "utf8");
    expect(() => reindexCatalog({}, { storeRoot: home.path })).toThrow(/GetEvent/);
    expect(readFileSync(metaPath(), "utf8")).toBe(before);
    reindexCatalog({ timezone: "America/New_York" }, { storeRoot: home.path });
    expect(readMeta({ storeRoot: home.path })?.timezone).toBe("America/New_York");
  });
  it("rejects an unrecognized timezone argument without touching meta", () => {
    seed(meta()); dropTimezoneKey();
    const before = readFileSync(metaPath(), "utf8");
    expect(() => reindexCatalog({ timezone: "Mars/Olympus" }, { storeRoot: home.path })).toThrow(ValidationError);
    expect(readFileSync(metaPath(), "utf8")).toBe(before);
  });
  it("preserves an explicit null timezone key", () => {
    seed(meta({ timezone: null }));
    reindexCatalog({}, { storeRoot: home.path });
    expect(readMeta({ storeRoot: home.path })?.timezone).toBeNull();
  });
  it("throws CatalogMissingError with no stored raw data", () => {
    expect(() => reindexCatalog({}, { storeRoot: home.path })).toThrow(CatalogMissingError);
  });
});

describe("importCatalog field rules", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); }); afterEach(() => home.cleanup());
  const page = { items: [{ sessionId: "a", title: "t" }], totalCount: 1 };
  const bad = (input: Parameters<typeof importCatalog>[0], pattern: RegExp) => {
    const d = { storeRoot: home.path, now: () => 1, randomId: () => "sync-00000001" };
    expect(() => importCatalog(input, d)).toThrow(pattern);
  };
  it("first page: needs eventId, timezone and one of path/page; refuses allowShrink", () => {
    bad({ action: "page", timezone: null, page }, /eventId/);
    bad({ action: "page", eventId: "e", page }, /timezone/);
    bad({ action: "page", eventId: "e", timezone: null }, /exactly one/);
    bad({ action: "page", eventId: "e", timezone: null, page, allowShrink: true }, /allowShrink/);
  });
  it("later page: refuses eventId, timezone and allowShrink", () => {
    bad({ action: "page", syncId: "sync-00000001", eventId: "e", page }, /eventId/);
    bad({ action: "page", syncId: "sync-00000001", timezone: null, page }, /timezone/);
    bad({ action: "page", syncId: "sync-00000001", page, allowShrink: false }, /allowShrink/);
  });
  it("commit: needs syncId; refuses path, page, eventId and timezone", () => {
    bad({ action: "commit" }, /syncId/);
    bad({ action: "commit", syncId: "sync-00000001", page }, /page/);
    bad({ action: "commit", syncId: "sync-00000001", path: "/x" }, /path/);
    bad({ action: "commit", syncId: "sync-00000001", eventId: "e" }, /eventId/);
    bad({ action: "commit", syncId: "sync-00000001", timezone: null }, /timezone/);
  });
  it("reindex: allows only timezone", () => {
    bad({ action: "reindex", syncId: "sync-00000001" }, /syncId/);
    bad({ action: "reindex", eventId: "e" }, /eventId/);
    bad({ action: "reindex", page }, /page/);
    bad({ action: "reindex", allowShrink: true }, /allowShrink/);
  });
  it("dispatches each action", () => {
    const d = { storeRoot: home.path, now: () => 1, randomId: () => "sync-00000001" };
    const staged = importCatalog({ action: "page", eventId: "reinvent2026", timezone: null, page }, d);
    expect(staged).toMatchObject({ pageNumber: 1, complete: true });
    expect(importCatalog({ action: "commit", syncId: "sync-00000001" }, d)).toMatchObject({ committed: true, count: 1 });
    expect(importCatalog({ action: "reindex" }, d)).toMatchObject({ reindexed: true });
  });
});
