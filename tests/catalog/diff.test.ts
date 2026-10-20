import { describe, expect, it } from "vitest";
import type { Session } from "../../src/aws/types.js";
import { diffCatalogs, summarizeCatalogChanges } from "../../src/catalog/diff.js";
import { OUTPUT_BUDGET_BYTES, outputBytes } from "../../src/commands/output-budget.js";

const s = (id: string, extra: Partial<Session> = {}): Session => ({ sessionId: id, abbreviation: id.toUpperCase(), title: `Title ${id}`, abstract: "Abstract", topics: ["a", "b"], sessionTime: { date: "2026-12-01", time: "10:30", length: "60" }, room: "R1", seatAvailability: "limited", ...extra });

describe("diffCatalogs", () => {
  it("reports added, removed and changed rows with their fields", () => {
    const prev = [s("a"), s("b"), s("c", { level: "300" })];
    const next = [s("a"), s("c", { level: "400" }), s("d")];
    const diff = diffCatalogs(prev, next, { compareAbstracts: true });
    expect(diff.counts).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 1 });
    expect(diff.changes).toEqual([
      { kind: "removed", sessionId: "b", code: "B", title: "Title b" },
      { kind: "added", sessionId: "d", code: "D", title: "Title d" },
      { kind: "changed", sessionId: "c", code: "C", title: "Title c", fields: ["level"] },
    ]);
  });
  it("orders removed, then schedule changes, then added, then other changes", () => {
    const prev = [s("gone"), s("moved"), s("retitled", { level: "300" })];
    const next = [s("new"), s("moved", { sessionTime: { date: "2026-12-02", time: "10:30", length: "60" } }), s("retitled", { level: "400" })];
    const kinds = diffCatalogs(prev, next, { compareAbstracts: true }).changes.map(change => `${change.kind}:${change.sessionId}`);
    expect(kinds).toEqual(["removed:gone", "changed:moved", "added:new", "changed:retitled"]);
  });
  it("breaks ties on code, then sessionId", () => {
    const prev = [s("z1", { abbreviation: "AAA100" }), s("a1", { abbreviation: "AAA100" }), s("m1", { abbreviation: "ZZZ100" }), s("n1", { abbreviation: undefined as unknown as string })];
    const ids = diffCatalogs(prev, [], { compareAbstracts: true }).changes.map(change => change.sessionId);
    expect(ids).toEqual(["n1", "a1", "z1", "m1"]);
  });
  it("does not count reordered taxonomy arrays", () => {
    const diff = diffCatalogs([s("a", { topics: ["x", "y"] })], [s("a", { topics: ["y", "x"] })], { compareAbstracts: true });
    expect(diff.counts).toMatchObject({ changed: 0, unchanged: 1 });
  });
  it("does not count a seatAvailability-only change", () => {
    const diff = diffCatalogs([s("a", { seatAvailability: "limited" })], [s("a", { seatAvailability: "unavailable" })], { compareAbstracts: true });
    expect(diff.counts).toMatchObject({ changed: 0, unchanged: 1 });
    expect(diff.changes).toEqual([]);
  });
  it("compares nested objects regardless of key order", () => {
    const a = s("a", { sessionTime: { date: "2026-12-01", time: "10:30", length: "60" } });
    const b = s("a", { sessionTime: { length: "60", time: "10:30", date: "2026-12-01" } });
    expect(diffCatalogs([a], [b], { compareAbstracts: true }).counts.changed).toBe(0);
  });
  it("ignores abstract changes when either pull omitted abstracts", () => {
    const prev = [s("a", { abstract: "old" })];
    const next = [s("a", { abstract: "new" })];
    expect(diffCatalogs(prev, next, { compareAbstracts: false })).toMatchObject({ abstractsCompared: false, counts: { changed: 0 } });
    expect(diffCatalogs(prev, next, { compareAbstracts: true })).toMatchObject({ abstractsCompared: true, counts: { changed: 1 } });
  });
});

describe("summarizeCatalogChanges", () => {
  const many = (count: number, titleLength: number) => {
    const prev = Array.from({ length: count }, (_, i) => s(`s${i}`, { title: "t".repeat(titleLength), level: "300" }));
    const next = prev.map(row => ({ ...row, level: "400" }));
    return diffCatalogs(prev, next, { compareAbstracts: true });
  };
  it("keeps at most 20 highlights and counts the rest as omitted", () => {
    const summary = summarizeCatalogChanges(many(35, 20));
    expect(summary.highlights).toHaveLength(20);
    expect(summary.omitted).toBe(15);
    expect(summary.counts.changed).toBe(35);
  });
  it("shortens long titles to 100 characters", () => {
    const summary = summarizeCatalogChanges(many(1, 300));
    expect(summary.highlights[0]!.title.length).toBeLessThanOrEqual(120);
    expect(summary.highlights[0]!.title).toContain("[shortened]");
  });
  it("drops highlights, counting them as omitted, until the summary fits the budget", () => {
    const fat = { kind: "changed" as const, sessionId: "x", code: null, title: "t", fields: Array.from({ length: 2000 }, (_, i) => `field-${i}-${"y".repeat(20)}`) };
    const summary = summarizeCatalogChanges({ counts: { added: 0, removed: 0, changed: 20, unchanged: 0 }, abstractsCompared: true, changes: Array.from({ length: 20 }, () => ({ ...fat })) });
    expect(outputBytes(summary)).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
    expect(summary.highlights.length).toBeLessThan(20);
    expect(summary.highlights.length + summary.omitted).toBe(20);
  });
  it("stays under the output budget for 2000 changed rows with 300 character titles", () => {
    expect(outputBytes(summarizeCatalogChanges(many(2000, 300)))).toBeLessThan(OUTPUT_BUDGET_BYTES);
  });
});
