import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { ValidationError } from "../../src/core/errors.js";
import { describePreferences, formatNote, resolvePreferences, type SessionPreferences } from "../../src/match/preferences.js";
import { matchFocus } from "../../src/match/focus.js";
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
const CHALK = "Chalk talk", BREAKOUT = "Breakout session", WORKSHOP = "Workshop", LIGHTNING = "Lightning talk", CODE = "Code talk";
const L200 = "200 - Intermediate", L300 = "300 - Advanced", L400 = "400 - Expert";
const s = (code: string, title: string, level: string, type: string, extra: Partial<Session> = {}): Session =>
  ({ sessionId: code, abbreviation: code, title, level, type, ...extra });
const DLQ = { services: ["AWS Lambda", "Amazon DynamoDB"], abstract: "Recover from failures with dead-letter queues and redrive." };
const CATALOG: Session[] = [
  // The breakouts name the service in the title, so they match more strongly than the chalk talks, which only mention it.
  s("B1", "DynamoDB data modeling", L300, BREAKOUT),
  s("B2", "DynamoDB essentials", L200, BREAKOUT),
  s("B3", "Lambda in depth", L400, BREAKOUT),
  s("C1", "Data at scale", L400, CHALK, { services: ["Amazon DynamoDB"], abstract: "You will use DynamoDB tables." }),
  s("C2", "Functions at scale", L200, CHALK, { services: ["AWS Lambda"], abstract: "You will use Lambda." }),
  s("W1", "DynamoDB hands-on workshop", L400, WORKSHOP),
  s("W2", "Lambda first steps workshop", L200, WORKSHOP),
  s("X1", "Lambda quick tour", L200, LIGHTNING),
  s("X2", "DynamoDB code walk", L300, CODE),
  s("D1", "Dead-letter queues in depth", L300, BREAKOUT, DLQ),
  s("D2", "Reliability patterns", L300, CHALK, DLQ),
  s("D3", "Redrive and dead-letter queues", L400, WORKSHOP, DLQ),
  s("P1", "Running containers on Fargate", L300, BREAKOUT, { services: ["AWS Lambda"], abstract: "Start from Lambda functions and grow into containers." }),
  s("P2", "Moving from functions to containers", L300, CHALK, { services: ["AWS Lambda"], abstract: "Start from Lambda functions and grow into containers." }),
  s("C3", "DynamoDB explained", L200, CHALK),
  s("ZC4", "Lambda for builders", L200, CHALK),
  s("ZC5", "Amazon SQS explained", L200, CHALK, { services: ["Amazon Simple Queue Service (Amazon SQS)"] }),
  s("S1", "Lambda at scale (sponsored by Acme)", L300, CHALK),
];

describe("session type preferences", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); });
  afterEach(() => { home.cleanup(); });
  const seed = (raw: Session[] = CATALOG) =>
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: raw.length, count: raw.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
  const deps = () => ({ storeRoot: home.path });
  const types = (list: Array<{ record: { type: string | null } }>) => list.map(candidate => candidate.record.type);
  const run = (lens: "all" | "explain" | "fix" | "next-level", preferences?: SessionPreferences) =>
    matchSessionsDetailed(profile(), deps(), { lens, limit: 100, ...(preferences === undefined ? {} : { preferences }) });
  const codes = (result: { candidates: Array<{ code: string }> }) => result.candidates.map(candidate => candidate.code);
  const LENSES = ["all", "explain", "fix", "next-level"] as const;
  const index = () => CATALOG.map(buildIndexRecord);

  describe("the rules", () => {
    it("names a type the way the catalog does: any case, or a unique prefix", () => {
      const resolve = (type: string) => resolvePreferences({ rules: [{ field: "format", value: type, action: "prefer" }] }, index())!.rules![0]!.value;
      expect(resolve("chalk talk")).toBe(CHALK);
      expect(resolve("CHALK TALK")).toBe(CHALK);
      expect(resolve("chalk")).toBe(CHALK);
      expect(resolve("break")).toBe(BREAKOUT);
      expect(resolve("work")).toBe(WORKSHOP);
    });

    it("takes an exact name before a longer one it begins", () => {
      const records = ["Lab", "Labs special"].map((type, i) => buildIndexRecord(s(`L${i}`, "x", L200, type)));
      expect(resolvePreferences({ rules: [{ field: "format", value: "lab", action: "avoid" }] }, records)!.rules![0]!.value).toBe("Lab");
      expect(resolvePreferences({ rules: [{ field: "format", value: "labs", action: "avoid" }] }, records)!.rules![0]!.value).toBe("Labs special");
    });

    it("says an before a vowel", () => {
      const record = buildIndexRecord(s("E1", "x", L200, "Exam prep"));
      expect(formatNote({ rules: [{ field: "format", value: "Exam prep", action: "prefer" }] }, record)).toBe("an exam prep, which you prefer");
      expect(formatNote({ rules: [{ field: "format", value: "Exam prep", action: "avoid" }] }, record)).toBe("ranked lower: an exam prep, which you asked to avoid");
    });

    it("refuses an unknown type, naming the catalog's", () => {
      expect(() => resolvePreferences({ rules: [{ field: "format", value: "keynote", action: "avoid" }] }, index())).toThrow(/Unknown format "keynote".*Chalk talk/);
    });

    it("refuses a prefix that names two types", () => {
      expect(() => resolvePreferences({ rules: [{ field: "format", value: "c", action: "avoid" }] }, index())).toThrow(/"c" is ambiguous: Chalk talk, Code talk/);
    });

    it("refuses a bad action and a bad level range in a rule", () => {
      expect(() => resolvePreferences({ rules: [{ field: "format", value: "chalk", action: "love" as never }] }, index())).toThrow(ValidationError);
      expect(() => resolvePreferences({ rules: [{ field: "format", value: "chalk", action: "avoid", levels: { min: 500, max: 300 } }] }, index())).toThrow(/min must not be above max/);
    });

    it("keeps rules in order with the type spelled as the catalog spells it, and drops an empty preference", () => {
      const rules = [{ field: "format" as const, value: "chalk", action: "prefer" as const }, { field: "format" as const, value: "breakout", action: "avoid" as const, levels: { min: 300, max: 500 } }];
      expect(resolvePreferences({ rules: rules }, index())).toEqual({ rules: [{ field: "format", value: CHALK, action: "prefer" }, { field: "format", value: BREAKOUT, action: "avoid", levels: { min: 300, max: 500 } }] });
      expect(resolvePreferences({ rules: [] }, index())).toBeUndefined();
      expect(resolvePreferences({}, index())).toBeUndefined();
    });

    it("says what is applied, in a line", () => {
      expect(describePreferences({ levels: { min: 400, max: 500 }, rules: [{ field: "format", value: CHALK, action: "prefer" }, { field: "format", value: BREAKOUT, action: "avoid", levels: { min: 300, max: 500 } }, { field: "format", value: WORKSHOP, action: "exclude" }] }))
        .toBe("Only sessions at level 400–500. Preferring chalk talks. Avoiding breakout sessions at 300–500. Excluding workshops.");
    });
  });

  describe("exclude", () => {
    it("removes the type from every lens", () => {
      seed();
      for (const lens of LENSES) {
        const result = run(lens, { rules: [{ field: "format", value: "workshop", action: "exclude" }, { field: "format", value: "chalk talk", action: "exclude" }] });
        expect(result.candidates.length, lens).toBeGreaterThan(0);
        expect(types(result.candidates), lens).not.toContain(WORKSHOP);
        expect(types(result.candidates), lens).not.toContain(CHALK);
      }
    });

    it("only removes sessions in the rule's own level range", () => {
      seed();
      const result = run("all", { rules: [{ field: "format", value: "workshop", action: "exclude", levels: { min: 400, max: 500 } }] });
      expect(codes(result)).toContain("W2");
      expect(codes(result)).not.toContain("W1");
    });

    it("says what it emptied", () => {
      seed();
      const all = run("fix").candidates.length;
      const none = run("fix", { rules: ["Breakout session", "Chalk talk", "Workshop"].map(value => ({ field: "format" as const, value, action: "exclude" as const })) });
      expect(none.candidates).toEqual([]);
      expect(none.reason).toBe(`${all} sessions match, none after excluding Breakout session, Chalk talk, Workshop`);
    });
  });

  describe("prefer and avoid", () => {
    it("puts every preferred session ahead of every other, in each lens, even one that matches less strongly", () => {
      seed();
      for (const lens of LENSES) {
        const plain = run(lens);
        const result = run(lens, { rules: [{ field: "format", value: "chalk talk", action: "prefer" }] });
        expect(codes(result).slice().sort(), lens).toEqual(codes(plain).slice().sort());
        const kept = result.candidates.filter(c => c.demoted === undefined).map(c => c.record.type === CHALK);
        expect(kept.includes(true), lens).toBe(true);
        expect(kept, lens).toEqual([...kept].sort((x, y) => Number(y) - Number(x)));
        expect(codes(result), `${lens} reordered`).not.toEqual(codes(plain));
      }
    });

    it("keeps the existing order within a tier", () => {
      seed();
      for (const lens of ["all", "fix", "next-level"] as const) {
        const plain = codes(run(lens));
        const result = run(lens, { rules: [{ field: "format", value: "chalk talk", action: "prefer" }] });
        const chalk = result.candidates.filter(c => c.record.type === CHALK && c.demoted === undefined).map(c => c.code);
        expect(chalk, lens).toEqual(plain.filter(code => chalk.includes(code)));
        const rest = result.candidates.filter(c => c.record.type !== CHALK && c.demoted === undefined).map(c => c.code);
        expect(rest, lens).toEqual(plain.filter(code => rest.includes(code)));
      }
    });

    it("puts an avoided session behind the neutral ones, and leaves one outside the rule's levels where it was", () => {
      seed();
      const result = run("all", { rules: [{ field: "format", value: "breakout session", action: "avoid", levels: { min: 300, max: 500 } }] });
      const undemoted = result.candidates.filter(c => c.demoted === undefined);
      const position = (code: string) => undemoted.findIndex(c => c.code === code);
      for (const neutral of ["B2", "C1", "C2", "W1"]) expect(position(neutral), neutral).toBeLessThan(position("B1"));
      expect(position("B3")).toBeGreaterThan(position("C2"));
      const plain = run("all").candidates.filter(c => c.demoted === undefined);
      expect(plain.findIndex(c => c.code === "B2")).toBeLessThan(plain.findIndex(c => c.code === "C1"));
      expect(position("B2")).toBeLessThan(position("C1"));
    });

    it("applies the first rule that matches a session", () => {
      seed();
      const result = run("all", { rules: [{ field: "format", value: "chalk talk", action: "avoid", levels: { min: 300, max: 500 } }, { field: "format", value: "chalk talk", action: "prefer" }] });
      const undemoted = result.candidates.filter(c => c.demoted === undefined).map(c => c.code);
      expect(undemoted.indexOf("C2")).toBeLessThan(undemoted.indexOf("B2"));
      expect(undemoted.indexOf("C1")).toBeGreaterThan(undemoted.indexOf("B3"));
    });

    it("puts a preferred session the per-concept cap holds back ahead of every neutral one", () => {
      const chalk = Array.from({ length: 5 }, (_, i) => s(`LC${i}`, `Lambda deep dive ${i}`, L300, CHALK));
      seed([...chalk, s("NB1", "DynamoDB essentials", L300, BREAKOUT), s("NB2", "Amazon SQS essentials", L300, BREAKOUT, { services: ["Amazon Simple Queue Service (Amazon SQS)"] }), s("NB3", "Serverless essentials", L300, BREAKOUT)]);
      const plain = codes(run("all"));
      // Without a preference the cap holds the fourth Lambda session behind the other concepts' sessions.
      expect(plain.indexOf("LC3")).toBeGreaterThan(plain.indexOf("NB3"));
      const result = codes(run("all", { rules: [{ field: "format", value: "chalk talk", action: "prefer" }] }));
      expect(result.slice(0, 5).sort()).toEqual(["LC0", "LC1", "LC2", "LC3", "LC4"]);
    });

    it("keeps a demoted session behind every undemoted one, preferred or not", () => {
      seed();
      const result = run("all", { rules: [{ field: "format", value: "chalk talk", action: "prefer" }] });
      const demoted = result.candidates.findIndex(c => c.code === "S1");
      expect(demoted).toBeGreaterThan(-1);
      expect(result.candidates.slice(demoted).every(c => c.demoted !== undefined)).toBe(true);
    });

    it("prefers within a focus's deepen and improve lists, and understand", () => {
      seed();
      const choices = [{ topic: "service:Amazon DynamoDB", goal: "deepen" as const }, { topic: "gap:gap-no-dlq", goal: "improve" as const }, { topic: "service:AWS Lambda", goal: "understand" as const }];
      const plain = matchFocus(profile(), deps(), choices, { perTopic: 10 });
      const chalk = matchFocus(profile(), deps(), choices, { perTopic: 10, preferences: { rules: [{ field: "format", value: "chalk talk", action: "prefer" }] } });
      for (const [position, entry] of chalk.results.entries()) {
        expect(entry.total).toBe(plain.results[position]!.total);
        const kinds = types(entry.candidates);
        if (kinds.includes(CHALK)) expect(kinds[0]).toBe(CHALK);
      }
      expect(chalk.results[1]!.candidates[0]!.code).toBe("D2");
      // The explain lens already favors chalk talks a little; a preferred lightning talk still outranks them.
      const lightning = matchFocus(profile(), deps(), choices.slice(2), { perTopic: 10, preferences: { rules: [{ field: "format", value: "lightning talk", action: "prefer" }] } });
      expect(plain.results[2]!.candidates[0]!.code).toBe("ZC4");
      expect(lightning.results[0]!.candidates[0]!.code).toBe("X1");
      for (const entry of chalk.results) expect(entry.candidates.find(candidate => candidate.record.type === CHALK)!.why.summary).toMatch(/\(a chalk talk, which you prefer\)\.$/);
      expect(plain.results[1]!.candidates[0]!.code).not.toBe("D2");
    });
  });

  describe("why", () => {
    const summaryOf = (result: ReturnType<typeof run>, code: string) => result.candidates.find(c => c.code === code)!.why.summary;
    it("says a preferred session is one, and an avoided one ranks lower and why", () => {
      seed();
      const result = run("all", { rules: [{ field: "format", value: "chalk talk", action: "prefer" }, { field: "format", value: "breakout session", action: "avoid", levels: { min: 300, max: 500 } }, { field: "format", value: "workshop", action: "avoid" }] });
      expect(summaryOf(result, "C1")).toMatch(/ \(a chalk talk, which you prefer\)\.$/);
      expect(summaryOf(result, "B1")).toMatch(/ \(ranked lower: a breakout session, which you asked to avoid at 300–500\)\.$/);
      expect(summaryOf(result, "W1")).toMatch(/ \(ranked lower: a workshop, which you asked to avoid\)\.$/);
      expect(summaryOf(result, "B2")).not.toMatch(/prefer|avoid/);
    });

    it("says it under every lens, and says nothing without preferences", () => {
      seed();
      for (const lens of LENSES) {
        const result = run(lens, { rules: [{ field: "format", value: "chalk talk", action: "prefer" }] });
        const chalk = result.candidates.find(c => c.record.type === CHALK)!;
        expect(chalk.why.summary, lens).toMatch(/\(a chalk talk, which you prefer\)\.$/);
        expect(run(lens).candidates.every(c => !/prefer|asked to avoid/.test(c.why.summary)), lens).toBe(true);
      }
    });
  });

  describe("the map", () => {
    const counts = (map: ReturnType<typeof mapProfile>) => [...map.services, ...map.patterns, ...map.gaps, ...map.nextSteps].flatMap(topic => topic.goals.map(goal => `${topic.id}|${goal.goal}|${goal.sessions}`));
    it("counts under exclude, and does not change under prefer and avoid", () => {
      seed();
      const plain = counts(mapProfile(profile(), deps()));
      expect(counts(mapProfile(profile(), deps(), { preferences: { rules: [{ field: "format", value: "chalk talk", action: "prefer" }, { field: "format", value: "workshop", action: "avoid" }] } }))).toEqual(plain);
      const excluded = counts(mapProfile(profile(), deps(), { preferences: { rules: [{ field: "format", value: "breakout session", action: "exclude" }] } }));
      expect(excluded).not.toEqual(plain);
      const total = (list: string[]) => list.reduce((sum, entry) => sum + Number(entry.split("|")[2]), 0);
      expect(total(excluded)).toBeLessThan(total(plain));
    });

    it("equals the focus totals under the same exclude", () => {
      seed();
      const preferences: SessionPreferences = { levels: { min: 200, max: 400 }, rules: [{ field: "format", value: "workshop", action: "exclude" }] };
      const map = mapProfile(profile(), deps(), { preferences });
      for (const topic of [...map.services, ...map.patterns, ...map.gaps, ...map.nextSteps]) {
        for (const goal of topic.goals) {
          const [entry] = matchFocus(profile(), deps(), [{ topic: topic.id, goal: goal.goal }], { preferences, perTopic: 10 }).results;
          expect(entry!.total, `${topic.id} ${goal.goal}`).toBe(goal.sessions);
        }
      }
    });

    it("echoes the rules the way the catalog spells the types", () => {
      seed();
      expect(mapProfile(profile(), deps(), { preferences: { rules: [{ field: "format", value: "chalk", action: "prefer" }] } }).preferences).toEqual({ rules: [{ field: "format", value: CHALK, action: "prefer" }] });
      expect(matchFocus(profile(), deps(), [{ topic: "service:AWS Lambda", goal: "deepen" }], { preferences: { rules: [{ field: "format", value: "chalk", action: "prefer" }] } }).preferences).toEqual({ rules: [{ field: "format", value: CHALK, action: "prefer" }] });
      expect(run("all", { rules: [{ field: "format", value: "chalk", action: "prefer" }] }).preferences).toEqual({ rules: [{ field: "format", value: CHALK, action: "prefer" }] });
    });
  });
});
