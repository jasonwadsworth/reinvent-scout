import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import { z } from "zod";
import { catalogServiceNames } from "../../catalog/query.js";
import { buildServiceAliasIndex } from "../../catalog/service-aliases.js";
import { readRaw } from "../../catalog/store.js";
import {
  CatalogMissingError,
  CatalogUnusableError,
  ValidationError,
} from "../../core/errors.js";
import { ensureStoreRoot } from "../../core/paths.js";
import { LENSES, type Lens } from "../../match/lens.js";
import { matchSessionsDetailed, type MatchCandidate, type MatchResult } from "../../match/match.js";
import { buildMatchResponse, isRankingReason, toLeanCandidate } from "../../match/response.js";
import { resolveProfile } from "../../profile/profile.js";
import { readProfileFile } from "../../profile/store.js";
import { formatZodError } from "../zod-errors.js";

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

function readRawProfile(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new ValidationError("The profile file is not valid JSON.");
  }
}

/**
 * Loads a profile's raw JSON content from `--profile <file|name>`: an existing filesystem path is
 * read directly, and anything else is looked up as a name previously saved with `profile save`.
 * The name form goes through `readProfileFile` -- the exact same `profilePath`/
 * `SAFE_PROFILE_NAME_PATTERN` guard `profile save` and `profile validate --name` already enforce
 * -- rather than a second, hand-rolled safety check here that could drift out of sync with it.
 * Since a saved name can never contain a path separator, this can't be tricked into resolving a
 * traversal attempt as a name: `existsSync` either finds the real file the caller pointed at, or
 * the value is rejected by the same pattern every other saved-name caller enforces.
 */
function loadProfileContent(profileArg: string, storeRoot: string): string {
  if (existsSync(profileArg)) {
    return readFileSync(profileArg, "utf8");
  }
  return readProfileFile(profileArg, { storeRoot });
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
 * `match/match.ts`'s repeat grouping), its `why` block directly under it, then each lens reason's
 * `detail` indented beneath (ranking reasons only under `--verbose`) -- the scorer
 * exists to be explainable (see `match/score.ts`'s `Reason`), so the human-readable table must
 * actually show why a session was suggested, not only its score -- and every one of its offerings
 * (day, time, venue, room) beneath that, so a repeat's every sitting is visible even though the
 * candidates being ranked are talks, not individual sittings. `abstract`, when given (only under
 * `--include-abstracts`; `null`/absent otherwise), prints beneath the offerings, mirroring
 * `catalog.ts`'s `formatSearchResultWithAbstract` -- a session with no abstract on record still
 * gets its ordinary line, never invented text. */
function formatCandidateWithReasons(candidate: MatchCandidate, verbose: boolean, abstract?: string | null): string {
  const line = formatCandidateLine(candidate);
  const shown = verbose ? candidate.reasons : candidate.reasons.filter(reason => !isRankingReason(reason));
  const reasonLines = shown.flatMap((reason) => [
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
    return [NO_CANDIDATES_MESSAGE, ...skipped].join("\n");
  }
  const blocks = result.candidates.map((candidate) =>
    formatCandidateWithReasons(candidate, verbose, abstracts?.get(candidate.record.sessionId) ?? null));
  return [blocks.join("\n\n"), ...skipped].join("\n\n");
}

/** Registers the `match` command. */
export function registerMatchCommands(program: Command, deps: MatchCommandDeps = {}): Command {
  const print = deps.print ?? ((message: string) => process.stdout.write(`${message}\n`));
  const resolveStoreRoot = deps.resolveStoreRoot ?? (() => ensureStoreRoot());

  program
    .command("match")
    .description("Rank the local catalog against an agent-authored tech profile.")
    .requiredOption("--profile <file|name>", "a profile file path, or a name saved with `profile save`")
    .option("--lens <lens>", `one of ${LENSES.join(", ")}`, "all")
    .option("--limit <n>", "maximum number of candidates", String(DEFAULT_MATCH_LIMIT))
    .option("--include-abstracts", "include each session's abstract in the output")
    .option("--verbose", "also show the ranking reasons (shared services, topics, wording) in the table")
    .option("--json", "print machine-readable JSON instead of a human-readable table")
    .action((options: MatchCommandOptions) => {
      const storeRoot = resolveStoreRoot();

      try {
        const lens = parseLens(options.lens);
        const limit = parseMatchLimit(options.limit);

        const content = loadProfileContent(options.profile, storeRoot);
        const rawProfile = readRawProfile(content);
        const serviceNames = catalogServiceNames({ storeRoot });
        const serviceAliasIndex = buildServiceAliasIndex(serviceNames);
        const resolvedProfile = resolveProfile(rawProfile, serviceAliasIndex);

        const result = matchSessionsDetailed(resolvedProfile, { storeRoot }, { lens, limit });

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
