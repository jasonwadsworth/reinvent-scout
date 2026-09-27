import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import { z } from "zod";
import { toPublicIndexRecord } from "../../catalog/index-record.js";
import { catalogServiceNames } from "../../catalog/query.js";
import { buildServiceAliasIndex } from "../../catalog/service-aliases.js";
import { readRaw } from "../../catalog/store.js";
import {
  CatalogMissingError,
  CatalogUnusableError,
  ValidationError,
} from "../../core/errors.js";
import { ensureStoreRoot } from "../../core/paths.js";
import type { Lens } from "../../match/lens.js";
import { matchSessions, type MatchCandidate } from "../../match/match.js";
import { resolveProfile } from "../../profile/profile.js";
import { readProfileFile } from "../../profile/store.js";

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
}

const DEFAULT_MATCH_LIMIT = 30;
const MAX_MATCH_LIMIT = 100;
const NO_CANDIDATES_MESSAGE = "No matching sessions found.";
const KNOWN_LENSES: readonly Lens[] = ["explain", "all"];

/** Every issue's own message, one per line -- mirrors `profile.ts`'s `formatZodError` so an
 * invalid profile passed to `match` surfaces the exact same, entry-naming errors `profile
 * validate` would have shown for the same file. */
function formatZodError(err: z.ZodError): string {
  return err.issues.map((issue) => issue.message).join("\n");
}

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
  if (!KNOWN_LENSES.includes(raw as Lens)) {
    throw new ValidationError(`--lens must be one of ${KNOWN_LENSES.join(", ")}, got "${raw}".`);
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

/** The candidate's own line (headed by its `code`, not any one sitting's own abbreviation -- see
 * `match/match.ts`'s repeat grouping), each reason's `detail` indented beneath it -- the scorer
 * exists to be explainable (see `match/score.ts`'s `Reason`), so the human-readable table must
 * actually show why a session was suggested, not only its score -- and every one of its offerings
 * (day, time, venue, room) beneath that, so a repeat's every sitting is visible even though the
 * candidates being ranked are talks, not individual sittings. `abstract`, when given (only under
 * `--include-abstracts`; `null`/absent otherwise), prints beneath the offerings, mirroring
 * `catalog.ts`'s `formatSearchResultWithAbstract` -- a session with no abstract on record still
 * gets its ordinary line, never invented text. */
function formatCandidateWithReasons(candidate: MatchCandidate, abstract?: string | null): string {
  const line = formatCandidateLine(candidate);
  const reasonLines = candidate.reasons.map((reason) => `  - ${reason.detail}`);
  const offeringLines = candidate.offerings.map(formatOfferingLine);
  const parts = [line, ...reasonLines, "  Offerings:", ...offeringLines];
  if (abstract !== undefined && abstract !== null && abstract !== "") {
    parts.push(`  ${abstract}`);
  }
  return parts.join("\n");
}

/** Registers the `match` command. */
export function registerMatchCommands(program: Command, deps: MatchCommandDeps = {}): Command {
  const print = deps.print ?? ((message: string) => process.stdout.write(`${message}\n`));
  const resolveStoreRoot = deps.resolveStoreRoot ?? (() => ensureStoreRoot());

  program
    .command("match")
    .description("Rank the local catalog against an agent-authored tech profile.")
    .requiredOption("--profile <file|name>", "a profile file path, or a name saved with `profile save`")
    .option("--lens <lens>", "explain (default level bands and formats) or all", "all")
    .option("--limit <n>", "maximum number of candidates", String(DEFAULT_MATCH_LIMIT))
    .option("--include-abstracts", "include each session's abstract in the output")
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

        const candidates = matchSessions(resolvedProfile, { storeRoot }, { lens, limit });

        if (options.includeAbstracts) {
          const rawBySessionId = new Map((readRaw({ storeRoot }) ?? []).map((s) => [s.sessionId, s]));
          const abstracts = candidates.map(
            (candidate) => rawBySessionId.get(candidate.record.sessionId)?.abstract ?? null,
          );
          const withAbstracts = candidates.map((candidate, i) => ({
            code: candidate.code,
            ...toPublicIndexRecord(candidate.record),
            score: candidate.score,
            reasons: candidate.reasons,
            offerings: candidate.offerings,
            abstract: abstracts[i],
          }));
          print(
            options.json
              ? JSON.stringify(withAbstracts)
              : candidates.length === 0
                ? NO_CANDIDATES_MESSAGE
                : candidates
                    .map((candidate, i) => formatCandidateWithReasons(candidate, abstracts[i]))
                    .join("\n\n"),
          );
          return;
        }

        const withoutAbstracts = candidates.map((candidate) => ({
          code: candidate.code,
          ...toPublicIndexRecord(candidate.record),
          score: candidate.score,
          reasons: candidate.reasons,
          offerings: candidate.offerings,
        }));
        print(
          options.json
            ? JSON.stringify(withoutAbstracts)
            : candidates.length === 0
              ? NO_CANDIDATES_MESSAGE
              : candidates.map((candidate) => formatCandidateWithReasons(candidate)).join("\n\n"),
        );
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
