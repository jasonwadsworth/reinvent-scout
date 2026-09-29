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
import { resolveProfile } from "../../src/profile/profile.js";
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
  it("validates, every service resolves against the catalog, and every topic-spelled pattern is a real catalog topic", () => {
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

    // "Security & Identity" is deliberately spelled to match a real catalog Topic exactly (see
    // profiling.md's own "Naming patterns" rule) -- pin that it actually is one, against the same
    // real-catalog vocabulary reference/taxonomy.md's own Topics list is checked against, not just
    // the small 61-session fixture.
    const patterns = (profileBlocks[0] as { patterns: Array<{ name: string }> }).patterns;
    const topicSpelledPattern = patterns.find((p) => p.name === "Security & Identity");
    expect(topicSpelledPattern).toBeDefined();
    expect(vocabulary.topics).toContain("Security & Identity");
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
describe("lens-quality documentation", () => {
  it("lists all eight reason kinds, the lens fields, and that the CLI prints the MCP objects", () => {
    for (const kind of ["service", "topic", "areaOfInterest", "text", "level", "format", "pillarGap", "migrationPath"]) {
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
