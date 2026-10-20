import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogServiceNames } from "../../src/catalog/query.js";
import { buildServiceAliasIndex } from "../../src/catalog/service-aliases.js";
import { matchSessions } from "../../src/match/match.js";
import { resolveProfile } from "../../src/profile/profile.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/aws/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, DEFAULT_EVENT_ID, writeCatalog, type CatalogMeta } from "../../src/catalog/store.js";
import { OUTPUT_BUDGET_BYTES } from "../../src/commands/output-budget.js";
import { callCommand } from "../helpers/call-command.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

function sampleMeta(overrides: Partial<CatalogMeta> = {}): CatalogMeta {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId: DEFAULT_EVENT_ID,
    syncedAt: 1_700_000_000_000,
    totalCount: fixture.length,
    count: fixture.length,
    includedAbstracts: true,
    timezone: null,
    ...overrides,
  };
}

function seedFixtureCatalog(storeRoot: string): void {
  writeCatalog(
    { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
    { storeRoot },
  );
}

/** `n` synthetic sessions that all cover AWS Lambda -- same shape as match-command.test.ts's own
 * helper -- needed because the 61-session fixture has no single service covering more than eight
 * sessions, so the default/cap limit tests need a synthetic pool bigger than fifty. */
function manyLambdaSessions(n: number): Session[] {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: `synthetic-${i}`,
    abbreviation: `LAM${String(i).padStart(3, "0")}`,
    title: `Lambda deep dive ${i}`,
    services: ["AWS Lambda"],
  }));
}

function seedCatalog(storeRoot: string, sessions: Session[]): void {
  writeCatalog(
    {
      raw: sessions,
      index: sessions.map(buildIndexRecord),
      meta: sampleMeta({ totalCount: sessions.length, count: sessions.length }),
    },
    { storeRoot },
  );
}

function lambdaProfile(): unknown {
  return {
    schemaVersion: 1,
    repos: [{ root: ".", languages: ["typescript"] }],
    services: [{ name: "lambda", evidence: [{ repo: ".", file: "src/handler.ts", line: 3 }] }],
    patterns: [],
  };
}

/** A pool of service names long enough, and numerous enough per session, to make every
 * candidate's own `reasons` array (one "service" reason per matched service -- see
 * match/score.ts) genuinely large -- deliberately synthetic, not because any real catalog session
 * looks like this, but because the 61-session fixture (and even a session with a realistic
 * handful of services) cannot produce a response anywhere near the 30 KB budget on its own; the
 * lead's truncation decision needs a scenario that actually crosses it to test at all. */
const LONG_SERVICE_NAMES = Array.from(
  { length: 20 },
  (_, i) => `Example Synthetic Cloud Service Number ${String(i).padStart(2, "0")} For Response Size Testing`,
);

function longReasonsSessions(n: number): Session[] {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: `long-${i}`,
    abbreviation: `LNG${String(i).padStart(3, "0")}`,
    title:
      `A deliberately verbose synthetic Lambda session title used only to inflate response size for ` +
      `the truncation test, entry number ${i}`,
    services: LONG_SERVICE_NAMES,
  }));
}

/** A profile whose one concept the sessions name cites forty places, each with a long note, so the
 * reason every candidate carries is genuinely large. */
function longReasonsProfile(): unknown {
  return {
    schemaVersion: 1,
    repos: [{ root: ".", languages: [] }],
    services: [
      {
        name: "AWS Lambda",
        evidence: Array.from({ length: 40 }, (_, i) => ({ repo: ".", file: `service-${i}.ts`, line: i + 1, note: "a long note about this place ".repeat(6) })),
      },
    ],
    patterns: [],
  };
}


describe("match_sessions tool", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it.each([
    ["fix", "gap-no-dlq", "Dead-letter queues", "pillarGap"],
    ["next-level", "genai-single-call", "Agentic workflows", "migrationPath"],
  ])("%s forwards complete cited reasons within the response budget", async (lens, source, title, kind) => {
    const evidence = [{ repo: "repo", file: "src/agent.ts", line: 17, note: "Complete citation" }];
    const profile = { schemaVersion: 1, repos: [{ root: "repo", languages: [] }], services: [{ name: "Amazon Bedrock", evidence }, { name: "AWS Lambda", evidence }], patterns: [{ name: source, evidence }] };
    seedCatalog(home.path, [{ sessionId: "lens", abbreviation: "LENS400", title: title!, abstract: "Starts from basic prompting today on Bedrock and Lambda." }]);
    const result = await callCommand("match_sessions", { profile, lens }, { storeRoot: home.path });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.text);
    expect(parsed.candidates.map((candidate: { code: string }) => candidate.code)).toEqual(["LENS400"]);
    expect(parsed.candidates[0].reasons).toContainEqual(expect.objectContaining({ kind, profileEvidence: evidence }));
    expect(parsed.candidates[0].reasons[0].evidence).toBe(lens === "fix" ? "Dead-letter queues" : "Agentic");
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
    evidence[0]!.note = "long citation ".repeat(4000);
    const huge = await callCommand("match_sessions", { profile, lens }, { storeRoot: home.path });
    expect(huge.isError).not.toBe(true);
    expect(Buffer.byteLength(huge.text)).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
    expect(JSON.parse(huge.text)).toMatchObject({ candidates: [], truncated: true, omitted: 1 });
  });

  it("returns ranked candidates from match_sessions", async () => {
    seedFixtureCatalog(home.path);

    const result = await callCommand("match_sessions", { profile: lambdaProfile() }, { storeRoot: home.path });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.text) as {
      candidates: Array<{ code: string; title: string; score: number; reasons: unknown[]; offerings: unknown[] }>;
      truncated: boolean;
    };
    expect(parsed.candidates.length).toBeGreaterThan(0);
    expect(parsed.candidates[0]!.score).toBeGreaterThan(0);
    expect(parsed.candidates[0]!.reasons.length).toBeGreaterThan(0);
    expect(parsed.candidates[0]!.offerings.length).toBeGreaterThan(0);
    expect(parsed.truncated).toBe(false);
  });

  it("uses a lean candidate shape, dropping fields offerings already carries", async () => {
    // Measured against the real 2,043-session catalog (not this fixture, which is too small to
    // expose it): the CLI's own full toPublicIndexRecord shape put the default-limit response
    // over the 30 KB budget. This pins the trimmed shape so it can't silently grow back.
    seedFixtureCatalog(home.path);

    const result = await callCommand("match_sessions", { profile: lambdaProfile() }, { storeRoot: home.path });

    const parsed = JSON.parse(result.text) as { candidates: Array<Record<string, unknown>> };
    expect(parsed.candidates.length).toBeGreaterThan(0);
    // `type` is deliberately kept (a caller needs to tell a Workshop from a Chalk talk); it's the
    // response-level truncation in buildMatchResponse, not the candidate shape, that now carries
    // the size guarantee -- see the size test below.
    expect(Object.keys(parsed.candidates[0]!).sort()).toEqual(
      ["code", "levelBand", "offerings", "reasons", "score", "sessionId", "title", "type", "why"].sort(),
    );
  });

  it("defaults match_sessions to twenty-five candidates", async () => {
    seedCatalog(home.path, manyLambdaSessions(60));

    const result = await callCommand("match_sessions", { profile: lambdaProfile() }, { storeRoot: home.path });

    const parsed = JSON.parse(result.text) as { candidates: unknown[]; requested: number };
    expect(parsed.candidates).toHaveLength(25);
    expect(parsed.requested).toBe(25);
  });

  it("caps match_sessions at fifty even when a larger limit is requested", async () => {
    seedCatalog(home.path, manyLambdaSessions(100));

    const result = await callCommand("match_sessions", { profile: lambdaProfile(), limit: 1000 }, { storeRoot: home.path });

    const parsed = JSON.parse(result.text) as { candidates: unknown[]; requested: number };
    expect(parsed.candidates).toHaveLength(50);
    expect(parsed.requested).toBe(50);
  });

  it("never includes abstracts in match_sessions output", async () => {
    seedFixtureCatalog(home.path);

    const result = await callCommand("match_sessions", { profile: lambdaProfile() }, { storeRoot: home.path });

    // The literal substring is the strongest guard here -- proves no candidate object anywhere in
    // the serialized response carries an "abstract" key at all, not just that one field was
    // checked and happened to be absent.
    expect(result.text).not.toContain('"abstract"');
  });

  it("tells the caller to import first when no catalog exists instead of failing opaquely", async () => {

    const result = await callCommand("match_sessions", { profile: lambdaProfile() }, { storeRoot: home.path });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/No catalog has been imported/);
  });

  it("distinguishes an unusable (outdated-schema) catalog from a missing one, through a real tool call", async () => {
    // toToolError's CatalogMissingError/CatalogUnusableError branches were unit-testable in
    // isolation, but a mapper being correct and a tool handler actually routing an error through
    // it are different properties -- reviewer's ask. A schema-version mismatch is the same
    // established trigger tests/catalog/query.test.ts's own CatalogUnusableError coverage uses.
    writeCatalog(
      {
        raw: fixture,
        index: fixture.map(buildIndexRecord),
        meta: sampleMeta({ schemaVersion: CURRENT_SCHEMA_VERSION - 1 }),
      },
      { storeRoot: home.path },
    );

    const result = await callCommand("match_sessions", { profile: lambdaProfile() }, { storeRoot: home.path });

    expect(result.isError).toBe(true);
    // "local rebuild" (CatalogUnusableError's own annotation) is the distinguishing phrase from
    // "catalog_sync and a signed-in session" (CatalogMissingError's), so this also pins that the
    // two error types stay textually distinguishable through the real tool call, not just in the
    // mapper's own source.
    expect(result.text).toMatch(/Rebuild it locally/i);
    expect(result.text).not.toMatch(/No catalog has been imported/);
  });

  it("keeps the response under 24 KiB and reports untruncated when everything fits", async () => {
    seedFixtureCatalog(home.path);

    const result = await callCommand("match_sessions", { profile: lambdaProfile() }, { storeRoot: home.path });

    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
    const parsed = JSON.parse(result.text) as {
      candidates: unknown[];
      truncated: boolean;
      returned: number;
      omitted: number;
      hint?: string;
    };
    expect(parsed.truncated).toBe(false);
    expect(parsed.returned).toBe(parsed.candidates.length);
    expect(parsed.omitted).toBe(0);
    expect(parsed.hint).toBeUndefined();
  });

  it("truncates and says so, staying under the size budget, when candidates would otherwise exceed it", async () => {
    // Lead's decision: the 30 KB budget is a hard guarantee at every limit, including the cap --
    // enforced mechanically at serialization time rather than by trimming the candidate shape
    // further, so reasons and offerings (the actual explainability) stay intact per candidate.
    seedCatalog(home.path, longReasonsSessions(60));

    const result = await callCommand("match_sessions", { profile: longReasonsProfile(), limit: 50 }, { storeRoot: home.path });

    expect(result.isError).not.toBe(true);
    const envelopeBytes = Buffer.byteLength(result.text, "utf8");
    expect(envelopeBytes).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);

    const parsed = JSON.parse(result.text) as {
      candidates: Array<Record<string, unknown>>;
      truncated: boolean;
      returned: number;
      requested: number;
      omitted: number;
      hint: string;
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.requested).toBe(50);
    // Fewer than requested -- the scenario is deliberately built so 50 genuinely would not fit.
    expect(parsed.returned).toBeLessThan(50);
    expect(parsed.candidates).toHaveLength(parsed.returned);
    // omitted counts only what the budget actually dropped from matchSessions' own ranked set --
    // not requested-minus-returned, which would also (wrongly) count a catalog simply not having
    // `requested` matches at all as an "omission."
    expect(parsed.omitted).toBeGreaterThan(0);
    expect(typeof parsed.hint).toBe("string");
    expect(parsed.hint.length).toBeGreaterThan(0);
    // Every included candidate is whole -- why and offerings are never partially serialized to
    // make room; a candidate is either fully in or fully left out. Ranking reasons (under All, the
    // concept reasons) went first, from all of them, and the response says so.
    expect((parsed as { rankingReasonsOmitted?: boolean }).rankingReasonsOmitted).toBe(true);
    for (const candidate of parsed.candidates) {
      expect(typeof (candidate.why as { summary: string }).summary).toBe("string");
      expect((candidate.offerings as unknown[]).length).toBeGreaterThan(0);
      expect(candidate.reasons).toEqual([]);
    }
  });

  it("names the omitted count in the truncation hint and never suggests lowering limit, which cannot reach the omitted ranks", async () => {
    // Lead's decision: the original hint ("Ask again with a smaller limit or a narrower lens to
    // see the rest.") was actionable advice that doesn't work -- a smaller `limit` only asks for
    // fewer of the same top-ranked candidates; there is no `offset` to reach the omitted,
    // lower-ranked ones. The only things that actually change which candidates rank highest are a
    // narrower lens or a more specific profile.
    seedCatalog(home.path, longReasonsSessions(60));

    const result = await callCommand("match_sessions", { profile: longReasonsProfile(), limit: 50 }, { storeRoot: home.path });

    const parsed = JSON.parse(result.text) as { truncated: boolean; omitted: number; hint: string };
    expect(parsed.truncated).toBe(true); // sanity: this scenario must actually truncate
    expect(parsed.omitted).toBeGreaterThan(0);
    expect(parsed.hint).toBe(
      `${parsed.omitted} lower-ranked candidates were omitted to fit the response budget. ` +
        "A narrower lens or a more specific profile changes what ranks highest.",
    );
    expect(parsed.hint).not.toMatch(/limit/i);
  });

  it("returns a truncated response's candidates as exactly the ranked prefix an untruncated run would produce", async () => {
    // Guards against a truncation that reorders or re-ranks rather than simply stopping early --
    // computed by calling the core matchSessions directly (bypassing the MCP layer's own
    // truncation entirely) with the same profile and options, so this compares against the real,
    // independently-computed ranking, not a copy of the tool's own logic.
    seedCatalog(home.path, longReasonsSessions(60));

    const result = await callCommand("match_sessions", { profile: longReasonsProfile(), limit: 50 }, { storeRoot: home.path });
    const parsed = JSON.parse(result.text) as { candidates: Array<{ code: string }>; returned: number };
    expect(parsed.returned).toBeGreaterThan(0);
    expect(parsed.returned).toBeLessThan(50); // confirms this scenario actually truncates

    const serviceNames = catalogServiceNames({ storeRoot: home.path });
    const serviceAliasIndex = buildServiceAliasIndex(serviceNames);
    const resolved = resolveProfile(longReasonsProfile(), serviceAliasIndex);
    const fullRanking = matchSessions(resolved, { storeRoot: home.path }, { limit: 50 });

    expect(parsed.candidates.map((c) => c.code)).toEqual(
      fullRanking.slice(0, parsed.returned).map((c) => c.code),
    );
  });
  it.each([
    ["all", "Lambda in practice", "Every handler runs on AWS Lambda behind a queue."],
    ["explain", "Introduction to Lambda", "Every handler runs on AWS Lambda behind a queue."],
    ["fix", "Dead-letter queues in depth", "Recover with dead-letter queues and redrive."],
    ["next-level", "Containers on Fargate", "Start from Lambda functions and grow into containers."],
  ] as const)("keeps %s within the response budget at the maximum limit with why on every candidate", async (lens, title, sentence) => {
    const filler = " Further detail about the session.".repeat(20);
    const sessions = Array.from({ length: 80 }, (_, i) => ({
      sessionId: `why-${i}`, abbreviation: `WHY${String(i).padStart(3, "0")}`, title: `${title} ${i}`,
      level: "200 - Intermediate", type: "Breakout session", abstract: `${sentence}${filler} ${sentence}`,
      services: ["AWS Lambda", "Amazon Simple Queue Service (Amazon SQS)", ...LONG_SERVICE_NAMES.slice(0, 6)],
    }));
    seedCatalog(home.path, sessions);
    const note = "Not evident in the cited scope: the three tenant-lifecycle EventBridge rules targeting Step Functions set no deadLetterQueue or retry policy. Second.".padEnd(400, "!");
    const evidence = Array.from({ length: 12 }, (_, i) => ({ repo: ".", file: `infra/very/long/path/to/a/construct-${i}.ts`, line: i + 1, note: "n".repeat(100) }));
    const result = await callCommand("match_sessions", {
        lens, limit: 100,
        profile: {
          schemaVersion: 1, repos: [{ root: ".", languages: [] }],
          services: [
            { name: "lambda", usage: note, evidence }, { name: "sqs", usage: note, evidence },
            ...LONG_SERVICE_NAMES.slice(0, 6).map(name => ({ name, usage: note, evidence })),
          ],
          patterns: [{ name: "gap-no-dlq", note, evidence }, { name: "serverless", note, evidence }],
        },
      }, { storeRoot: home.path });

    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
    const parsed = JSON.parse(result.text) as { candidates: Array<{ why: { summary: string; sessionSays?: string } }>; requested: number };
    expect(parsed.requested).toBe(50);
    expect(parsed.candidates.length).toBeGreaterThan(0);
    for (const candidate of parsed.candidates) {
      expect(candidate.why.summary.length).toBeGreaterThan(0);
      expect(candidate.why.sessionSays).toBeDefined();
    }
  });
});
