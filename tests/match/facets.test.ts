import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { matchFocus } from "../../src/match/focus.js";
import { mapProfile } from "../../src/match/map.js";
import { matchSessionsDetailed } from "../../src/match/match.js";
import { describePreferences, formatNote, resolvePreferences, type SessionPreferences } from "../../src/match/preferences.js";
import type { ResolvedProfile } from "../../src/profile/profile.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const cite = (file: string) => ({ repo: "repo", file, line: 1 });
const profile = (): ResolvedProfile => ({
  schemaVersion: 1, repos: [{ root: "repo", languages: [] }],
  services: [{ name: "AWS Lambda", catalogName: "AWS Lambda", evidence: [cite("a.ts")] }, { name: "Amazon DynamoDB", catalogName: "Amazon DynamoDB", evidence: [cite("db.ts")] }],
  patterns: [{ name: "serverless", evidence: [cite("app.ts")] }],
  unresolvedServices: [],
});
const MGM = "MGM Grand", VEN = "Venetian", WYN = "Wynn/Encore";
const s = (code: string, title: string, extra: Partial<Session> = {}): Session =>
  ({ sessionId: code, abbreviation: code, title, level: "300 - Advanced", type: "Breakout session", ...extra });
const at = (venue: string | undefined, date: string | undefined, extra: Partial<Session> = {}): Partial<Session> =>
  ({ ...(venue === undefined ? {} : { venue }), ...(date === undefined ? {} : { sessionTime: { date, time: "10:00", length: "60" } }), ...extra });
const CATALOG: Session[] = [
  s("M1", "DynamoDB at MGM", at(MGM, "2026-12-01", { topics: ["Databases"], roles: ["Developer"] })),
  s("M2", "Lambda at MGM", at(MGM, "2026-12-02", { type: "Chalk talk", topics: ["Serverless"] })),
  s("V1", "DynamoDB at the Venetian", at(VEN, "2026-12-01", { type: "Chalk talk", topics: ["Databases", "Serverless"] })),
  s("V2", "Lambda at the Venetian", at(VEN, "2026-12-03", { topics: ["Serverless"] })),
  s("W1", "DynamoDB at Wynn", at(WYN, "2026-12-02", { topics: ["Databases"] })),
  s("N1", "DynamoDB nowhere", at(undefined, "2026-12-02", { topics: ["Databases"] })),
  s("U1", "DynamoDB unscheduled", at(MGM, undefined)),
];

describe("facet preferences", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); });
  afterEach(() => { home.cleanup(); });
  const seed = (raw: Session[] = CATALOG) =>
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: raw.length, count: raw.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
  const deps = () => ({ storeRoot: home.path });
  const run = (preferences?: SessionPreferences) => matchSessionsDetailed(profile(), deps(), { limit: 100, ...(preferences === undefined ? {} : { preferences }) });
  const codes = (result: { candidates: Array<{ code: string }> }) => result.candidates.map(candidate => candidate.code);
  const index = () => CATALOG.map(buildIndexRecord);
  const only = (field: "venue" | "day" | "topic" | "role" | "area" | "industry" | "format", value: string, levels?: { min: number; max: number }) =>
    ({ field, value, action: "only" as const, ...(levels === undefined ? {} : { levels }) });

  describe("only", () => {
    it("keeps just the sessions with the value, and drops those with none", () => {
      seed();
      expect(codes(run({ rules: [only("venue", "mgm")] })).sort()).toEqual(["M1", "M2", "U1"]);
    });

    it("is a union within a field", () => {
      seed();
      expect(codes(run({ rules: [only("venue", "mgm"), only("venue", "venetian")] })).sort()).toEqual(["M1", "M2", "U1", "V1", "V2"]);
    });

    it("is an intersection across fields", () => {
      seed();
      expect(codes(run({ rules: [only("venue", "mgm"), only("venue", "venetian"), only("day", "2026-12-01")] })).sort()).toEqual(["M1", "V1"]);
    });

    it("matches a multi-valued field when any value does", () => {
      seed();
      expect(codes(run({ rules: [only("topic", "serverless")] })).sort()).toEqual(["M2", "V1", "V2"]);
    });

    it("applies only to sessions in the rule's own level range", () => {
      seed([...CATALOG, s("L1", "DynamoDB basics at Wynn", at(WYN, "2026-12-01", { level: "100 - Foundational" }))]);
      // The rule is about 300-level sessions only, so the 100-level one is not constrained by it.
      expect(codes(run({ rules: [only("venue", "mgm", { min: 300, max: 300 })] })).sort()).toEqual(["L1", "M1", "M2", "U1"]);
    });

    it("says what it emptied", () => {
      seed();
      const result = run({ rules: [only("venue", "wynn"), only("day", "2026-12-03")] });
      expect(result.candidates).toEqual([]);
      expect(result.reason).toBe(`${run().candidates.length} sessions match, none with venue Wynn/Encore or day 2026-12-03`);
    });
  });

  describe("exclude", () => {
    it("removes by any field", () => {
      seed();
      expect(codes(run({ rules: [{ field: "day", value: "2026-12-02", action: "exclude" }, { field: "venue", value: "venetian", action: "exclude" }] })).sort()).toEqual(["M1", "U1"]);
    });
  });

  describe("prefer and avoid", () => {
    it("moves a session by its venue", () => {
      seed();
      expect(codes(run({ rules: [{ field: "venue", value: "wynn", action: "prefer" }] }))[0]).toBe("W1");
      expect(codes(run({ rules: [{ field: "venue", value: "wynn", action: "avoid" }] })).at(-1)).toBe("W1");
    });

    it("adds up across fields: a session both fields prefer comes before one only one prefers", () => {
      seed();
      const both: SessionPreferences = { rules: [{ field: "format", value: "chalk", action: "prefer" }, { field: "venue", value: "venetian", action: "prefer" }] };
      const result = codes(run(both));
      expect(result[0]).toBe("V1");
      expect(result.indexOf("M2")).toBeLessThan(result.indexOf("M1"));
      expect(result.indexOf("V2")).toBeLessThan(result.indexOf("M1"));
    });

    it("cancels a preference against an avoidance on another field", () => {
      seed();
      const plain = codes(run());
      const result = codes(run({ rules: [{ field: "format", value: "chalk", action: "prefer" }, { field: "venue", value: "venetian", action: "avoid" }] }));
      // M2 is only preferred and V2 only avoided; V1 is both, so it is neutral and keeps its place among the neutral sessions.
      expect(result[0]).toBe("M2");
      expect(result.at(-1)).toBe("V2");
      const neutral = (list: string[]) => list.filter(code => !["M2", "V2"].includes(code));
      expect(neutral(result)).toEqual(neutral(plain));
    });

    it("lets the first matching rule decide within a field", () => {
      seed();
      const avoidFirst = codes(run({ rules: [{ field: "venue", value: "venetian", action: "avoid" }, { field: "venue", value: "venetian", action: "prefer" }] }));
      expect(avoidFirst.slice(-2).sort()).toEqual(["V1", "V2"]);
      const preferFirst = codes(run({ rules: [{ field: "venue", value: "venetian", action: "prefer" }, { field: "venue", value: "venetian", action: "avoid" }] }));
      expect(preferFirst.slice(0, 2).sort()).toEqual(["V1", "V2"]);
    });

    it("does not change what a map counts", () => {
      seed();
      const counts = (preferences?: SessionPreferences) => JSON.stringify(mapProfile(profile(), deps(), preferences === undefined ? {} : { preferences }).services.map(topic => topic.goals));
      expect(counts({ rules: [{ field: "venue", value: "wynn", action: "prefer" }, { field: "day", value: "2026-12-01", action: "avoid" }] })).toBe(counts());
    });
  });

  describe("naming values", () => {
    it("resolves each field against its own vocabulary, in any case or as a prefix", () => {
      const resolve = (field: "venue" | "day" | "topic" | "role", value: string) => resolvePreferences({ rules: [{ field, value, action: "only" }] }, index())!.rules![0]!.value;
      expect(resolve("venue", "MGM")).toBe(MGM);
      expect(resolve("venue", "wynn")).toBe(WYN);
      expect(resolve("day", "2026-12-03")).toBe("2026-12-03");
      expect(resolve("topic", "data")).toBe("Databases");
      expect(resolve("role", "dev")).toBe("Developer");
    });

    it("lists the closest values for one that does not resolve, and points at list_filters", () => {
      expect(() => resolvePreferences({ rules: [{ field: "venue", value: "Bellagio", action: "only" }] }, index())).toThrow(/Unknown venue "Bellagio"\. Values in the catalog: .*Venetian.*`list_filters`/);
      expect(() => resolvePreferences({ rules: [{ field: "topic", value: "base", action: "only" }] }, index())).toThrow(/Closest values: Databases/);
    });

    it("offers the values that contain what was typed before the commonest ones", () => {
      const records = [...Array.from({ length: 20 }, (_, i) => s(`J${i}`, "t", { topics: [`Junk ${i}`, `Junk ${i}`] })), s("Z1", "t", { topics: ["Zebra Databases"] })].map(buildIndexRecord);
      expect(() => resolvePreferences({ rules: [{ field: "topic", value: "databases", action: "only" }] }, records)).toThrow('Closest values: Zebra Databases (`list_filters`');
    });

    it("refuses an ambiguous prefix and an unknown field or action", () => {
      expect(() => resolvePreferences({ rules: [{ field: "day", value: "2026-12-0", action: "only" }] }, index())).toThrow(/The day "2026-12-0" is ambiguous/);
      expect(() => resolvePreferences({ rules: [{ field: "colour" as never, value: "red", action: "only" }] }, index())).toThrow(/field must be one of/);
      expect(() => resolvePreferences({ rules: [{ field: "venue", value: "mgm", action: "love" as never }] }, index())).toThrow(/action must be one of only, prefer, avoid, exclude/);
    });

    it("leaves a rule with no values to resolve against refused, not silently dropped", () => {
      expect(() => resolvePreferences({ rules: [{ field: "area", value: "anything", action: "only" }] }, index())).toThrow(/Unknown area of interest "anything"/);
    });
  });

  describe("why and the readable line", () => {
    const record = (venue: string, type: string) => buildIndexRecord(s("X", "t", at(venue, "2026-12-01", { type })));
    it("names every preference that moved the session", () => {
      const prefs: SessionPreferences = { rules: [{ field: "format", value: "Chalk talk", action: "prefer" }, { field: "venue", value: MGM, action: "prefer" }] };
      expect(formatNote(prefs, record(MGM, "Chalk talk"))).toBe("a chalk talk at MGM Grand, which you prefer");
      expect(formatNote(prefs, record(VEN, "Chalk talk"))).toBe("a chalk talk, which you prefer");
      expect(formatNote(prefs, record(VEN, "Breakout session"))).toBeUndefined();
    });

    it("says both directions when the fields disagree", () => {
      const prefs: SessionPreferences = { rules: [{ field: "format", value: "Chalk talk", action: "prefer" }, { field: "venue", value: VEN, action: "avoid", levels: { min: 300, max: 500 } }] };
      expect(formatNote(prefs, record(VEN, "Chalk talk"))).toBe("a chalk talk, which you prefer; ranked lower: at Venetian, which you asked to avoid at 300–500");
    });

    it("says the filters in the readable line", () => {
      expect(describePreferences({ rules: [{ field: "venue", value: MGM, action: "only" }, { field: "venue", value: VEN, action: "only" }, { field: "topic", value: "Serverless", action: "exclude" }, { field: "format", value: "Chalk talk", action: "prefer" }] }))
        .toBe("Only venue MGM Grand, venue Venetian. Preferring chalk talks. Excluding topic Serverless.");
    });
  });

  describe("the map and focus", () => {
    it("counts under only, and the focus totals equal the counts", () => {
      seed();
      const preferences: SessionPreferences = { rules: [only("venue", "mgm")] };
      const map = mapProfile(profile(), deps(), { preferences });
      const plain = mapProfile(profile(), deps());
      const sum = (m: typeof map) => m.services.flatMap(topic => topic.goals).reduce((total, goal) => total + goal.sessions, 0);
      expect(sum(map)).toBeLessThan(sum(plain));
      for (const topic of [...map.services, ...map.patterns]) {
        for (const goal of topic.goals) {
          const [entry] = matchFocus(profile(), deps(), [{ topic: topic.id, goal: goal.goal }], { preferences, perTopic: 10 }).results;
          expect(entry!.total, `${topic.id} ${goal.goal}`).toBe(goal.sessions);
          for (const candidate of entry!.candidates) expect(candidate.record.venue).toBe(MGM);
        }
      }
      expect(map.preferences).toEqual({ rules: [{ field: "venue", value: MGM, action: "only" }] });
    });
  });
});
