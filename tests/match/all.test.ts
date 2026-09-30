import { describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { admitConcepts, buildConcepts, type ConceptMatch, type ProfileConcept } from "../../src/match/concepts.js";
import { allReason, demotionReason, matchAllConcepts, rankAll, type AllSession } from "../../src/match/all.js";
import type { ResolvedProfile } from "../../src/profile/profile.js";

const cite = (file: string) => ({ repo: "repo", file, line: 1 });
const profile = (
  services: Array<{ name: string; role?: "core" | "supporting"; files?: string[] }>,
  patterns: Array<{ name: string; files?: string[] }> = [],
): ResolvedProfile => ({
  schemaVersion: 1,
  repos: [{ root: "repo", languages: [] }],
  services: services.map(service => ({
    name: service.name, catalogName: service.name,
    ...(service.role === undefined ? {} : { role: service.role }),
    evidence: (service.files ?? ["a.ts"]).map(file => cite(file)),
  })),
  patterns: patterns.map(pattern => ({ name: pattern.name, evidence: (pattern.files ?? ["a.ts"]).map(file => cite(file)) })),
  unresolvedServices: [],
});
const record = (session: Partial<Session> & { title: string }) =>
  buildIndexRecord({ sessionId: session.abbreviation ?? "s1", level: "300 - Advanced", ...session });
const conceptsOf = (services: Parameters<typeof profile>[0], patterns: Parameters<typeof profile>[1] = []): ProfileConcept[] =>
  buildConcepts(profile(services, patterns)).concepts;

describe("matchAllConcepts", () => {
  const dynamo = conceptsOf([{ name: "Amazon DynamoDB" }]);
  const serverless = conceptsOf([], [{ name: "serverless" }]);
  const agentic = conceptsOf([], [{ name: "agentic" }]);
  const shape = (concepts: ProfileConcept[], session: Parameters<typeof record>[0], abstract = "") =>
    matchAllConcepts(concepts, record(session), abstract).map(match => [match.concept.name, match.strength]);

  it("admits a title that names the concept at any level", () => {
    expect(shape(dynamo, { title: "DynamoDB data modeling" })).toEqual([["Amazon DynamoDB", 3]]);
  });

  it("admits an abstract that names the concept twice, without any corroboration", () => {
    const abstract = "You will use DynamoDB tables. DynamoDB streams too.";
    expect(shape(dynamo, { title: "Data at scale" }, abstract)).toEqual([["Amazon DynamoDB", 2]]);
  });

  it("admits an abstract that names the concept once when a listed service says the same, more weakly", () => {
    expect(shape(dynamo, { title: "Data at scale", services: ["Amazon DynamoDB"] }, "You will use DynamoDB tables.")).toEqual([["Amazon DynamoDB", 1]]);
    expect(shape(serverless, { title: "Data at scale", topics: ["Serverless"] }, "A serverless design.")).toEqual([["serverless", 1]]);
  });

  it("never admits on one abstract mention nothing corroborates, nor on a tag or listed service alone", () => {
    expect(shape(dynamo, { title: "Data at scale" }, "You will use DynamoDB tables.")).toEqual([]);
    expect(shape(dynamo, { title: "Data at scale", services: ["Amazon DynamoDB"], topics: ["Databases"] })).toEqual([]);
    expect(shape(serverless, { title: "Data at scale", topics: ["Serverless"] })).toEqual([]);
  });

  it("does not count a mention inside an enumeration of names", () => {
    const abstract = "It covers Amazon S3, DynamoDB, and Amazon SQS. Also Kinesis, DynamoDB or Amazon RDS.";
    expect(shape(dynamo, { title: "Storage options", services: ["Amazon DynamoDB"] }, abstract)).toEqual([]);
  });

  it("admits a broad term only by a title that names it, not by an abstract or by how-to wording", () => {
    const abstract = "An agent plans. The agent acts. Agents everywhere.";
    expect(shape(agentic, { title: "Platform engineering", topics: ["Agentic AI"] }, abstract)).toEqual([]);
    expect(shape(agentic, { title: "Agents in the wild" })).toEqual([["agentic", 3]]);
  });

  it("skips an AWS Partner bootcamp, a certification session and exam prep, whatever they name", () => {
    expect(shape(dynamo, { title: "AWS Partner: DynamoDB bootcamp" })).toEqual([]);
    expect(shape(dynamo, { title: "DynamoDB certification prep" })).toEqual([]);
    expect(shape(dynamo, { title: "Get DynamoDB proficient" })).toEqual([]);
    expect(shape(dynamo, { title: "DynamoDB practice questions", type: "Exam prep" })).toEqual([]);
  });

  it("keeps a sponsored, news or story session, which the ranking demotes instead", () => {
    expect(shape(dynamo, { title: "DynamoDB at scale (sponsored by Acme)" })).toEqual([["Amazon DynamoDB", 3]]);
    expect(shape(dynamo, { title: "What's new in DynamoDB" })).toEqual([["Amazon DynamoDB", 3]]);
  });

  it("differs from the explain admission only where the plan says: a single corroborated mention", () => {
    const session = record({ title: "Data at scale", services: ["Amazon DynamoDB"] });
    expect(admitConcepts(dynamo, session, "You will use DynamoDB tables.", { singleCorroborated: false, broadNeedsBuildCue: true })).toEqual([]);
  });
});

describe("demotionReason", () => {
  const reason = (session: Parameters<typeof record>[0], abstract = "") => demotionReason(record(session), abstract);

  it("names a sponsored session by its title or by its -S code", () => {
    expect(reason({ title: "Scale it (sponsored by Acme)" })).toBe("sponsored session");
    expect(reason({ title: "Scale it", abbreviation: "SEC218-S" })).toBe("sponsored session");
    expect(reason({ title: "Scale it", abbreviation: "SEC218-S1" })).toBe("sponsored session");
    expect(reason({ title: "Scale it", abbreviation: "SEC218-R" })).toBeUndefined();
    expect(reason({ title: "Scale it", abbreviation: "SEC218" })).toBeUndefined();
  });

  it("names a news or launch session", () => {
    expect(reason({ title: "What's new in Lambda" })).toBe("news or launch session");
    expect(reason({ title: "Launching Lambda managed instances" })).toBeUndefined();
    expect(reason({ title: "Lambda launches in review" })).toBe("news or launch session");
  });

  it("names a customer story, told in the title or the abstract, but not a how-to", () => {
    expect(reason({ title: "Acme: How we scaled to 1M RPS" })).toBe("customer story");
    expect(reason({ title: "Scaling", type: "Breakout session" }, "See how a customer moved to the cloud.")).toBe("customer story");
    expect(reason({ title: "Acme: How to scale on Lambda" })).toBeUndefined();
  });

  it("joins every reason that applies, sponsored first", () => {
    expect(reason({ title: "What's new (sponsored by Acme)" })).toBe("sponsored session and news or launch session");
  });
});

describe("rankAll", () => {
  const lambda = conceptsOf([{ name: "AWS Lambda", files: ["a.ts", "b.ts", "c.ts"] }, { name: "Amazon DynamoDB", files: ["a.ts", "b.ts"] }, { name: "Amazon SQS", files: ["a.ts"] }]);
  const [lam, ddb, sqs] = lambda as [ProfileConcept, ProfileConcept, ProfileConcept];
  const match = (concept: ProfileConcept, strength = 3): ConceptMatch =>
    ({ concept, strength, phrase: concept.name, boosted: false, site: { inTitle: true, index: 0, length: 1 } });
  const session = (key: string, matches: ConceptMatch[], extra: Partial<AllSession> = {}): AllSession =>
    ({ key, record: record({ title: key }), matches, relevance: 0, ...extra });
  const keys = (sessions: AllSession[]) => rankAll(sessions).map(entry => entry.key);

  it("ranks by the summed centrality of the matched concepts first", () => {
    expect(keys([session("ONE", [match(sqs)]), session("TWO", [match(ddb)]), session("THREE", [match(lam)]), session("FIVE", [match(lam, 1), match(ddb, 1)])]))
      .toEqual(["FIVE", "THREE", "TWO", "ONE"]);
  });

  it("puts a demoted session after every undemoted one with the same coverage, not before a better-covered one", () => {
    expect(keys([
      session("PITCH", [match(lam)], { demoted: "sponsored session" }),
      session("PLAIN", [match(lam)]),
      session("MORE", [match(lam), match(ddb, 1)], { demoted: "customer story" }),
      session("LESS", [match(ddb)]),
    ])).toEqual(["MORE", "PLAIN", "PITCH", "LESS"]);
  });

  it("breaks a centrality tie by the strongest match, then the number of concepts, then relevance, then key", () => {
    expect(keys([session("WEAK", [match(lam, 1)]), session("STRONG", [match(lam, 3)])])).toEqual(["STRONG", "WEAK"]);
    // lam alone and ddb + sqs both sum to 3, both strongest 3: the session about more concepts first.
    expect(keys([session("ONE", [match(lam)]), session("TWO", [match(ddb), match(sqs)])])).toEqual(["TWO", "ONE"]);
    expect(keys([session("B", [match(lam)], { relevance: 1 }), session("A", [match(lam)], { relevance: 2 }), session("C", [match(lam)], { relevance: 2 })]))
      .toEqual(["A", "C", "B"]);
  });

  it("puts a scheduled session before an unscheduled one that ties on everything else, then orders by key", () => {
    const scheduled = record({ title: "B", sessionTime: { date: "2026-12-01", time: "10:00", length: "60" } });
    expect(keys([session("A", [match(lam)]), session("B", [match(lam)], { record: scheduled })])).toEqual(["B", "A"]);
  });

  it("puts the primary concept of each session first: the strongest match, then the most central", () => {
    const [entry] = rankAll([session("X", [match(sqs, 3), match(lam, 2), match(ddb, 3)])]);
    expect(entry!.matches.map(found => found.concept.name)).toEqual(["Amazon DynamoDB", "Amazon SQS", "AWS Lambda"]);
  });

  describe("coverage", () => {
    const fourth = conceptsOf([{ name: "AWS Lambda", files: ["a.ts", "b.ts", "c.ts"] }, { name: "Amazon DynamoDB", files: ["a.ts", "b.ts"] }, { name: "Amazon SQS", files: ["a.ts"] }, { name: "Amazon Cognito", files: ["z.ts"] }]);
    const [l, d, q, c] = fourth as [ProfileConcept, ProfileConcept, ProfileConcept, ProfileConcept];
    const lams = Array.from({ length: 6 }, (_, index) => session(`L${index}`, [match(l)]));
    const others = [session("D0", [match(d)]), session("D1", [match(d)]), session("Q0", [match(q)]), session("C0", [match(c)])];

    it("lets no primary concept take more than three of the top ten, keeping the rest in order after them", () => {
      const ranked = rankAll([...lams, ...others]).map(entry => entry.key);
      expect(ranked).toEqual(["L0", "L1", "L2", "D0", "D1", "C0", "Q0", "L3", "L4", "L5"]);
    });

    it("counts only the primary concept of a session toward the cap", () => {
      const secondary = Array.from({ length: 4 }, (_, index) => session(`S${index}`, [match(d), match(l, 1)]));
      const ranked = rankAll([...secondary, session("Q0", [match(q)]), session("C0", [match(c)]), session("L0", [match(l)])]).map(entry => entry.key);
      expect(ranked.slice(0, 4)).toEqual(["S0", "S1", "S2", "L0"]);
    });

    it("does not cap when fewer than four concepts have any admitted session", () => {
      const three = rankAll([...lams, ...others.slice(0, 3)]).map(entry => entry.key);
      expect(three.slice(0, 6)).toEqual(["L0", "L1", "L2", "L3", "L4", "L5"]);
    });
  });
});

describe("allReason", () => {
  it("names the concept, the phrase and where the code uses it", () => {
    const [concept] = conceptsOf([{ name: "Amazon DynamoDB", files: ["a.ts"] }]);
    const found = matchAllConcepts([concept!], record({ title: "DynamoDB data modeling" }), "")[0]!;
    const reason = allReason(found, 1);
    expect(reason.kind).toBe("matchesConcept");
    expect(reason.detail).toBe('Matches Amazon DynamoDB ("DynamoDB"), which this code uses at a.ts:1.');
    expect(reason.profileEvidence).toEqual([cite("a.ts")]);
  });
});
