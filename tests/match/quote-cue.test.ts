import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { matchSessionsDetailed } from "../../src/match/match.js";
import { quoteSite, type MatchSite } from "../../src/match/why.js";
import type { ResolvedProfile } from "../../src/profile/profile.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const OPENER = "Amazon EventBridge simplifies event routing for distributed applications.";
const SITE = (text: string, word: string, others: string[] = []): MatchSite => {
  const at = (needle: string) => ({ index: text.indexOf(needle), length: needle.length });
  return { inTitle: false, ...at(word), ...(others.length === 0 ? {} : { others: others.map(at) }) };
};

describe("quoteSite prefers the sentence that says what the attendee will do", () => {
  const abstract = (second: string) => `${OPENER} ${second}`;
  const quote = (text: string, others: string[]) => quoteSite({ title: "T", abstract: text }, SITE(text, "EventBridge", others));

  it("takes a later sentence that names the concept with a cue over the opener", () => {
    const text = abstract("Learn how to build event-driven systems with EventBridge rules and pipes.");
    expect(quote(text, ["EventBridge rules"])).toBe("Learn how to build event-driven systems with EventBridge rules and pipes.");
  });

  it("falls back to the first match when no sentence has a cue", () => {
    const text = abstract("EventBridge also has rules and pipes.");
    expect(quote(text, ["EventBridge also"])).toBe(OPENER);
  });

  it("keeps the first match when its own sentence has a cue", () => {
    const text = "Learn how EventBridge routes events. Later we use EventBridge pipes too, and build a demo.";
    expect(quote(text, ["EventBridge pipes"])).toBe("Learn how EventBridge routes events.");
  });

  it("takes the first cued sentence among several", () => {
    const text = `${OPENER} EventBridge is popular. Walk through EventBridge rules. We dive into EventBridge pipes.`;
    expect(quote(text, ["EventBridge is", "EventBridge rules", "EventBridge pipes"])).toBe("Walk through EventBridge rules.");
  });

  it("recognises each cue the plan names", () => {
    const cues = ["learn", "build", "explore how", "discover how", "walk through", "dive into", "see how", "we'll show", "you'll", "demo", "hands-on", "deep dive", "patterns for", "best practices"];
    for (const cue of cues) {
      const text = abstract(`This session has ${cue} for EventBridge users.`);
      expect(quote(text, ["EventBridge users"]), cue).toBe(`This session has ${cue} for EventBridge users.`);
    }
    expect(quote(abstract("Here you’ll meet EventBridge."), ["EventBridge."])).toBe("Here you’ll meet EventBridge.");
  });

  it("does not match a cue inside another word", () => {
    const text = abstract("Rebuilding EventBridge unlearned nothing.");
    expect(quote(text, ["EventBridge unlearned"])).toBe(OPENER);
  });

  it("is still a verbatim, trimmed slice of the abstract", () => {
    const long = `Learn ${"how to wire many different sources and targets together, ".repeat(6)}with EventBridge at the center of it all and more.`;
    const text = abstract(long);
    const result = quote(text, ["EventBridge at"])!;
    expect(result.length).toBeLessThanOrEqual(162);
    expect(result.replace(/…/g, "")).not.toBe("");
    expect(text).toContain(result.replace(/^…/, "").replace(/…$/, ""));
  });

  it("ignores another place that does not fall inside the abstract", () => {
    const text = abstract("Learn how to build with EventBridge.");
    expect(quoteSite({ title: "T", abstract: text }, { ...SITE(text, "EventBridge simplifies"), others: [{ index: 9999, length: 5 }] })).toBe(OPENER);
  });

  it("leaves a title match alone, and a site outside the abstract", () => {
    expect(quoteSite({ title: "EventBridge deep dive", abstract: "x" }, { inTitle: true, index: 0, length: 11 })).toBe("EventBridge deep dive");
    expect(quoteSite({ title: "T", abstract: "short" }, { inTitle: false, index: 40, length: 5, others: [{ index: 0, length: 5 }] })).toBeUndefined();
  });
});

describe("the quote in the lenses", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); });
  afterEach(() => { home.cleanup(); });
  const profile: ResolvedProfile = {
    schemaVersion: 1, repos: [{ root: "repo", languages: [] }],
    services: [{ name: "Amazon EventBridge", catalogName: "Amazon EventBridge", evidence: [{ repo: "repo", file: "a.ts", line: 1 }] }],
    patterns: [], unresolvedServices: [],
  };
  const LEARN = "Learn how to build event-driven systems with EventBridge rules and pipes.";
  const session: Session = {
    sessionId: "E1", abbreviation: "E1", title: "Event routing in practice", level: "200 - Intermediate", type: "Breakout session", services: ["Amazon EventBridge"],
    abstract: `${OPENER} ${LEARN}`,
  };
  const seed = () => writeCatalog({ raw: [session], index: [buildIndexRecord(session)], meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: 1, count: 1, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });

  it("quotes the sentence about what the attendee will do under the all and explain lenses", () => {
    seed();
    for (const lens of ["all", "explain"] as const) {
      const [candidate] = matchSessionsDetailed(profile, { storeRoot: home.path }, { lens }).candidates;
      expect(candidate!.why.sessionSays, lens).toBe(LEARN);
    }
  });

  it("changes nothing but the quote", () => {
    seed();
    const [candidate] = matchSessionsDetailed(profile, { storeRoot: home.path }).candidates;
    expect(candidate).toMatchObject({ code: "E1", score: expect.any(Number) });
    expect(candidate!.why.summary).toMatch(/EventBridge/);
  });

  it("quotes the sentence about what the attendee will do under the fix lens too", () => {
    const dlqProfile: ResolvedProfile = {
      schemaVersion: 1, repos: [{ root: "repo", languages: [] }],
      services: [{ name: "AWS Lambda", catalogName: "AWS Lambda", evidence: [{ repo: "repo", file: "a.ts", line: 1 }] }, { name: "Amazon DynamoDB", catalogName: "Amazon DynamoDB", evidence: [{ repo: "repo", file: "b.ts", line: 1 }] }],
      patterns: [{ name: "gap-no-dlq", note: "No dead-letter queue.", evidence: [{ repo: "repo", file: "q.ts", line: 1 }] }], unresolvedServices: [],
    };
    const REDRIVE = "Learn how to recover from failures with dead-letter queues and redrive.";
    const dlq: Session = { sessionId: "D1", abbreviation: "D1", title: "Reliability patterns", level: "300 - Advanced", type: "Breakout session", services: ["AWS Lambda", "Amazon DynamoDB"],
      abstract: `Dead-letter queues are a feature of queues. ${REDRIVE}` };
    writeCatalog({ raw: [dlq], index: [buildIndexRecord(dlq)], meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: 1, count: 1, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    const [candidate] = matchSessionsDetailed(dlqProfile, { storeRoot: home.path }, { lens: "fix" }).candidates;
    expect(candidate!.why.sessionSays).toBe(REDRIVE);
  });
});
