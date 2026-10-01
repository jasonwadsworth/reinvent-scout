import { PLATFORM_SERVICES } from "../../src/match/stack-fit.js";
import { patternPhrase } from "../../src/match/concepts.js";
import { LENS_RULE_SELECTORS } from "../../src/match/lens-signals.js";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { buildServiceAliasIndex } from "../../src/catalog/service-aliases.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { DEFAULT_EVENT_ID } from "../../src/catalog/sync.js";
import { buildProgram } from "../../src/cli/main.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { resolveProfile, type ResolvedProfile } from "../../src/profile/profile.js";
import { buildValidateReport } from "../../src/profile/report.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = join(here, "..", "..", "skills", "reinvent-scout");
const referenceDir = join(skillRoot, "reference");

function readSkillFile(...parts: string[]): string {
  return readFileSync(join(skillRoot, ...parts), "utf8");
}

const skillMd = readSkillFile("SKILL.md");
const taxonomyMd = readSkillFile("reference", "taxonomy.md");
const workflowMd = readSkillFile("reference", "workflow.md");
const profilingMd = readSkillFile("reference", "profiling.md");

/** Every skill file's raw text, concatenated -- the corpus a real reader (agent or human) actually
 * sees across the whole skill, not just one file. Reviewer's finding: checking only one dedicated
 * section (e.g. SKILL.md's own "## MCP tools used" list) lets a tool get renamed or removed
 * everywhere *else* in the doc -- the actual flow prose an agent follows -- while that one list
 * stays correct and the anti-drift check stays green. */
const allSkillText = [skillMd, profilingMd, taxonomyMd, workflowMd].join("\n");

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

/** Language tags treated as a shell example -- content an agent would actually copy and run,
 * unlike a ```json response example. An untagged fence ("```\n...\n```") counts too, since a
 * plain command example is often left untagged. */
const SHELL_FENCE_LANGS = new Set(["", "sh", "bash", "shell", "console", "text"]);

/**
 * Every `reinvent-scout <path>` mention across a document -- both backtick-quoted inline spans
 * (from fence-stripped text, for the same desync reason `backtickIdentifiers` strips fences) and
 * lines inside a fenced shell-like code block (scanned from the *unstripped* text, since fence-
 * stripping would erase exactly the blocks this half exists to catch). `<path>` is the leading run
 * of one or two lowercase, space-separated words after the "reinvent-scout " prefix (a leaf command
 * is never more than two words in this CLI) -- an optional leading shell prompt ("$ ") and trailing
 * content in the same span or line (an argument placeholder, a flag) don't prevent extraction.
 *
 * Reviewer's finding: a command written inside a ```sh block is exactly what an agent copies and
 * runs, so a misnamed command hiding there has to be caught the same way an inline backtick mention
 * already is -- fence-stripping alone (needed for the tool-name/backtick-pairing scan) would
 * otherwise erase it from the corpus entirely, at exactly the spot a real reader acts on it.
 */
function cliCommandMentions(text: string): string[] {
  const paths: string[] = [];

  const inlineSpans = [...stripFences(text).matchAll(/`reinvent-scout ([^`]*)`/g)].map(
    (match) => match[1]!,
  );
  for (const remainder of inlineSpans) {
    const pathMatch = /^[a-z][a-z-]*(?: [a-z][a-z-]*)?/.exec(remainder);
    paths.push(`reinvent-scout ${pathMatch ? pathMatch[0] : remainder.trim()}`);
  }

  for (const fence of text.matchAll(/```([a-zA-Z]*)\n([\s\S]*?)```/g)) {
    const lang = fence[1]!.toLowerCase();
    if (!SHELL_FENCE_LANGS.has(lang)) {
      continue;
    }
    for (const line of fence[2]!.split("\n")) {
      const lineMatch = /^[\s$]*(?:npx\s+)?reinvent-scout\s+([a-z][a-z-]*(?: [a-z][a-z-]*)?)/.exec(line);
      if (lineMatch) {
        paths.push(`reinvent-scout ${lineMatch[1]!}`);
      }
    }
  }

  return paths;
}

/**
 * Walks a commander program's command tree and returns every full invocation path for a leaf
 * command ("auth login", "catalog sync", "match") -- not just top-level group names, which are
 * never invocable on their own. Commander's auto-added "help" pseudo-command is excluded at every
 * level. Mirrors tests/docs.test.ts's own helper -- the same authoritative source the README's own
 * command-coverage test already trusts.
 */
function collectLeafCommandPaths(command: Command, prefix: string[] = []): string[] {
  const paths: string[] = [];
  for (const sub of command.commands) {
    if (sub.name() === "help") {
      continue;
    }
    const path = [...prefix, sub.name()];
    if (sub.commands.length === 0) {
      paths.push(path.join(" "));
    } else {
      paths.push(...collectLeafCommandPaths(sub, path));
    }
  }
  return paths;
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

  it("names only tools the mcp server actually registers or explicitly documents as absent, anywhere in the skill's files", async () => {
    const home: TempHome = createTempHome();
    try {
      const server = createMcpServer({ resolveStoreRoot: () => home.path });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "0.0.1" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const { tools } = await client.listTools();
      const registered = new Set(tools.map((tool) => tool.name));

      // A sanity check on the test itself: if the server ever registered nothing, the forward
      // direction below would pass vacuously.
      expect(registered.size).toBeGreaterThan(0);

      for (const name of documentedAbsentTools) {
        expect(registered.has(name)).toBe(false);
      }
      for (const name of documentedNonToolIdentifiers) {
        expect(registered.has(name)).toBe(false);
      }

      const extracted = new Set(backtickIdentifiers(allSkillText));
      // A sanity check on the test itself: if every skill file were ever emptied of these
      // identifiers, this would pass vacuously with nothing left to check.
      expect(extracted.size).toBeGreaterThan(0);

      const allowed = new Set([...registered, ...documentedAbsentTools, ...documentedNonToolIdentifiers]);
      for (const name of extracted) {
        expect(allowed.has(name)).toBe(true);
      }
    } finally {
      home.cleanup();
    }
  });

  it("names every registered tool in the flow an agent actually follows, not just in a reference list", async () => {
    const home: TempHome = createTempHome();
    try {
      const server = createMcpServer({ resolveStoreRoot: () => home.path });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "0.0.1" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const { tools } = await client.listTools();
      const registered = new Set(tools.map((tool) => tool.name));
      expect(registered.size).toBeGreaterThan(0);

      const namedInFlow = new Set(backtickIdentifiers(extractSection(skillMd, "## The flow")));
      expect(namedInFlow.size).toBeGreaterThan(0);

      for (const name of registered) {
        expect(namedInFlow.has(name)).toBe(true);
      }
    } finally {
      home.cleanup();
    }
  });
});

describe("skill files CLI command names", () => {
  it("names only commands the cli actually registers, anywhere in the skill's files", () => {
    const program = buildProgram();
    const leafPaths = collectLeafCommandPaths(program);
    expect(leafPaths.length).toBeGreaterThan(0);
    const registered = new Set(leafPaths.map((path) => `reinvent-scout ${path}`));

    const extracted = new Set(cliCommandMentions(allSkillText));
    expect(extracted.size).toBeGreaterThan(0);

    for (const path of extracted) {
      expect(registered.has(path)).toBe(true);
    }
  });

  it("names every registered command somewhere in the skill's files", () => {
    const program = buildProgram();
    const leafPaths = collectLeafCommandPaths(program);
    expect(leafPaths.length).toBeGreaterThan(0);
    const registered = leafPaths.map((path) => `reinvent-scout ${path}`);

    const extracted = new Set(cliCommandMentions(allSkillText));
    expect(extracted.size).toBeGreaterThan(0);

    for (const path of registered) {
      expect(extracted.has(path)).toBe(true);
    }
  });

  it("extracts a command written inside a fenced sh/bash/console/untagged block, not just an inline backtick span", () => {
    // Reviewer's finding: fence-stripping (needed so the backtick-pairing scan isn't desynced by a
    // ```json block's own triple backticks) also erases a command that's an example of something
    // to *run*, not to read -- exactly what an agent would copy out of a fenced shell block. This
    // locks in that such a block is scanned on its own terms, from the unstripped text.
    const sample =
      "```sh\nreinvent-scout auth login\n```\n\n" +
      "```bash\nreinvent-scout catalog sync --reindex\n```\n\n" +
      "```console\n$ reinvent-scout schedule show\n```\n\n" +
      "```\nreinvent-scout mcp\n```\n";

    expect(new Set(cliCommandMentions(sample))).toEqual(
      new Set([
        "reinvent-scout auth login",
        "reinvent-scout catalog sync",
        "reinvent-scout schedule show",
        "reinvent-scout mcp",
      ]),
    );
  });

  it("extracts text-fenced and npx commands including invalid commands for registry checking", () => {
    const sample = "```text\n$ npx reinvent-scout match --lens fix\nnpx reinvent-scout catalog invented --json\nreinvent-scout profile validate --help\n```";
    const extracted = cliCommandMentions(sample);
    expect(extracted).toEqual(["reinvent-scout match", "reinvent-scout catalog invented", "reinvent-scout profile validate"]);
    const registered = new Set(collectLeafCommandPaths(buildProgram()).map(path => `reinvent-scout ${path}`));
    expect(extracted.filter(path => !registered.has(path))).toEqual(["reinvent-scout catalog invented"]);
  });

  it("does not extract a command mentioned only inside a non-shell fence, such as a json example", () => {
    const sample = '```json\n{ "next": "reinvent-scout catalog refresh" }\n```\n';

    expect(cliCommandMentions(sample)).toEqual([]);
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
    expect(flow).toContain("Never judge yourself whether two sessions overlap or whether the user can attend both: that is a `plan_schedule` question, whatever the times look like, and `plan_schedule` needs a sign-in");
    expect(flow).toContain("with its `endTime` when it has one");
    const text = workflowMd.replace(/\s+/g, " ");
    for (const expected of ["\"startTime\": \"10:30\", \"endTime\": \"11:30\"", "An offering also has `endTime` (`startTime` plus the catalog's length", "is the first thing left off, before ranking reasons and before any candidate", "which checks time overlap (not travel or seats)", "(it needs a sign-in)", "Never infer that two sittings overlap or do not, or answer \"can I attend both\", from these times", "call `plan_schedule` with the offerings"]) {
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

describe("sign-in is not needed to browse", () => {
  const flow = (): string => extractSection(skillMd, "## The flow").replace(/\s+/g, " ");
  it("tells the agent to profile, map and match without signing in when the catalog is present, and to sign in only to sync or touch the schedule", () => {
    for (const expected of ["Not being signed in is not an error", "returns `signedIn: false` with the catalog state", "Browsing needs no sign-in", "or `\"stale\"` with `reason: \"age\"`", "`\"stale\"` for `reason: \"schema-version\"`", "call `catalog_sync` with `reindex: true`: it rebuilds the local index from what is already stored and needs no sign-in", "(steps 6 and 7)", "go straight to profiling, mapping and matching without signing in",
      "Sign in only when you need a real fetch from the catalog sync (step 2) or the schedule, favorite, reservation and `plan_schedule` tools (steps 6 and 7)", "run `reinvent-scout auth login` yourself in the shell"]) {
      expect(flow(), expected).toContain(expected);
    }
  });
  it("documents status's signedIn false result and which tools need no sign-in in workflow.md", () => {
    const text = workflowMd.replace(/\s+/g, " ");
    for (const expected of ["`status` is not an error: it returns `{ \"signedIn\": false,", "no `accessTokenExpiresAt`", "`validate_profile`, `map_profile`, `match_sessions` and `list_filters` do not need a sign-in", "only for `catalog_sync` and the schedule, favorite and reservation tools"]) {
      expect(text, expected).toContain(expected);
    }
  });
});

describe("SKILL.md auth login instructions", () => {
  it("tells the agent how to run auth login itself rather than deferring to the user", () => {
    expect(skillMd).toMatch(/run\s+`reinvent-scout auth login`\s+yourself/);
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
    expect(readFileSync(join(here, "..", "..", "skills", "reinvent-scout", "reference", "taxonomy.md"), "utf8")).toContain("tiebreak");
    expect(readmeMd).toContain("`uncovered`");
  });
});
describe("lens-quality documentation", () => {
  it("lists all eight reason kinds, the lens fields, and that the CLI prints the MCP objects", () => {
    for (const kind of ["service", "topic", "areaOfInterest", "text", "level", "format", "pillarGap", "migrationPath", "explainsConcept"]) {
      expect(workflowMd).toContain(`\`${kind}\``);
    }
    for (const field of ["lensRules", "skippedRules", "startDate: null", "profile already has agentic"]) expect(workflowMd).toContain(field);
    expect(workflowMd).toContain("`reinvent-scout match --json` returns exactly what `match_sessions`");
    expect(workflowMd).toContain("exactly the `validate_profile`");
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
  it("counts a wildcard inside an ARN that is wider than the code needs as broad IAM", () => {
    expect(recipe("gap-broad-iam")).toContain("wildcard inside an ARN that is wider than the code needs");
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
    for (const term of ["memory", "instance size", "defaults", "measurement", "production"]) expect(text, term).toContain(term);
  });
  it("tells absence gaps to cite the deploy entry point and say so", () => {
    expect(collapsed).toContain("cite the deploy entry point (the app or stack file) and say so in the `note`");
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

it("executes the documented plan-confirm-reserve-cancel contracts using plan-returned IDs", async () => {
  const blocks = [...workflowMd.matchAll(/```json\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]!) as { tool?: string; arguments?: { sessionIds?: string[]; sessionId?: string } }).filter(value => ["plan_schedule", "reserve_sessions", "cancel_reservation"].includes(value.tool ?? ""));
  expect(blocks.map(value => value.tool)).toEqual(["plan_schedule", "reserve_sessions", "cancel_reservation"]);
  const home = createTempHome();
  try {
    const { createApiClient } = await import("../../src/api/client.js");
    let reserved: string[] = []; let writes = 0;
    const apiClient = createApiClient({ getAccessToken: async () => "fixture-token", fetchFn: async (_url, init) => {
      if (init?.method === "POST") { writes++; reserved = (JSON.parse(init.body as string) as { sessionIds: string[] }).sessionIds; return new Response(JSON.stringify({ result: { successful: reserved, failed: [] } }), { status: 200 }); }
      if (init?.method === "DELETE") { reserved = []; return new Response(null, { status: 204 }); }
      return new Response(JSON.stringify({ schedule: { reserved, favorites: [], personalTime: [] } }), { status: 200 });
    } });
    const raw = [{ sessionId: "example-offering", title: "Example", sessionTime: { date: "2099-12-02", time: "10:00", length: "60" } }];
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: DEFAULT_EVENT_ID, syncedAt: 1, count: 1, totalCount: 1, includedAbstracts: true, timezone: "America/Los_Angeles" } }, { storeRoot: home.path });
    const server = createMcpServer({ resolveStoreRoot: () => home.path, buildApiClient: () => apiClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "doc-reservation-test", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const plan = await client.callTool({ name: blocks[0]!.tool!, arguments: blocks[0]!.arguments! });
    expect(plan.isError).not.toBe(true); expect(writes).toBe(0);
    const selectedId = JSON.parse((plan.content as Array<{ text: string }>)[0]!.text).selected[0].sessionId as string;
    for (const step of blocks.slice(1)) {
      const args = JSON.parse(JSON.stringify(step.arguments).replaceAll("<selected-session-id>", selectedId));
      const result = await client.callTool({ name: step.tool!, arguments: args });
      expect(result.isError).not.toBe(true);
    }
    expect(writes).toBe(1); expect(reserved).toEqual([]);
    expect(skillMd).toMatch(/confirmation before.*reserv/i);
    expect(workflowMd).toContain("uncertain");
    await client.close(); await server.close();
  } finally { home.cleanup(); }
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
    for (const text of ["`why`", "`summary`", "`yourCode`", "`more`", "`sessionSays`", "`rankingReasonsOmitted`", "`--verbose`"]) {
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

  it("says CLI --json differs from MCP only by the ranking reasons MCP may drop, and that no full abstract is included", () => {
    const cli = workflowMd.slice(workflowMd.indexOf("The CLI prints the same object"), workflowMd.indexOf("## 6. Present candidates"));
    expect(cli).toContain("`rankingReasonsOmitted`");
    expect(workflowMd).not.toContain("Never includes abstracts.");
    expect(workflowMd).toContain("Never includes full abstracts");
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
      "4 sessions match, none at 400\u2013500", "explain lists introductory (100\u2013200) sessions, which is outside 400\u2013500; use deepen or all", "`profile map --level 400-500`", "`--level 400-500` is the CLI form"]) {
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
      "several on one field are a union, on different fields an intersection", "across fields the effects add up", "the per-concept cap applies within each tier", "a level-scoped `only` also leaves out a session with no level", "`fix` and `next-level` re-interleave their rules over what remains", "`explain` and `understand` included",
      "`--only <field>:<value>[@band]`, and `--prefer`, `--avoid` and `--exclude` taking `[<field>:]<value>[@band]`", "## 4b. `list_filters`", "Read-only, from the local catalog: it needs no profile and no sign-in",
      "every field lists its first 40 values", "`reinvent-scout catalog filters [--field <field>] [--json]`"]) {
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
    for (const expected of ["## 4a. `map_profile`", "`service:Amazon DynamoDB`", "`gap:gap-no-dlq`", "`path:genai-single-call`", "a goal with `0` is a dead end (its `reason` says why", "`perTopic` defaults to 3 and is at most 3 here", "never together with `lens` or `limit`", "`alsoMatches`", "whose title names the topic", "`reinvent-scout profile map --profile <file|name> [--json]`", "reinvent-scout match --focus"]) {
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
