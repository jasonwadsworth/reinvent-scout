import { PLATFORM_SERVICES } from "../../src/match/stack-fit.js";
import { patternPhrase } from "../../src/match/concepts.js";
import { LENS_RULE_SELECTORS } from "../../src/match/lens-signals.js";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { buildServiceAliasIndex } from "../../src/catalog/service-aliases.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { DEFAULT_EVENT_ID } from "../../src/catalog/sync.js";
import { registry } from "../../src/commands/registry.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { resolveProfile, type ResolvedProfile } from "../../src/profile/profile.js";
import { buildValidateReport } from "../../src/profile/report.js";
import { callCommand } from "../helpers/call-command.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = join(here, "..", "..", "plugin", "skills", "reinvent-scout");
const referenceDir = join(skillRoot, "reference");

function readSkillFile(...parts: string[]): string {
  return readFileSync(join(skillRoot, ...parts), "utf8");
}

const skillMd = readSkillFile("SKILL.md");
const taxonomyMd = readSkillFile("reference", "taxonomy.md");
const workflowMd = readSkillFile("reference", "workflow.md");
const profilingMd = readSkillFile("reference", "profiling.md");
const agentMd = readFileSync(join(skillRoot, "..", "..", "agents", "catalog-sync.md"), "utf8");
const watchMd = readSkillFile("reference", "watch.md");

/** Every skill file's raw text, concatenated -- the corpus a real reader (agent or human) actually
 * sees across the whole skill, not just one file. Reviewer's finding: checking only one dedicated
 * section (e.g. SKILL.md's own "## MCP tools used" list) lets a tool get renamed or removed
 * everywhere *else* in the doc -- the actual flow prose an agent follows -- while that one list
 * stays correct and the anti-drift check stays green. */
const allSkillText = [skillMd, profilingMd, taxonomyMd, workflowMd, watchMd, agentMd].join("\n");

/**
 * Strips fenced ``` code blocks before any single-backtick scan runs. Load-bearing, not cosmetic:
 * a fenced block's own opening/closing ``` markers are three literal backtick characters each, and
 * a naive `` /`([^`]+)`/g `` scan over raw text pairs backticks left-to-right with no awareness of
 * fences -- three backticks in a row parse as one zero-width empty match plus one unpaired
 * backtick, which desyncs the pairing for every real inline `code span` later in the same
 * document until a later fence happens to resync it. Confirmed directly: scanning this file's own
 * unfenced text finds `aws_dynamodb_table`/`aws_elasticache_serverless_cache`/`node_modules` (real
 * inline spans in reference/profiling.md, after several ```json blocks) only once fences are
 * stripped first -- without this, those three spans are silently swallowed by the desync and the
 * test below would never see them at all.
 */
function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

/**
 * Extracts the body of one `## Heading` section (up to, but not including, the next `## ` heading
 * or end of file).
 */
function extractSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const startIndex = lines.findIndex((line) => line.trim() === heading);
  if (startIndex === -1) {
    throw new Error(`Heading ${JSON.stringify(heading)} not found`);
  }
  const rest = lines.slice(startIndex + 1);
  const endIndex = rest.findIndex((line) => /^##\s/.test(line));
  return (endIndex === -1 ? rest : rest.slice(0, endIndex)).join("\n");
}

/** Bullet items of the form `- content` -- one per line, plain text. */
function plainBullets(section: string): string[] {
  return [...section.matchAll(/^- (.+)$/gm)].map((match) => match[1]!.trim());
}

/** Every backtick-quoted span, from fence-stripped text, matching either the bare tool name
 * `status` or a full snake_case identifier (`catalog_sync`, `aws_dynamodb_table`) -- deliberately
 * broader than "just the registered tools", so a stray or hallucinated identifier of the same
 * shape is caught by the allow-list check at the call site, not silently excluded by the
 * extraction itself. */
function backtickIdentifiers(text: string): string[] {
  const spans = [...stripFences(text).matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
  return spans.filter((span) => /^status$|^[a-z]+(?:_[a-z]+)+$/.test(span));
}


const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

interface CatalogVocabulary {
  sessionTypes: string[];
  levels: string[];
  topics: string[];
  roles: string[];
  areasOfInterest: string[];
  features: string[];
}

/** Distinct values per taxonomy field, extracted once from a real, full catalog pull -- see the
 * fixture file's own header comment for provenance. Unlike tests/fixtures/catalog-sample.json (61
 * sessions, used everywhere else in this suite), this exists specifically so
 * reference/taxonomy.md's vocabulary lists can be checked against the real catalog's full
 * vocabulary rather than a small sample that happens to be missing most of it. */
const vocabulary: CatalogVocabulary = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-vocabulary.json"), "utf8"),
);

function uniqueFixtureValues(field: "topics" | "roles" | "areasOfInterest" | "features"): string[] {
  const values = new Set<string>();
  for (const session of fixture) {
    for (const value of session[field] ?? []) {
      values.add(value);
    }
  }
  return [...values];
}

describe("SKILL.md frontmatter", () => {
  it("has valid frontmatter with a name and a description", () => {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(skillMd);
    expect(match).not.toBeNull();
    const frontmatter = match![1]!;
    expect(frontmatter).toMatch(/^name:\s*\S+/m);
    expect(frontmatter).toMatch(/^description:\s*\S+/m);
  });
});

describe("SKILL.md length", () => {
  it("keeps SKILL.md under five hundred lines", () => {
    expect(skillMd.split("\n").length).toBeLessThan(500);
  });
});

describe("skill files tool names", () => {
  /** A tool name the skill is allowed to mention without it being registered -- documented,
   * deliberate absences, not drift. Asserted below to genuinely be unregistered, so this allow-list
   * itself can't quietly go stale if the tool is ever actually added. */
  const documentedAbsentTools = new Set(["profile_repo"]);
  /** Backtick-quoted identifiers that happen to share the tool-name shape (lowercase, underscore-
   * joined) but are not tool names at all -- real examples used elsewhere in the reference docs
   * (a dependency directory, a Terraform resource-type name). Asserted below to genuinely be
   * unregistered too, for the same reason. */
  const documentedNonToolIdentifiers = new Set([
    "node_modules",
    "aws_dynamodb_table",
    "aws_elasticache_serverless_cache",
    "aws_cloudwatch_event_target",
    "aws_sqs_queue",
    "aws_sns_topic_subscription",
    "aws_lambda_function_event_invoke_config",
    "aws_cloudwatch_metric_alarm",
    "aws_iam_policy_document",
    "aws_lambda_event_source_mapping",
    "dead_letter_queue",
    "dead_letter_config",
    "redrive_policy",
    "destination_config",
    "alarm_actions",
    "memory_size",
    "on_failure",
  ]);

  it("names only commands the registry actually holds or explicitly documents as absent, anywhere in the skill's files", () => {
    const registered = new Set(Object.keys(registry));
    expect(registered.size).toBeGreaterThan(0);
    for (const name of documentedAbsentTools) expect(registered.has(name)).toBe(false);
    for (const name of documentedNonToolIdentifiers) expect(registered.has(name)).toBe(false);
    const extracted = new Set(backtickIdentifiers(allSkillText));
    expect(extracted.size).toBeGreaterThan(0);
    const allowed = new Set([...registered, ...documentedAbsentTools, ...documentedNonToolIdentifiers]);
    for (const name of extracted) expect(allowed.has(name), name).toBe(true);
  });

  it("names every registry command in the flow an agent actually follows, not just in a reference list", () => {
    const namedInFlow = new Set(backtickIdentifiers(extractSection(skillMd, "## The flow")));
    expect(namedInFlow.size).toBeGreaterThan(0);
    for (const name of Object.keys(registry)) expect(namedInFlow.has(name), name).toBe(true);
  });
});

describe("plugin skill conventions", () => {
  const flat = (text: string): string => text.replace(/\s+/g, " ");
  const expectAll = (text: string, phrases: string[]) => { for (const phrase of phrases) expect(flat(text), phrase).toContain(phrase); };
  // Quoted on purpose: the docs quote the path (it may hold spaces), and a rule only matches the command text it was written with.
  const SCRIPT_RULE = 'Bash(node "${CLAUDE_SKILL_DIR}/scripts/reinvent-scout.mjs" *)';
  const SKILL_SCRIPT = "${CLAUDE_SKILL_DIR}/scripts/reinvent-scout.mjs";
  const AGENT_SCRIPT = "${CLAUDE_PLUGIN_ROOT}/skills/reinvent-scout/scripts/reinvent-scout.mjs";
  const EITHER_NAME = "AWS Events tools are `mcp__plugin_reinvent-scout_awsevents__AWSEventsPublicApi-Mcp-prod___<Name>`, or `mcp__awsevents__AWSEventsPublicApi-Mcp-prod___<Name>` when your own `awsevents` server shadows the plugin's; use whichever is available.";
  const AWS_TOOLS = ["AssociateFavorites", "CancelReservation", "CreatePersonalTime", "DeletePersonalTime", "DisassociateFavorite", "GetEvent", "GetSchedule", "GetSession", "ListEvents", "ListSessions", "ReserveSessions", "UpdatePersonalTime"];
  const spansOf = (text: string): string[] => [...stripFences(text).matchAll(/`([^`]+)`/g)].map(match => match[1]!);

  it("pre-approves exactly the bundled script in SKILL.md's allowed-tools", () => {
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skillMd)![1]!;
    expect(/^allowed-tools: (.+)$/m.exec(frontmatter)?.[1]).toBe(SCRIPT_RULE);
  });
  it("writes every script invocation with the plugin-relative path and a registry command", () => {
    const files: Array<[string, string, string]> = [["SKILL.md", skillMd, SKILL_SCRIPT], ["workflow.md", workflowMd, SKILL_SCRIPT], ["watch.md", watchMd, SKILL_SCRIPT], ["profiling.md", profilingMd, SKILL_SCRIPT], ["catalog-sync.md", agentMd, AGENT_SCRIPT]];
    for (const [name, rawText, expected] of files) {
      const text = rawText.replace(/^---\n[\s\S]*?\n---\n/, "");
      for (const match of text.matchAll(/node "([^"]*reinvent-scout\.mjs)"(?: ([a-z_]+))?/g)) {
        expect(match[1], `${name} script path`).toBe(expected);
        expect(Object.keys(registry), `${name} command ${match[2]}`).toContain(match[2]);
      }
      const body = text;
      expect(body.match(/reinvent-scout\.mjs/g)?.length ?? 0, `${name} mentions of the script`).toBe(body.match(/node "[^"]*reinvent-scout\.mjs" [a-z_]+/g)?.length ?? 0);
    }
    for (const [name, text] of [["SKILL.md", skillMd], ["workflow.md", workflowMd], ["catalog-sync.md", agentMd]] as const) expect(text, name).toMatch(/node "[^"]*reinvent-scout\.mjs" [a-z_]+/);
  });
  it("names no CLI subcommand anywhere in the skill's files", () => {
    for (const span of spansOf(allSkillText)) expect(span, span).not.toMatch(/^reinvent-scout [a-z]/);
    for (const line of allSkillText.split("\n")) expect(line, line).not.toMatch(/^\s*(?:\$ )?reinvent-scout [a-z]/);
  });
  it("names only real AWS Events tools, under the two server prefixes", () => {
    for (const span of spansOf(allSkillText)) {
      if (/^(List|Get|Associate|Disassociate|Reserve|Cancel|Create|Update|Delete)[A-Z]\w+$/.test(span)) expect(AWS_TOOLS, span).toContain(span);
      if (span.startsWith("mcp__")) {
        if (span === "mcp__plugin_reinvent-scout_awsevents__AWSEventsPublicApi-Mcp-prod___<Name>" || span === "mcp__awsevents__AWSEventsPublicApi-Mcp-prod___<Name>") continue;
        const match = /^mcp__(?:plugin_reinvent-scout_awsevents|awsevents)__AWSEventsPublicApi-Mcp-prod___(\w+)$/.exec(span);
        expect(match, span).not.toBeNull();
        expect(AWS_TOOLS, span).toContain(match![1]);
      }
    }
    for (const tool of /^tools: (.+)$/m.exec(agentMd)![1]!.split(",").map(entry => entry.trim()).filter(entry => entry.startsWith("mcp__"))) {
      const match = /^mcp__(?:plugin_reinvent-scout_awsevents|awsevents)__AWSEventsPublicApi-Mcp-prod___(\w+)$/.exec(tool);
      expect(match, tool).not.toBeNull();
      expect(AWS_TOOLS, tool).toContain(match![1]);
    }
  });
  it("says in SKILL.md, the sync agent and watch.md that either server name works", () => {
    for (const [name, text] of [["SKILL.md", skillMd], ["catalog-sync.md", agentMd], ["watch.md", watchMd]] as const) expect(flat(text), name).toContain(EITHER_NAME);
  });
  it("never asks the user to remove their own awsevents entry", () => {
    expect(flat(allSkillText)).not.toMatch(/remove your (?:own )?`?awsevents/i);
  });

  describe("catalog sync through the plugin agent", () => {
    it("has SKILL.md run the agent, keep the catalog out of context, relay only the summary and ask before allowShrink", () => {
      expectAll(extractSection(skillMd, "## The flow"), [
        "run the `reinvent-scout:catalog-sync` agent",
        "The catalog never enters your context",
        "relay only its summary",
        "ask the user, with both counts, before passing `allowShrink`",
        "call `catalog_changes`",
      ]);
    });
    it("gives the agent the whole sync brief", () => {
      expectAll(agentMd, [
        "Call `GetEvent`",
        "`ListSessions` with `includeAbstracts: true`",
        "saved to a file",
        "pass its absolute path as `path`",
        "pass it as `page`",
        "`action: \"page\"`",
        "`action: \"commit\"`",
        "until the output says `complete: true`",
        "Never pass allowShrink",
        "Never return session data",
      ]);
    });
    it("documents the same brief and the protocol in workflow.md", () => {
      expectAll(workflowMd, ["`catalog_import`", "`syncId`", "`shrunk`", "`allowShrink`", "`catalog_changes`", "reinvent-scout:catalog-sync"]);
    });
  });

  describe("the schedule and favorites through AWS", () => {
    it("has SKILL.md use GetSchedule, plan_schedule, ReserveSessions, CancelReservation, AssociateFavorites and DisassociateFavorite", () => {
      expectAll(extractSection(skillMd, "## The flow"), [
        "call `GetSchedule`", "pass the whole `schedule` object to `plan_schedule`",
        "`ReserveSessions`", "`CancelReservation`",
        "`AssociateFavorites`", "at most 10 ids per call", "on a 429, pause",
        "`DisassociateFavorite`", "`GetSession`",
        "resolve the ids on a `GetSchedule` result with `lookup_sessions`",
        "`includeAbstract`",
      ]);
    });
    it("gives the write rules in workflow.md", () => {
      expectAll(workflowMd, ["at most 10 ids per call", "read every `failed` entry", "A 409 means reservations are closed: stop", "on a 429, pause", "Never replay an uncertain write"]);
    });
  });
});


describe("SKILL.md reference file coverage", () => {
  it("references every file in the reference directory", () => {
    const files = readdirSync(referenceDir);

    // A sanity check on the test itself: if the reference directory were ever emptied out, this
    // would pass vacuously with nothing left to check.
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      expect(skillMd).toContain(`reference/${file}`);
    }
  });
});

describe("reference/taxonomy.md vocabulary", () => {
  const cases: Array<{ label: string; heading: string; field: keyof CatalogVocabulary }> = [
    { label: "session types", heading: "## Session types", field: "sessionTypes" },
    { label: "levels", heading: "## Levels", field: "levels" },
    { label: "topics", heading: "## Topics", field: "topics" },
    { label: "roles", heading: "## Roles", field: "roles" },
    { label: "areas of interest", heading: "## Areas of interest", field: "areasOfInterest" },
    { label: "features", heading: "## Features", field: "features" },
  ];

  it.each(cases)(
    "lists exactly the real catalog's $label, matching tests/fixtures/catalog-vocabulary.json",
    ({ heading, field }) => {
      const expected = new Set(vocabulary[field]);
      expect(expected.size).toBeGreaterThan(0);

      const listed = new Set(plainBullets(extractSection(taxonomyMd, heading)));
      expect(listed.size).toBeGreaterThan(0);

      for (const value of listed) {
        expect(expected.has(value)).toBe(true);
      }
      for (const value of expected) {
        expect(listed.has(value)).toBe(true);
      }
    },
  );

  it("has the 61-session test fixture's own topics, roles, areas of interest and features as a subset of the real vocabulary", () => {
    const subsetChecks: Array<{ label: string; fixtureValues: string[]; field: keyof CatalogVocabulary }> = [
      { label: "topics", fixtureValues: uniqueFixtureValues("topics"), field: "topics" },
      { label: "roles", fixtureValues: uniqueFixtureValues("roles"), field: "roles" },
      {
        label: "areasOfInterest",
        fixtureValues: uniqueFixtureValues("areasOfInterest"),
        field: "areasOfInterest",
      },
      { label: "features", fixtureValues: uniqueFixtureValues("features"), field: "features" },
    ];

    for (const { label, fixtureValues, field } of subsetChecks) {
      // A sanity check on the test itself: if the 61-session fixture ever carried none of this
      // field, the subset assertion below would pass vacuously.
      expect(fixtureValues.length, `${label} fixture values`).toBeGreaterThan(0);
      const realValues = new Set(vocabulary[field]);
      for (const value of fixtureValues) {
        expect(realValues.has(value), `${label}: ${value}`).toBe(true);
      }
    }
  });
});

describe("the sessionSays quote", () => {
  it("documents that a sentence about what the attendee will do is preferred, with the first match as the fallback", () => {
    const text = workflowMd.replace(/\s+/g, " ");
    for (const expected of ["one that says what the attendee will learn, build or see", "is preferred over a marketing opener", "the first sentence that names it is the fallback"]) expect(text, expected).toContain(expected);
    expect(readFileSync(join(here, "..", "..", "README.md"), "utf8").replace(/\s+/g, " ")).toContain("preferring one about what you will learn, build or see over the abstract's opener");
  });
});

describe("offering end times and conflicts", () => {
  it("tells the agent to use plan_schedule for any overlap question and never infer it from the times", () => {
    const flow = extractSection(skillMd, "## The flow").replace(/\s+/g, " ");
    expect(flow).toContain("Never judge yourself whether two sessions overlap or whether the user can attend both: that is a `plan_schedule` question, whatever the times look like, and `plan_schedule` needs the schedule from `GetSchedule`");
    expect(flow).toContain("with its `endTime` when it has one");
    const text = workflowMd.replace(/\s+/g, " ");
    for (const expected of ["\"startTime\": \"10:30\", \"endTime\": \"11:30\"", "An offering also has `endTime` (`startTime` plus the catalog's length", "is the first thing left off, before ranking reasons and before any candidate", "which checks time overlap (not travel or seats)", "(it needs the schedule from `GetSchedule`)", "Never infer that two sittings overlap or do not, or answer \"can I attend both\", from these times", "call `plan_schedule` with the offerings"]) {
      expect(text, expected).toContain(expected);
    }
    expect(readFileSync(join(here, "..", "..", "README.md"), "utf8").replace(/\s+/g, " ")).toContain("overlap and \"can I attend both\" are `plan_schedule` questions, never guessed from the times");
  });
});

describe("platform services the map leaves out", () => {
  it("tells the agent to say which platform services are not shown, in the skill, workflow.md and the readme", () => {
    expect(extractSection(skillMd, "## The flow").replace(/\s+/g, " ")).toContain("when `omittedPlatformServices` is not empty, the one line saying which platform services are not shown and why");
    const text = workflowMd.replace(/\s+/g, " ");
    for (const expected of ["\"omittedPlatformServices\": [...]", "`omittedPlatformServices` names the ones this profile has by short name", "Not shown: S3, KMS (platform services nearly every workload uses; they don't narrow sessions)", "Supporting services that are not platform services (SQS, WAF, SNS) stay listed"]) {
      expect(text, expected).toContain(expected);
    }
    expect(readFileSync(join(here, "..", "..", "README.md"), "utf8").replace(/\s+/g, " ")).toContain("a \"Not shown\" line naming the platform services");
  });
});

describe("truncation advice consistency", () => {
  it("never tells the agent a smaller limit can reach omitted match_sessions candidates", () => {
    // Reviewer's finding: SKILL.md once suggested "a smaller limit" as a way to narrow a
    // truncated match_sessions response, contradicting both workflow.md and the tool's own
    // truncationHint (src/mcp/tools.ts), which say a smaller limit returns fewer of the exact
    // same top-ranked candidates and can never reach the ones already omitted for size. It's fine
    // for the phrase to appear as part of explicitly saying *not* to do it (which is what should
    // be there now) -- the bug was offering it as one of the narrowing options in the same breath
    // as "a narrower lens, a more specific profile."
    const offeredAsOption = /\(a smaller\s+`?limit`?,/i;
    expect(skillMd).not.toMatch(offeredAsOption);
    expect(skillMd).toMatch(/not\*{0,2}\s+a smaller\s+`?limit`?/i);
    // Positive check that the real advice (narrower lens / more specific profile) is still there,
    // so this isn't just proving the phrase was deleted along with the whole sentence.
    expect(skillMd).toMatch(/narrower lens/i);
  });

  it("never shows a startsAt/endsAt example with milliseconds -- real output never has them", () => {
    // Reviewer's finding: workflow.md's get_schedule example showed "startsAt":
    // "2026-11-30T18:30:00.000Z", but zonedWallClockToUtcIso/addMinutesToIso (src/schedule/
    // timezone.ts) always strip the ".000" for these two fields specifically -- real output never
    // carries it. Scoped to startsAt/endsAt by name, not every timestamp in the skill corpus:
    // `accessTokenExpiresAt` (the `status` tool, src/mcp/tools.ts) is a genuinely different field,
    // built with a plain `new Date(...).toISOString()` that is never stripped -- its own example
    // correctly does show milliseconds, and must not be flagged as if it were the same bug.
    const startsAtOrEndsAtWithMs = /"(?:startsAt|endsAt)":\s*"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/;
    expect(allSkillText).not.toMatch(startsAtOrEndsAtWithMs);
    // Positive check that a real startsAt example is still present, so this isn't trivially
    // passing because no such example exists at all.
    expect(allSkillText).toMatch(/"startsAt":\s*"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"/);
  });
});

describe("reference file existence", () => {
  it("ships all three reference files named by the plan", () => {
    expect(taxonomyMd.length).toBeGreaterThan(0);
    expect(workflowMd.length).toBeGreaterThan(0);
    expect(profilingMd.length).toBeGreaterThan(0);
  });
});

describe("reference/profiling.md worked example", () => {
  it("validates, every service resolves against the catalog, and every pattern it records is matchable", () => {
    // Mirrors tests/docs.test.ts's own README-example check -- the same "the worked example must
    // actually work, not just read plausibly" guard, applied to profiling.md's own example instead.
    const profileBlocks = [...profilingMd.matchAll(/```json\n([\s\S]*?)```/g)]
      .map((match) => JSON.parse(match[1]!) as unknown)
      .filter(
        (parsed): parsed is Record<string, unknown> =>
          typeof parsed === "object" &&
          parsed !== null &&
          "schemaVersion" in parsed &&
          "services" in parsed &&
          "patterns" in parsed,
      );

    // A sanity check on the test itself: if profiling.md's full worked example is ever reworded
    // out of a single ```json fence (or removed), this must fail loudly, not pass vacuously.
    expect(profileBlocks).toHaveLength(1);

    const serviceNames = [...new Set(fixture.flatMap((session) => session.services ?? []))];
    const serviceAliasIndex = buildServiceAliasIndex(serviceNames);
    const resolved = resolveProfile(profileBlocks[0], serviceAliasIndex);
    expect(resolved.unresolvedServices).toEqual([]);

    // Every pattern the worked example records is one the lenses and the map can match.
    const patterns = (profileBlocks[0] as { patterns: Array<{ name: string }> }).patterns;
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) expect(isMatchablePattern(pattern.name), pattern.name).toBe(true);
  });
});

/** A pattern name the lenses and the map can use: it has a phrase entry in `concepts.ts`, or it is a Fix gap or Next-level source (or `dead-code`). */
function isMatchablePattern(name: string): boolean {
  return patternPhrase(name) !== undefined || LENS_RULE_SELECTORS.some((rule) => rule.source === name.toLowerCase()) || name.toLowerCase() === "dead-code";
}

/** Every pattern name a profiling guide recommends: the starting vocabulary, the curated phrase list, and each pattern its worked example records. */
function recommendedPatternNames(guide: string): string[] {
  // Every backticked token, whatever its spelling: a topic-spelled name ("Security & Identity") is exactly the dead end this guards against.
  const names = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
  const vocabulary = /starting vocabulary[^\n]*\n\n([\s\S]*?)\n\n/.exec(guide)?.[1] ?? "";
  const curated = /Patterns match through a curated phrase list:([\s\S]*?)\./.exec(guide)?.[1] ?? "";
  const example = [...guide.matchAll(/"patterns": \[([\s\S]*?)\n  \]/g)].flatMap((match) => [...match[1]!.matchAll(/"name": "([^"]+)"/g)].map((entry) => entry[1]!));
  return [...new Set([...names(vocabulary), ...names(curated), ...example])];
}

describe("profiling.md's recommended pattern names", () => {
  it("are all names the lenses and the map can match", () => {
    const recommended = recommendedPatternNames(profilingMd);
    // Sanity: the extraction finds the three places, or it would pass vacuously.
    for (const expected of ["serverless", "event-driven", "multi-account", "multi-tenant", "iac-cdk", "data-lake", "gap-no-dlq"]) expect(recommended, expected).toContain(expected);
    expect(recommended.filter((name) => !isMatchablePattern(name))).toEqual([]);
  });

  it("flags a recommended name the lenses cannot match", () => {
    const guide = "Use this starting vocabulary:\n\n`serverless`, `iac-terraform`.\n\nNext.\n\nPatterns match through a curated phrase list: `serverless`, `data-lake`.";
    expect(recommendedPatternNames(guide).filter((name) => !isMatchablePattern(name))).toEqual(["iac-terraform"]);
  });

  it("flags a recommended name that is not kebab-case, such as a catalog topic's spelling", () => {
    const guide = "Use this starting vocabulary:\n\n`serverless`, `Security & Identity`.\n\nNext.";
    expect(recommendedPatternNames(guide).filter((name) => !isMatchablePattern(name))).toEqual(["Security & Identity"]);
  });

  it("does not tell the profiler to spell a pattern with a catalog topic's exact spelling", () => {
    expect(profilingMd).not.toContain("exact spelling");
    expect(profilingMd).not.toContain("Security & Identity\" is a pattern");
    expect(profilingMd).toContain("A user's topical interests belong in `interests`");
  });
});

describe("workflow.md's validate_profile contract", () => {
  it("documents exactly the keys the real tool's response actually has, so docs and tool can't drift", async () => {
    // pr-reviewer-3's finding: workflow.md kept describing validate_profile's pre-budget-fix
    // response (the whole profile echoed back) well after d4914df changed it to a compact report
    // -- an agent that read both docs would (and, in the reviewer's own repro, did) pass that
    // report straight into match_sessions, which rejects it outright. Calls the real tool, not a
    // hand-written stand-in, so a future response-shape change is caught here too.
    const home: TempHome = createTempHome();
    try {
      writeCatalog(
        {
          raw: fixture,
          index: fixture.map(buildIndexRecord),
          meta: {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            eventId: DEFAULT_EVENT_ID,
            syncedAt: 1_700_000_000_000,
            totalCount: fixture.length,
            count: fixture.length,
            includedAbstracts: true,
            timezone: null,
          },
        },
        { storeRoot: home.path },
      );

      const profileBlocks = [...profilingMd.matchAll(/```json\n([\s\S]*?)```/g)]
        .map((match) => JSON.parse(match[1]!) as unknown)
        .filter(
          (parsed): parsed is Record<string, unknown> =>
            typeof parsed === "object" && parsed !== null && "schemaVersion" in parsed && "services" in parsed,
        );
      expect(profileBlocks).toHaveLength(1);

      const server = createMcpServer({ resolveStoreRoot: () => home.path });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "0.0.1" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const result = await client.callTool({
        name: "validate_profile",
        arguments: { profile: profileBlocks[0] },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      const realKeys = Object.keys(JSON.parse(content[0]!.text) as Record<string, unknown>).sort();

      const documentedBlocks = [...extractSection(workflowMd, "## 4. `validate_profile`").matchAll(
        /```json\n([\s\S]*?)```/g,
      )].map((match) => JSON.parse(match[1]!) as Record<string, unknown>);
      expect(documentedBlocks).toHaveLength(1);
      const documentedKeys = Object.keys(documentedBlocks[0]!).sort();

      expect(realKeys).toEqual(documentedKeys);
    } finally {
      home.cleanup();
    }
  });

  it("never tells the agent to pass validate_profile's own response into match_sessions", () => {
    // The other half of the same finding: SKILL.md step 5 must name the profile object itself as
    // what gets sent, not validate_profile's report.
    expect(skillMd).toMatch(/match_sessions.*the profile you wrote/i);
    expect(skillMd).not.toMatch(/match_sessions.*validated profile/i);
  });
});

describe("documented evidence lenses", () => {
  it("documents the exact MCP lens enum and executes every example pattern through matching", async () => {
    const home = createTempHome();
    try {
      const server = createMcpServer({ resolveStoreRoot: () => home.path });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "lens-doc-test", version: "0.0.1" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const { tools } = await client.listTools();
      const lensSchema = tools.find(tool => tool.name === "match_sessions")!.inputSchema.properties!.lens as { enum: string[] };
      const declaration = /"lens"\?: ([^,]+)/.exec(workflowMd)![1]!;
      expect([...declaration.matchAll(/"([a-z-]+)"/g)].map(match => match[1])).toEqual(lensSchema.enum);
      const profiles = [...workflowMd.matchAll(/```json\n([\s\S]*?)```/g)]
        .map(match => JSON.parse(match[1]!) as Record<string, unknown>)
        .filter(value => "schemaVersion" in value && "patterns" in value);
      expect(profiles).toHaveLength(1);
      const resolved = resolveProfile(profiles[0], buildServiceAliasIndex([]));
      const examples = [
        ["gap-no-dlq", "Dead-letter queues"], ["gap-no-alarms", "CloudWatch alarms and alerting strategy"],
        ["gap-no-tests", "Automated testing"], ["gap-broad-iam", "Least privilege"],
        ["gap-no-load-tests", "Load testing"], ["gap-no-cost-monitoring", "Cost monitoring"],
        ["gap-no-resource-rightsizing", "Rightsizing"], ["serverless", "Containers"],
        ["ecs", "Kubernetes"], ["genai-single-call", "Agentic workflows"],
      ];
      expect(resolved.patterns.map(pattern => pattern.name).sort()).toEqual(examples.map(example => example[0]).sort());
      for (const [name, title] of examples) {
        // The abstract carries what the lenses require beyond the title: a source-side mention and a profile service.
        const raw = [{ sessionId: "documented", abbreviation: "DOC400", title: title!, abstract: `Lambda ECS basic prompting ${resolved.services.map(service => service.name).join(" ")}` }];
        writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: DEFAULT_EVENT_ID, syncedAt: 1, totalCount: 1, count: 1, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
        const pattern = resolved.patterns.find(entry => entry.name === name)!;
        const input = { ...profiles[0], patterns: [pattern] };
        const validation = await client.callTool({ name: "validate_profile", arguments: { profile: input } });
        expect(validation.isError).not.toBe(true);
        const lens = name!.startsWith("gap-") ? "fix" : "next-level";
        const result = await client.callTool({ name: "match_sessions", arguments: { profile: input, lens } });
        expect(result.isError).not.toBe(true);
        const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
        expect(parsed.candidates).toHaveLength(1);
        expect(parsed.candidates[0].code).toBe("DOC400");
        expect(parsed.candidates[0].reasons).toContainEqual(expect.objectContaining({ kind: lens === "fix" ? "pillarGap" : "migrationPath", profileEvidence: pattern.evidence }));
      }
      await client.close();
      await server.close();
    } finally { home.cleanup(); }
  });
  it("states the evidence boundary and migration trade-offs throughout the guidance", () => {
    for (const text of [skillMd, workflowMd, profilingMd]) {
      expect(text).toContain("profileEvidence");
      expect(text).toContain("not evident in the cited scope");
      expect(text).toContain("genai-single-call");
      expect(text).not.toMatch(/lenses (?:do not exist|are\s+not available)/);
    }
    for (const phrase of ["runtime control", "operational ownership", "portability", "complexity", "multi-step tool use", "latency"]) {
      expect(profilingMd).toContain(phrase);
    }
  });
});
describe("explain lens documentation", () => {
  const readmeMd = readFileSync(join(here, "..", "..", "README.md"), "utf8");
  it("describes concepts, the admission rule, the uncovered list and the curated pattern phrases in profiling.md", () => {
    const section = profilingMd.slice(profilingMd.indexOf("## The explain lens"), profilingMd.indexOf("## Supported evidence lenses"));
    for (const text of [
      "distinct files", "names the concept in its title", "at least twice in its abstract", "`uncovered`", "300-level",
      "sponsored", "What's new", "`serverless`", "`event-driven`", "`api`", "`multi-tenant`", "`multi-account`", "`iac-cdk`", "`containers`",
      "`ecs`", "`eks`", "`agentic`", "`genai-single-call`", "`streaming`", "`data-lake`",
    ]) {
      expect(section, text).toContain(text);
    }
  });
  it("documents the explain output shape in workflow.md, SKILL.md, taxonomy.md and the README", () => {
    expect(workflowMd).toContain("`uncovered`");
    expect(workflowMd).toContain("explainsConcept");
    expect(skillMd).toContain("`uncovered`");
    expect(readFileSync(join(skillRoot, "reference", "taxonomy.md"), "utf8")).toContain("tiebreak");
    expect(readmeMd).toContain("`uncovered`");
  });
});
describe("lens-quality documentation", () => {
  it("lists all eight reason kinds and the lens fields", () => {
    for (const kind of ["service", "topic", "areaOfInterest", "text", "level", "format", "pillarGap", "migrationPath", "explainsConcept"]) {
      expect(workflowMd).toContain(`\`${kind}\``);
    }
    for (const field of ["lensRules", "skippedRules", "startDate: null", "profile already has agentic"]) expect(workflowMd).toContain(field);
  });
  it("documents role, the explain lens, partial gaps, and tool-free utility calls in profiling.md", () => {
    for (const text of ['"role": "supporting"', "The explain lens", "which components lack it", "tag both `agentic` and `genai-single-call`", "fewer than 3% of catalog sessions"]) {
      expect(profilingMd).toContain(text);
    }
  });
  it("says a profile with no core service admits nothing, and that lens results are not score-ordered", () => {
    expect(profilingMd).toContain("profile has no core services to check stack fit");
    expect(workflowMd).toContain("not by score, so\nscores can appear out of order");
  });
  it("tells the agent Fix picks still need the abstract check", () => {
    expect(skillMd).toContain("leads, not verdicts");
    expect(profilingMd).toContain("leads, not verdicts");
  });
  it("does not cite repository test fixtures from the skill's own reference", () => {
    expect(taxonomyMd).not.toContain("tests/fixtures");
    expect(allSkillText).not.toContain("tests/fixtures");
  });
});

describe("lens-precision guidance in profiling.md", () => {
  const collapsed = profilingMd.replace(/\s+/g, " ");
  it("marks platform services supporting by default and names them, from the exported list", () => {
    expect(collapsed).toContain("Always list the platform services you find, as `\"role\": \"supporting\"`");
    const shortName = (name: string): string => {
      const inner = /\(([^)]+)\)\s*$/.exec(name)?.[1] ?? name;
      return inner.replace(/^(?:Amazon|AWS)\s+/, "");
    };
    const never = new Set(["IAM", "STS"]);
    const listed = PLATFORM_SERVICES.map(shortName);
    expect(listed).toEqual(expect.arrayContaining(["IAM", "STS"]));
    for (const name of listed) {
      if (never.has(name)) continue;
      expect(collapsed, name).toMatch(new RegExp(`Always list the platform services[^.]*\\b${name}\\b`));
    }
    expect(collapsed).toContain("IAM and STS are never listed; if present they are ignored.");
    expect(collapsed).toContain("no alarm that notifies a person on the infrastructure you found");
    expect(collapsed).not.toMatch(/Mark platform services[^.]*\bIAM\b/);
  });
  it("adds ecs and eks to the starting vocabulary", () => {
    expect(collapsed).toMatch(/starting vocabulary[^]*`containers`, `ecs`, `eks`/);
  });
  it("says an unresolved name is fine, is never rare, and lists the names the catalog lacks", () => {
    expect(collapsed).toContain("never counts as rare");
    for (const name of ["Amazon SES", "Amazon SNS", "AWS X-Ray", "Powertools for AWS Lambda"]) expect(collapsed).toContain(name);
    expect(collapsed).toContain("Amazon Bedrock AgentCore");
  });
  it("defines gap-no-alarms as an alarm that notifies a person", () => {
    expect(collapsed).toContain("no alarm that notifies a person");
    expect(collapsed).toContain("only drives automation");
  });
  it("keeps IAM out of services and points broad-IAM sessions at the remedy path", () => {
    expect(collapsed).toContain("IAM stays out of `services`");
    expect(collapsed).toContain("remedy services");
  });
  it("covers core versus supporting, gap consistency, any model API and partial scope", () => {
    expect(collapsed).toContain("The repository's own IaC tool (CDK, CloudFormation) is supporting");
    expect(collapsed).toContain("wired in but switched off");
    expect(collapsed).toContain("used only at deploy time");
    expect(collapsed).toContain("STS (any use, including runtime AssumeRole)");
    expect(collapsed).toContain("Record `gap-no-load-tests` and `gap-no-cost-monitoring` only when the repository deploys production infrastructure");
    expect(collapsed).toContain("any model API, not only Bedrock");
    for (const name of ["Gemini", "OpenAI", "Anthropic"]) expect(collapsed).toContain(name);
    expect(collapsed).toContain("say which part in the `note`");
    expect(collapsed).toContain("narrowed by a condition or session policy is still recordable as `gap-broad-iam`");
  });
  it("describes the enumeration rule, the single-call source and the reverse move", () => {
    expect(collapsed).toContain("enumeration of three or more names");
    expect(collapsed).toContain("agents built on two of your other core services");
    expect(collapsed).toContain("Kubernetes or EKS to serverless or AgentCore");
    expect(collapsed).not.toContain("whose phrase is specific enough that one mention counts");
  });
});

describe("the workflow.md teaching profile", () => {
  it("names a file and a count in every gap note, so copying it triggers no validate_profile warning", () => {
    const block = [...workflowMd.matchAll(/```json\n([\s\S]*?)```/g)]
      .map(match => JSON.parse(match[1]!) as { profile?: ResolvedProfile })
      .map(parsed => parsed.profile ?? (parsed as unknown as ResolvedProfile))
      .find(parsed => Array.isArray(parsed.patterns) && parsed.patterns.some(pattern => pattern.name === "gap-no-resource-rightsizing"));
    expect(block).toBeDefined();
    const gaps = block!.patterns.filter(pattern => pattern.name.startsWith("gap-"));
    expect(gaps.length).toBeGreaterThanOrEqual(7);
    for (const gap of gaps) expect(gap.note, gap.name).toMatch(/\d/);
    for (const gap of gaps) {
      const cited = /deploy entry point (\S+\.ts)\./.exec(gap.note ?? "")?.[1];
      if (cited !== undefined) {
        expect(cited, gap.name).toBe("infra/app.ts");
        expect(gap.evidence[0]!.file, gap.name).toBe(cited);
      }
    }
    const report = buildValidateReport({ ...block!, unresolvedServices: [] });
    expect(report.warnings, JSON.stringify(report.warnings)).toBeUndefined();
  });
});

describe("validate_profile warnings in the skill docs", () => {
  it("documents the optional warnings field, and says a warning is not an error", () => {
    const section = extractSection(workflowMd, "## 4. `validate_profile`").replace(/\s+/g, " ");
    expect(section).toContain("`warnings`");
    expect(section).toContain("names no file, path or glob");
    expect(section).toContain("A warning is not an error; add the files or search you used");
  });
});

describe("gap consistency guidance in profiling.md", () => {
  const collapsed = profilingMd.replace(/\s+/g, " ");
  const recipe = (gap: string): string => {
    const match = new RegExp(`- \\*\\*\`${gap}\`\\*\\* recipe\\. (.*?)(?= - \\*\\*\`gap-|## |$)`).exec(collapsed);
    expect(match, `${gap} recipe`).not.toBeNull();
    return match![1]!;
  };
  it("gives gap-no-dlq a search recipe that lists every asynchronous target and source", () => {
    const text = recipe("gap-no-dlq");
    for (const term of ["EventBridge rule target", "SfnStateMachine", "onFailure", "SNS subscription", "destination", "deadLetterQueue", "dead_letter_config", "RedrivePolicy"]) {
      expect(text, term).toContain(term);
    }
  });
  it("gives gap-no-alarms a recipe that checks each resource kind reaches a person", () => {
    const text = recipe("gap-no-alarms");
    for (const term of ["state machine", "queue", "SNS topic", "PagerDuty", "Chatbot", "alarm_actions", "AlarmActions", "addAlarmAction"]) {
      expect(text, term).toContain(term);
    }
  });
  it("gives gap-broad-iam a recipe with a wildcard search, the unscopable actions and a production-first rule", () => {
    const text = recipe("gap-broad-iam");
    for (const term of ["cloudwatch:PutMetricData", "xray:PutTraceSegments", "sts:GetCallerIdentity", "logs:CreateLogGroup", "production", "test"]) {
      expect(text, term).toContain(term);
    }
    expect(text).toMatch(/'\*'|"\*"/);
  });
  it("names file kinds for every IaC flavour in each recipe", () => {
    for (const gap of ["gap-no-dlq", "gap-no-alarms", "gap-broad-iam"]) {
      const text = recipe(gap);
      for (const flavour of ["CDK", "CloudFormation", "Terraform", "Serverless Framework"]) expect(text, `${gap} ${flavour}`).toContain(flavour);
    }
  });
  it("requires counting before recording a gap or claiming a practice, with the count in the note", () => {
    expect(collapsed).toContain("Count, do not sample.");
    expect(collapsed).toContain("18 of 20 EventBridge rules have a DLQ");
    expect(collapsed).not.toContain("34 of 37");
    expect(collapsed).toContain("never claim a practice is present everywhere from a sample");
  });
  it("says one lacking resource is the gap, and coverage elsewhere never cancels it", () => {
    expect(collapsed).toContain("If even one resource of the kind lacks the practice, record the gap.");
    expect(collapsed).toContain("never cancels the gap");
    expect(collapsed).toContain("cite the lacking resource");
  });
  it("counts a practice switched off in every deployed environment as absent, naming the switch and where it is set", () => {
    const section = collapsed.slice(collapsed.indexOf("**Absent versus partial.**"), collapsed.indexOf("**Every gap note names"));
    expect(section).toContain("switched off in every deployed environment");
    expect(section).toContain("counts as absent");
    for (const term of ["feature flag", "enabled: false", "commented-out", "env-gated"]) expect(section, term).toContain(term);
    expect(section).toContain("names the switch and where it is set");
  });
  it("gives gap-no-tests a per-unit recipe where a pipeline flag is not a test", () => {
    const text = recipe("gap-no-tests");
    for (const term of ["deployable unit", "count the test files", "N of M units have tests", "--passWithNoTests", "does not count", "jest", "pytest", "go test", "Terraform", "CloudFormation", "Serverless Framework"]) {
      expect(text, term).toContain(term);
    }
  });
  it("reconciles the platform-services list with the CloudFormation and KMS exclusions in one sentence", () => {
    expect(collapsed).toContain("CloudFormation (when it is more than CDK's synthesis target)");
    expect(collapsed).toContain("KMS (a customer-managed key, not the default key)");
  });
  it("says a test file that exercises no production code does not count toward gap-no-tests", () => {
    expect(recipe("gap-no-tests")).toContain("never imports or exercises the unit's production code does not count");
  });
  it("covers Java and C# test conventions in the gap-no-tests recipe", () => {
    const text = recipe("gap-no-tests");
    for (const term of ["*Test.java", "src/test/java", "*Tests.cs", "xunit"]) expect(text, term).toContain(term);
  });
  it("searches for ARNs ending in /* or :* too, and keeps the wider-than-needed judgment", () => {
    const text = recipe("gap-broad-iam");
    expect(text).toContain("search for an ARN that ends in `/*` or `:*`");
    expect(text).toContain("A wildcard inside an ARN counts only when it is wider than the code needs");
    expect(text).toContain("counts exactly like a bare");
  });
  it("covers event source mappings and Serverless dead-letter keys in the dlq recipe", () => {
    const text = recipe("gap-no-dlq");
    for (const term of ["aws_lambda_event_source_mapping", "deadLetterQueueArn", "onError"]) expect(text, term).toContain(term);
  });
  it("defines multi-account as deploying to or assuming roles in more than one account", () => {
    expect(collapsed).toContain("`multi-account` means the code deploys to, or assumes roles in, more than one AWS account");
    expect(collapsed).toContain("account-keyed configuration or cross-account roles");
  });
  it("gives gap-no-resource-rightsizing a recipe, since the lens table lists it", () => {
    const text = recipe("gap-no-resource-rightsizing");
    for (const term of ["memory", "instance size", "platform default", "production"]) expect(text, term).toContain(term);
  });
  it("tells absence gaps to cite the deploy entry point and say so", () => {
    expect(collapsed).toContain("cite the deploy entry point (the app or stack file) and say so in the `note`");
  });
  it("says how many gaps have recipes, matching the recipes there are", () => {
    const recipes = collapsed.match(/\*\*`gap-[a-z-]+`\*\* recipe\./g) ?? [];
    expect(recipes).toHaveLength(5);
    expect(collapsed).toContain("Five gaps are easy to get wrong by sampling");
  });
  it("records rightsizing only for compute left at the platform default or with an explicit sizing TODO", () => {
    const text = recipe("gap-no-resource-rightsizing");
    for (const term of ["MemorySize", "memory_size", "platform default", "explicit sizing TODO"]) expect(text, term).toContain(term);
    expect(text).not.toContain("round number");
  });
  it("does not add a gap-no-waf rule", () => {
    expect(collapsed).not.toContain("gap-no-waf");
  });
  it("requires every gap note to name what was inspected, and says validate_profile warns", () => {
    expect(collapsed).toContain("Every gap note names what was inspected");
    expect(collapsed).toContain("`validate_profile` returns a warning");
  });
  it("lists platform services as supporting and treats runtime CloudFormation as a real service", () => {
    expect(collapsed).toContain("Always list the platform services you find");
    expect(collapsed).toContain("cloudformation:CreateStack");
    expect(collapsed).not.toContain("Listing the excluded items as services would swamp");
  });
  it("keeps multi-tenant in the vocabulary and adds IaC directories to what to read", () => {
    const vocabulary = collapsed.slice(collapsed.indexOf("Use this starting vocabulary"), collapsed.indexOf("These are the names"));
    expect(vocabulary).toContain("`multi-tenant`");
    expect(collapsed).toContain("every directory that holds infrastructure as code");
  });
});

describe("newer gap guidance in profiling.md", () => {
  const collapsed = profilingMd.replace(/\s+/g, " ");
  const gaps = ["gap-no-tracing", "gap-no-ci", "gap-no-graviton"];
  it.each(gaps)("defines %s, says what does not count, and lists it in the rules table", name => {
    const entry = new RegExp(`- \\*\\*\`${name}\`\\*\\* \\(([A-Za-z ]+)\\)\\. (.*?)(?= - \\*\\*\`gap-|## Interests)`).exec(collapsed);
    expect(entry, name).not.toBeNull();
    expect(entry![2]).toMatch(/\bnot\b/);
    expect(profilingMd).toMatch(new RegExp(`\\| \`${name}\` \\| ${entry![1]} \\|`));
  });
  it("says a switched-off practice is the gap and a partly true gap names its part", () => {
    expect(collapsed).toContain("wired in but switched off");
    expect(collapsed).toContain("say which part in the `note`");
    expect(collapsed).toContain("A practice that is wired in but switched off");
  });
  it("keeps the guide sentences that settle the edge cases", () => {
    expect(collapsed).toContain("A single function that calls nothing else is not this gap.");
    expect(collapsed).toContain("cite the part that lacks it and say which part in the `note`");
    expect(collapsed).toContain("is present but weak (tracing sampled at a low rate, a pipeline that runs one test) is not this gap");
    expect(collapsed).toContain("Custom resources and placeholder functions (reserved concurrency 0, an inline stub) are not production compute");
    expect(collapsed).not.toContain("a retention of 0");
    expect(collapsed).not.toContain("association that exists only in a comment");
  });
  it("says the newer gaps skip AI-tagged sessions for a profile with no AI pattern", () => {
    expect(collapsed).toContain("skip a session tagged Agentic AI or Generative AI unless your profile has an `agentic` or `genai-single-call` pattern");
  });
  it("names the remedy services of the newer gaps in the stack-fit paragraph", () => {
    for (const service of ["AWS Distro for OpenTelemetry", "CodePipeline", "EC2 - Graviton"]) {
      expect(collapsed).toContain(service);
    }
  });
});

it("runs the documented plan_schedule example against a catalog, and shows the AWS reserve and cancel calls it leads to", async () => {
  const blocks = [...workflowMd.matchAll(/```json\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]!) as { tool?: string; arguments?: Record<string, unknown> }).filter(value => ["plan_schedule", "ReserveSessions", "CancelReservation"].includes(value.tool ?? ""));
  expect(blocks.map(value => value.tool)).toEqual(["plan_schedule", "ReserveSessions", "CancelReservation"]);
  const home = createTempHome();
  try {
    const raw = [{ sessionId: "example-offering", title: "Example", sessionTime: { date: "2099-12-02", time: "10:00", length: "60" } }];
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: DEFAULT_EVENT_ID, syncedAt: 1, count: 1, totalCount: 1, includedAbstracts: true, timezone: "America/Los_Angeles" } }, { storeRoot: home.path });
    const plan = await callCommand("plan_schedule", blocks[0]!.arguments, { storeRoot: home.path });
    expect(plan.isError).toBe(false);
    const selected = JSON.parse(plan.text).selected as Array<{ sessionId: string }>;
    expect(selected.map(entry => entry.sessionId)).toEqual(["example-offering"]);
    // The writes are AWS calls with AWS argument shapes: at most 10 ids to reserve, one id to cancel.
    expect(blocks[1]!.arguments).toEqual({ sessionIds: ["<selected-session-id>"] });
    expect(blocks[2]!.arguments).toEqual({ sessionId: "<selected-session-id>" });
  } finally { home.cleanup(); }
  expect(skillMd).toMatch(/confirmation before.*reserv/i);
  expect(workflowMd).toContain("uncertain");
});

describe("why documentation", () => {
  const readmeMd = readFileSync(join(here, "..", "..", "README.md"), "utf8");
  const step6 = skillMd.slice(skillMd.indexOf("6. Present the candidates"), skillMd.indexOf("7. For reservations"));
  const presenting = skillMd.slice(skillMd.indexOf("## Presenting reasons and evidence"), skillMd.indexOf("## What this build does not do"));

  it("tells the agent, in step 6, to lead each candidate with why.summary and sessionSays and cite yourCode", () => {
    for (const text of ["`why.summary`", "`why.sessionSays`", "`why.yourCode`"]) expect(step6, text).toContain(text);
    expect(step6.indexOf("`why.summary`")).toBeLessThan(step6.indexOf("`offerings`"));
    expect(step6).not.toMatch(/every `reasons` entry/);
  });

  it("does not have the agent read out ranking reasons unless asked", () => {
    expect(presenting).toMatch(/ranking reasons/i);
    expect(presenting).toMatch(/unless (?:the user )?asks?/i);
    expect(presenting).not.toMatch(/always show it, not just the score/);
  });

  it("documents the why block, its omissions and the budget order in workflow.md", () => {
    for (const text of ["`why`", "`summary`", "`yourCode`", "`more`", "`sessionSays`", "`rankingReasonsOmitted`"]) {
      expect(workflowMd, text).toContain(text);
    }
    expect(extractSection(workflowMd, "## 6. Present candidates")).toContain("`why.summary`");
  });

  it("shows a why in the documented match_sessions example, with exactly the keys the tool returns", () => {
    const example = JSON.parse([...extractSection(workflowMd, "## 5. `match_sessions`").matchAll(/```json\n([\s\S]*?)```/g)][0]![1]!) as { candidates: Array<Record<string, unknown>> };
    const why = example.candidates[0]!.why as Record<string, unknown>;
    expect(Object.keys(why).sort()).toEqual(["sessionSays", "summary", "yourCode"]);
    expect(Object.keys(example.candidates[0]!).sort()).toEqual(["code", "levelBand", "offerings", "reasons", "score", "sessionId", "title", "type", "why"]);
  });

  it("says the summary names the strongest rule, not the first", () => {
    expect(presenting).toContain("names only the strongest");
    expect(presenting).not.toContain("names only the first");
  });

  it("says no full abstract is included in a match", () => {
    expect(workflowMd).not.toContain("Never includes abstracts.");
    expect(workflowMd).toContain("Never includes full abstracts");
    expect(workflowMd).toContain("`rankingReasonsOmitted`");
  });

  it("documents --verbose in the README", () => {
    expect(readmeMd).toContain("--verbose");
    expect(readmeMd).toContain("rankingReasonsOmitted");
  });
});

describe("the all lens documentation", () => {
  const readmeMd = readFileSync(join(here, "..", "..", "README.md"), "utf8");
  const collapse = (text: string): string => text.replace(/\s+/g, " ");
  it("describes admission, demotion and order in profiling.md", () => {
    for (const text of ["The all lens", "at least twice", "never admits a session", "`demoted`", "sponsored session", "more than three of the first ten"]) {
      expect(collapse(profilingMd)).toContain(text);
    }
  });
  it("names the matchesConcept reason and the demoted field in workflow.md, and the demotion in the skill and the readme", () => {
    expect(workflowMd).toContain("`matchesConcept`");
    expect(workflowMd).toContain("`demoted`");
    expect(collapse(workflowMd)).toContain("ranked lower: sponsored session");
    expect(skillMd).toContain("`demoted`");
    expect(readmeMd).toContain("`demoted`");
  });
});

describe("the off-stack documentation", () => {
  const readmeMd = readFileSync(join(here, "..", "..", "README.md"), "utf8");
  const collapse = (text: string): string => text.replace(/\s+/g, " ");
  it("documents the off-stack technology demotion", () => {
    const text = collapse(profilingMd);
    for (const expected of ["names a specific technology your profile does not use", "ranked lower: about Terraform, which this code does not use", "a comparison"]) expect(text, expected).toContain(expected);
    expect(collapse(workflowMd)).toContain("titled about a technology the profile does not use");
    expect(collapse(readmeMd)).toContain("about a technology the code does not use");
  });
});

describe("the session preferences documentation", () => {
  const readmeMd = readFileSync(join(here, "..", "..", "README.md"), "utf8");
  const collapse = (text: string): string => text.replace(/\s+/g, " ");
  it("tells the agent to pass a stated level preference on the map and the match, in words as well as numbers, and keep it", () => {
    const flow = collapse(extractSection(skillMd, "## The flow"));
    for (const expected of ["`preferences: { \"levels\": { \"min\": N, \"max\": M } }`", "on `map_profile` and on `match_sessions`", "for the rest of the conversation, the map included",
      "100 Foundational, 200 Intermediate, 300 Advanced, 400 Expert, 500 Distinguished", "\"Only 400-500\" and \"expert\" are 400 to 500", "\"advanced and up\" and \"no intro\" are 300 to 500",
      "the remaining ones are re-ranked by the same rules", "never widen the range yourself, and offer to widen it", "`explain` is an error naming `deepen` or `all`"]) {
      expect(flow, expected).toContain(expected);
    }
  });
  it("documents the preferences argument, its order of application and its refusals in workflow.md", () => {
    const text = collapse(workflowMd);
    for (const expected of ["\"preferences\"?: { \"levels\"?: { \"min\": number, \"max\": number }, \"rules\"?:", "applied after admission and before the per-concept cap", "a session's own score does not change",
      "4 sessions match, none at 400\u2013500", "explain lists introductory (100\u2013200) sessions, which is outside 400\u2013500; use deepen or all", "`--level 400-500` is the CLI form"]) {
      expect(text, expected).toContain(expected);
    }
  });
  it("turns plain statements into facet rules, restates them and keeps them, in the skill", () => {
    const flow = collapse(extractSection(skillMd, "## The flow"));
    for (const expected of ["`rules` on any catalog field", "\"field\": \"format\" | \"venue\" | \"day\" | \"topic\" | \"area\" | \"industry\" | \"role\"", "\"action\": \"only\" | \"prefer\" | \"avoid\" | \"exclude\"",
      "several `only` rules on one field are a union", "an intersection", "a session with no value for that field is left out", "within one field the first matching rule decides, across fields the effects add up",
      "a preferred session outranks a neutral one even if it matches less strongly", "(a chalk talk at MGM Grand, which you prefer)", "(ranked lower: a breakout session, which you asked to avoid at 300\u2013500)",
      "| \"only 400+\" |", "| \"no workshops\" | `rules: [{ field: \"format\", value: \"Workshop\", action: \"exclude\" }]` |", "| \"I like chalk talks\" |",
      "| \"avoid breakouts unless intro\" | `rules: [{ field: \"format\", value: \"Breakout session\", action: \"avoid\", levels: { min: 300, max: 500 } }]` |",
      "| \"only sessions at MGM\" | `rules: [{ field: \"venue\", value: \"MGM Grand\", action: \"only\" }]` |", "| \"I'm staying at the Venetian, prefer sessions there\" |", "| \"nothing on Thursday\" | `rules: [{ field: \"day\", value: \"<that date>\", action: \"exclude\" }]`, the date from `list_filters` with `field: \"day\"` |", "Never compute a day's date yourself",
      "| \"what venues are there?\" | call `list_filters` with `field: \"venue\"` |",
      "chalk talk; breakout or talk (the catalog's \"Breakout session\"); workshop; builders' session; lightning talk; code talk; lab; bootcamp",
      "call `list_filters` (no profile needed", "names a value that does not resolve (the error lists the closest values)", "Restate the active preferences once, briefly",
      "`only`, `exclude` and `levels` change the map's counts; `prefer` and `avoid` do not"]) {
      expect(flow, expected).toContain(expected);
    }
  });
  it("documents the facet rules and list_filters in workflow.md and the readme", () => {
    const text = collapse(workflowMd);
    for (const expected of ["\"rules\"?: [{ \"field\": string, \"value\": string, \"action\": \"only\" | \"prefer\" | \"avoid\" | \"exclude\"", "the first rule that matches winning within a field", "an unknown or ambiguous value is an `isError` listing the closest values and pointing at `list_filters`",
      "several on one field are a union, on different fields an intersection", "across fields the effects add up", "the per-concept cap applies within each tier", "a level-scoped `only` also leaves out a session with no level", "`fix` and `next-level` re-interleave their rules over what remains", "`explain` and `understand` included", "## 4b. `list_filters`", "Read-only, from the local catalog: it needs no profile",
      "every field lists its first 40 values"] ) {
      expect(text, expected).toContain(expected);
    }
    const readme = collapse(readmeMd);
    for (const expected of ["#### Chalk talks more than anything, no workshops, only this venue", "--only venue:mgm --prefer \"chalk talk\" --avoid \"breakout session@300-500\" --exclude workshop", "demoted sessions still come last", "`preferences: { levels, rules: [{ field, value, action, levels? }] }`", "#### What can I filter on?", "reinvent-scout catalog filters --field venue"]) {
      expect(readme, expected).toContain(expected);
    }
  });
  it("documents --level in the readme", () => {
    const text = collapse(readmeMd);
    for (const expected of ["#### Only the levels you want", "`--level 400-500`", "filtering removes sessions, the remaining ones are re-ranked by the same rules", "none at 400-500"]) {
      expect(text, expected).toContain(expected);
    }
  });
});

describe("the map and focus documentation", () => {
  const readmeMd = readFileSync(join(here, "..", "..", "README.md"), "utf8");
  const collapse = (text: string): string => text.replace(/\s+/g, " ");
  it("makes map_profile then a focus the default flow, with the plain lenses as the fallback", () => {
    const flow = collapse(extractSection(skillMd, "## The flow"));
    for (const expected of ["call `map_profile` with the same profile", "show the user the map", "ask what they care about", "a `focus`", "`focus` replaces `lens`", "fall back to a lens", "`understand`", "`deepen`", "`improve`", "Offer only goals with sessions", "closest 300-level session"]) {
      expect(flow, expected).toContain(expected);
    }
    expect(flow.indexOf("`map_profile`")).toBeLessThan(flow.indexOf("`match_sessions`"));
  });
  it("tells the agent how to present a focused response", () => {
    const flow = collapse(extractSection(skillMd, "## The flow"));
    for (const expected of ["`results[]`", "one heading per choice", "`total`", "`reason`", "`alsoMatches`"]) expect(flow, expected).toContain(expected);
  });
  it("documents the map shape, the focus shape and the refusals in workflow.md", () => {
    const text = collapse(workflowMd);
    for (const expected of ["## 4a. `map_profile`", "`service:Amazon DynamoDB`", "`gap:gap-no-dlq`", "`path:genai-single-call`", "a goal with `0` is a dead end (its `reason` says why", "`perTopic` defaults to 3 and is at most 3 here", "never together with `lens` or `limit`", "`alsoMatches`", "whose title names the topic"]) {
      expect(text, expected).toContain(expected);
    }
  });
  it("documents the commands and the three goals in the readme", () => {
    const text = collapse(readmeMd);
    for (const expected of ["### Map your code, then choose what to look for", "reinvent-scout profile map --profile", "--focus \"DynamoDB:understand,gap-no-dlq:improve,event-driven:deepen\"", "**understand**", "**deepen**", "**improve**", "`--focus` replaces `--lens` and `--limit`", "title names the topic"]) {
      expect(text, expected).toContain(expected);
    }
  });
});

describe("watch playbook (reference/watch.md)", () => {
  /** Line wrapping in the markdown must not matter, so whitespace is collapsed before matching. */
  const expectAll = (text: string, phrases: string[]) => {
    const flat = text.replace(/\s+/g, " ");
    for (const phrase of phrases) expect(flat, phrase).toContain(phrase);
  };

  it("is reachable from SKILL.md, the workflow reference and the README", () => {
    expectAll(skillMd, ["Watch a full session", "`GetSession`", "reference/watch.md"]);
    expect(workflowMd).toContain("watch.md");
    expect(readFileSync(join(skillRoot, "..", "..", "..", "README.md"), "utf8")).toContain("Watch a full session");
  });
  it("documents the get_session contract in workflow.md, including that a 404 is not proof", () => {
    expectAll(workflowMd, ["GetSession", "seatAvailability", "is not proof the session is gone"]);
  });
  it("gets consent before starting and limits what may be cancelled", () => {
    expectAll(watchMd, [
      "Confirm the target sessions",
      "the exact list of reservations you may cancel to make room",
      "consent to reserve the targets and to cancel only the reservations on that list",
      "Never cancel anything that is not on the may-cancel list, and never add to it yourself",
    ]);
  });
  it("tells the agent which state to carry and what to do when it loses track", () => {
    expectAll(watchMd, [
      "State you carry between checks",
      "the targets (id, title, day and time)",
      "the exact may-cancel list",
      "the last seat band you saw for each target",
      "which targets have a deferred swap, and at which band",
      "the last thing you told the user about each target",
      "the backoff level",
      "the end time",
      "pending restores (ids and attempt count)",
      "If you lose track",
      "re-read `GetSchedule`",
      "re-confirm the may-cancel list with the user",
      "do not cancel anything until the user re-confirms",
    ]);
  });
  it("paces the loop with the client's own scheduler, jitter and backoff", () => {
    expectAll(watchMd, [
      "`/loop`",
      "about every 3 minutes",
      "never more often than every 1 minute",
      "jitter",
      "double the wait, up to 30 minutes",
      "reset after a clean check",
      "Stop scheduling when every target is resolved",
    ]);
  });
  it("defines one check, with every failure code and the 404 and fatal cases", () => {
    expectAll(watchMd, [
      "`GetSchedule`", "`GetSession`", "`ReserveSessions`",
      "`sessionFull`: keep watching",
      "`alreadyScheduled`: done",
      "`timePassed`", "`sessionNotReservable`", "`insufficientAccess`", "`walkUp`",
      "An unknown code: stop that target and tell the user",
      "A `GetSession` 404 in the middle of a watch is transient",
      "Auth required, not registered, or a 409 (reservations closed): stop the whole watch",
    ]);
  });
  it("restricts swaps to conflicts fully inside the may-cancel list", () => {
    expectAll(watchMd, [
      "only if every id in `conflictsWith` is on the may-cancel list",
      "no partial swaps",
      "if even one id is not on the list, do not swap",
      "Cancel exactly those ids and no others",
      "Otherwise do not cancel",
      "Tell the user once what it clashes with",
    ]);
  });
  it("cancels one at a time, reads each result and restores only what it cancelled", () => {
    expectAll(watchMd, [
      "Cancel one reservation at a time, then read the result and call `GetSchedule`",
      "stop cancelling, do not reserve the target, re-reserve anything you already cancelled",
      "If a cancel is refused with a 429, re-reserve the ones you already cancelled and skip the target for this check, and back off",
      "If a cancel is refused because auth is required, you are not registered, or reservations are closed (409), re-reserve the ones you already cancelled, then stop the whole watch and tell the user",
      "Restore every cancel that was confirmed",
      "re-reserve the uncertain one",
      "If it is still held, that returns `alreadyScheduled`, which is harmless",
      "if it was cancelled, the re-reserve restores it",
      "The target is never reserved on this path, so nothing can double-book",
      "A cancel is uncertain if the call times out or fails in transit, or if the `GetSchedule` that follows still lists the reservation or cannot be read",
      "A `CancelReservation` 404 means the reservation is already gone",
      "it is never re-reserved, even when the read-back fails",
      "In every uncertain-cancel case, stop the watch and tell the user",
      "A 400 (validation error) or an OAuth failure on a cancel is treated like auth: re-reserve what you cancelled, then stop the whole watch",
      "Restore only what you actually cancelled",
    ]);
  });
  it("splits a failed target reserve into refused and uncertain, and restores either way", () => {
    expectAll(watchMd, [
      "If the target reserve was refused",
      "or the read-back shows it absent, restore",
      "If the target reserve is uncertain and the read-back cannot be done, restore anyway",
      "If the target did land, the API refuses the restore with `scheduleConflict`, so it cannot double-book",
      "Then verify with `GetSchedule` when you can, stop the whole watch, and tell the user exactly what is known",
    ]);
    expect(watchMd.replace(/\s+/g, " ")).not.toContain("do not restore, because");
  });
  const exception = "the may-cancel list is the explicit choice of cancellations and the running watch is the standing request for re-attempts";
  it("states the narrow watch exception to the no-auto-cancel and no-auto-retry rules in SKILL.md, workflow.md and watch.md", () => {
    for (const [name, text] of [["SKILL.md", skillMd], ["workflow.md", workflowMd], ["watch.md", watchMd]] as const) {
      const flat = text.replace(/\s+/g, " ");
      expect(flat, `${name} exception`).toContain(exception);
      expect(flat, `${name} outside`).toContain("Outside a watch, these rules hold");
    }
  });
  it("retries a restore only when it was not a real refusal", () => {
    expectAll(watchMd, [
      "Retry a restore only when it was refused by a 429 or never sent, up to 3 times, about 1 minute apart",
      "A restore refused with `sessionFull` is lost; do not retry it",
      "If anything was lost or is uncertain, stop the whole watch and tell the user right away",
    ]);
  });
  it("spreads restore retries across wakeups and lets a pending restore win", () => {
    expectAll(watchMd, [
      "a pending restore is not lost until its retries run out or it is refused with `sessionFull`",
      "restore wakeups keep running even after the rest of the watch stops",
      "tell the user right away that a restore is pending",
      "Every re-reserve-then-stop branch that gets a 429 becomes a pending restore",
      "schedule a short wakeup (about 1 minute) for the retry",
      "A pending restore takes priority over everything else on the next check",
      "While a restore is pending, never attempt another swap",
    ]);
  });
  it("keeps a durable record in the conversation and recovers from it", () => {
    expectAll(watchMd, [
      "Before each swap, tell the user in the conversation which ids are about to be cancelled",
      "so the transcript is the durable record",
      "check the transcript or ask the user about in-flight swaps and pending restores before doing anything else",
    ]);
  });
  it("warns the user about the swap risk when the may-cancel list is not empty", () => {
    expectAll(watchMd, [
      "tell the user that a swap briefly frees their seat, and that a restore refused as full means it is lost",
    ]);
    expect(readFileSync(join(skillRoot, "..", "..", "..", "README.md"), "utf8").replace(/\s+/g, " ")).toContain("tries to put back");
  });
  it("works with the whole conflict set AWS returns, and defines uncertain and a 404 cancel for AWS", () => {
    expectAll(watchMd, [
      "AWS returns up to 100 `conflictsWith` ids",
      "Uncertain means a transport error or a timeout from a write, or an effect that a following `GetSchedule` contradicts",
      "A `CancelReservation` 404 means the reservation is already gone",
      "at most 10 ids per `ReserveSessions` call",
    ]);
    for (const gone of ["omittedConflicts", "get_schedule", "get_session", "reserve_sessions", "cancel_reservation"]) expect(watchMd, gone).not.toContain(gone);
  });
  it("only reports and waits while a swap is deferred", () => {
    expectAll(watchMd, ["report the conflict once and wait for the seat band to change"]);
    expect(watchMd.replace(/\s+/g, " ")).not.toContain("keep trying a plain");
  });
  it("makes the agent re-confirm the targets after losing track before it reserves anything", () => {
    expectAll(watchMd, [
      "re-confirm the targets with the user before anything else",
      "reserving without re-confirmation is not allowed",
      "Retrying a pending restore of a reservation this watch cancelled is exempt from re-confirmation",
    ]);
    expect(watchMd.replace(/\s+/g, " ")).not.toContain("Reserving a target needs no new consent");
  });
  it("states the watch exception once in SKILL.md", () => {
    const flat = skillMd.replace(/\s+/g, " ");
    expect(flat.split("Outside a watch, these rules hold").length - 1).toBe(1);
    expect(flat).toContain("never cancel conflicts automatically.");
  });
  it("defers a repeat swap until the seat band changes", () => {
    expectAll(watchMd, [
      "After a swap you undid",
      "do not try it again until that target's seat band changes",
      "Each attempt briefly frees the user's existing seat",
      "going to `unavailable` and back counts as a change",
    ]);
  });
  it("never replays uncertain writes and treats a contradicted acknowledgement as uncertain", () => {
    expectAll(watchMd, [
      "Never blindly replay a write",
      "let the next `GetSchedule` decide whether it landed",
      "A reserve acknowledged as successful but missing from the `GetSchedule` read-back is uncertain, not reserved",
    ]);
  });
  it("uses judgment, stays quiet, and states its limits", () => {
    expectAll(watchMd, [
      "offer it to the user",
      "Do not reserve a repeat without asking",
      "Stay quiet on checks where nothing changed",
      "one watch per account at a time",
      "up to about 10 targets",
      "Travel time between venues is not checked",
    ]);
  });
});
