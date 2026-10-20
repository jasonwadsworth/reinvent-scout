/* eslint-disable @typescript-eslint/no-explicit-any -- parsed command output is checked field by field */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/aws/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { queryCatalog } from "../../src/catalog/query.js";
import { CURRENT_SCHEMA_VERSION, readMeta, writeCatalog } from "../../src/catalog/store.js";
import { OUTPUT_BUDGET_BYTES, outputBytes } from "../../src/commands/output-budget.js";
import { registry } from "../../src/commands/registry.js";
import { callCommand } from "../helpers/call-command.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const T0 = Date.parse("2026-12-01T00:00:00Z");
const T1 = Date.parse("2026-12-02T00:00:00Z");
const session = (n: number, extra: Partial<Session> = {}): Session => ({ sessionId: `id-${n}`, abbreviation: `ABC${String(n).padStart(3, "0")}`, title: `Title ${n}`, abstract: `Abstract ${n}`, type: "Chalk talk", level: "400 – Advanced", venue: "MGM Grand", room: "R1", sessionTime: { date: "2026-12-02", time: "10:30", length: "60" }, ...extra });
const sessions = (count: number, extra: Partial<Session> = {}) => Array.from({ length: count }, (_, i) => session(i + 1, extra));

describe("catalog commands", () => {
  let home: TempHome; let ids = 0;
  beforeEach(() => { home = createTempHome(); ids = 0; }); afterEach(() => home.cleanup());
  const opts = (now = T1) => ({ storeRoot: home.path, now: () => now, randomId: () => `sync-${String(++ids).padStart(8, "0")}` });
  const call = (name: keyof typeof registry, input: unknown, now = T1) => callCommand(name, input, opts(now));
  const json = (result: { text: string }) => JSON.parse(result.text) as Record<string, any>;
  const pageFile = (name: string, body: unknown) => { const path = join(home.path, name); writeFileSync(path, JSON.stringify(body)); return path; };
  const seed = (raw: Session[], over: Record<string, unknown> = {}) => writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: T0, totalCount: raw.length, count: raw.length, includedAbstracts: true, timezone: "America/Los_Angeles", ...over } }, { storeRoot: home.path });
  /** The sync brief, run by hand: pages from files, then commit. */
  async function importAll(raw: Session[], opt: { allowShrink?: boolean; now?: number } = {}) {
    const half = Math.ceil(raw.length / 2);
    const one = json(await call("catalog_import", { action: "page", eventId: "reinvent2026", timezone: "America/Los_Angeles", path: pageFile("p1.json", { items: raw.slice(0, half), nextToken: "t", totalCount: raw.length }) }, opt.now));
    await call("catalog_import", { action: "page", syncId: one.syncId, path: pageFile("p2.json", { items: raw.slice(half), totalCount: raw.length }) }, opt.now);
    return { syncId: one.syncId as string, commit: await call("catalog_import", { action: "commit", syncId: one.syncId, ...(opt.allowShrink ? { allowShrink: true } : {}) }, opt.now) };
  }

  it("registry now holds all thirteen commands", () => {
    expect(Object.keys(registry).sort()).toEqual(["catalog_changes", "catalog_import", "get_onsite_preferences", "list_filters", "lookup_sessions", "map_profile", "match_sessions", "nearby_sessions", "plan_schedule", "search_sessions", "set_onsite_preferences", "status", "validate_profile"]);
  });

  describe("catalog_import", () => {
    it("imports two page files and commits, returning counts and no session data", async () => {
      const raw = sessions(4);
      const { commit } = await importAll(raw);
      expect(commit.isError).toBe(false);
      expect(json(commit)).toMatchObject({ committed: true, count: 4, totalCount: 4, firstImport: true });
      expect(commit.text).not.toContain("Title 1");
      expect(queryCatalog({ storeRoot: home.path })).toHaveLength(4);
      expect(readMeta({ storeRoot: home.path })?.syncedAt).toBe(T1);
    });
    it("a second import returns a diff summary; titles appear only in the highlights", async () => {
      seed(sessions(4));
      const changed = [session(1), session(2, { room: "Moved" }), session(3), session(5)];
      const { commit } = await importAll(changed);
      const out = json(commit);
      expect(out.summary.counts).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 2 });
      expect(out.summary.highlights.map((h: { kind: string }) => h.kind)).toEqual(["removed", "changed", "added"]);
      expect(Object.keys(out)).not.toContain("changes");
    });
    it("a rejected commit is an error starting with its reason and naming allowShrink, and keeps the catalog", async () => {
      seed(sessions(100));
      const { commit } = await importAll(sessions(50));
      expect(commit.isError).toBe(true);
      expect(commit.text).toMatch(/^shrunk:/);
      expect(commit.text).toContain("allowShrink");
      expect(readMeta({ storeRoot: home.path })?.count).toBe(100);
    });
    it("allowShrink lets the user-approved drop through", async () => {
      seed(sessions(100));
      const { commit } = await importAll(sessions(50), { allowShrink: true });
      expect(json(commit)).toMatchObject({ committed: true, count: 50 });
    });
    it("rejects unknown keys as a schema error, and reindexes without any page", async () => {
      expect((await call("catalog_import", { action: "commit", syncId: "sync-00000001", surprise: 1 })).isError).toBe(true);
      seed(sessions(2), { schemaVersion: CURRENT_SCHEMA_VERSION - 1 });
      expect(json(await call("catalog_import", { action: "reindex" }))).toMatchObject({ reindexed: true, count: 2 });
    });
  });

  describe("catalog_changes", () => {
    it("answers for the ids asked about, with a page cursor", async () => {
      seed(Array.from({ length: 30 }, (_, i) => session(i + 1)));
      await importAll(Array.from({ length: 30 }, (_, i) => session(i + 1, { room: "Moved" })));
      const all = json(await call("catalog_changes", { limit: 10 }));
      expect(all).toMatchObject({ available: true, eventId: "reinvent2026", fromSyncedAt: T0, toSyncedAt: T1, total: 30, offset: 0, nextOffset: 10 });
      expect(all.changes).toHaveLength(10);
      const last = json(await call("catalog_changes", { limit: 10, offset: 20 }));
      expect(last.changes).toHaveLength(10); expect(last).not.toHaveProperty("nextOffset");
      const some = json(await call("catalog_changes", { sessionIds: ["id-3", "ABC005", "nope"] }));
      expect(some.changes.map((c: { sessionId: string }) => c.sessionId).sort()).toEqual(["id-3", "id-5"]);
      expect(some.total).toBe(2);
    });
    it("filters by kind", async () => {
      seed(sessions(3));
      await importAll([session(1), session(4)]);
      expect(json(await call("catalog_changes", { kinds: ["removed"] })).changes.map((c: { sessionId: string }) => c.sessionId).sort()).toEqual(["id-2", "id-3"]);
    });
    it.each([
      ["noImport", async () => {}],
      ["firstImport", async () => { await importAll(sessions(2)); }],
      ["eventReplaced", async () => { seed(sessions(2), { eventId: "other2026" }); await importAll(sessions(2)); }],
      ["superseded", async () => { seed(sessions(3)); await importAll([session(1), session(2), session(4)]); seed(sessions(3), { syncedAt: T1 + 1 }); }],
    ])("reports why there is no diff: %s", async (reason, setup) => {
      await setup();
      expect(json(await call("catalog_changes", {}))).toEqual({ available: false, reason });
    });
    it("shortens a page to fit the budget and points to the rest", async () => {
      seed(sessions(40, { title: "界".repeat(2000) }));
      await importAll(sessions(40, { title: "界".repeat(2000), room: "Moved" }));
      const result = json(await call("catalog_changes", { limit: 50 }));
      expect(outputBytes(result)).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
      expect(result.changes.length).toBeLessThan(40);
      expect(result.nextOffset).toBe(result.changes.length);
    });
  });

  describe("status", () => {
    it("reports the catalog and no sign-in", async () => {
      expect(json(await call("status", {}))).toEqual({ catalog: { status: "missing" } });
    });
    it("shows the last import while it matches the catalog, and drops it once superseded", async () => {
      seed(sessions(3));
      await importAll([session(1), session(2), session(4)]);
      const out = json(await call("status", {}));
      expect(out).not.toHaveProperty("signedIn");
      expect(out.lastImport).toMatchObject({ toSyncedAt: T1, counts: { added: 1, removed: 1 } });
      seed(sessions(3), { syncedAt: T1 + 1 });
      expect(json(await call("status", {}))).not.toHaveProperty("lastImport");
    });
  });

  describe("lookup_sessions", () => {
    it("resolves ids and codes and accounts for every query", async () => {
      seed(sessions(3));
      const out = json(await call("lookup_sessions", { ids: ["id-1", "abc002", "nope"] }));
      expect(out.rows.map((r: { code: string }) => r.code)).toEqual(["ABC001", "ABC002"]);
      expect(out.notFound).toEqual(["nope"]);
    });
    it("refuses an unknown key and more than 100 ids", async () => {
      seed(sessions(1));
      expect((await call("lookup_sessions", { ids: ["id-1"], surprise: 1 })).isError).toBe(true);
      expect((await call("lookup_sessions", { ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) })).isError).toBe(true);
    });
  });

  describe("search_sessions", () => {
    const fixtures = [
      session(1, { title: "Serverless agents", venue: "MGM Grand", type: "Chalk talk", level: "500 – Expert" }),
      session(2, { title: "Serverless data", venue: "Venetian", type: "Workshop", level: "300 – Intermediate", sessionTime: { date: "2026-12-03", time: "09:00", length: "60" } }),
      session(3, { title: "Agents everywhere", venue: "MGM Grand", type: "Breakout session", level: "200 – Foundational" }),
    ];
    const ids = (out: Record<string, any>) => out.rows.map((r: { sessionId: string }) => r.sessionId).sort();
    it("narrows by query and by each filter, like queryCatalog", async () => {
      seed(fixtures);
      expect(ids(json(await call("search_sessions", { query: "serverless" })))).toEqual(["id-1", "id-2"]);
      expect(ids(json(await call("search_sessions", { venue: "Venetian" })))).toEqual(["id-2"]);
      expect(ids(json(await call("search_sessions", { format: "Workshop" })))).toEqual(["id-2"]);
      expect(ids(json(await call("search_sessions", { day: "2026-12-03" })))).toEqual(["id-2"]);
      expect(ids(json(await call("search_sessions", { levels: { min: 400, max: 500 } })))).toEqual(["id-1"]);
      expect(ids(json(await call("search_sessions", { query: "agents", venue: "MGM Grand", levels: { min: 100, max: 300 } })))).toEqual(["id-3"]);
      expect(json(await call("search_sessions", {})).rows).toHaveLength(3);
    });
    it("returns lean rows with no abstract and no term maps", async () => {
      seed(fixtures);
      const row = json(await call("search_sessions", { query: "serverless" })).rows[0];
      expect(Object.keys(row).sort()).toEqual(["code", "level", "score", "sessionId", "startDate", "startTime", "title", "type", "venue"]);
    });
    it("rejects an unknown venue, caps the limit at 25 and defaults to 15", async () => {
      seed(sessions(40));
      expect((await call("search_sessions", { venue: "Atlantis" })).isError).toBe(true);
      expect(json(await call("search_sessions", {})).rows).toHaveLength(15);
      expect(json(await call("search_sessions", { limit: 100 })).rows).toHaveLength(25);
    });
    it("stays within the output budget, counting what it left out", async () => {
      seed(sessions(40, { type: "界".repeat(2000), level: "界".repeat(2000) }));
      const out = json(await call("search_sessions", { limit: 25 }));
      expect(outputBytes(out)).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
      expect(out.rows.length + out.omitted).toBe(25);
      expect(out.omitted).toBeGreaterThan(0);
    });
    it("says to import the catalog when there is none", async () => {
      const result = await call("search_sessions", { query: "x" });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/catalog-sync/);
    });
  });
});
