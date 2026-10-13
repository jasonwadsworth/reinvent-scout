import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stageCatalogPage, CatalogImportRejectedError, SYNC_ID_PATTERN } from "../../src/catalog/import.js";
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
