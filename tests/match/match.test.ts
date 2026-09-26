import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog, type CatalogMeta } from "../../src/catalog/store.js";
import { CatalogMissingError } from "../../src/core/errors.js";
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
});
