import type { Command } from "commander";
import { z } from "zod";
import { readRaw } from "../../catalog/store.js";
import {
  CatalogMissingError,
  CatalogUnusableError,
  ValidationError,
} from "../../core/errors.js";
import { ensureStoreRoot } from "../../core/paths.js";
import { LENSES, type Lens } from "../../match/lens.js";
import { DEFAULT_PER_TOPIC, matchFocus, MAX_PER_TOPIC, profileTopics, type FocusCandidate, type FocusEntry, type FocusResult } from "../../match/focus.js";
import { resolveTopic, type Nameable } from "../../match/map.js";
import { GOALS, type Goal } from "../../match/topics.js";
import { matchSessionsDetailed, type MatchCandidate, type MatchResult } from "../../match/match.js";
import { buildFocusResponse, buildMatchResponse, toLeanCandidate, toLeanFocusCandidate } from "../../match/response.js";
import { describePreferences, type SessionPreferences } from "../../match/levels.js";
import { parseLevelBandRange } from "../level-option.js";
import { formatZodError } from "../zod-errors.js";
import { loadResolvedProfile } from "../profile-input.js";

export interface MatchCommandDeps {
  /** Defaults to the real store root (`ensureStoreRoot`). Inject a fixed path in tests so
   * nothing touches the real home directory. */
  resolveStoreRoot?: () => string;
  /** Where command output goes. Defaults to stdout. */
  print?: (message: string) => void;
}

interface MatchCommandOptions {
  profile: string;
  lens: string;
  limit: string;
  json: boolean;
  includeAbstracts: boolean;
  verbose: boolean;
  focus?: string;
  perTopic?: string;
  level?: string;
}

const DEFAULT_MATCH_LIMIT = 30;
const MAX_MATCH_LIMIT = 100;
const NO_CANDIDATES_MESSAGE = "No matching sessions found.";

function parseMatchLimit(raw: string): number {
  const limit = Number(raw);
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) {
    throw new ValidationError(`--limit must be a positive integer, got "${raw}".`);
  }
  if (limit > MAX_MATCH_LIMIT) {
    throw new ValidationError(`--limit must be at most ${MAX_MATCH_LIMIT}, got "${raw}".`);
  }
  return limit;
}

function parseLens(raw: string): Lens {
  if (!LENSES.includes(raw as Lens)) {
    throw new ValidationError(`--lens must be one of ${LENSES.join(", ")}, got "${raw}".`);
  }
  return raw as Lens;
}

/** "service:Amazon DynamoDB:understand,gap-no-dlq:improve" into choices; the goal is after the last colon, and a topic may be a
 * bare label ("DynamoDB") that names exactly one topic. */
function parseFocus(text: string, topics: readonly Nameable[]): Array<{ topic: string; goal: Goal }> {
  return text.split(",").map(part => part.trim()).filter(part => part !== "").map(part => {
    const colon = part.lastIndexOf(":");
    const goal = colon === -1 ? "" : part.slice(colon + 1).trim().toLowerCase();
    if (colon === -1 || !(GOALS as readonly string[]).includes(goal)) {
      throw new ValidationError(`--focus entries look like "<topic>:<goal>" with a goal of ${GOALS.join(", ")}; got "${part}".`);
    }
    return { topic: resolveTopic(topics, part.slice(0, colon).trim(), goal as Goal), goal: goal as Goal };
  });
}

function parsePerTopic(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PER_TOPIC) {
    throw new ValidationError(`--per-topic must be a whole number from 1 to ${MAX_PER_TOPIC}, got "${raw}".`);
  }
  return value;
}

const GOAL_HEADINGS: Record<Goal, string> = { understand: "Understand", deepen: "Go deeper on", improve: "Improve" };

function formatFocusEntry(entry: FocusEntry, verbose: boolean, abstracts?: ReadonlyMap<string, string | null>): string {
  const heading = `${GOAL_HEADINGS[entry.goal]} ${entry.topic} -- ${entry.candidates.length} of ${entry.total} session${entry.total === 1 ? "" : "s"}`;
  if (entry.candidates.length === 0) return [heading, `  No sessions: ${entry.reason ?? "none match"}`].join("\n");
  const blocks = entry.candidates.map((candidate: FocusCandidate) => [
    formatCandidateWithReasons(candidate, verbose, abstracts?.get(candidate.record.sessionId) ?? null),
    ...(candidate.alsoMatches === undefined ? [] : [`  Also matches: ${candidate.alsoMatches.join(", ")}`]),
  ].join("\n"));
  return [heading, ...blocks].join("\n\n");
}

function formatFocusResult(result: FocusResult, verbose: boolean, abstracts?: ReadonlyMap<string, string | null>): string {
  const header = describePreferences(result.preferences);
  return [...(header === undefined ? [] : [`${header}\n`]), result.results.map(entry => formatFocusEntry(entry, verbose, abstracts)).join("\n\n\n")].join("\n");
}

function formatCandidateLine(candidate: MatchCandidate): string {
  const { record } = candidate;
  const parts = [candidate.code, record.title];
  if (record.type !== null) {
    parts.push(`[${record.type}]`);
  }
  if (record.level !== null) {
    parts.push(record.level);
  }
  parts.push(`(score: ${candidate.score})`);
  return parts.join(" -- ");
}

/** One offering's day, time, venue and room, however many of those this particular sitting
 * actually has on record -- an unscheduled sitting still prints, just without a day or time. */
function formatOfferingLine(offering: MatchCandidate["offerings"][number]): string {
  const parts = [offering.startDate ?? "unscheduled"];
  if (offering.startTime !== null) {
    parts.push(offering.startTime);
  }
  if (offering.venue !== null) {
    parts.push(offering.venue);
  }
  if (offering.room !== null) {
    parts.push(offering.room);
  }
  return `    ${parts.join(" -- ")}`;
}

/** The `why` block as the lines under the title: what the candidate covers, where the profile's
 * code shows it, and the session's own sentence. */
function formatWhyLines(why: MatchCandidate["why"]): string[] {
  const code = why.yourCode.map(citation => `${citation.repo}/${citation.file}${citation.line === undefined ? "" : `:${citation.line}`}`);
  return [
    `  Why: ${why.summary}`,
    ...(code.length === 0 ? [] : [`  Your code: ${code.join(", ")}${why.more === undefined ? "" : ` (+${why.more} more)`}`]),
    ...(why.sessionSays === undefined ? [] : [`  Session: "${why.sessionSays}"`]),
  ];
}

/** The candidate's own line (headed by its `code`, not any one sitting's own abbreviation -- see
 * `match/match.ts`'s repeat grouping), its `why` block directly under it, then its `Rules:`; each reason's
 * `detail` is indented beneath only under `--verbose`, since `why` already says it -- the scorer
 * exists to be explainable (see `match/score.ts`'s `Reason`), so the human-readable table must
 * actually show why a session was suggested, not only its score -- and every one of its offerings
 * (day, time, venue, room) beneath that, so a repeat's every sitting is visible even though the
 * candidates being ranked are talks, not individual sittings. `abstract`, when given (only under
 * `--include-abstracts`; `null`/absent otherwise), prints beneath the offerings, mirroring
 * `catalog.ts`'s `formatSearchResultWithAbstract` -- a session with no abstract on record still
 * gets its ordinary line, never invented text. */
function formatCandidateWithReasons(candidate: MatchCandidate, verbose: boolean, abstract?: string | null): string {
  const line = formatCandidateLine(candidate);
  const reasonLines = (verbose ? candidate.reasons : []).flatMap((reason) => [
    `  - ${reason.detail}`,
    ...(reason.profileEvidence ?? []).map(citation =>
      `    Source: ${citation.repo}/${citation.file}${citation.line === undefined ? "" : `:${citation.line}`}`),
  ]);
  const offeringLines = candidate.offerings.map(formatOfferingLine);
  const ruleLines = candidate.lensRules === undefined ? [] : [`  Rules: ${candidate.lensRules.join(", ")}`];
  const parts = [line, ...formatWhyLines(candidate.why), ...ruleLines, ...reasonLines, "  Offerings:", ...offeringLines];
  if (abstract !== undefined && abstract !== null && abstract !== "") {
    parts.push(`  ${abstract}`);
  }
  return parts.join("\n");
}

function formatHumanResult(result: MatchResult, verbose: boolean, abstracts?: ReadonlyMap<string, string | null>): string {
  const skipped = [
    ...result.skippedRules.map((skip) => `Skipped: ${skip.rule} (${skip.reason})`),
    ...(result.uncovered ?? []).map((entry) => `Uncovered: ${entry.concept} (${entry.reason})`),
  ];
  if (result.candidates.length === 0) {
    return [NO_CANDIDATES_MESSAGE, ...(result.reason === undefined ? [] : [result.reason]), ...skipped].join("\n");
  }
  const blocks = result.candidates.map((candidate) =>
    formatCandidateWithReasons(candidate, verbose, abstracts?.get(candidate.record.sessionId) ?? null));
  const header = describePreferences(result.preferences);
  return [...(header === undefined ? [] : [header]), blocks.join("\n\n"), ...skipped].join("\n\n");
}

/** Registers the `match` command. */
export function registerMatchCommands(program: Command, deps: MatchCommandDeps = {}): Command {
  const print = deps.print ?? ((message: string) => process.stdout.write(`${message}\n`));
  const resolveStoreRoot = deps.resolveStoreRoot ?? (() => ensureStoreRoot());

  program
    .command("match")
    .description("Rank the local catalog against an agent-authored tech profile.")
    .requiredOption("--profile <file|name>", "a profile file path, or a name saved with `profile save`")
    .option("--focus <choices>", `what to look for, as "<topic>:<goal>" pairs separated by commas (goals: ${GOALS.join(", ")}); topics are listed by \`profile map\``)
    .option("--per-topic <n>", `with --focus, how many sessions each choice lists (default ${DEFAULT_PER_TOPIC}, maximum ${MAX_PER_TOPIC})`)
    .option("--level <band>", "only sessions at this level band, e.g. 400 or a range like 400-500")
    .option("--lens <lens>", `one of ${LENSES.join(", ")}`, "all")
    .option("--limit <n>", "maximum number of candidates", String(DEFAULT_MATCH_LIMIT))
    .option("--include-abstracts", "include each session's abstract in the output")
    .option("--verbose", "also show every reason in the table: the lens reasons with their sources and the ranking reasons")
    .option("--json", "print machine-readable JSON instead of a human-readable table")
    .action((options: MatchCommandOptions, command: Command) => {
      const storeRoot = resolveStoreRoot();

      try {
        const preferences: SessionPreferences | undefined = options.level === undefined ? undefined : { levels: parseLevelBandRange(options.level) };
        if (options.focus !== undefined) {
          if (command.getOptionValueSource("lens") !== "default") {
            throw new ValidationError("--focus and --lens cannot be used together: a focus names its own goal for each topic.");
          }
          if (command.getOptionValueSource("limit") !== "default") {
            throw new ValidationError("--focus and --limit cannot be used together: use --per-topic to cap each choice.");
          }
          const focused = loadResolvedProfile(options.profile, storeRoot);
          const choices = parseFocus(options.focus, profileTopics(focused, { storeRoot }));
          const perTopic = options.perTopic === undefined ? undefined : parsePerTopic(options.perTopic);
          const focusResult = matchFocus(focused, { storeRoot }, choices, {
            ...(perTopic === undefined ? {} : { perTopic }),
            ...(preferences === undefined ? {} : { preferences }),
          });
          const focusAbstracts = options.includeAbstracts
            ? new Map((readRaw({ storeRoot }) ?? []).map((s) => [s.sessionId, s.abstract ?? null]))
            : undefined;
          if (options.json) {
            const toCandidate = (candidate: FocusCandidate): Record<string, unknown> => ({
              ...toLeanFocusCandidate(candidate),
              ...(focusAbstracts === undefined ? {} : { abstract: focusAbstracts.get(candidate.record.sessionId) ?? null }),
            });
            print(JSON.stringify(buildFocusResponse(focusResult, undefined, toCandidate)));
            return;
          }
          print(formatFocusResult(focusResult, options.verbose === true, focusAbstracts));
          return;
        }
        if (options.perTopic !== undefined) {
          throw new ValidationError("--per-topic needs --focus.");
        }
        const lens = parseLens(options.lens);
        const limit = parseMatchLimit(options.limit);

        const resolvedProfile = loadResolvedProfile(options.profile, storeRoot);

        const result = matchSessionsDetailed(resolvedProfile, { storeRoot }, { lens, limit, ...(preferences === undefined ? {} : { preferences }) });

        const abstracts = options.includeAbstracts
          ? new Map((readRaw({ storeRoot }) ?? []).map((s) => [s.sessionId, s.abstract ?? null]))
          : undefined;

        if (options.json) {
          const toCandidate = (candidate: MatchCandidate): Record<string, unknown> => ({
            ...toLeanCandidate(candidate),
            ...(abstracts === undefined ? {} : { abstract: abstracts.get(candidate.record.sessionId) ?? null }),
          });
          print(JSON.stringify(buildMatchResponse(result, limit, undefined, toCandidate)));
          return;
        }
        print(formatHumanResult(result, options.verbose === true, abstracts));
      } catch (err) {
        if (err instanceof z.ZodError) {
          print(formatZodError(err));
          process.exitCode = 1;
          return;
        }
        if (
          err instanceof CatalogMissingError ||
          err instanceof CatalogUnusableError ||
          err instanceof ValidationError
        ) {
          print(err.message);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  return program;
}
