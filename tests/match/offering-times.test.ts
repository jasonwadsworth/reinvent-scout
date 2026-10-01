import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { registerMatchCommands } from "../../src/cli/commands/match.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { endOf } from "../../src/match/offering-time.js";
import { matchFocus } from "../../src/match/focus.js";
import { matchSessionsDetailed } from "../../src/match/match.js";
import { toLeanCandidate } from "../../src/match/response.js";
import type { ResolvedProfile } from "../../src/profile/profile.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const profile = (): ResolvedProfile => ({
  schemaVersion: 1, repos: [{ root: "repo", languages: [] }],
  services: [{ name: "AWS Lambda", catalogName: "AWS Lambda", evidence: [{ repo: "repo", file: "a.ts", line: 1 }] }],
  patterns: [], unresolvedServices: [],
});
const session = (code: string, time: Record<string, string | undefined>): Session => {
  const sessionTime = Object.fromEntries(Object.entries({ date: "2026-12-02", time: "10:00", length: "60", ...time }).filter(([, value]) => value !== undefined)) as unknown as NonNullable<Session["sessionTime"]>;
  return { sessionId: code, abbreviation: code, title: "Lambda in depth", level: "300 - Advanced", type: "Breakout session", sessionTime };
};

describe("endOf", () => {
  it("adds the length to the start, as the same local wall-clock time", () => {
    expect(endOf("2026-12-02", "10:00", 60)).toEqual({ endTime: "11:00" });
    expect(endOf("2026-12-02", "10:45", 90)).toEqual({ endTime: "12:15" });
    expect(endOf("2026-12-02", "09:05", 25)).toEqual({ endTime: "09:30" });
  });

  it("rounds a fractional length to whole minutes", () => {
    expect(endOf("2026-12-02", "10:00", 30.5)).toEqual({ endTime: "10:31" });
    expect(endOf("2026-12-02", "10:00", 29.4)).toEqual({ endTime: "10:29" });
  });

  it("says the next day when the session runs past midnight", () => {
    expect(endOf("2026-12-02", "23:30", 60)).toEqual({ endTime: "00:30", endDate: "2026-12-03" });
    expect(endOf("2026-12-31", "23:30", 60)).toEqual({ endTime: "00:30", endDate: "2027-01-01" });
  });

  it("counts every day a very long sitting spans", () => {
    expect(endOf("2026-12-02", "10:00", 3000)).toEqual({ endTime: "12:00", endDate: "2026-12-04" });
  });

  it("has no end without a start time or a usable length", () => {
    expect(endOf("2026-12-02", null, 60)).toBeUndefined();
    expect(endOf("2026-12-02", "10:00", null)).toBeUndefined();
    expect(endOf("2026-12-02", "10:00", 0)).toBeUndefined();
    expect(endOf("2026-12-02", "10:00", -30)).toBeUndefined();
    expect(endOf("2026-12-02", "10:00", 0.4)).toBeUndefined();
    expect(endOf("2026-12-02", "soon", 60)).toBeUndefined();
    expect(endOf("2026-12-02", "10:00:30", 60)).toBeUndefined();
    expect(endOf(null, "10:00", 60)).toEqual({ endTime: "11:00" });
  });
});

describe("offerings carry their length and end", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); });
  afterEach(() => { home.cleanup(); });
  const seed = (raw: Session[]) => writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: raw.length, count: raw.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
  const offeringsOf = (code: string) => matchSessionsDetailed(profile(), { storeRoot: home.path }).candidates.find(candidate => candidate.code === code)!.offerings;

  it("gives endTime for a session with a length, in the match and the lean response", () => {
    seed([session("L1", { time: "10:00", length: "75" })]);
    const [offering] = offeringsOf("L1");
    expect(offering).toMatchObject({ startTime: "10:00", endTime: "11:15" });
    expect(offering).not.toHaveProperty("lengthMinutes");
    const lean = toLeanCandidate(matchSessionsDetailed(profile(), { storeRoot: home.path }).candidates[0]!) as { offerings: Array<Record<string, unknown>> };
    expect(lean.offerings[0]).toMatchObject({ endTime: "11:15" });
    expect(lean.offerings[0]).not.toHaveProperty("lengthMinutes");
  });

  it("omits endTime when the catalog has no length", () => {
    seed([session("L2", { length: undefined })]);
    const [offering] = offeringsOf("L2");
    expect(offering).not.toHaveProperty("endTime");
    expect(offering!.startTime).toBe("10:00");
  });

  it("gives no end when there is no start time", () => {
    seed([session("L3", { time: undefined, length: "60" })]);
    const [offering] = offeringsOf("L3");
    expect(offering).not.toHaveProperty("endTime");
  });

  it("computes each sitting's own end, and the same in a focus", () => {
    seed([session("L4", { time: "09:00", length: "60" }), session("L4-R", { date: "2026-12-03", time: "15:30", length: "60" })]);
    const sittings = offeringsOf("L4");
    expect(sittings.map(offering => offering.endTime)).toEqual(["10:00", "16:30"]);
    const [entry] = matchFocus(profile(), { storeRoot: home.path }, [{ topic: "service:AWS Lambda", goal: "deepen" }]).results;
    expect(entry!.candidates[0]!.offerings.map(offering => offering.endTime)).toEqual(["10:00", "16:30"]);
  });

  it("prints the end next to the start in the match text, and the date when it passes midnight", async () => {
    seed([session("L5", { time: "10:00", length: "60" }), session("L6", { time: "23:30", length: "60" }), session("L7", { length: undefined })]);
    const printed: string[] = [];
    const program = new Command().exitOverride();
    registerMatchCommands(program, { resolveStoreRoot: () => home.path, print: (message: string) => { printed.push(message); } });
    const file = join(home.path, "profile.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, repos: [{ root: "repo", languages: [] }], services: [{ name: "AWS Lambda", evidence: [{ repo: "repo", file: "a.ts", line: 1 }] }], patterns: [] }));
    await program.parseAsync(["node", "reinvent-scout", "match", "--profile", file]);
    const text = printed.join("\n");
    expect(text).toContain("2026-12-02 -- 10:00-11:00");
    expect(text).toContain("2026-12-02 -- 23:30-00:30 (ends 2026-12-03)");
    expect(text).toMatch(/2026-12-02 -- 10:00$/m);
  });
});
