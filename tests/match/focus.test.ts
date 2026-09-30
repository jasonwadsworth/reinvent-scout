import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { ValidationError } from "../../src/core/errors.js";
import { mapProfile } from "../../src/match/map.js";
import { matchFocus } from "../../src/match/focus.js";
import type { ResolvedProfile } from "../../src/profile/profile.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const cite = (file: string, line = 1) => ({ repo: "repo", file, line });
const base = (): ResolvedProfile => ({
  schemaVersion: 1, repos: [{ root: "repo", languages: [] }],
  services: [
    { name: "AWS Lambda", catalogName: "AWS Lambda", usage: "Every handler runs on Lambda. Second sentence.", evidence: [cite("a.ts", 3), cite("b.ts", 4), cite("c.ts", 5), cite("d.ts", 6)] },
    { name: "Amazon DynamoDB", catalogName: "Amazon DynamoDB", evidence: [cite("db.ts", 9), cite("db2.ts", 2)] },
    { name: "Amazon SQS", catalogName: "Amazon Simple Queue Service (Amazon SQS)", role: "supporting", evidence: [cite("q.ts", 1)] },
    { name: "Amazon CloudWatch", catalogName: "Amazon CloudWatch", evidence: [cite("w.ts", 1)] },
  ],
  patterns: [
    { name: "serverless", note: "No servers anywhere.", evidence: [cite("app.ts", 5)] },
    { name: "event-driven", evidence: [cite("bus.ts", 6)] },
    { name: "gap-no-dlq", note: "Not evident in the cited scope: the queue has no dead-letter queue.", evidence: [cite("q.ts", 1)] },
    { name: "gap-invented", evidence: [cite("x.ts", 1)] },
    { name: "dead-code", evidence: [cite("old.ts", 1)] },
  ],
  unresolvedServices: [],
});
const session = (code: string, title: string, extra: Partial<Session> = {}): Session =>
  ({ sessionId: code, abbreviation: code, title, level: "200 - Intermediate", type: "Breakout session", ...extra });
const CATALOG: Session[] = [
  session("DDB100", "Getting started with DynamoDB", { level: "100 - Foundational" }),
  session("DDB300", "DynamoDB data modeling", { level: "300 - Advanced" }),
  session("LAM200", "Lambda basics"),
  session("LAM201", "Lambda and DynamoDB together", { services: ["AWS Lambda", "Amazon DynamoDB"] }),
  session("DLQ300", "Dead-letter queues in depth", { level: "300 - Advanced", services: ["AWS Lambda", "Amazon DynamoDB"], abstract: "Recover from failures with dead-letter queues and redrive." }),
  session("CON300", "Running containers on Fargate", { level: "300 - Advanced", services: ["AWS Lambda"], abstract: "Start from Lambda functions and grow into containers." }),
  session("PIT300", "Lambda at scale (sponsored by Acme)", { level: "300 - Advanced" }),
  session("SPN300", "Dead-letter queues, the sponsored edition (sponsored by Acme)", { level: "300 - Advanced", services: ["AWS Lambda", "Amazon DynamoDB"], abstract: "Recover with dead-letter queues and redrive." }),
  session("PAS300", "Reliability patterns", { level: "300 - Advanced", services: ["AWS Lambda", "Amazon DynamoDB"], abstract: "Use dead-letter queues and redrive policies when a batch fails." }),
  session("TST300", "Automated testing for Lambda applications", { level: "300 - Advanced", services: ["AWS Lambda", "Amazon DynamoDB"] }),
  session("ABS300", "Data at scale", { level: "300 - Advanced", services: ["Amazon DynamoDB"], abstract: "You will use DynamoDB tables. DynamoDB streams too." }),
];

describe("mapProfile and matchFocus", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); });
  afterEach(() => { home.cleanup(); });
  const seed = (raw: Session[] = CATALOG) =>
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: raw.length, count: raw.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
  const deps = () => ({ storeRoot: home.path });
  const codes = (result: { candidates: Array<{ code: string }> }) => result.candidates.map(candidate => candidate.code);

  describe("the map", () => {
    it("groups the topics: core services before supporting, patterns, supported gaps, next steps, and leaves out platform services, unsupported gaps and dead code", () => {
      seed();
      const map = mapProfile(base(), deps());
      expect(map.services.map(topic => topic.id)).toEqual(["service:AWS Lambda", "service:Amazon DynamoDB", "service:Amazon Simple Queue Service (Amazon SQS)"]);
      expect(map.patterns.map(topic => topic.id).sort()).toEqual(["pattern:event-driven", "pattern:serverless"]);
      expect(map.gaps.map(topic => topic.id)).toEqual(["gap:gap-no-dlq"]);
      expect(map.nextSteps.map(topic => topic.id)).toEqual(["path:serverless"]);
    });

    it("orders services and patterns by how many files cite them, core services before supporting ones, and lists a pattern once", () => {
      seed();
      const p = base();
      p.services.push({ name: "Amazon Polly", catalogName: "Amazon Polly", role: "supporting", evidence: [cite("p1.ts"), cite("p2.ts"), cite("p3.ts"), cite("p4.ts"), cite("p5.ts")] });
      p.patterns.find(pattern => pattern.name === "event-driven")!.evidence.push(cite("e1.ts"), cite("e2.ts"));
      p.patterns.push({ name: "Serverless", evidence: [cite("again.ts")] });
      const map = mapProfile(p, deps());
      expect(map.services.map(topic => topic.label)).toEqual(["AWS Lambda", "Amazon DynamoDB", "Amazon Polly", "Amazon Simple Queue Service"]);
      expect(map.patterns.map(topic => topic.id)).toEqual(["pattern:event-driven", "pattern:serverless"]);
    });

    it("describes a topic: label, one-sentence note, up to three places and how many more, and the goals that apply", () => {
      seed();
      const [lambda, dynamo] = mapProfile(base(), deps()).services;
      expect(lambda).toMatchObject({ id: "service:AWS Lambda", label: "AWS Lambda", note: "Every handler runs on Lambda" });
      expect(lambda!.evidence).toEqual([{ repo: "repo", file: "a.ts", line: 3 }, { repo: "repo", file: "b.ts", line: 4 }, { repo: "repo", file: "c.ts", line: 5 }]);
      expect(lambda!.more).toBe(1);
      expect(dynamo!.more).toBeUndefined();
      expect(lambda!.goals.map(goal => goal.goal)).toEqual(["understand", "deepen"]);
    });

    it("gives a gap its pillar and the improve goal, and a migration path its destination", () => {
      seed();
      const map = mapProfile(base(), deps());
      expect(map.gaps[0]).toMatchObject({ label: "gap-no-dlq", pillar: "Reliability", note: "the queue has no dead-letter queue" });
      expect(map.gaps[0]!.goals.map(goal => goal.goal)).toEqual(["improve"]);
      expect(map.nextSteps[0]).toMatchObject({ label: "serverless → containers" });
    });

    it("marks a path the profile already completed as skipped, with why, and no goals", () => {
      seed();
      const p = base();
      p.patterns.push({ name: "genai-single-call", evidence: [cite("g.ts")] }, { name: "agentic", evidence: [cite("a2.ts")] });
      const skipped = mapProfile(p, deps()).nextSteps.find(topic => topic.id === "path:genai-single-call")!;
      expect(skipped.skipped).toBe("profile already has agentic");
      expect(skipped.goals).toEqual([]);
    });

    it("keeps a goal with no sessions and marks it 0, so the user sees the dead end", () => {
      seed();
      const p = base();
      p.services.push({ name: "Amazon Cognito", catalogName: "Amazon Cognito", evidence: [cite("auth.ts")] });
      const cognito = mapProfile(p, deps()).services.find(topic => topic.id === "service:Amazon Cognito")!;
      expect(cognito.goals).toEqual([{ goal: "understand", sessions: 0 }, { goal: "deepen", sessions: 0 }]);
    });

    it("counts, for every topic and goal, exactly the sessions matchFocus returns for that topic and goal alone", () => {
      seed();
      const map = mapProfile(base(), deps());
      const topics = [...map.services, ...map.patterns, ...map.gaps, ...map.nextSteps];
      let checked = 0;
      for (const topic of topics) {
        for (const { goal, sessions } of topic.goals) {
          const [entry] = matchFocus(base(), deps(), [{ topic: topic.id, goal }]).results;
          expect(entry!.total, `${topic.id} ${goal}`).toBe(sessions);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(8);
      expect(topics.flatMap(topic => topic.goals).some(goal => goal.sessions > 0)).toBe(true);
    });
  });

  describe("matchFocus", () => {
    it("understand: only introductory sessions about the topic's concept", () => {
      seed();
      const [entry] = matchFocus(base(), deps(), [{ topic: "service:Amazon DynamoDB", goal: "understand" }]).results;
      expect(codes(entry!).sort()).toEqual(["DDB100", "LAM201"]);
      expect(codes(entry!)).not.toContain("DDB300");
    });

    it("deepen: sessions of any level admitted by that concept, leaving out the demoted ones", () => {
      seed();
      const [entry] = matchFocus(base(), deps(), [{ topic: "service:AWS Lambda", goal: "deepen" }]).results;
      expect(codes(entry!).sort()).toEqual(["LAM200", "LAM201", "TST300"]);
      expect(codes(entry!)).not.toContain("DDB300");
      expect(codes(entry!)).not.toContain("PIT300");
    });

    it("deepen: only sessions whose title names the topic, not ones that only mention it in the abstract", () => {
      seed();
      const [entry] = matchFocus(base(), deps(), [{ topic: "service:Amazon DynamoDB", goal: "deepen" }]).results;
      expect(codes(entry!).sort()).toEqual(["DDB100", "DDB300", "LAM201"]);
      expect(codes(entry!)).not.toContain("ABS300");
    });

    it("improve a gap: only that rule's sessions, each with its why", () => {
      seed();
      const [entry] = matchFocus(base(), deps(), [{ topic: "gap:gap-no-dlq", goal: "improve" }]).results;
      expect(codes(entry!)).toEqual(["DLQ300"]);
      expect(entry!.candidates[0]!.why.summary).toContain("gap-no-dlq");
    });

    it("improve: only sessions whose signal is strong, a title or a cued or tagged mention, not two passing mentions in the abstract", () => {
      seed();
      const [entry] = matchFocus(base(), deps(), [{ topic: "gap:gap-no-dlq", goal: "improve" }]).results;
      expect(codes(entry!)).toEqual(["DLQ300"]);
      expect(codes(matchFocus(base(), deps(), [{ topic: "gap:gap-no-dlq", goal: "improve" }]).results[0]!)).not.toContain("PAS300");
    });

    it("improve a gap: leaves out a sponsored, news or customer-story session", () => {
      seed();
      const [entry] = matchFocus(base(), deps(), [{ topic: "gap:gap-no-dlq", goal: "improve" }]).results;
      expect(codes(entry!)).not.toContain("SPN300");
      expect(entry!.total).toBe(1);
    });

    it("improve a gap: a session another gap's rule admitted is not listed under it", () => {
      seed();
      const p = base();
      p.patterns.push({ name: "gap-no-tests", evidence: [cite("t.ts")] });
      const { results } = matchFocus(p, deps(), [{ topic: "gap:gap-no-dlq", goal: "improve" }, { topic: "gap:gap-no-tests", goal: "improve" }]);
      expect(codes(results[0]!)).toEqual(["DLQ300"]);
      expect(codes(results[1]!)).toEqual(["TST300"]);
    });

    it("improve a path: only that next-level rule's sessions", () => {
      seed();
      const [entry] = matchFocus(base(), deps(), [{ topic: "path:serverless", goal: "improve" }]).results;
      expect(codes(entry!)).toEqual(["CON300"]);
    });

    it("lists a session under its first entry only, and notes the later entries it also matches", () => {
      seed();
      const { results } = matchFocus(base(), deps(), [{ topic: "service:AWS Lambda", goal: "deepen" }, { topic: "service:Amazon DynamoDB", goal: "deepen" }]);
      expect(codes(results[0]!)).toContain("LAM201");
      expect(codes(results[1]!)).not.toContain("LAM201");
      expect(results[0]!.candidates.find(candidate => candidate.code === "LAM201")).toHaveProperty("alsoMatches", ["service:Amazon DynamoDB"]);
      expect(results[1]!.total).toBeGreaterThan(codes(results[1]!).length);
    });

    it("caps an entry at perTopic, keeping the uncapped total", () => {
      seed();
      const [entry] = matchFocus(base(), deps(), [{ topic: "service:AWS Lambda", goal: "deepen" }], { perTopic: 1 }).results;
      expect(entry!.candidates).toHaveLength(1);
      expect(entry!.total).toBeGreaterThan(1);
    });

    it("says why an entry has no sessions", () => {
      seed();
      const p = base();
      p.services.push({ name: "Amazon Cognito", catalogName: "Amazon Cognito", evidence: [cite("auth.ts")] });
      const [understand, improve] = matchFocus(p, deps(), [{ topic: "service:Amazon Cognito", goal: "understand" }, { topic: "gap:gap-no-dlq", goal: "improve" }], { perTopic: 5 }).results;
      expect(understand).toMatchObject({ total: 0, candidates: [] });
      expect(understand!.reason).toContain("introductory");
      expect(improve!.total).toBeGreaterThan(0);
      const skipped = base();
      skipped.patterns.push({ name: "genai-single-call", evidence: [cite("g.ts")] }, { name: "agentic", evidence: [cite("a2.ts")] });
      const [path] = matchFocus(skipped, deps(), [{ topic: "path:genai-single-call", goal: "improve" }]).results;
      expect(path).toMatchObject({ total: 0, reason: "profile already has agentic" });
    });

    it("refuses an unknown topic, naming it and listing the valid ones", () => {
      seed();
      expect(() => matchFocus(base(), deps(), [{ topic: "service:Nope", goal: "deepen" }])).toThrow(ValidationError);
      expect(() => matchFocus(base(), deps(), [{ topic: "service:Nope", goal: "deepen" }])).toThrow(/service:Nope.*service:AWS Lambda.*gap:gap-no-dlq/s);
    });

    it("refuses a goal that is not one of the three", () => {
      seed();
      expect(() => matchFocus(base(), deps(), [{ topic: "service:AWS Lambda", goal: "dance" as never }])).toThrow(/Unknown goal "dance"/);
    });

    it("refuses a goal that does not apply to the topic", () => {
      seed();
      expect(() => matchFocus(base(), deps(), [{ topic: "service:AWS Lambda", goal: "improve" }])).toThrow(/improve.*service:AWS Lambda/s);
      expect(() => matchFocus(base(), deps(), [{ topic: "gap:gap-no-dlq", goal: "understand" }])).toThrow(ValidationError);
    });

    it("refuses no entries, more than six, and a perTopic outside 1 to 10", () => {
      seed();
      const entry = { topic: "service:AWS Lambda", goal: "deepen" } as const;
      expect(() => matchFocus(base(), deps(), [])).toThrow(ValidationError);
      expect(() => matchFocus(base(), deps(), Array.from({ length: 7 }, () => entry))).toThrow(ValidationError);
      expect(() => matchFocus(base(), deps(), [entry], { perTopic: 0 })).toThrow(ValidationError);
      expect(() => matchFocus(base(), deps(), [entry], { perTopic: 11 })).toThrow(ValidationError);
    });

    it("resolves a pattern that is merged into its service, such as ecs, to that service's sessions", () => {
      seed([session("ECS200", "Amazon ECS basics"), session("LAM200", "Lambda basics")]);
      const p = base();
      p.services.push({ name: "Amazon ECS", catalogName: "Amazon Elastic Container Service (Amazon ECS)", evidence: [cite("e.ts")] });
      p.patterns.push({ name: "ecs", evidence: [cite("e2.ts")] });
      const [entry] = matchFocus(p, deps(), [{ topic: "pattern:ecs", goal: "deepen" }]).results;
      expect(codes(entry!)).toEqual(["ECS200"]);
    });
  });
});
