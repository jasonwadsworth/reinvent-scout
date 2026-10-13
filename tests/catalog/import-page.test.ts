import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/errors.js";
import { parseListSessionsPage, resolveListSessionsPage } from "../../src/catalog/import-page.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const item = (n: number, extra: Record<string, unknown> = {}) => ({
  sessionId: `id-${n}`, title: `Session ${n}`, abbreviation: `ABC${n}`, abstract: "A", venue: "MGM Grand", room: "Room", seatAvailability: "limited",
  sessionTime: { date: "2026-12-01", time: "10:30", length: "60" }, topics: ["x", "y"], customField: { nested: [1, 2] }, ...extra,
});
const page = (count = 2, extra: Record<string, unknown> = {}) => ({ items: Array.from({ length: count }, (_, i) => item(i + 1)), nextToken: "tok", totalCount: 4, ...extra });

describe("ListSessions page validation", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); }); afterEach(() => home.cleanup());
  const file = (name: string, content: unknown) => { const path = join(home.path, name); writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content)); return path; };

  describe("accepted", () => {
    it("reads a page file and keeps every field of every item", () => {
      const result = resolveListSessionsPage({ path: file("p.json", page()) });
      expect(result.items).toEqual(page().items);
      expect(result).toMatchObject({ totalCount: 4, nextToken: "tok" });
    });
    it("accepts the same page inline", () => {
      expect(resolveListSessionsPage({ page: page() }).items).toHaveLength(2);
    });
    it("unwraps a one-element text array", () => {
      const wrapped = [{ type: "text", text: JSON.stringify(page()) }];
      expect(resolveListSessionsPage({ path: file("w.json", wrapped) }).items).toHaveLength(2);
    });
    it("strips unknown top-level keys", () => {
      const result = parseListSessionsPage({ ...page(), surprise: true });
      expect(result).not.toHaveProperty("surprise");
    });
    it("allows a last page without a nextToken", () => {
      const last: Record<string, unknown> = page();
      delete last.nextToken;
      expect(parseListSessionsPage(last).nextToken).toBeUndefined();
    });
  });

  describe("rejected", () => {
    it("a relative path", () => {
      expect(() => resolveListSessionsPage({ path: "page.json" })).toThrow(ValidationError);
      expect(() => resolveListSessionsPage({ path: "page.json" })).toThrow(/absolute/);
    });
    it("a symlink", () => {
      const target = file("real.json", page());
      const link = join(home.path, "link.json");
      symlinkSync(target, link);
      expect(() => resolveListSessionsPage({ path: link })).toThrow(/symbolic link/);
    });
    it("a directory", () => {
      const dir = join(home.path, "dir"); mkdirSync(dir);
      expect(() => resolveListSessionsPage({ path: dir })).toThrow(/regular file/);
    });
    it("a missing file", () => {
      expect(() => resolveListSessionsPage({ path: join(home.path, "nope.json") })).toThrow(ValidationError);
    });
    it("a file over the size cap", () => {
      const path = file("big.json", page());
      expect(() => resolveListSessionsPage({ path }, { maxBytes: 10 })).toThrow(/too large/);
    });
    it.each([
      ["non-JSON text", "not json at all"],
      ["a GetSession object", { session: item(1) }],
      ["a GetSchedule object", { schedule: { reserved: [], personalTime: [] } }],
      ["an item without a sessionId", { ...page(), items: [{ title: "x" }] }],
      ["a repeated sessionId", { ...page(), items: [item(1), item(1)] }],
      ["a negative totalCount", page(2, { totalCount: -1 })],
      ["an empty nextToken", page(2, { nextToken: "" })],
      ["a non-array items", { items: "x", totalCount: 1 }],
    ])("%s", (_name, content) => {
      expect(() => resolveListSessionsPage({ path: file("bad.json", content) })).toThrow(ValidationError);
    });
    it("both path and page given, or neither", () => {
      expect(() => resolveListSessionsPage({ path: file("p.json", page()), page: page() })).toThrow(/exactly one/);
      expect(() => resolveListSessionsPage({})).toThrow(/exactly one/);
    });
    it("an invalid inline page", () => {
      expect(() => resolveListSessionsPage({ page: { items: [] } })).toThrow(ValidationError);
    });
  });

  it("never echoes file content, but names the file", () => {
    const path = file("leaky.json", "SECRET-MARKER is not json");
    let message = "";
    try { resolveListSessionsPage({ path }); } catch (err) { message = (err as Error).message; }
    expect(message).toContain("leaky.json");
    expect(message).not.toContain("SECRET-MARKER");
    const shaped = file("shaped.json", { items: [{ sessionId: "SECRET-MARKER", title: 5 }], totalCount: 1 });
    try { resolveListSessionsPage({ path: shaped }); } catch (err) { message = (err as Error).message; }
    expect(message).toContain("shaped.json");
    expect(message).not.toContain("SECRET-MARKER");
  });
});
