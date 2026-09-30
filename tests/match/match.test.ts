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
    timezone: null,
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

  it("lists only introductory sessions under the explain lens", () => {
    const sessions: Session[] = [
      { sessionId: "intro", abbreviation: "INT200", title: "Going serverless", level: "200 - Intermediate" },
      { sessionId: "advanced", abbreviation: "ADV300", title: "Serverless internals", level: "300 - Advanced" },
      { sessionId: "expert", abbreviation: "EXP400", title: "Serverless at the limit", level: "400 - Expert" },
    ];
    writeCatalog(
      { raw: sessions, index: sessions.map(buildIndexRecord), meta: sampleMeta({ totalCount: 3, count: 3 }) },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({
      patterns: [{ name: "serverless", evidence: [{ repo: ".", file: "x" }] }],
    });

    const results = matchSessions(profile, { storeRoot: home.path }, { lens: "explain" });

    expect(results.map((r) => r.record.abbreviation)).toEqual(["INT200"]);
  });

  it("excludes a session with no level band under a level-restricting lens", () => {
    // Deliberate decision: a session with no level at all (the real catalog has exactly one) is
    // excluded by a level-restricting lens, not assumed to satisfy it -- the same rule
    // catalog/query.ts's own --level filter already applies to an unknown level band.
    const noLevelSession: Session = {
      sessionId: "no-level-session",
      abbreviation: "NOLVL1",
      title: "A session about Lambda with no level at all",
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
      title: "Foundations of Lambda",
      type: "Breakout session",
      level: "100 - Foundational",
      services: ["AWS Lambda"],
    };
    const lab: Session = {
      sessionId: "lab",
      abbreviation: "LAB100",
      title: "Foundations of Lambda",
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

  it("excludes a lens-favored session under the explain lens when it shares nothing else with the profile", () => {
    // A level-200 Breakout session that matches nothing in the profile at all -- no service,
    // topic, area of interest, or text overlap. The format bonus is a tiebreak among real matches,
    // not a standalone signal; this session must never become a candidate purely by being the
    // lens's favored type.
    const unrelatedBreakout: Session = {
      sessionId: "unrelated",
      abbreviation: "BRK200",
      title: "Cost optimization for finance teams",
      type: "Breakout session",
      level: "200 - Intermediate",
    };
    writeCatalog(
      {
        raw: [unrelatedBreakout],
        index: [unrelatedBreakout].map(buildIndexRecord),
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

  it("ranks a genuine text match above an unrelated lens-favored session, which is excluded entirely", () => {
    // Reproduces the reviewer's exact finding: an unrelated Breakout session must not outrank --
    // or even outlast the zero-score gate ahead of -- a Workshop that actually matches the
    // profile's own pattern text, even though Workshop earns no format bonus under this lens at
    // all and the Breakout would otherwise get one.
    const unrelatedBreakout: Session = {
      sessionId: "unrelated",
      abbreviation: "BRK200",
      title: "Cost optimization for finance teams",
      type: "Breakout session",
      level: "200 - Intermediate",
    };
    const matchingWorkshop: Session = {
      sessionId: "matching",
      abbreviation: "WRK200",
      title: "Build a Kubernetes operator",
      type: "Workshop",
      level: "200 - Intermediate",
    };
    writeCatalog(
      {
        raw: [unrelatedBreakout, matchingWorkshop],
        index: [unrelatedBreakout, matchingWorkshop].map(buildIndexRecord),
        meta: sampleMeta({ totalCount: 2, count: 2 }),
      },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({
      patterns: [
        { name: "eks", evidence: [{ repo: ".", file: "x" }] },
      ],
    });

    const results = matchSessions(profile, { storeRoot: home.path }, { lens: "explain" });

    expect(results.map((r) => r.record.abbreviation)).toEqual(["WRK200"]);
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
      title: "Building with Lambda",
      type: "Breakout session",
      services: ["AWS Lambda"],
    };
    const sessionA: Session = {
      sessionId: "session-a",
      abbreviation: "AAA100",
      title: "Building with Lambda",
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
      title: "Building with Lambda",
      type: "Breakout session",
      services: ["AWS Lambda"],
      sessionTime: { date: "2026-12-01", time: "10:00", length: "60" },
    };
    const unscheduled: Session = {
      sessionId: "unscheduled",
      abbreviation: "AAA000",
      title: "Building with Lambda",
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
      title: "A session about Lambda with no level at all",
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

  it("scores a session typed 'constructor' as a real number, not a corrupted NaN, under a lens that grants a format bonus", () => {
    // record.type comes straight from the catalog API. If the lens's type-weight lookup were a
    // plain object, ["constructor"] would resolve to the inherited Object.prototype.constructor
    // function instead of undefined -- passing the "!== undefined" guard, getting pushed as a
    // reason's weight, and corrupting `score` (string concatenation, then NaN once the output
    // boundary's rounding step multiplies that string by 100) for every session of this type.
    const session: Session = {
      sessionId: "s1",
      abbreviation: "CON100",
      title: "Something matching the profile on Lambda",
      type: "constructor",
      level: "200 - Intermediate",
      services: ["AWS Lambda"],
    };
    writeCatalog(
      {
        raw: [session],
        index: [session].map(buildIndexRecord),
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

    expect(results).toHaveLength(1);
    expect(typeof results[0]!.score).toBe("number");
    expect(Number.isNaN(results[0]!.score)).toBe(false);
    expect(results[0]!.reasons.some((r) => r.kind === "format")).toBe(false);
  });
});

describe("matchSessions grouping repeat sessions by base code", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("collapses the fixture's real repeat pair into one candidate with two offerings", () => {
    // API303-R and API303-R1 (see tests/fixtures/README.md) are the real catalog's own repeat
    // pair: the same AWS AppSync talk, sat twice on different days.
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({
      services: [
        {
          name: "AWS AppSync",
          evidence: [{ repo: ".", file: "x" }],
          catalogName: "AWS AppSync",
        },
      ],
    });

    const results = matchSessions(profile, { storeRoot: home.path });

    const api303 = results.filter((r) => r.code === "API303");
    expect(api303).toHaveLength(1);
    expect(api303[0]!.offerings).toHaveLength(2);
    expect(api303[0]!.offerings.map((o) => o.abbreviation)).toEqual(["API303-R", "API303-R1"]);
    // The base sitting (2026-11-30) comes before the later repeat (2026-12-02).
    expect(api303[0]!.offerings.map((o) => o.startDate)).toEqual(["2026-11-30", "2026-12-02"]);
    // Neither raw member's abbreviation stands in for the group -- "API303" is the stable code
    // both sittings share.
    expect(results.some((r) => r.code === "API303-R" || r.code === "API303-R1")).toBe(false);
  });

  it("strips the real catalog's trailing '[REPEAT]' title marker from the group's displayed title, even when the marked sitting scores highest", () => {
    // API303-R1's own title carries " [REPEAT]" (matching the real catalog's convention); if that
    // sitting happens to be the group's best-scoring member, the group must still display the
    // clean, unmarked title, not "... [REPEAT]".
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );

    // Text-only query naming API303-R1's own repeat marker plus a term only it would favor via
    // extra title weight is unnecessary here -- both members share identical text apart from the
    // marker, so any AWS AppSync match ties between them and the tie-break (first in index order)
    // picks API303-R, which does NOT carry the marker. To actually exercise "the marked sitting
    // scores highest", give the query textual overlap that only scores through the title, where
    // API303-R1's extra word "repeat" itself would otherwise nudge it ahead if title-stripping
    // happened before scoring rather than only at display time.
    const profile = resolvedProfile({
      services: [
        { name: "AWS AppSync", evidence: [{ repo: ".", file: "x" }], catalogName: "AWS AppSync" },
      ],
      intents: [{ kind: "goal", text: "repeat" }],
    });

    const results = matchSessions(profile, { storeRoot: home.path });

    const api303 = results.find((r) => r.code === "API303");
    expect(api303).toBeDefined();
    expect(api303!.record.title).toBe("Building real-time applications with event-driven architectures");
    expect(api303!.record.title).not.toContain("REPEAT");
  });

  it("gives a session with no repeats a one-element offerings list", () => {
    writeCatalog(
      { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({
      services: [
        { name: "Amazon Redshift", evidence: [{ repo: ".", file: "x" }], catalogName: "Amazon Redshift" },
      ],
    });

    const results = matchSessions(profile, { storeRoot: home.path });

    const ant301 = results.find((r) => r.code === "ANT301");
    expect(ant301).toBeDefined();
    expect(ant301!.offerings).toHaveLength(1);
    expect(ant301!.offerings[0]!.abbreviation).toBe("ANT301");
  });

  it("keeps a three-member repeat group's every sitting in the offerings list", () => {
    const base: Session = {
      sessionId: "arc202-r",
      abbreviation: "ARC202-R",
      title: "Where does Lambda fit? A capability-first approach to agentic AI",
      services: ["AWS Lambda"],
      sessionTime: { date: "2026-12-01", time: "14:30", length: "60" },
    };
    const repeat1: Session = {
      ...base,
      sessionId: "arc202-r1",
      abbreviation: "ARC202-R1",
      title: `${base.title} [REPEAT]`,
      sessionTime: { date: "2026-12-03", time: "10:00", length: "60" },
    };
    const repeat2: Session = {
      ...base,
      sessionId: "arc202-r2",
      abbreviation: "ARC202-R2",
      title: `${base.title} [REPEAT]`,
      sessionTime: { date: "2026-12-02", time: "10:00", length: "60" },
    };
    writeCatalog(
      {
        raw: [base, repeat1, repeat2],
        index: [base, repeat1, repeat2].map(buildIndexRecord),
        meta: sampleMeta({ totalCount: 3, count: 3 }),
      },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({
      services: [
        { name: "lambda", evidence: [{ repo: ".", file: "x" }], catalogName: "AWS Lambda" },
      ],
    });

    const results = matchSessions(profile, { storeRoot: home.path });

    expect(results).toHaveLength(1);
    expect(results[0]!.code).toBe("ARC202");
    // Sorted by start time: Dec 1, then Dec 2 (-R2), then Dec 3 (-R1) -- deliberately out of
    // abbreviation-suffix order, so this fails if offerings were sorted by abbreviation instead of
    // by their actual scheduled time.
    expect(results[0]!.offerings.map((o) => o.abbreviation)).toEqual([
      "ARC202-R",
      "ARC202-R2",
      "ARC202-R1",
    ]);
  });

  it("does not merge a sponsored '-S' session into a same-named base code's group", () => {
    // The real catalog's one collision between the two suffix conventions: AIM214 (a SageMaker
    // session) and AIM214-S (an unrelated sponsored talk) happen to share a base string, but "-S"
    // is not a repeat suffix -- a broader "-<letter><digits>?" pattern would wrongly merge them
    // and attach one session's sittings to the other's title in output an agent reads as fact.
    const base: Session = {
      sessionId: "aim214",
      abbreviation: "AIM214",
      title: "The age of vertical models: training to deployment on SageMaker AI",
      services: ["Amazon SageMaker AI"],
    };
    const sponsored: Session = {
      sessionId: "aim214-s",
      abbreviation: "AIM214-S",
      title: "Ring's Security Evolution: From Doorbell to Enterprise Platform (sponsored by Ring LLC)",
      abstract: "Amazon SageMaker AI trains the models. SageMaker AI also serves them.",
      services: ["Amazon SageMaker AI"],
    };
    writeCatalog(
      {
        raw: [base, sponsored],
        index: [base, sponsored].map(buildIndexRecord),
        meta: sampleMeta({ totalCount: 2, count: 2 }),
      },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({
      services: [
        {
          name: "sagemaker",
          evidence: [{ repo: ".", file: "x" }],
          catalogName: "Amazon SageMaker AI",
        },
      ],
    });

    const results = matchSessions(profile, { storeRoot: home.path });

    const codes = results.map((r) => r.code).sort();
    expect(codes).toEqual(["AIM214", "AIM214-S"]);
    for (const candidate of results) {
      expect(candidate.offerings).toHaveLength(1);
    }
  });

  it("counts groups, not raw sittings, toward --limit", () => {
    // Three groups -- one with two members, two singletons -- four raw sittings total. A limit of
    // two must return two whole groups (three rows' worth of data), not stop after two raw rows
    // and clip the two-member group in half.
    const groupA1: Session = {
      sessionId: "a1",
      abbreviation: "GRP100-R",
      title: "Highest scoring Lambda talk",
      services: ["AWS Lambda"],
      abstract: "lambda lambda lambda",
      sessionTime: { date: "2026-12-01", time: "10:00", length: "60" },
    };
    const groupA2: Session = {
      ...groupA1,
      sessionId: "a2",
      abbreviation: "GRP100-R1",
      title: `${groupA1.title} [REPEAT]`,
      sessionTime: { date: "2026-12-02", time: "10:00", length: "60" },
    };
    const groupB: Session = {
      sessionId: "b1",
      abbreviation: "GRP200",
      title: "Middle scoring Lambda talk",
      services: ["AWS Lambda"],
      abstract: "lambda",
    };
    const groupC: Session = {
      sessionId: "c1",
      abbreviation: "GRP300",
      title: "Lowest scoring Lambda talk",
      services: ["AWS Lambda"],
    };
    writeCatalog(
      {
        raw: [groupA1, groupA2, groupB, groupC],
        index: [groupA1, groupA2, groupB, groupC].map(buildIndexRecord),
        meta: sampleMeta({ totalCount: 4, count: 4 }),
      },
      { storeRoot: home.path },
    );

    const profile = resolvedProfile({
      services: [
        { name: "lambda", evidence: [{ repo: ".", file: "x" }], catalogName: "AWS Lambda" },
      ],
      intents: [{ kind: "goal", text: "lambda" }],
    });

    const results = matchSessions(profile, { storeRoot: home.path }, { limit: 2 });

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.code)).toEqual(["GRP100", "GRP200"]);
    // The two-member group must still carry both its offerings, not just whichever raw row
    // happened to fall inside the old, ungrouped limit.
    expect(results[0]!.offerings).toHaveLength(2);
  });

  it("uses the maximum member score for the group, not a sum across repeats", () => {
    const a: Session = {
      sessionId: "a",
      abbreviation: "DUP100-R",
      title: "Same Lambda talk, sitting one",
      services: ["AWS Lambda"],
    };
    const b: Session = { ...a, sessionId: "b", abbreviation: "DUP100-R1", title: `${a.title} [REPEAT]` };
    writeCatalog(
      {
        raw: [a, b],
        index: [a, b].map(buildIndexRecord),
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

    expect(results).toHaveLength(1);
    // A sum across the two identical members would double the concept's weight to 120; the group's
    // score must be the same 60 (20 for a match, 10 for each of a title mention and a listed
    // service) either single member would score on its own.
    expect(results[0]!.score).toBe(60);
  });

  it("orders tied groups by code", () => {
    // Two groups, genuinely tied on score by construction (identical service, no repeats), so
    // this fails on the score comparison alone if the code tiebreak weren't applied -- and codes
    // deliberately don't sort the same way their sessionIds would, so this can't pass by accident.
    const sessionZ: Session = {
      sessionId: "session-z",
      abbreviation: "ZZZ999",
      title: "Building with Lambda",
      services: ["AWS Lambda"],
    };
    const sessionA: Session = {
      sessionId: "session-a",
      abbreviation: "AAA100",
      title: "Building with Lambda",
      services: ["AWS Lambda"],
    };
    writeCatalog(
      {
        raw: [sessionZ, sessionA],
        index: [sessionZ, sessionA].map(buildIndexRecord),
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
    expect(results.map((r) => r.code)).toEqual(["AAA100", "ZZZ999"]);
  });
});

describe("evidence lenses end to end", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); });
  afterEach(() => { home.cleanup(); });
  const evidence = [{ repo: "repo", file: "stack.ts", line: 12 }];
  const sessions: Session[] = [
    { sessionId: "source", abbreviation: "SRC100", title: "Lambda serverless basics", services: ["AWS Lambda"], type: "Breakout session", level: "200 - Intermediate" },
    { sessionId: "fix", abbreviation: "FIX400", title: "Queue recovery", abstract: "Explore dead-letter queues and redrive for Lambda and SQS consumers.", level: "400 - Expert" },
    { sessionId: "next", abbreviation: "NEXT400", title: "Containers runtime options", topics: ["Containers"], abstract: "Beyond Lambda.", level: "400 - Expert" },
    { sessionId: "alien", abbreviation: "ALIEN100", title: "Quux flibbertigibbet", type: "Breakout session" },
  ];
  const p = (names: string[] = ["gap-no-dlq", "serverless"]) => resolvedProfile({
    services: [{ name: "lambda", catalogName: "AWS Lambda", evidence }, { name: "sqs", catalogName: "Amazon Simple Queue Service (Amazon SQS)", evidence }],
    patterns: names.map(name => ({ name, evidence })),
    interests: ["Lambda"], intents: [{ kind: "goal", text: "serverless dead-letter containers" }],
  });
  function seed(raw = sessions): void {
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: sampleMeta({ count: raw.length, totalCount: raw.length }) }, { storeRoot: home.path });
  }
  it.each([ ["fix", "FIX400", "pillarGap"], ["next-level", "NEXT400", "migrationPath"] ] as const)("%s requires remediation/destination signal and carries citations without level filtering", (lens, code, kind) => {
    seed();
    const input = p(); delete input.intents; delete input.interests;
    const results = matchSessions(input, { storeRoot: home.path }, { lens });
    expect(results.map(result => result.code)).toEqual([code]);
    expect(results[0]!.score).toBeGreaterThanOrEqual(30);
    expect(results[0]!.reasons).toContainEqual(expect.objectContaining({ kind, profileEvidence: evidence }));
    expect(results[0]!.reasons[0]!.evidence).toBe(lens === "fix" ? "dead-letter queues" : "Containers");
  });
  it.each(["fix", "next-level"] as const)("%s returns zero for absent/unknown source despite strong services, intent, and interests", lens => {
    seed();
    for (const names of [[], ["constructor"], ["gap-invented"], ["unknown-pattern"]]) {
      expect(matchSessions(p(names), { storeRoot: home.path }, { lens })).toEqual([]);
    }
  });
  it.each(["fix", "next-level"] as const)("%s ranks eligible sessions by actual profile relevance after admission", lens => {
    const title = lens === "fix" ? "Dead-letter queues" : "Containers";
    seed([
      { sessionId: "generic", abbreviation: "AAA100", title, abstract: "Lambda and SQS." },
      { sessionId: "relevant", abbreviation: "ZZZ100", title, services: ["AWS Lambda"], abstract: "Lambda and SQS." },
      { sessionId: "source", abbreviation: "SRC100", title: "Lambda basics", services: ["AWS Lambda"] },
    ]);
    const results = matchSessions(p(), { storeRoot: home.path }, { lens });
    expect(results.map(result => result.code)).toEqual(["ZZZ100", "AAA100"]);
    expect(results[0]!.reasons.some(reason => reason.kind === "service")).toBe(true);
    expect(results[0]!.score).toBeCloseTo(results[0]!.reasons.reduce((sum, reason) => sum + reason.weight, 0), 1);
  });
  it.each(["fix", "next-level"] as const)("%s rounds the emitted score and reason weights to two decimal places, ranking on the full precision", lens => {
    const title = lens === "fix" ? "Dead-letter queues" : "Containers";
    seed([
      { sessionId: "a", abbreviation: "AAA100", title, services: ["AWS Lambda"], abstract: "Lambda and SQS." },
      { sessionId: "source", abbreviation: "SRC100", title: "Lambda basics", services: ["AWS Lambda"] },
    ]);
    const [result] = matchSessions(p(), { storeRoot: home.path }, { lens });
    const twoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
    expect(result!.score).not.toBe(Math.round(result!.score));
    expect(twoDecimals(result!.score)).toBe(true);
    expect(result!.reasons.every(reason => twoDecimals(reason.weight))).toBe(true);
  });
  it("retains the winning sitting's signals, sources, grouping, limits and deterministic order", () => {
    seed([
      { sessionId: "weak", abbreviation: "FIX400-R1", title: "Dead-letter queues [REPEAT]", abstract: "Lambda and SQS." },
      { sessionId: "strong", abbreviation: "FIX400-R2", title: "Dead-letter queues and CloudWatch alarms [REPEAT]", abstract: "Lambda and SQS." },
      { sessionId: "other", abbreviation: "FIX401", title: "Dead-letter queues", abstract: "Lambda and SQS." },
    ]);
    const result = matchSessions(p(["gap-no-dlq", "GAP-NO-DLQ", "gap-no-alarms"]), { storeRoot: home.path }, { lens: "fix", limit: 1 });
    expect(result).toHaveLength(1);
    expect(result[0]!.record.sessionId).toBe("strong");
    expect(result[0]!.score).toBeGreaterThanOrEqual(60);
    expect(result[0]!.reasons.filter(reason => reason.kind === "pillarGap").map(reason => reason.evidence)).toEqual(["Dead-letter queues", "CloudWatch alarms"]);
    expect(result[0]!.reasons.filter(reason => reason.kind === "pillarGap").every(reason => JSON.stringify(reason.profileEvidence) === JSON.stringify(evidence))).toBe(true);
    expect(result[0]!.offerings.map(offering => offering.sessionId).sort()).toEqual(["strong", "weak"]);
  });
  it("gives the all and explain lenses their own concept reasons for the source session", () => {
    seed(sessions.filter(session => session.sessionId === "source" || session.sessionId === "alien"));
    const plain = resolvedProfile({ services: [{ name: "lambda", catalogName: "AWS Lambda", evidence }] });
    const all = matchSessions(plain, { storeRoot: home.path });
    const explain = matchSessions(plain, { storeRoot: home.path }, { lens: "explain" });
    expect(all.map(result => [result.code, result.score, result.reasons])).toEqual([["SRC100", 60, [
      { kind: "matchesConcept", detail: 'Matches AWS Lambda ("Lambda"), which this code uses at stack.ts:12.', weight: 60, evidence: "Lambda", profileEvidence: evidence },
    ]]]);
    expect(explain.map(result => [result.code, result.score, result.reasons])).toEqual([["SRC100", 65, [
      { kind: "explainsConcept", detail: 'Explains AWS Lambda ("Lambda"), which this code uses at stack.ts:12.', weight: 60, evidence: "Lambda", profileEvidence: evidence },
      { kind: "format", detail: "Breakout session sessions are favored under the explain lens.", weight: 5, evidence: "Breakout session" },
    ]]]);
  });
});
