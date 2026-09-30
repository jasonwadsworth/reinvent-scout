import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import type { Lens } from "../../src/match/lens.js";
import { matchSessionsDetailed } from "../../src/match/match.js";
import type { Evidence, ResolvedProfile } from "../../src/profile/profile.js";
import type { Reason } from "../../src/match/score.js";
import { allWhy } from "../../src/match/why.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const cite = (file: string, line: number | null = 1, extra: Partial<Evidence> = {}): Evidence =>
  ({ repo: "repo", file, ...(line === null ? {} : { line }), ...extra });
const service = (name: string, extra: { usage?: string; evidence?: Evidence[] } = {}) =>
  ({ name, catalogName: name, evidence: extra.evidence ?? [cite(`${name}.ts`, 3)], ...(extra.usage === undefined ? {} : { usage: extra.usage }) });
const stack = [service("AWS Lambda"), service("Amazon Simple Queue Service (Amazon SQS)")];
const profileOf = (patterns: ResolvedProfile["patterns"], services = stack): ResolvedProfile =>
  ({ schemaVersion: 1, repos: [{ root: "repo", languages: [] }], services, patterns, unresolvedServices: [] });
const session = (code: string, title: string, extra: Partial<Session> = {}): Session =>
  ({ sessionId: code, abbreviation: code, title, level: "200 - Intermediate", type: "Breakout session",
    services: ["AWS Lambda", "Amazon Simple Queue Service (Amazon SQS)"], ...extra });

describe("the why block", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); });
  afterEach(() => { home.cleanup(); });
  function run(p: ResolvedProfile, raw: Session[], lens: Lens, limit?: number) {
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: raw.length, count: raw.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    return matchSessionsDetailed(p, { storeRoot: home.path }, { lens, ...(limit === undefined ? {} : { limit }) });
  }

  describe("fix", () => {
    const dlq = (note?: string, evidence: Evidence[] = [cite("rules.ts", 179)]) =>
      profileOf([{ name: "gap-no-dlq", ...(note === undefined ? {} : { note }), evidence }]);

    it("covers the gap in the pattern's own words, with the boilerplate prefix stripped", () => {
      const result = run(dlq("Not evident in the cited scope: the three tenant rules set no deadLetterQueue. Second sentence."),
        [session("DLQ100", "Dead-letter queues in depth")], "fix");
      expect(result.candidates[0]!.why.summary).toBe("Covers your gap-no-dlq: the three tenant rules set no deadLetterQueue.");
    });

    it("falls back to the rule's description of the pillar and what is missing when the gap has no note", () => {
      const result = run(dlq(), [session("DLQ100", "Dead-letter queues in depth")], "fix");
      expect(result.candidates[0]!.why.summary).toBe("Covers your gap-no-dlq (Reliability): dead-letter handling is not evident in the cited scope.");
    });

    it("cites up to three deduped places in profile order and counts the rest", () => {
      const evidence = [cite("a.ts", 1), cite("a.ts", 1, { snippet: "dup" }), cite("b.ts", 2), cite("c.ts"), cite("d.ts", 4), cite("e.ts", 5)];
      const why = run(dlq("x", evidence), [session("DLQ100", "Dead-letter queues in depth")], "fix").candidates[0]!.why;
      expect(why.yourCode).toEqual([{ repo: "repo", file: "a.ts", line: 1 }, { repo: "repo", file: "b.ts", line: 2 }, { repo: "repo", file: "c.ts", line: 1 }]);
      expect(why.more).toBe(2);
    });

    it("omits the more count and any line that is not on record", () => {
      const why = run(dlq("x", [cite("a.ts", null)]), [session("DLQ100", "Dead-letter queues in depth")], "fix").candidates[0]!.why;
      expect(why.yourCode).toEqual([{ repo: "repo", file: "a.ts" }]);
      expect("more" in why).toBe(false);
      expect(Object.keys(why.yourCode[0]!)).not.toContain("line");
    });

    it("quotes the title when the phrase is in the title", () => {
      const why = run(dlq("x"), [session("DLQ100", "Dead-letter queues in depth", { abstract: "Unrelated. We also mention redrive twice, redrive again." })], "fix").candidates[0]!.why;
      expect(why.sessionSays).toBe("Dead-letter queues in depth");
    });

    it("quotes the sentence of the abstract holding the first match when the title has none", () => {
      const abstract = "Opening remarks about queues. Learn to recover from failed event deliveries using dead-letter queues and redrive. Later we revisit dead-letter queues once more.";
      const why = run(dlq("x"), [session("EVT100", "Reliable event delivery", { abstract })], "fix").candidates[0]!.why;
      expect(why.sessionSays).toBe("Learn to recover from failed event deliveries using dead-letter queues and redrive.");
    });

    it("skips a match inside an enumeration of names and quotes the first unlisted one", () => {
      const abstract = "We compare Kinesis, Lambda, DLQs and Step Functions side by side. Then dead-letter queues get a deeper look. Dead-letter queues again.";
      const why = run(dlq("x"), [session("EVT100", "Reliable event delivery", { abstract })], "fix").candidates[0]!.why;
      expect(why.sessionSays).toBe("Then dead-letter queues get a deeper look.");
    });

    it("names the strongest rule, not the first, and counts the others when several admitted the session", () => {
      const p = profileOf([
        { name: "gap-no-dlq", note: "no dead-letter queue on the rules", evidence: [cite("rules.ts", 4)] },
        { name: "gap-no-alarms", note: "no alarms on the queue", evidence: [cite("alarms.ts", 9)] },
      ]);
      const result = run(p, [session("BOTH100", "CloudWatch alarms in depth", { abstract: "Use dead-letter queues. Add dead-letter queues everywhere." })], "fix");
      const why = result.candidates[0]!.why;
      expect(why.summary).toBe("Covers your gap-no-alarms: no alarms on the queue (+1 more).");
      expect(why.yourCode).toEqual([{ repo: "repo", file: "alarms.ts", line: 9 }]);
      expect(result.candidates[0]!.lensRules).toEqual(["gap-no-dlq", "gap-no-alarms"]);
    });
  });

  describe("summaries read cleanly", () => {
    const dlq = (note: string) => profileOf([{ name: "gap-no-dlq", note, evidence: [cite("rules.ts", 4)] }]);
    const talk = session("DLQ100", "Dead-letter queues in depth");

    it("ends a long note on a clause, with one ellipsis and no doubled period", () => {
      const note = `Rules ${"target Step Functions and ".repeat(4)}set no deadLetterQueue or retry policy on the target, so a failed delivery is dropped without any record at all`;
      const summary = run(dlq(note), [talk], "fix").candidates[0]!.why.summary;
      expect(summary.endsWith("target…")).toBe(true);
      expect(summary).not.toContain("…." );
    });

    it("keeps the more count after an ellipsis", () => {
      const p = profileOf([
        { name: "gap-no-dlq", note: `word ${"long ".repeat(60)}`, evidence: [cite("rules.ts", 4)] },
        { name: "gap-no-alarms", note: "no alarms", evidence: [cite("alarms.ts", 9)] },
      ]);
      const summary = run(p, [session("BOTH100", "Dead-letter queues", { abstract: "Wire up CloudWatch alarms. Add CloudWatch alarms everywhere." })], "fix").candidates[0]!.why.summary;
      expect(summary).toMatch(/…  ?\(\+1 more\)\.$|… \(\+1 more\)\.$/);
    });

    it("does not nest parentheses when a next-level note has its own", () => {
      const p = profileOf([{ name: "serverless", note: "Every handler is a Lambda function (behind API Gateway) with no servers.", evidence: [cite("fn.ts", 5)] }], [service("AWS Lambda")]);
      const talk2 = session("CON200", "Running containers on Fargate", { services: ["AWS Lambda"], abstract: "Start from Lambda functions and grow into containers." });
      expect(run(p, [talk2], "next-level").candidates[0]!.why.summary).toBe("Next step from serverless (Every handler is a Lambda function with no servers) toward containers.");
    });

    it("names an explained service without its catalog acronym", () => {
      const p = profileOf([], [service("Amazon Simple Queue Service (Amazon SQS)", { usage: "Work queues" })]);
      const why = run(p, [session("SQS100", "Getting started with Amazon SQS", { services: [] })], "explain").candidates[0]!.why;
      expect(why.summary).toBe("Explains Amazon Simple Queue Service, which this code uses: Work queues.");
    });
  });

  describe("next-level", () => {
    const movers = (patternNote?: string, evidence: Evidence[] = [cite("fn.ts", 5)]) =>
      profileOf([{ name: "serverless", ...(patternNote === undefined ? {} : { note: patternNote }), evidence }], [service("AWS Lambda")]);
    const containerTalk = session("CON200", "Running containers on Fargate", { services: ["AWS Lambda"], abstract: "Start from Lambda functions and grow into containers." });

    it("names the source pattern with its note and the destination", () => {
      const why = run(movers("every handler is a Lambda function behind API Gateway."), [containerTalk], "next-level").candidates[0]!.why;
      expect(why.summary).toBe("Next step from serverless (every handler is a Lambda function behind API Gateway) toward containers.");
      expect(why.yourCode).toEqual([{ repo: "repo", file: "fn.ts", line: 5 }]);
      expect(why.sessionSays).toBe("Running containers on Fargate");
    });

    it("uses the evidence note when the pattern has none", () => {
      const why = run(movers(undefined, [cite("fn.ts", 5, { note: "Lambda handlers for each route." })]), [containerTalk], "next-level").candidates[0]!.why;
      expect(why.summary).toBe("Next step from serverless (Lambda handlers for each route) toward containers.");
    });

    it("drops the parenthetical when nothing describes the source", () => {
      const why = run(movers(), [containerTalk], "next-level").candidates[0]!.why;
      expect(why.summary).toBe("Next step from serverless toward containers.");
    });
  });
  describe("explain", () => {
    const ddb = (usage?: string, evidence: Evidence[] = [cite("db/table.ts", 14), cite("db/stream.ts", 2)]) =>
      profileOf([], [service("Amazon DynamoDB", { evidence, ...(usage === undefined ? {} : { usage }) })]);
    const intro = session("DDB100", "Getting started with DynamoDB", { services: ["Amazon DynamoDB"] });

    it("says how the code uses the concept in the profile's own words, one sentence", () => {
      const why = run(ddb("Single-table data store for tenants and policies. Streams feed Lambda."), [intro], "explain").candidates[0]!.why;
      expect(why.summary).toBe("Explains Amazon DynamoDB, which this code uses: Single-table data store for tenants and policies.");
      expect(why.yourCode).toEqual([{ repo: "repo", file: "db/table.ts", line: 14 }, { repo: "repo", file: "db/stream.ts", line: 2 }]);
      expect(why.sessionSays).toBe("Getting started with DynamoDB");
    });

    it("says where the code uses it when the profile has no note", () => {
      const why = run(ddb(), [intro], "explain").candidates[0]!.why;
      expect(why.summary).toBe("Explains Amazon DynamoDB, which this code uses at db/table.ts:14.");
    });

    it("puts the repo in front of the place when the profile spans several", () => {
      const p = ddb();
      p.repos.push({ root: "other", languages: [] });
      expect(run(p, [intro], "explain").candidates[0]!.why.summary).toBe("Explains Amazon DynamoDB, which this code uses at repo/db/table.ts:14.");
    });

    it("uses a pattern's note for a pattern concept", () => {
      const p = profileOf([{ name: "serverless", note: "No servers anywhere: Lambda, SQS and API Gateway only.", evidence: [cite("app.ts", 5)] }], []);
      const why = run(p, [session("SLS100", "Serverless basics", { services: [] })], "explain").candidates[0]!.why;
      expect(why.summary).toBe("Explains serverless, which this code uses: No servers anywhere: Lambda, SQS and API Gateway only.");
      expect(why.yourCode).toEqual([{ repo: "repo", file: "app.ts", line: 5 }]);
    });

    it("quotes the abstract sentence holding the concept when the title does not name it", () => {
      const abstract = "Opening remarks about data. You will use DynamoDB tables here. DynamoDB streams too.";
      const why = run(ddb("Data store"), [session("DAT100", "Data at scale", { services: ["Amazon DynamoDB"], abstract })], "explain").candidates[0]!.why;
      expect(why.sessionSays).toBe("You will use DynamoDB tables here.");
    });

    it("cuts the quote from the original text even when earlier text has ampersands", () => {
      const abstract = "A & B & C & D & E & F & G & H & I & J are letters. DynamoDB rocks. DynamoDB streams next.";
      const why = run(ddb("Data store"), [session("DAT100", "Data at scale", { services: ["Amazon DynamoDB"], abstract })], "explain").candidates[0]!.why;
      expect(why.sessionSays).toBe("DynamoDB rocks.");
    });

    it("names the concept the session was taken for, not another it also explains", () => {
      const p = profileOf([], [service("AWS Lambda", { usage: "Every handler", evidence: [cite("a.ts"), cite("a2.ts"), cite("a3.ts")] }), service("Amazon DynamoDB", { usage: "Tenant data", evidence: [cite("b.ts")] })]);
      const result = run(p, [session("LAM100", "Introduction to Lambda", { services: [] }), session("BOTH100", "Lambda and DynamoDB in practice", { services: [] })], "explain");
      const both = result.candidates.find(candidate => candidate.code === "BOTH100")!;
      expect(both.reasons[0]!.detail).toContain("Explains Amazon DynamoDB");
      expect(both.why.summary).toBe("Explains Amazon DynamoDB, which this code uses: Tenant data.");
    });
  });
  describe("all", () => {
    const lambda = service("AWS Lambda", { usage: "Cognito triggers and stream processors. Second sentence.", evidence: [cite("fn/a.ts", 8), cite("fn/b.ts", 2)] });
    const sqs = { ...service("Amazon Simple Queue Service (Amazon SQS)", { usage: "Dead-letter queues." }), role: "supporting" as const };
    const talk = (extra: Partial<Session> = {}) => session("LAM100", "Building on AWS Lambda", { ...extra });

    it("names the two strongest matched services, the strongest with the code's note", () => {
      const why = run(profileOf([], [sqs, lambda]), [talk()], "all").candidates[0]!.why;
      expect(why.summary).toBe("Matches your AWS Lambda (Cognito triggers and stream processors) and Amazon Simple Queue Service.");
      expect(why.yourCode).toEqual([{ repo: "repo", file: "fn/a.ts", line: 8 }, { repo: "repo", file: "Amazon Simple Queue Service (Amazon SQS).ts", line: 3 }, { repo: "repo", file: "fn/b.ts", line: 2 }]);
      expect(why.sessionSays).toBe("Building on AWS Lambda");
    });

    it("never names a third", () => {
      const three = [lambda, service("Amazon DynamoDB"), service("Amazon Cognito")];
      const why = run(profileOf([], three), [talk({ services: ["AWS Lambda", "Amazon DynamoDB", "Amazon Cognito"] })], "all").candidates[0]!.why;
      expect(why.summary).toBe("Matches your AWS Lambda (Cognito triggers and stream processors) and Amazon DynamoDB.");
    });

    it("quotes the abstract sentence that names the service when the title does not", () => {
      const abstract = "A deep look at events. Every handler runs on AWS Lambda behind a queue. More to come.";
      const why = run(profileOf([], [lambda]), [session("EVT100", "Event handlers", { services: ["AWS Lambda"], abstract })], "all").candidates[0]!.why;
      expect(why.sessionSays).toBe("Every handler runs on AWS Lambda behind a queue.");
    });

    it("omits the quote rather than invent one when the session only lists the service", () => {
      const why = run(profileOf([], [lambda]), [session("EVT100", "Event handlers", { services: ["AWS Lambda"], abstract: "Nothing relevant here." })], "all").candidates[0]!.why;
      expect("sessionSays" in why).toBe(false);
    });

    it("describes a matched pattern by its note and quotes the sentence that says it", () => {
      const p = profileOf([{ name: "serverless", note: "Only Lambda and DynamoDB.", evidence: [cite("app.ts", 5)] }], []);
      const abstract = "Intro. We build a serverless backend from scratch. Enjoy.";
      const why = run(p, [session("SLS100", "Backends", { services: [], topics: ["Serverless"], abstract })], "all").candidates[0]!.why;
      expect(why.summary).toBe("Matches your serverless (Only Lambda and DynamoDB).");
      expect(why.yourCode).toEqual([{ repo: "repo", file: "app.ts", line: 5 }]);
      expect(why.sessionSays).toBe("We build a serverless backend from scratch.");
    });

    it("says an interest matched when nothing of the code did, citing no code", () => {
      const p = { ...profileOf([], []), interests: ["Kubernetes"] };
      const why = run(p, [session("K8S100", "Cluster basics", { services: [], areasOfInterest: ["Kubernetes"], abstract: "Learn Kubernetes today." })], "all").candidates[0]!.why;
      expect(why.summary).toBe("Matches your interest in Kubernetes.");
      expect(why.yourCode).toEqual([]);
      expect(why.sessionSays).toBe("Learn Kubernetes today.");
    });

    it("falls back to the wording it shares with the profile, with nothing of the code to cite", () => {
      const p = { ...profileOf([], []), intents: [{ kind: "goal" as const, text: "reduce cold starts" }] };
      const why = run(p, [session("COLD100", "Cold starts", { services: [], abstract: "Fewer cold starts, faster." })], "all").candidates[0]!.why;
      expect(why.summary).toMatch(/^Matches the wording of your profile: /);
      expect(why.yourCode).toEqual([]);
    });

    it("quotes the first mention outside an enumeration of names", () => {
      const abstract = "Compare AWS Lambda, Amazon SQS and Amazon SNS side by side. Then AWS Lambda gets a deep dive.";
      const why = run(profileOf([], [lambda]), [session("EVT100", "Event handlers", { services: ["AWS Lambda"], abstract })], "all").candidates[0]!.why;
      expect(why.sessionSays).toBe("Then AWS Lambda gets a deep dive.");
    });

    it("treats an ampersand list of names as an enumeration, not a mention", () => {
      const p = profileOf([], [lambda, service("Amazon DynamoDB")]);
      const listed = session("LST100", "Scaling lessons: Lambda, DynamoDB & SQS", { services: ["AWS Lambda", "Amazon DynamoDB"] });
      expect("sessionSays" in run(p, [listed], "all").candidates[0]!.why).toBe(false);
    });

    it("prefers the title over an earlier-reading abstract sentence", () => {
      const why = run(profileOf([], [lambda]), [talk({ abstract: "AWS Lambda first. Then more." })], "all").candidates[0]!.why;
      expect(why.sessionSays).toBe("Building on AWS Lambda");
    });

    it("finds a pattern with no defined session wording by its own name", () => {
      const p = profileOf([{ name: "cell-based", evidence: [cite("cells.ts", 3)] }], []);
      const abstract = "Intro. Cell based design keeps the blast radius small. Done.";
      const why = run(p, [session("CEL100", "Blast radius", { services: [], topics: ["Cell-Based"], abstract })], "all").candidates[0]!.why;
      expect(why.summary).toBe("Matches your cell-based.");
      expect(why.sessionSays).toBe("Cell based design keeps the blast radius small.");
    });

    it("finds a pattern by the wording sessions use for it, not only its name", () => {
      const p = profileOf([{ name: "event-driven", evidence: [cite("bus.ts", 3)] }], []);
      const abstract = "Intro. We build event-based systems on AWS. Done.";
      const why = run(p, [session("EVT100", "Systems", { services: [], topics: ["Event-Driven"], abstract })], "all").candidates[0]!.why;
      expect(why.sessionSays).toBe("We build event-based systems on AWS.");
    });

    describe("from reasons directly", () => {
      const reason = (kind: Reason["kind"], evidence: string, weight: number): Reason => ({ kind, detail: "", evidence, weight });
      const profile = profileOf([], [service("AWS Lambda"), service("Amazon DynamoDB"), service("Amazon Cognito")]);
      const empty = { title: "Nothing", abstract: "" };

      it("orders concepts by reason weight, not by the order the reasons arrive in", () => {
        const why = allWhy([reason("service", "AWS Lambda", 25), reason("service", "Amazon DynamoDB", 50)], profile, empty);
        expect(why.summary).toBe("Matches your Amazon DynamoDB and AWS Lambda.");
      });

      it("names a concept once however many reasons point at it", () => {
        const why = allWhy([reason("service", "AWS Lambda", 50), reason("service", "AWS Lambda", 25), reason("service", "Amazon DynamoDB", 12)], profile, empty);
        expect(why.summary).toBe("Matches your AWS Lambda and Amazon DynamoDB.");
      });

      it("quotes only for a concept the summary names, swapping in a weaker matched one the session does say", () => {
        const reasons = [reason("service", "AWS Lambda", 50), reason("service", "Amazon DynamoDB", 40), reason("service", "Amazon Cognito", 30)];
        expect(allWhy(reasons, profile, { title: "Sign-in", abstract: "" })).not.toHaveProperty("sessionSays");
        const swapped = allWhy(reasons, profile, { title: "Sign-in with Amazon Cognito", abstract: "" });
        expect(swapped.summary).toBe("Matches your AWS Lambda and Amazon Cognito.");
        expect(swapped.sessionSays).toBe("Sign-in with Amazon Cognito");
        const kept = allWhy(reasons, profile, { title: "Sign-in with Amazon DynamoDB", abstract: "" });
        expect(kept.summary).toBe("Matches your AWS Lambda and Amazon DynamoDB.");
        expect(kept.sessionSays).toBe("Sign-in with Amazon DynamoDB");
      });

      it("swaps in a profile pattern the session names though no reason points at it, title first", () => {
        const withPatterns = profileOf([{ name: "event-driven", evidence: [cite("bus.ts", 6)] }, { name: "serverless", evidence: [cite("app.ts", 5)] }], [service("AWS Lambda")]);
        const why = allWhy([reason("service", "AWS Lambda", 50)], withPatterns, { title: "Testing serverless applications", abstract: "We cover event-driven flows. Then event-driven again." });
        expect(why.summary).toBe("Matches your AWS Lambda and serverless.");
        expect(why.sessionSays).toBe("Testing serverless applications");
        expect(why.yourCode).toEqual([{ repo: "repo", file: "AWS Lambda.ts", line: 3 }, { repo: "repo", file: "app.ts", line: 5 }]);
      });

      it("never swaps in a gap pattern", () => {
        const withGap = profileOf([{ name: "gap-no-dlq", evidence: [cite("rules.ts", 4)] }], [service("AWS Lambda")]);
        const why = allWhy([reason("service", "AWS Lambda", 50)], withGap, { title: "gap-no-dlq and dead-letter queues", abstract: "" });
        expect(why.summary).toBe("Matches your AWS Lambda.");
      });
    });
  });
});
