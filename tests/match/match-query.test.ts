import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { buildMatchQuery } from "../../src/match/match.js";
import { buildCorpusStats, scoreSession } from "../../src/match/score.js";
import type { ResolvedProfile } from "../../src/profile/profile.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

function resolvedProfile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    schemaVersion: 1,
    repos: [{ root: ".", languages: [] }],
    services: [],
    patterns: [],
    unresolvedServices: [],
    ...overrides,
  };
}

/** What `buildMatchQuery` and `scoreSession` say about every session of `raw` the profile shares
 * anything with: the relevance that breaks ties under the All lens and adds the ranking reasons
 * under Fix and Next-level. */
function scored(profile: ResolvedProfile, raw: Session[] = fixture) {
  const index = raw.map(buildIndexRecord);
  const stats = buildCorpusStats(index);
  const query = buildMatchQuery(profile);
  return index
    .map((record) => ({ record, code: record.abbreviation, ...scoreSession(record, query, stats) }))
    .filter((entry) => entry.score > 0);
}

describe("the match query and its relevance score", () => {
  it("ranks a candidate matching a rare term above one matching only a near-universal term, using the fixture's real corpus frequencies", () => {
    // Real, measured frequencies in the 61-session fixture: "amazon" appears in 45 of 61 sessions
    // (the catalog's own "Amazon <service>" naming convention makes it near-universal), while
    // "guide" appears in only 3. INV501 contains "amazon" twice (via its services, Amazon API
    // Gateway and Amazon Bedrock) but never "guide"; API318 contains "guide" once, in its abstract
    // ("...a real production example to guide your next serverless workflow decision"), but never
    // "amazon". On raw term frequency alone (no inverse document frequency), INV501's two "amazon"
    // occurrences actually outscore API318's one "guide" occurrence -- confirmed by hand against
    // this module's own scoring constants before this test was written. Inverse document frequency
    // must flip that: a term nearly every session shares says almost nothing about relevance,
    // while a term only three sessions use says a great deal.
    const profile = resolvedProfile({ intents: [{ kind: "goal", text: "guide amazon" }] });

    const results = scored(profile);

    const rareTermMatch = results.find((r) => r.record.abbreviation === "API318");
    const universalTermMatch = results.find((r) => r.record.abbreviation === "INV501");

    expect(rareTermMatch).toBeDefined();
    expect(universalTermMatch).toBeDefined();
    expect(rareTermMatch!.score).toBeGreaterThan(universalTermMatch!.score);
  });


  it("ranks every session with a real service or topic match above one whose only connection is the near-universal word 'amazon'", () => {
    // The reviewer's own reproduction: a profile naming Amazon DynamoDB by service. DAT414 is the
    // only session in the fixture that actually covers Amazon DynamoDB (both a "service" reason and
    // a "text" reason, since the service's own name also feeds the free-text query -- see
    // buildMatchQuery). Every other session that merely shares the word "amazon" (45 of 61, via the
    // catalog's own "Amazon <service>" naming convention) gets only a "text" reason, and inverse
    // document frequency must keep every one of those strictly below DAT414 -- not just below its
    // own rank position, but below its score, since a service match is the one signal a human
    // should trust most.
    // The service's own `name` (not just its resolved `catalogName`) feeds the free-text query
    // (see buildMatchQuery) -- naming it the way the catalog itself does, "Amazon DynamoDB" rather
    // than a short key like "dynamodb", is what actually puts "amazon" into the query text at all,
    // matching the reviewer's own reproduction.
    const profile = resolvedProfile({
      services: [
        {
          name: "Amazon DynamoDB",
          evidence: [{ repo: ".", file: "x" }],
          catalogName: "Amazon DynamoDB",
        },
      ],
    });

    const results = scored(profile);

    const withStructuredReason = results.filter((r) =>
      r.reasons.some((reason) => reason.kind === "service" || reason.kind === "topic"),
    );
    const amazonOnlyTextMatches = results.filter(
      (r) =>
        r.reasons.every((reason) => reason.kind === "text") &&
        r.reasons.some((reason) => reason.evidence.split(", ").includes("amazon")),
    );

    // Sanity check on the test itself: if either group were empty, the comparison below would
    // pass vacuously.
    expect(withStructuredReason.length).toBeGreaterThan(0);
    expect(amazonOnlyTextMatches.length).toBeGreaterThan(0);

    const minStructuredScore = Math.min(...withStructuredReason.map((r) => r.score));
    const maxAmazonOnlyScore = Math.max(...amazonOnlyTextMatches.map((r) => r.score));

    expect(maxAmazonOnlyScore).toBeLessThan(minStructuredScore);
  });


  it("deduplicates a service named under multiple spellings, yielding exactly one service reason", () => {
    // The documented use case, not an abuse: an agent that finds DynamoDB in package.json and
    // again in a source file naturally writes two entries with different evidence. All three
    // entries here resolve to the same catalog name via different spellings, matching the
    // README's own example ("dynamodb", "Amazon DynamoDB", "@aws-sdk/client-dynamodb").
    const profile = resolvedProfile({
      services: [
        { name: "dynamodb", evidence: [{ repo: ".", file: "a" }], catalogName: "Amazon DynamoDB" },
        {
          name: "Amazon DynamoDB",
          evidence: [{ repo: ".", file: "b" }],
          catalogName: "Amazon DynamoDB",
        },
        {
          name: "@aws-sdk/client-dynamodb",
          evidence: [{ repo: ".", file: "c" }],
          catalogName: "Amazon DynamoDB",
        },
      ],
    });

    const results = scored(profile);

    const dat414 = results.find((r) => r.code === "DAT414");
    expect(dat414).toBeDefined();
    const serviceReasons = dat414!.reasons.filter((r) => r.kind === "service");
    expect(serviceReasons).toHaveLength(1);
  });


  it("keeps the exact-match service reason at its single weight regardless of how many spellings named it", () => {
    // Not an exact-total-score equality claim: textParts is deliberately left un-deduplicated (see
    // buildMatchQuery's own doc comment) since three distinct spellings really do carry slightly
    // different free text ("Amazon DynamoDB" contributes "amazon" too, "@aws-sdk/client-dynamodb"
    // contributes "aws"/"sdk"/"client"), and BM25 saturation absorbs that without eliminating it.
    // What must never happen is the specific bug the reviewer found: the 50-point *service* reason
    // scaling with the spelling count (157.33 for three spellings of a session that scores 57.33
    // for one). A small, saturation-explained difference in the *text* contribution is fine; a
    // near-tripled total is not.
    const singleSpelling = resolvedProfile({
      services: [
        { name: "dynamodb", evidence: [{ repo: ".", file: "a" }], catalogName: "Amazon DynamoDB" },
      ],
    });
    const tripleSpelling = resolvedProfile({
      services: [
        { name: "dynamodb", evidence: [{ repo: ".", file: "a" }], catalogName: "Amazon DynamoDB" },
        {
          name: "Amazon DynamoDB",
          evidence: [{ repo: ".", file: "b" }],
          catalogName: "Amazon DynamoDB",
        },
        {
          name: "@aws-sdk/client-dynamodb",
          evidence: [{ repo: ".", file: "c" }],
          catalogName: "Amazon DynamoDB",
        },
      ],
    });

    const singleResults = scored(singleSpelling);
    const tripleResults = scored(tripleSpelling);

    const singleDat414 = singleResults.find((r) => r.code === "DAT414");
    const tripleDat414 = tripleResults.find((r) => r.code === "DAT414");
    expect(singleDat414).toBeDefined();
    expect(tripleDat414).toBeDefined();

    const singleServiceReason = singleDat414!.reasons.find((r) => r.kind === "service");
    const tripleServiceReason = tripleDat414!.reasons.find((r) => r.kind === "service");
    expect(tripleServiceReason?.weight).toBe(singleServiceReason?.weight);

    // The whole point: nowhere near the ~150 a per-spelling multiplication would produce.
    expect(tripleDat414!.score).toBeLessThan(singleDat414!.score * 1.5);
  });


  it("deduplicates a pattern named under different casing, yielding exactly one topic reason", () => {
    const session: Session = {
      sessionId: "s1",
      abbreviation: "SVS100",
      title: "Serverless deep dive",
      topics: ["Serverless"],
    };
    const profile = resolvedProfile({
      patterns: [
        { name: "serverless", evidence: [{ repo: ".", file: "a" }] },
        { name: "Serverless", evidence: [{ repo: ".", file: "b" }] },
      ],
    });

    const results = scored(profile, [session]);

    expect(results).toHaveLength(1);
    const topicReasons = results[0]!.reasons.filter((r) => r.kind === "topic");
    expect(topicReasons).toHaveLength(1);
  });


  it("matches a profile note that writes an acronym lowercase against a session indexed from capitalized source text", () => {
    // The query tokenizer (see index-record.ts's keepShortTokens) must not apply the index's own
    // acronym-capitalization requirement to free text a profile author writes -- an agent noting
    // "we use ai heavily" means the real, capitalized "AI" the catalog's own copy carries in
    // INV501's title ("AtoZ AI Co-Scientist: Multi-Agent Systems That Do Research With You").
    const profile = resolvedProfile({ intents: [{ kind: "goal", text: "we use ai heavily" }] });

    const results = scored(profile);

    expect(results.some((r) => r.code === "INV501")).toBe(true);
  });
});

describe("service roles in the match query", () => {
  const raw: Session[] = [{ sessionId: "a", abbreviation: "AAA100", title: "Deep dive", services: ["AWS Lambda"] }];
  const serviceWeights = (services: ResolvedProfile["services"]) =>
    scored(resolvedProfile({ services }), raw)[0]!.reasons.filter(reason => reason.kind === "service").map(reason => reason.weight);
  const lambda = (extra: object) => ({ name: "lambda", catalogName: "AWS Lambda", evidence: [{ repo: ".", file: "x" }], ...extra });
  it("halves a supporting service's weight", () => {
    expect(serviceWeights([lambda({})])).toEqual([50]);
    expect(serviceWeights([lambda({ role: "core" })])).toEqual([50]);
    expect(serviceWeights([lambda({ role: "supporting" })])).toEqual([25]);
  });
  it("keeps full weight when another entry for the same service is core", () => {
    expect(serviceWeights([lambda({ role: "supporting" }), lambda({ name: "aws_lambda_function", role: "core" })])).toEqual([50]);
  });
  it("keeps a supporting service's name and usage out of the free-text relevance", () => {
    const sessions: Session[] = [{ sessionId: "b", abbreviation: "BBB100", title: "Gateway deep dive", abstract: "Gatewayzz throttling." }];
    const text = (services: ResolvedProfile["services"]) =>
      scored(resolvedProfile({ services }), sessions).flatMap(result => result.reasons.filter(reason => reason.kind === "text"));
    const gateway = (extra: object) => ({ name: "gateway", usage: "gatewayzz", catalogName: null, evidence: [{ repo: ".", file: "x" }], ...extra });
    expect(text([gateway({})])).toHaveLength(1);
    expect(text([gateway({ role: "supporting" })])).toEqual([]);
  });
});
