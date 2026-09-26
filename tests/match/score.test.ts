import { describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord, type IndexRecord } from "../../src/catalog/index-record.js";
import { scoreSession, type MatchQuery } from "../../src/match/score.js";

function record(overrides: Partial<Session> & { sessionId: string; title: string }): IndexRecord {
  return buildIndexRecord(overrides);
}

function query(overrides: Partial<MatchQuery> = {}): MatchQuery {
  return { services: [], topics: [], areasOfInterest: [], text: "", ...overrides };
}

describe("scoreSession", () => {
  it("scores an exact catalog service match above a topic match", () => {
    const serviceMatch = record({
      sessionId: "s1",
      title: "Building with the data layer",
      services: ["Amazon DynamoDB"],
    });
    const topicMatch = record({
      sessionId: "s2",
      title: "Building with the data layer",
      topics: ["Databases"],
    });
    const q = query({ services: ["Amazon DynamoDB"], topics: ["Databases"] });

    const serviceResult = scoreSession(serviceMatch, q);
    const topicResult = scoreSession(topicMatch, q);

    expect(serviceResult.score).toBeGreaterThan(topicResult.score);
  });

  it("scores a topic match above a bare text overlap", () => {
    const topicMatch = record({
      sessionId: "s1",
      title: "Modernizing your architecture",
      topics: ["Databases"],
    });
    const textOnly = record({
      sessionId: "s2",
      title: "A talk that happens to mention databases",
    });
    const q = query({ topics: ["Databases"], text: "databases" });

    const topicResult = scoreSession(topicMatch, q);
    const textResult = scoreSession(textOnly, q);

    expect(topicResult.score).toBeGreaterThan(textResult.score);
  });

  it("weights a title term above the same term in the abstract", () => {
    const titleMatch = record({ sessionId: "s1", title: "Deep dive into Step Functions" });
    const abstractMatch = record({
      sessionId: "s2",
      title: "An unrelated headline",
      abstract: "This session covers Step Functions in some detail.",
    });
    const q = query({ text: "step functions" });

    const titleResult = scoreSession(titleMatch, q);
    const abstractResult = scoreSession(abstractMatch, q);

    expect(titleResult.score).toBeGreaterThan(abstractResult.score);
  });

  it("saturates repeated occurrences of one term instead of scaling linearly", () => {
    const fewRepeats = record({
      sessionId: "s1",
      title: "An unrelated headline",
      abstract: "orders orders orders",
    });
    const manyRepeats = record({
      sessionId: "s2",
      title: "An unrelated headline",
      abstract: Array(30).fill("orders").join(" "),
    });
    const q = query({ text: "orders" });

    const fewScore = scoreSession(fewRepeats, q).score;
    const manyScore = scoreSession(manyRepeats, q).score;

    // Linear scaling would put manyScore at 10x fewScore (30 occurrences vs 3). Saturation must
    // land far short of that -- the marginal 27 extra occurrences buy almost nothing.
    expect(manyScore).toBeGreaterThan(fewScore);
    expect(manyScore).toBeLessThan(fewScore * 2);
  });

  it("does not let a long abstract outscore a short precise title", () => {
    const preciseTitle = record({
      sessionId: "s1",
      title: "AWS Step Functions for event-driven workflows",
      abstract: "",
    });
    // A long abstract that mentions the query terms only in passing, padded with a lot of
    // unrelated text -- the kind of session a naive linear-and-unnormalized scorer would let
    // outscore a short, precise title purely by accumulating many terms over a lot of text.
    const longAbstract = record({
      sessionId: "s2",
      title: "Rethinking your platform strategy",
      abstract: [
        "This wide-ranging session explores platform strategy across many dimensions.",
        "We touch on organizational design, cost governance, developer experience, security",
        "posture, and observability. Along the way we mention step functions and workflows",
        "as one of several patterns teams consider, alongside queues, pipelines, and event",
        "driven designs. The session also covers hiring, culture, incident response, and",
        "long-term platform investment planning across a multi-year roadmap for the org.",
      ].join(" "),
    });
    const q = query({ text: "step functions event-driven workflows" });

    const preciseResult = scoreSession(preciseTitle, q).score;
    const longResult = scoreSession(longAbstract, q).score;

    expect(preciseResult).toBeGreaterThan(longResult);
  });

  it("returns a reason for every signal that contributed, with its weight and its evidence", () => {
    const session = record({
      sessionId: "s1",
      title: "Serverless orders processing",
      services: ["AWS Lambda"],
      topics: ["Serverless"],
      areasOfInterest: ["Modern Applications"],
      abstract: "Learn about orders processing.",
    });
    const q = query({
      services: ["AWS Lambda"],
      topics: ["Serverless"],
      areasOfInterest: ["Modern Applications"],
      text: "orders processing",
    });

    const result = scoreSession(session, q);

    const kinds = result.reasons.map((r) => r.kind).sort();
    expect(kinds).toEqual(["areaOfInterest", "service", "text", "topic"]);
    for (const reason of result.reasons) {
      expect(reason.weight).toBeGreaterThan(0);
      expect(reason.evidence.length).toBeGreaterThan(0);
      expect(reason.detail.length).toBeGreaterThan(0);
    }
  });

  it("returns no reasons and a zero score for a session with nothing in common", () => {
    const session = record({ sessionId: "s1", title: "Completely unrelated headline" });
    const q = query({ services: ["Amazon DynamoDB"], topics: ["Databases"], text: "kubernetes" });

    const result = scoreSession(session, q);

    expect(result.reasons).toEqual([]);
    expect(result.score).toBe(0);
  });

  it("produces byte-identical output for the same inputs across two runs", () => {
    // Genuinely independent runs: fresh record and query objects built from scratch each time,
    // not the same references reused, so this can't pass merely because something was cached
    // between calls rather than because scoring itself is deterministic.
    function buildInputs(): { session: IndexRecord; q: MatchQuery } {
      return {
        session: record({
          sessionId: "s1",
          title: "Serverless orders processing",
          services: ["AWS Lambda"],
          topics: ["Serverless"],
          abstract: "Learn about orders processing with Lambda.",
        }),
        q: query({ services: ["AWS Lambda"], topics: ["Serverless"], text: "orders processing" }),
      };
    }

    const first = buildInputs();
    const result1 = scoreSession(first.session, first.q);
    const second = buildInputs();
    const result2 = scoreSession(second.session, second.q);

    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
  });

  it("does not let a verbose free-text query outscore an exact service match via incidental overlap", () => {
    // Agent-authored prose (service usage notes, pattern descriptions, interests, intent text)
    // can be long. An unrelated session that happens to share some of that vocabulary must not
    // outscore one the profile actually names a real service for.
    const realMatch = record({
      sessionId: "s1",
      title: "AWS Lambda for order processing",
      services: ["AWS Lambda"],
      abstract: "",
    });
    const incidentalOverlap = record({
      sessionId: "s2",
      title: "Platform strategy and team topologies",
      abstract: [
        "This session discusses how teams organize around services, processing pipelines,",
        "order fulfillment workflows, event handling, and general application platform design",
        "considerations across a growing organization with many independent product teams.",
      ].join(" "),
    });
    const q = query({
      services: ["AWS Lambda"],
      text:
        "Our order processing service handles fulfillment workflows and event handling for the platform.",
    });

    const realResult = scoreSession(realMatch, q).score;
    const incidentalResult = scoreSession(incidentalOverlap, q).score;

    expect(realResult).toBeGreaterThan(incidentalResult);
  });
});
