import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { ValidationError } from "../../src/core/errors.js";
import { describeLevels, validateLevels } from "../../src/match/levels.js";
import { matchFocus, type FocusChoice } from "../../src/match/focus.js";
import { mapProfile } from "../../src/match/map.js";
import { matchSessionsDetailed } from "../../src/match/match.js";
import type { ResolvedProfile } from "../../src/profile/profile.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const cite = (file: string, line = 1) => ({ repo: "repo", file, line });
const profile = (): ResolvedProfile => ({
  schemaVersion: 1, repos: [{ root: "repo", languages: [] }],
  services: [
    { name: "AWS Lambda", catalogName: "AWS Lambda", evidence: [cite("a.ts", 3)] },
    { name: "Amazon DynamoDB", catalogName: "Amazon DynamoDB", evidence: [cite("db.ts", 9)] },
    { name: "Amazon SQS", catalogName: "Amazon Simple Queue Service (Amazon SQS)", role: "supporting", evidence: [cite("q.ts", 1)] },
  ],
  patterns: [
    { name: "serverless", evidence: [cite("app.ts", 5)] },
    { name: "gap-no-dlq", note: "Not evident in the cited scope: the queue has no dead-letter queue.", evidence: [cite("q.ts", 1)] },
  ],
  unresolvedServices: [],
});
const session = (code: string, title: string, level: string, extra: Partial<Session> = {}): Session =>
  ({ sessionId: code, abbreviation: code, title, level, type: "Breakout session", ...extra });
const L100 = "100 - Foundational", L200 = "200 - Intermediate", L300 = "300 - Advanced", L400 = "400 - Expert", L500 = "500 - Distinguished";
const CATALOG: Session[] = [
  session("DDB100", "Getting started with DynamoDB", L100),
  session("DDB200", "DynamoDB basics", L200),
  session("DDB300", "DynamoDB data modeling", L300),
  session("DDB400", "DynamoDB at the limit", L400),
  session("DDB500", "DynamoDB internals", L500),
  session("LAM100", "Lambda basics", L100),
  session("LAM300", "Lambda in depth", L300),
  session("LAM400", "Lambda at scale", L400),
  session("DLQ300", "Dead-letter queues in depth", L300, { services: ["AWS Lambda", "Amazon DynamoDB"], abstract: "Recover from failures with dead-letter queues and redrive." }),
  session("DLQ400", "Dead-letter queues at scale", L400, { services: ["AWS Lambda", "Amazon DynamoDB"], abstract: "Recover from failures with dead-letter queues and redrive." }),
  session("CON300", "Running containers on Fargate", L300, { services: ["AWS Lambda"], abstract: "Start from Lambda functions and grow into containers." }),
  session("CON500", "Containers beyond Lambda", L500, { services: ["AWS Lambda"], abstract: "Start from Lambda functions and grow into containers." }),
];

describe("session levels", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); });
  afterEach(() => { home.cleanup(); });
  const seed = (raw: Session[] = CATALOG) =>
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: raw.length, count: raw.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
  const deps = () => ({ storeRoot: home.path });
  const band = (candidate: { record: { levelBand: number | null } }) => candidate.record.levelBand;
  const codes = (result: { candidates: Array<{ code: string }> }) => result.candidates.map(candidate => candidate.code);
  const HIGH = { min: 400, max: 500 };

  describe("validation", () => {
    it("takes a range of the catalog's bands, min at most max", () => {
      expect(() => validateLevels({ min: 400, max: 500 })).not.toThrow();
      expect(() => validateLevels({ min: 300, max: 300 })).not.toThrow();
      for (const bad of [{ min: 500, max: 400 }, { min: 250, max: 400 }, { min: 100, max: 600 }, { min: 0, max: 100 }, { min: 100.5, max: 200 }]) {
        expect(() => validateLevels(bad), JSON.stringify(bad)).toThrow(ValidationError);
      }
    });

    it("names a range the way the user said it", () => {
      expect(describeLevels({ min: 400, max: 500 })).toBe("400–500");
      expect(describeLevels({ min: 300, max: 300 })).toBe("300");
    });

    it("is refused by every entry point", () => {
      seed();
      const bad = { min: 500, max: 100 };
      expect(() => matchSessionsDetailed(profile(), deps(), { preferences: { levels: bad } })).toThrow(ValidationError);
      expect(() => matchFocus(profile(), deps(), [{ topic: "service:AWS Lambda", goal: "deepen" }], { preferences: { levels: bad } })).toThrow(ValidationError);
      expect(() => mapProfile(profile(), deps(), { preferences: { levels: bad } })).toThrow(ValidationError);
    });
  });

  describe("the lenses", () => {
    it("lists only sessions in range, in the order the unfiltered list has them", () => {
      seed();
      for (const lens of ["all", "fix", "next-level"] as const) {
        const everything = matchSessionsDetailed(profile(), deps(), { lens });
        const high = matchSessionsDetailed(profile(), deps(), { lens, preferences: { levels: HIGH } });
        expect(high.candidates.length, lens).toBeGreaterThan(0);
        for (const candidate of high.candidates) expect([400, 500], lens).toContain(band(candidate));
        expect(codes(high), lens).toEqual(codes(everything).filter(code => /[45]00$/.test(code)));
      }
    });

    it("applies the per-concept cap to the sessions in range, so a concept does not crowd the filtered list's first places", () => {
      // Three of each concept at 300 fill the unfiltered first ten, so every 400 session waits behind them in the unfiltered list.
      const at300 = ["Lambda design", "DynamoDB design", "Amazon SQS design", "Serverless design"].flatMap((title, k) =>
        Array.from({ length: 3 }, (_, i) => session(`A${k}${i}`, `${title} ${i}`, L300, k === 2 ? { services: ["Amazon Simple Queue Service (Amazon SQS)"] } : {})));
      const ddb400 = Array.from({ length: 5 }, (_, i) => session(`DX${i}`, `DynamoDB internals ${i}`, L400));
      seed([...at300, ...ddb400, session("LH400", "Lambda extremes", L400), session("SQ400", "Amazon SQS at scale", L400, { services: ["Amazon Simple Queue Service (Amazon SQS)"] }), session("SL400", "Serverless at the limit", L400)]);
      const high = codes(matchSessionsDetailed(profile(), deps(), { limit: 100, preferences: { levels: HIGH } }));
      expect(high).toEqual(["LH400", "SL400", "DX0", "DX1", "DX2", "SQ400", "DX3", "DX4"]);
    });

    it("fills a limit from the sessions in range, not from the top of the whole list", () => {
      seed();
      const everything = matchSessionsDetailed(profile(), deps(), { limit: 2 });
      expect(everything.candidates.some(candidate => ![400, 500].includes(band(candidate)!))).toBe(true);
      const high = matchSessionsDetailed(profile(), deps(), { limit: 2, preferences: { levels: HIGH } });
      expect(high.candidates).toHaveLength(2);
    });

    it("leaves a session with no level out", () => {
      seed([...CATALOG, session("NOLVL", "DynamoDB without a level", "")]);
      expect(codes(matchSessionsDetailed(profile(), deps(), { preferences: { levels: { min: 100, max: 500 } } }))).not.toContain("NOLVL");
      expect(codes(matchSessionsDetailed(profile(), deps()))).toContain("NOLVL");
    });

    it("echoes the filter and says when it emptied a result that had sessions", () => {
      seed();
      expect(matchSessionsDetailed(profile(), deps(), { preferences: { levels: HIGH } }).preferences).toEqual({ levels: HIGH });
      expect(matchSessionsDetailed(profile(), deps()).preferences).toBeUndefined();
      const none = matchSessionsDetailed(profile(), deps(), { lens: "fix", preferences: { levels: { min: 100, max: 200 } } });
      expect(none.candidates).toEqual([]);
      expect(none.reason).toMatch(/^\d+ sessions? match(es)?, none at 100–200$/);
      expect(matchSessionsDetailed(profile(), deps(), { preferences: { levels: HIGH } }).reason).toBeUndefined();
    });

    it("counts the sessions the filter hid, exactly", () => {
      seed();
      const everything = matchSessionsDetailed(profile(), deps(), { lens: "fix" }).candidates.length;
      const none = matchSessionsDetailed(profile(), deps(), { lens: "fix", preferences: { levels: { min: 100, max: 100 } } });
      expect(none.reason).toBe(`${everything} sessions match, none at 100`);
    });

    it("says it in the singular for one session", () => {
      seed([session("DLQ400", "Dead-letter queues at scale", L400, { services: ["AWS Lambda", "Amazon DynamoDB"], abstract: "Recover from failures with dead-letter queues and redrive." })]);
      expect(matchSessionsDetailed(profile(), deps(), { lens: "fix", preferences: { levels: { min: 100, max: 200 } } }).reason).toBe("1 session matches, none at 100\u2013200");
    });

    it("intersects explain with the introductory levels, and refuses an empty intersection", () => {
      seed();
      const both = matchSessionsDetailed(profile(), deps(), { lens: "explain", preferences: { levels: { min: 200, max: 300 } } });
      expect(both.candidates.length).toBeGreaterThan(0);
      for (const candidate of both.candidates) expect(band(candidate)).toBe(200);
      expect(() => matchSessionsDetailed(profile(), deps(), { lens: "explain", preferences: { levels: HIGH } }))
        .toThrow("explain lists introductory (100–200) sessions, which is outside 400–500; use deepen or all");
    });

    it("drops explain's closest-300-level hint when 300 is outside the filter", () => {
      seed([session("DDB300", "DynamoDB data modeling", L300), session("LAM100", "Lambda basics", L100)]);
      const hinted = matchSessionsDetailed(profile(), deps(), { lens: "explain" });
      expect(hinted.uncovered!.find(entry => entry.concept === "Amazon DynamoDB")!.reason).toContain("the closest is a 300-level one");
      const filtered = matchSessionsDetailed(profile(), deps(), { lens: "explain", preferences: { levels: { min: 100, max: 200 } } });
      expect(filtered.uncovered!.find(entry => entry.concept === "Amazon DynamoDB")!.reason).not.toContain("300-level");
    });
  });

  describe("the map and focus", () => {
    const choices = (): FocusChoice[] => [
      { topic: "service:Amazon DynamoDB", goal: "understand" }, { topic: "service:Amazon DynamoDB", goal: "deepen" },
      { topic: "service:AWS Lambda", goal: "deepen" }, { topic: "gap:gap-no-dlq", goal: "improve" }, { topic: "path:serverless", goal: "improve" },
    ];

    it("lists only sessions in range, and counts equal the focus totals under the same filter", () => {
      seed();
      const map = mapProfile(profile(), deps(), { preferences: { levels: HIGH } });
      const counts = new Map([...map.services, ...map.patterns, ...map.gaps, ...map.nextSteps].flatMap((topic: { id: string; goals: Array<{ goal: string; sessions: number }> }) => topic.goals.map(goal => [`${topic.id}|${goal.goal}`, goal.sessions] as const)));
      for (const choice of choices().slice(1)) {
        const [entry] = matchFocus(profile(), deps(), [choice], { preferences: { levels: HIGH }, perTopic: 10 }).results;
        expect(entry!.total, `${choice.topic} ${choice.goal}`).toBe(counts.get(`${choice.topic}|${choice.goal}`));
        for (const candidate of entry!.candidates) expect([400, 500]).toContain(band(candidate));
      }
      expect(counts.get("service:Amazon DynamoDB|deepen")).toBe(2);
    });

    it("explains a goal the filter emptied, with the count it hid", () => {
      seed();
      const everything = mapProfile(profile(), deps()).services.find(topic => topic.id === "service:Amazon DynamoDB")!.goals.find(goal => goal.goal === "deepen")!.sessions;
      const only200 = mapProfile(profile(), deps(), { preferences: { levels: { min: 200, max: 200 } } }).services.find(topic => topic.id === "service:AWS Lambda")!;
      expect(only200.goals.find(goal => goal.goal === "deepen")).toMatchObject({ sessions: 0, reason: expect.stringMatching(/^\d+ sessions? match(es)?, none at 200$/) });
      expect(everything).toBeGreaterThan(0);
      const [entry] = matchFocus(profile(), deps(), [{ topic: "service:AWS Lambda", goal: "deepen" }], { preferences: { levels: { min: 200, max: 200 } } }).results;
      expect(entry).toMatchObject({ total: 0, candidates: [] });
      expect(entry!.reason).toMatch(/^\d+ sessions? match(es)?, none at 200$/);
    });

    it("keeps understand introductory: 0 sessions, with why, when the filter is above 200", () => {
      seed();
      const map = mapProfile(profile(), deps(), { preferences: { levels: HIGH } });
      const understand = map.services.find(topic => topic.id === "service:Amazon DynamoDB")!.goals.find(goal => goal.goal === "understand")!;
      expect(understand).toEqual({ goal: "understand", sessions: 0, reason: "understand lists introductory (100–200) sessions, which is outside 400–500; use deepen" });
      const [entry] = matchFocus(profile(), deps(), [{ topic: "service:Amazon DynamoDB", goal: "understand" }], { preferences: { levels: HIGH } }).results;
      expect(entry).toMatchObject({ total: 0, reason: understand.reason });
      const both = matchFocus(profile(), deps(), [{ topic: "service:Amazon DynamoDB", goal: "understand" }], { preferences: { levels: { min: 200, max: 400 } } }).results[0]!;
      expect(codes(both)).toEqual(["DDB200"]);
    });

    it("echoes the filter, and only when there is one", () => {
      seed();
      expect(mapProfile(profile(), deps(), { preferences: { levels: HIGH } }).preferences).toEqual({ levels: HIGH });
      expect("preferences" in mapProfile(profile(), deps())).toBe(false);
      expect(matchFocus(profile(), deps(), choices().slice(1, 2), { preferences: { levels: HIGH } }).preferences).toEqual({ levels: HIGH });
      expect("preferences" in matchFocus(profile(), deps(), choices().slice(1, 2))).toBe(false);
    });

    it("dedupes on the filtered lists, so a session past an earlier choice's cap still shows under a later one", () => {
      seed();
      const result = matchFocus(profile(), deps(), [{ topic: "service:AWS Lambda", goal: "deepen" }, { topic: "service:Amazon DynamoDB", goal: "deepen" }], { preferences: { levels: HIGH }, perTopic: 1 });
      for (const entry of result.results) for (const candidate of entry.candidates) expect([400, 500]).toContain(band(candidate));
      expect(result.results.every(entry => entry.candidates.length === 1)).toBe(true);
    });
  });
});
