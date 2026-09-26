import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord, type IndexRecord } from "../../src/catalog/index-record.js";
import { buildCorpusStats, scoreSession, type MatchQuery } from "../../src/match/score.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

function record(overrides: Partial<Session> & { sessionId: string; title: string }): IndexRecord {
  return buildIndexRecord(overrides);
}

function query(overrides: Partial<MatchQuery> = {}): MatchQuery {
  return { services: [], topics: [], areasOfInterest: [], text: "", ...overrides };
}

describe("scoreSession", () => {
  it("does not round its own raw values -- rounding happens at the output boundary in match.ts", () => {
    // 3 * (1 / 2.5) is 1.2000000000000002 in floating point, not a clean 1.2 -- this exact
    // fixture (a single title-only term match) reproduces that noise. scoreSession is used for
    // sorting (see match.ts), so it must keep full precision internally; only the final,
    // agent-facing output gets rounded, once, after sorting is done.
    const session = record({ sessionId: "s1", title: "AWS Lambda Basics" });
    const q = query({ text: "lambda" });

    const result = scoreSession(session, q);

    const textReason = result.reasons.find((r) => r.kind === "text");
    expect(textReason?.weight).toBe(1.2000000000000002);
    expect(result.score).toBe(1.2000000000000002);
  });

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

describe("scoreSession with corpus statistics (inverse document frequency)", () => {
  it("weighs an equally-repeated term higher when it's rare across the corpus than when it's common", () => {
    // A term-frequency match alone can't tell a genuinely rare, specific term from a word nearly
    // every document happens to share -- that's the missing half of BM25 this corpus-aware form
    // adds. Ten documents total: "rare" appears in exactly one of them, "common" in nine.
    const rareTarget = record({ sessionId: "rare-target", title: "Unrelated filler", abstract: "rare" });
    const commonTarget = record({
      sessionId: "common-target",
      title: "Unrelated filler",
      abstract: "common",
    });
    const commonFillers = Array.from({ length: 8 }, (_, i) =>
      record({ sessionId: `common-filler-${i}`, title: "Unrelated filler", abstract: "common" }),
    );
    const corpus = [rareTarget, commonTarget, ...commonFillers];
    const corpusStats = buildCorpusStats(corpus);

    // Same term frequency (one occurrence, body only) in both target records -- the only variable
    // is how many other documents in the corpus also contain the query's term.
    const rareResult = scoreSession(rareTarget, query({ text: "rare" }), corpusStats);
    const commonResult = scoreSession(commonTarget, query({ text: "common" }), corpusStats);

    expect(rareResult.score).toBeGreaterThan(commonResult.score);
  });

  it("gives a term that appears in every document in the corpus a small, non-zero weight -- Okapi BM25's idf, not a plain ln(N/df)", () => {
    // Standard BM25's idf includes a "+1" inside the outer log specifically so a term with no
    // discriminating power at all (every document has it) still contributes something small,
    // rather than collapsing to exactly zero the way a plain ln(totalDocuments / documentFrequency)
    // would -- verified against a rarer term in the same corpus to confirm it's genuinely small,
    // not merely present.
    const target = record({ sessionId: "target", title: "Unrelated filler", abstract: "everywhere" });
    const otherDoc = record({ sessionId: "other", title: "Another filler", abstract: "everywhere rare" });
    const corpusStats = buildCorpusStats([target, otherDoc]);

    const universalResult = scoreSession(target, query({ text: "everywhere" }), corpusStats);
    const rareResult = scoreSession(otherDoc, query({ text: "rare" }), corpusStats);

    const universalTextReason = universalResult.reasons.find((r) => r.kind === "text");
    expect(universalTextReason).toBeDefined();
    expect(universalTextReason!.weight).toBeGreaterThan(0);
    expect(universalTextReason!.weight).toBeLessThan(rareResult.score);
  });

  it("weighs a term present in three quarters of the fixture at less than a fifth of a term present in only one session", () => {
    // Real, measured document frequencies in the 61-session fixture (confirmed by direct
    // inspection before writing this test, and re-verified against tests/match/match.test.ts's own
    // real-catalog test): "amazon" appears in 45 of 61 sessions -- three quarters -- via the
    // catalog's own "Amazon <service>" naming convention, while "dynamodb" appears in exactly 1.
    // Both target records below share the identical structure (a single body-only occurrence),
    // isolating the ratio to inverse document frequency alone, not incidental differences in term
    // frequency or title placement between real, messy session records.
    const realCorpusStats = buildCorpusStats(fixture.map(buildIndexRecord));
    const universalTermTarget = record({ sessionId: "u", title: "Unrelated filler", abstract: "amazon" });
    const rareTermTarget = record({ sessionId: "r", title: "Unrelated filler", abstract: "dynamodb" });

    const universalResult = scoreSession(universalTermTarget, query({ text: "amazon" }), realCorpusStats);
    const rareResult = scoreSession(rareTermTarget, query({ text: "dynamodb" }), realCorpusStats);

    expect(universalResult.score).toBeLessThan(rareResult.score * 0.2);
  });

  it("treats every term as equally informative when no corpus statistics are supplied", () => {
    // Backward-compatible default for callers -- almost every other test in this file -- that
    // don't care about corpus-wide rarity and would otherwise have to construct one just to keep
    // testing term-frequency saturation and title-weighting in isolation.
    const session = record({ sessionId: "s1", title: "AWS Lambda Basics" });
    const q = query({ text: "lambda" });

    const withoutCorpusStats = scoreSession(session, q);
    const withRealCorpusStats = scoreSession(session, q, buildCorpusStats([session]));

    // A single-document corpus containing the term gives it documentFrequency === totalDocuments --
    // Okapi BM25's idf there is small but not zero (unlike a plain ln(N/df)), and always strictly
    // less than the neutral weight 1 that omitting corpusStats uses -- so if omitting corpusStats
    // were silently falling back to a real, empty corpus rather than a genuine neutral default,
    // this would be smaller than it is, not equal to the undamped raw value.
    expect(withoutCorpusStats.score).toBe(1.2000000000000002);
    expect(withRealCorpusStats.score).toBeLessThan(withoutCorpusStats.score);
  });

  it("produces byte-identical output for the same corpus-aware inputs across two runs", () => {
    // The same determinism guarantee this file's other byte-identical-output test makes for the
    // no-corpus-stats path, but exercised through buildCorpusStats and the idf-weighted path
    // specifically -- Map iteration order or floating-point summation order could in principle
    // introduce nondeterminism that a corpus-unaware test would never see.
    function buildInputs(): { session: IndexRecord; q: MatchQuery; corpusStats: ReturnType<typeof buildCorpusStats> } {
      const target = record({ sessionId: "s1", title: "Serverless orders processing", abstract: "orders" });
      const filler = record({ sessionId: "s2", title: "Unrelated filler" });
      return {
        session: target,
        q: query({ text: "orders" }),
        corpusStats: buildCorpusStats([target, filler]),
      };
    }

    const first = buildInputs();
    const result1 = scoreSession(first.session, first.q, first.corpusStats);
    const second = buildInputs();
    const result2 = scoreSession(second.session, second.q, second.corpusStats);

    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
  });
});
