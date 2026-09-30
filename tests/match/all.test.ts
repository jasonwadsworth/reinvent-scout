import { describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { absentBroadTopics, admitConcepts, buildConcepts, interestConcepts, type ConceptMatch, type ProfileConcept } from "../../src/match/concepts.js";
import { allReason, demotionReason, industryTerms, matchAllConcepts, rankAll, rareProfileServices, type AllSession, type DemotionContext } from "../../src/match/all.js";
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
    // A pattern alone needs a title that names it (see below), so only a service is admitted this way.
    expect(shape(serverless, { title: "Data at scale", topics: ["Serverless"] }, "A serverless design.")).toEqual([]);
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

  it("admits a broad term only by a title that names it; alone it also needs a build or design cue", () => {
    const both = conceptsOf([{ name: "AWS Lambda" }], [{ name: "agentic" }]);
    const abstract = "An agent plans. The agent acts. Agents everywhere.";
    expect(shape(both, { title: "Platform engineering", topics: ["Agentic AI"] }, abstract)).toEqual([]);
    expect(shape(both, { title: "Agents in the wild" })).toEqual([]);
    expect(shape(both, { title: "Building agents in the wild" })).toEqual([["agentic", 3]]);
    expect(shape(both, { title: "Best practices for agent orchestration" })).toEqual([["agentic", 3]]);
    expect(shape(both, { title: "Agents on Lambda" })).toEqual([["agentic", 3], ["AWS Lambda", 3]]);
  });

  it("admits a broad term alone when the session names a service of the profile, even in a list, and counts it as named only outside a list", () => {
    const tools = buildConcepts(profile([{ name: "Claude Code" }], [{ name: "agentic" }])).concepts;
    const listed = "It coordinates Kiro CLI, Claude Code, and Codex as a team.";
    expect(shape(tools, { title: "Agent orchestrator for developer CLIs" }, listed)).toEqual([["agentic", 3]]);
    expect(shape(tools, { title: "Agent orchestrator for developer CLIs" }, "Claude Code runs the agents.")).toEqual([["agentic", 3], ["Claude Code", 1]]);
    expect(shape(tools, { title: "Agent orchestrator for developer CLIs" }, "It coordinates other tools.")).toEqual([]);
    expect(shape(tools, { title: "Orchestrator for developer CLIs" }, listed)).toEqual([]);
  });

  it("admits a session matched only through patterns when a pattern is named in its title", () => {
    const both = conceptsOf([{ name: "AWS Lambda" }], [{ name: "serverless" }, { name: "event-driven" }]);
    const abstract = "A serverless design. Serverless again. Event-driven flows too. Event-driven again.";
    expect(shape(both, { title: "Platforms" }, abstract)).toEqual([]);
    expect(shape(both, { title: "Serverless platforms" }, abstract)).toEqual([["event-driven", 2], ["serverless", 3]]);
  });

  it("lets a service concept admit a session without a title mention, patterns or not", () => {
    const both = conceptsOf([{ name: "AWS Lambda" }], [{ name: "serverless" }]);
    const abstract = "A serverless design. Serverless again. AWS Lambda here. Lambda again.";
    expect(shape(both, { title: "Platforms" }, abstract).map(([name]) => name).sort()).toEqual(["AWS Lambda", "serverless"]);
  });

  it("matches a pattern by the architecture it names, never by a service's name", () => {
    const patterns = [{ name: "api" }, { name: "streaming" }, { name: "iac-cdk" }, { name: "multi-account" }];
    const concepts = buildConcepts(profile([], patterns), [], { architecturePhrases: true }).concepts;
    for (const title of ["API Gateway unleashed", "Kinesis in depth", "Kafka at scale", "Getting started with AWS CDK", "Organizing with AWS Organizations", "Control Tower basics"]) {
      expect(shape(concepts, { title }), title).toEqual([]);
    }
    for (const title of ["REST API design", "GraphQL APIs", "Real-time streaming pipelines", "Infrastructure as code patterns", "A multi-account strategy"]) {
      expect(shape(concepts, { title }).length, title).toBe(1);
    }
  });

  it("still matches a service by its own name when the profile uses the service", () => {
    const concepts = buildConcepts(profile([{ name: "Amazon API Gateway" }], [{ name: "api" }]), [], { architecturePhrases: true }).concepts;
    expect(shape(concepts, { title: "API Gateway unleashed" }).map(([name]) => name)).toEqual(["Amazon API Gateway"]);
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
  const reason = (session: Parameters<typeof record>[0], abstract = "", context: DemotionContext = {}) => demotionReason(record(session), abstract, context);

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

  it("names a customer story told in the title, but not a how-to", () => {
    expect(reason({ title: "Acme: How we scaled to 1M RPS" })).toBe("customer story");
    expect(reason({ title: "Acme: How to scale on Lambda" })).toBeUndefined();
    expect(reason({ title: "Scaling", type: "Breakout session" }, "The [Customer] moved to the cloud.")).toBe("customer story");
  });

  it("does not take the abstract's description of how customers work for a story", () => {
    expect(reason({ title: "Databases on EC2" }, "See how customers in databases approach design. Learn how a customer deploys agents.")).toBeUndefined();
  });

  it("does not take a title that says how a service of the catalog or the profile works for a story", () => {
    const services = ["Kiro", "Lambda"];
    expect(reason({ title: "How Kiro learns: an AI coding agent" }, "", { services })).toBeUndefined();
    expect(reason({ title: "Trusted intent: How Kiro proves your specs" }, "", { services })).toBeUndefined();
    expect(reason({ title: "How Deutsche Bahn made cloud pay off" }, "", { services })).toBe("customer story");
    expect(reason({ title: "How Kiro learns" }, "", {})).toBe("customer story");
  });

  it("does not take a service of the catalog or the profile for the company of a story", () => {
    expect(reason({ title: "Specs" }, "Kiro built a spec engine. Kiro Crew moved on.", { services: ["Kiro"] })).toBeUndefined();
    expect(reason({ title: "Specs" }, "Kiro built a spec engine. Acme moved on.", { services: ["Kiro"] })).toBe("customer story");
  });

  it("names a customer story told in the abstract about a named company, whatever the title", () => {
    const story = "Honeycomb spends millions of dollars a year on Lambda. We outgrew Lambda Functions.";
    expect(reason({ title: "Lambda for every scale" }, story)).toBe("customer story");
    expect(reason({ title: "Scaling" }, "Nordstrom built a platform. Then it grew.")).toBe("customer story");
    expect(reason({ title: "Scaling" }, "Intro. Acme Corp migrated 400 services to containers.")).toBe("customer story");
  });

  it("does not take a plain subject, a pronoun or a common noun for a company", () => {
    for (const text of ["AI moves fast. Payment processes vary.", "Partners spent months. Agents built tools.", "Maybe migrated later. Then we built it.", "You built it. Teams moved on.", "Learn how Lambda scales. AWS built the service."]) {
      expect(reason({ title: "Scaling" }, text), text).toBeUndefined();
    }
  });

  it("names migration or modernization tooling and programs, not a technical talk about modernizing", () => {
    expect(reason({ title: "Automating migrations at scale with AWS Transform" })).toBe("modernization or migration session");
    expect(reason({ title: "Migration acceleration for mainframes" })).toBe("modernization or migration session");
    expect(reason({ title: "Modernization program office" })).toBe("modernization or migration session");
    expect(reason({ title: "Modernizing .NET to Serverless: Native AOT and SnapStart" })).toBeUndefined();
    expect(reason({ title: "Transform your SaaS for the agentic AI era on Amazon ECS" })).toBeUndefined();
  });

  it("names an industry-tagged session whose title names the industry or has no build or design cue", () => {
    const context = { industries: industryTerms([record({ title: "x", industries: ["Government", "Financial Services"] })]) };
    expect(reason({ title: "Build hybrid data planes for government pipelines", industries: ["Government"] }, "", context)).toBe("industry session");
    expect(reason({ title: "Automate dispute resolution with Bedrock", industries: ["Financial Services"] }, "", context)).toBe("industry session");
    expect(reason({ title: "Build a flash-sale control plane with CloudFront", industries: ["Retail & Consumer Goods"] }, "", context)).toBeUndefined();
    expect(reason({ title: "Automate dispute resolution with Bedrock", industries: [] }, "", context)).toBeUndefined();
  });

  it("takes the words of the industry names, not their filler", () => {
    const terms = industryTerms([record({ title: "x", industries: ["Media & Entertainment", "Financial Services", "Retail & Consumer Goods", "Healthcare & Life Sciences", "Energy & Utilities", "Travel."] })]);
    expect(terms).toEqual(["media", "entertainment", "financial", "retail", "consumer", "healthcare", "energy", "utilities", "travel"]);
  });

  it("names a title about a broad topic the profile does not use, and no other", () => {
    const absent = absentBroadTopics(conceptsOf([{ name: "AWS Lambda" }], [{ name: "genai-single-call" }]));
    expect(reason({ title: "Building agentic apps on Lambda" }, "", { absent })).toBe("about agents, which this code does not use");
    expect(reason({ title: "Multi-agent systems" }, "", { absent })).toBe("about agents, which this code does not use");
    expect(reason({ title: "LLM apps on Lambda" }, "", { absent })).toBeUndefined();
    expect(reason({ title: "Lambda in practice" }, "Agents are everywhere.", { absent })).toBeUndefined();
    expect(reason({ title: "Building agentic apps on Lambda" }, "", { absent: [] })).toBeUndefined();
  });

  it("joins every reason that applies, sponsored first", () => {
    expect(reason({ title: "What's new (sponsored by Acme)" })).toBe("sponsored session and news or launch session");
  });
});

describe("absentBroadTopics", () => {
  it("lists the broad topics the profile has no pattern for", () => {
    expect(absentBroadTopics(conceptsOf([{ name: "AWS Lambda" }], [])).map(topic => topic.label)).toEqual(["agents", "generative AI"]);
    expect(absentBroadTopics(conceptsOf([], [{ name: "agentic" }])).map(topic => topic.label)).toEqual(["generative AI"]);
    expect(absentBroadTopics(conceptsOf([], [{ name: "agentic" }, { name: "genai-single-call" }]))).toEqual([]);
  });

  it("counts an interest that names the topic as the profile having it", () => {
    const p = { ...profile([{ name: "AWS Lambda" }]), interests: ["Agentic AI"] };
    const evidenced = buildConcepts(p).concepts;
    const concepts = [...evidenced, ...interestConcepts(p, evidenced)];
    expect(absentBroadTopics(concepts).map(topic => topic.label)).toEqual(["generative AI"]);
    expect(absentBroadTopics(evidenced).map(topic => topic.label)).toEqual(["agents", "generative AI"]);
  });

  it("does not count a service of the same name as the pattern", () => {
    expect(absentBroadTopics(conceptsOf([{ name: "agentic" }], [])).map(topic => topic.label)).toEqual(["agents", "generative AI"]);
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

  it("ranks by the strongest match first: a session that names a concept in its title before one that only has it in the abstract", () => {
    expect(keys([session("ABSTRACT", [match(lam, 2), match(ddb, 2)]), session("TITLE", [match(sqs, 3)])])).toEqual(["TITLE", "ABSTRACT"]);
  });

  it("ranks by the summed centrality of the matched concepts within a strength", () => {
    expect(keys([session("ONE", [match(sqs)]), session("TWO", [match(ddb)]), session("THREE", [match(lam)]), session("FIVE", [match(lam), match(ddb)])]))
      .toEqual(["FIVE", "THREE", "TWO", "ONE"]);
  });

  it("puts every demoted session after every undemoted one, whatever it covers", () => {
    expect(keys([
      session("PITCH", [match(lam)], { demoted: "sponsored session" }),
      session("PLAIN", [match(lam)]),
      session("MORE", [match(lam), match(ddb, 1)], { demoted: "customer story" }),
      session("LESS", [match(ddb)]),
    ])).toEqual(["PLAIN", "LESS", "MORE", "PITCH"]);
  });

  it("breaks a centrality tie by the number of concepts, then relevance, then key", () => {
    // lam alone and ddb + sqs both sum to 3, both strongest 3: the session about more concepts first.
    expect(keys([session("ONE", [match(lam)]), session("TWO", [match(ddb), match(sqs)])])).toEqual(["TWO", "ONE"]);
    expect(keys([session("B", [match(lam)], { relevance: 1 }), session("A", [match(lam)], { relevance: 2 }), session("C", [match(lam)], { relevance: 2 })]))
      .toEqual(["A", "C", "B"]);
  });

  it("ranks a session about a stated interest after one about an evidenced concept at the same strength", () => {
    const interest: ProfileConcept = { ...sqs, name: "Aardvark", kind: "interest", citations: [], centrality: 1, weight: 1 };
    expect(keys([session("INT", [match(interest)]), session("SQS", [match(sqs)]), session("LAM", [match(lam)])])).toEqual(["LAM", "SQS", "INT"]);
    expect(keys([session("INT", [match(interest, 3)]), session("SQS", [match(sqs, 2)])])).toEqual(["INT", "SQS"]);
    const [entry] = rankAll([session("X", [match(interest), match(sqs)])]);
    expect(entry!.matches.map(found => found.concept.name)).toEqual(["Amazon SQS", "Aardvark"]);
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

    it("keeps the rest in rank order after the top ten, however many of a concept follow", () => {
      const quads = (prefix: string, concept: ProfileConcept, count: number) => Array.from({ length: count }, (_, index) => session(`${prefix}${index}`, [match(concept)]));
      const ranked = rankAll([...quads("L", l, 4), ...quads("D", d, 4), ...quads("C", c, 4), ...quads("Q", q, 4)]).map(entry => entry.key);
      expect(ranked).toEqual(["L0", "L1", "L2", "D0", "D1", "D2", "C0", "C1", "C2", "Q0", "L3", "D3", "C3", "Q1", "Q2", "Q3"]);
    });

    it("puts the sessions the cap held back ahead of every demoted one", () => {
      const pitch = session("PITCH", [match(d, 3)], { demoted: "sponsored session" });
      const ranked = rankAll([...lams, ...others, pitch]).map(entry => entry.key);
      expect(ranked).toEqual(["L0", "L1", "L2", "D0", "D1", "C0", "Q0", "L3", "L4", "L5", "PITCH"]);
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
  it("lists each place the code uses the concept once, however many times the profile cites it", () => {
    const p = profile([{ name: "Amazon DynamoDB", files: ["a.ts", "a.ts", "b.ts"] }]);
    const [concept] = buildConcepts(p).concepts;
    const found = matchAllConcepts([concept!], record({ title: "DynamoDB data modeling" }), "")[0]!;
    const reason = allReason(found, 1);
    expect(reason.profileEvidence).toEqual([cite("a.ts"), cite("b.ts")]);
    expect(reason.detail).toBe('Matches Amazon DynamoDB ("DynamoDB"), which this code uses at a.ts:1, b.ts:1.');
  });

  it("names the concept, the phrase and where the code uses it", () => {
    const [concept] = conceptsOf([{ name: "Amazon DynamoDB", files: ["a.ts"] }]);
    const found = matchAllConcepts([concept!], record({ title: "DynamoDB data modeling" }), "")[0]!;
    const reason = allReason(found, 1);
    expect(reason.kind).toBe("matchesConcept");
    expect(reason.detail).toBe('Matches Amazon DynamoDB ("DynamoDB"), which this code uses at a.ts:1.');
    expect(reason.profileEvidence).toEqual([cite("a.ts")]);
  });
});

describe("interest concepts", () => {
  const withInterests = (interests: string[], services: Parameters<typeof profile>[0] = [], patterns: Parameters<typeof profile>[1] = []) => {
    const p = { ...profile(services, patterns), interests };
    return [...buildConcepts(p).concepts, ...interestConcepts(p, buildConcepts(p).concepts)];
  };
  const interestShape = (concepts: ProfileConcept[], session: Parameters<typeof record>[0], abstract = "") =>
    matchAllConcepts(concepts, record(session), abstract).map(match => [match.concept.name, match.concept.kind, match.strength, match.phrase]);

  it("makes each stated interest a concept of centrality one with no citations", () => {
    const [interest] = interestConcepts({ ...profile([]), interests: ["Kubernetes"] }, []);
    expect(interest).toMatchObject({ name: "Kubernetes", kind: "interest", weight: 1, centrality: 1, citations: [], tags: ["Kubernetes"] });
  });

  it("skips an interest the profile already evidences under the same name, and a repeat", () => {
    const concepts = withInterests(["serverless", "Serverless", "Kubernetes", "kubernetes"], [], [{ name: "serverless" }]);
    expect(concepts.map(concept => concept.name)).toEqual(["serverless", "Kubernetes"]);
  });

  it("admits an interest named in the title", () => {
    expect(interestShape(withInterests(["Kubernetes"]), { title: "Kubernetes from scratch" })).toEqual([["Kubernetes", "interest", 3, "Kubernetes"]]);
  });

  it("admits an interest by an exact topic or area-of-interest tag, which is the user's own ask", () => {
    const concepts = withInterests(["Edge Computing"]);
    expect(interestShape(concepts, { title: "Faster pages", areasOfInterest: ["Edge Computing"] })).toEqual([["Edge Computing", "interest", 1, "Edge Computing"]]);
    expect(interestShape(concepts, { title: "Faster pages", topics: ["edge computing"] })).toEqual([["Edge Computing", "interest", 1, "edge computing"]]);
  });

  it("does not admit an interest named only in the abstract, or by a tag that merely contains it", () => {
    const concepts = withInterests(["Kubernetes"]);
    expect(interestShape(concepts, { title: "Clusters" }, "Kubernetes everywhere. Kubernetes again.")).toEqual([]);
    expect(interestShape(concepts, { title: "Clusters", topics: ["Kubernetes Security"] })).toEqual([]);
  });

  it("quotes nothing for a tag-only match, and the abstract sentence when it also names the interest", () => {
    const tagged = matchAllConcepts(withInterests(["Edge Computing"]), record({ title: "Faster pages", areasOfInterest: ["Edge Computing"] }), "")[0]!;
    expect(tagged.site.index).toBe(-1);
  });
});

describe("rare services named in a list", () => {
  const p = profile([{ name: "AWS Lambda" }, { name: "Claude Code", files: ["a.ts", "b.ts"] }], [{ name: "serverless" }]);
  const concepts = buildConcepts(p).concepts;
  const byName = (name: string) => concepts.find(concept => concept.name === name)!;
  const rare = new Set([byName("Claude Code")]);
  const shape = (session: Parameters<typeof record>[0], abstract: string, rareSet = rare) =>
    matchAllConcepts(concepts, record(session), abstract, rareSet).map(match => [match.concept.name, match.strength]);

  it("adds a rare service named only in a list to a session already about a concept, at strength one", () => {
    expect(shape({ title: "Serverless in practice" }, "Kiro CLI, Claude Code, and Codex work side by side.")).toEqual([["serverless", 3], ["Claude Code", 1]]);
  });

  it("adds nothing for a common service in a list, nor for a rare one the session does not name", () => {
    expect(shape({ title: "Serverless in practice" }, "Kiro CLI, AWS Lambda, and Amazon S3 work side by side.")).toEqual([["serverless", 3]]);
    expect(shape({ title: "Serverless in practice" }, "Nothing else here.")).toEqual([["serverless", 3]]);
    expect(shape({ title: "Serverless in practice" }, "Kiro CLI, Claude Code, and Codex.", new Set())).toEqual([["serverless", 3]]);
  });

  it("never admits a session by itself", () => {
    expect(shape({ title: "Developer tools" }, "Kiro CLI, Claude Code, and Codex work side by side.")).toEqual([]);
  });

  it("does not add the service twice when it already matched", () => {
    expect(shape({ title: "Claude Code in practice" }, "Kiro CLI, Claude Code, and Codex.")).toEqual([["Claude Code", 3]]);
  });

  it("finds the services named in under 3% of the catalog sessions, listed or not, by their text", () => {
    const records = Array.from({ length: 100 }, (_, index) => record({ title: index < 2 ? "Claude Code tips" : index < 10 ? "Lambda tips" : `Topic ${index}`, abbreviation: `S${index}` }));
    const found = rareProfileServices(concepts, records, () => "", 0.03);
    expect([...found].map(concept => concept.name)).toEqual(["Claude Code"]);
    const inAbstract = rareProfileServices(concepts, records, candidate => ["Topic 55", "Topic 56"].includes(candidate.title) ? "Kiro CLI, Claude Code, and Codex." : "", 0.03);
    expect([...inAbstract]).toEqual([]);
  });
});
