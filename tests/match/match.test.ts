import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog, type CatalogMeta } from "../../src/catalog/store.js";
import { CatalogMissingError, CatalogUnusableError } from "../../src/core/errors.js";
import { matchSessions } from "../../src/match/match.js";
import type { ResolvedProfile } from "../../src/profile/profile.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

function sampleMeta(overrides: Partial<CatalogMeta> = {}): CatalogMeta {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId: "reinvent2026",
    syncedAt: 1_700_000_000_000,
    totalCount: fixture.length,
    count: fixture.length,
    includedAbstracts: true,
    ...overrides,
  };
}

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

describe("matchSessions", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("ranks the serverless repo's top candidates around lambda and step functions", () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({
      services: [
        { name: "lambda", evidence: [{ repo: ".", file: "x" }], catalogName: "AWS Lambda" },
        {
          name: "sfn",
          evidence: [{ repo: ".", file: "x" }],
          catalogName: "AWS Step Functions",
        },
      ],
    });

    const results = matchSessions(profile, { storeRoot: home.path }, { limit: 5 });

    // API318 is the only fixture session covering both AWS Lambda and AWS Step Functions -- the
    // strongest possible double service-match signal -- so it must lead the ranking.
    expect(results[0]?.record.abbreviation).toBe("API318");
  });

  it("restricts the explain lens to level bands 100 and 200", () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({
      services: [
        { name: "lambda", evidence: [{ repo: ".", file: "x" }], catalogName: "AWS Lambda" },
      ],
    });

    const results = matchSessions(profile, { storeRoot: home.path }, { lens: "explain" });

    for (const result of results) {
      expect(result.record.levelBand).not.toBeNull();
      expect([100, 200]).toContain(result.record.levelBand);
    }
    // API201 (Lambda, level 200, Breakout session) is a genuine fixture match at an allowed band.
    expect(results.map((r) => r.record.abbreviation)).toContain("API201");
    // API402 and COM320 (Lambda, level 400/300) must be excluded by the lens's level restriction.
    expect(results.map((r) => r.record.abbreviation)).not.toContain("API402");
    expect(results.map((r) => r.record.abbreviation)).not.toContain("COM320");
  });

  it("excludes a session with no level band under a level-restricting lens", () => {
    // Deliberate decision: a session with no level at all (the real catalog has exactly one) is
    // excluded by a level-restricting lens, not assumed to satisfy it -- the same rule
    // catalog/query.ts's own --level filter already applies to an unknown level band.
    const noLevelSession: Session = {
      sessionId: "no-level-session",
      abbreviation: "NOLVL1",
      title: "A session with no level at all",
      services: ["AWS Lambda"],
    };
    writeCatalog(
      {
        raw: [noLevelSession],
        index: [buildIndexRecord(noLevelSession)],
        meta: sampleMeta({ totalCount: 1, count: 1 }),
      },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({
      services: [
        { name: "lambda", evidence: [{ repo: ".", file: "x" }], catalogName: "AWS Lambda" },
      ],
    });

    const results = matchSessions(profile, { storeRoot: home.path }, { lens: "explain" });

    expect(results).toEqual([]);
  });

  it("prefers lecture-style and breakout formats under the explain lens", () => {
    const breakout: Session = {
      sessionId: "breakout",
      abbreviation: "BRK100",
      title: "Foundations of the platform",
      type: "Breakout session",
      level: "100 - Foundational",
      services: ["AWS Lambda"],
    };
    const lab: Session = {
      sessionId: "lab",
      abbreviation: "LAB100",
      title: "Foundations of the platform",
      type: "Lab",
      level: "100 - Foundational",
      services: ["AWS Lambda"],
    };
    writeCatalog(
      {
        raw: [breakout, lab],
        index: [breakout, lab].map(buildIndexRecord),
        meta: sampleMeta({ totalCount: 2, count: 2 }),
      },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({
      services: [
        { name: "lambda", evidence: [{ repo: ".", file: "x" }], catalogName: "AWS Lambda" },
      ],
    });

    const results = matchSessions(profile, { storeRoot: home.path }, { lens: "explain" });

    const breakoutResult = results.find((r) => r.record.abbreviation === "BRK100");
    const labResult = results.find((r) => r.record.abbreviation === "LAB100");
    expect(breakoutResult!.score).toBeGreaterThan(labResult!.score);
    expect(breakoutResult!.reasons.some((r) => r.kind === "format")).toBe(true);
  });

  it("returns deeper sessions when the explain lens is not applied", () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({
      services: [
        { name: "lambda", evidence: [{ repo: ".", file: "x" }], catalogName: "AWS Lambda" },
      ],
    });

    const results = matchSessions(profile, { storeRoot: home.path }, { lens: "all" });

    // COM320 (Lambda, level band 300) would be excluded under the explain lens but must appear
    // when no lens restriction is applied at all.
    expect(results.map((r) => r.record.abbreviation)).toContain("COM320");
  });

  it("caps the result at the requested limit", () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({
      services: [
        { name: "lambda", evidence: [{ repo: ".", file: "x" }], catalogName: "AWS Lambda" },
      ],
    });

    const results = matchSessions(profile, { storeRoot: home.path }, { limit: 2 });

    expect(results).toHaveLength(2);
  });

  it("breaks ties by abbreviation so the order is stable", () => {
    // Genuinely tied by construction: identical service, title, and type, differing only in
    // abbreviation -- a real tie, not two unrelated sessions that merely happen not to differ.
    const sessionB: Session = {
      sessionId: "session-b",
      abbreviation: "ZZZ999",
      title: "Building with the platform",
      type: "Breakout session",
      services: ["AWS Lambda"],
    };
    const sessionA: Session = {
      sessionId: "session-a",
      abbreviation: "AAA100",
      title: "Building with the platform",
      type: "Breakout session",
      services: ["AWS Lambda"],
    };
    writeCatalog(
      {
        raw: [sessionB, sessionA],
        index: [sessionB, sessionA].map(buildIndexRecord),
        meta: sampleMeta({ totalCount: 2, count: 2 }),
      },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({
      services: [
        { name: "lambda", evidence: [{ repo: ".", file: "x" }], catalogName: "AWS Lambda" },
      ],
    });

    const results = matchSessions(profile, { storeRoot: home.path });

    expect(results[0]?.score).toBe(results[1]?.score);
    expect(results.map((r) => r.record.abbreviation)).toEqual(["AAA100", "ZZZ999"]);
  });

  it("ranks unscheduled sessions below otherwise equal scheduled ones", () => {
    // Genuinely tied on every scoring signal by construction (identical service, title, type),
    // differing only in whether sessionTime is present.
    const scheduled: Session = {
      sessionId: "scheduled",
      abbreviation: "SCH100",
      title: "Building with the platform",
      type: "Breakout session",
      services: ["AWS Lambda"],
      sessionTime: { date: "2026-12-01", time: "10:00", length: "60" },
    };
    const unscheduled: Session = {
      sessionId: "unscheduled",
      abbreviation: "AAA000",
      title: "Building with the platform",
      type: "Breakout session",
      services: ["AWS Lambda"],
    };
    writeCatalog(
      {
        raw: [scheduled, unscheduled],
        index: [scheduled, unscheduled].map(buildIndexRecord),
        meta: sampleMeta({ totalCount: 2, count: 2 }),
      },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({
      services: [
        { name: "lambda", evidence: [{ repo: ".", file: "x" }], catalogName: "AWS Lambda" },
      ],
    });

    const results = matchSessions(profile, { storeRoot: home.path });

    expect(results[0]?.score).toBe(results[1]?.score);
    // "AAA000" would sort first alphabetically -- proving this ordering is driven by scheduled
    // status, not the abbreviation tiebreak that would otherwise put it first.
    expect(results.map((r) => r.record.abbreviation)).toEqual(["SCH100", "AAA000"]);
  });

  it("returns an empty list rather than throwing for a profile with no signals", () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );

    const results = matchSessions(resolvedProfile(), { storeRoot: home.path });

    expect(results).toEqual([]);
  });

  it("errors with CatalogMissingError when the catalog has not been synced", () => {
    expect(() => matchSessions(resolvedProfile(), { storeRoot: home.path })).toThrow(
      CatalogMissingError,
    );
  });

  it("errors with CatalogUnusableError, distinct from CatalogMissingError, for an outdated local index", () => {
    // An agent acting on this needs to tell "you've never synced -- go online" apart from "your
    // local index needs a rebuild, no network required" -- collapsing both into one error type
    // would erase that distinction for the one caller (match) where it matters most: the profile
    // it's holding is otherwise ready to use the moment the index is fixed.
    writeCatalog(
      {
        raw: fixture,
        index: fixture.map(buildIndexRecord),
        meta: sampleMeta({ schemaVersion: CURRENT_SCHEMA_VERSION - 1 }),
      },
      { storeRoot: home.path },
    );

    let caught: unknown;
    try {
      matchSessions(resolvedProfile(), { storeRoot: home.path });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CatalogUnusableError);
    expect(caught).not.toBeInstanceOf(CatalogMissingError);
    expect((caught as CatalogUnusableError).reason).toBe("outdated");
  });

  it("includes a session with no level band when the lens does not restrict by level", () => {
    // The mirror image of "excludes a session with no level band under a level-restricting lens"
    // above: the same no-level session must NOT be excluded when nothing constrains level at all
    // -- there's no band to violate, so a null level band is only ever a problem for a lens that
    // actually checks it.
    const noLevelSession: Session = {
      sessionId: "no-level-session",
      abbreviation: "NOLVL1",
      title: "A session with no level at all",
      services: ["AWS Lambda"],
    };
    writeCatalog(
      {
        raw: [noLevelSession],
        index: [buildIndexRecord(noLevelSession)],
        meta: sampleMeta({ totalCount: 1, count: 1 }),
      },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({
      services: [
        { name: "lambda", evidence: [{ repo: ".", file: "x" }], catalogName: "AWS Lambda" },
      ],
    });

    const results = matchSessions(profile, { storeRoot: home.path }, { lens: "all" });

    expect(results.map((r) => r.record.abbreviation)).toEqual(["NOLVL1"]);
  });

  it("rounds the emitted score and reason weights to two decimal places, without disturbing ranking precision", () => {
    // A title-only match on "lambda", the only document (of two) that contains it -- BM25-lite's
    // saturation and inverse-document-frequency arithmetic together produce a long, non-clean
    // floating-point value here (raw: 3 * (1/2.5) * ln(2/1) = 0.8317766166719345), which is exactly
    // the kind of noise this rounding exists to hide. The scorer itself must keep that full
    // precision internally for correct ranking (see score.test.ts); only this module's final,
    // agent-facing output gets rounded, once, after ranking is settled.
    const session: Session = {
      sessionId: "s1",
      abbreviation: "LAM100",
      title: "AWS Lambda Basics",
    };
    // A second, unrelated document so "lambda" isn't in literally every document in the corpus --
    // with only one document, its own inverse document frequency would be exactly zero (see
    // score.test.ts's corpus-statistics tests), which would hide the rounding this test exists to
    // check rather than exercise it.
    const filler: Session = { sessionId: "s2", abbreviation: "FIL100", title: "Unrelated filler" };
    writeCatalog(
      {
        raw: [session, filler],
        index: [session, filler].map(buildIndexRecord),
        meta: sampleMeta({ totalCount: 2, count: 2 }),
      },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({ intents: [{ kind: "goal", text: "lambda" }] });

    const results = matchSessions(profile, { storeRoot: home.path });

    expect(results[0]?.record.abbreviation).toBe("LAM100");
    expect(results[0]?.score).toBe(0.83);
    const textReason = results[0]?.reasons.find((r) => r.kind === "text");
    expect(textReason?.weight).toBe(0.83);
  });

  it("ranks a candidate matching a rare term above one matching only a near-universal term, using the fixture's real corpus frequencies", () => {
    // Real, measured frequencies in the 60-session fixture: "amazon" appears in 45 of 60 sessions
    // (the catalog's own "Amazon <service>" naming convention makes it near-universal), while
    // "guide" appears in only 3. INV501 contains "amazon" twice (via its services, Amazon API
    // Gateway and Amazon Bedrock) but never "guide"; API318 contains "guide" once, in its abstract
    // ("...a real production example to guide your next serverless workflow decision"), but never
    // "amazon". On raw term frequency alone (no inverse document frequency), INV501's two "amazon"
    // occurrences actually outscore API318's one "guide" occurrence -- confirmed by hand against
    // this module's own scoring constants before this test was written. Inverse document frequency
    // must flip that: a term nearly every session shares says almost nothing about relevance,
    // while a term only three sessions use says a great deal.
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({ intents: [{ kind: "goal", text: "guide amazon" }] });

    const results = matchSessions(profile, { storeRoot: home.path });

    const rareTermMatch = results.find((r) => r.record.abbreviation === "API318");
    const universalTermMatch = results.find((r) => r.record.abbreviation === "INV501");

    expect(rareTermMatch).toBeDefined();
    expect(universalTermMatch).toBeDefined();
    expect(rareTermMatch!.score).toBeGreaterThan(universalTermMatch!.score);
  });
});
