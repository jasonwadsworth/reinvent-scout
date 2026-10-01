import type { Command } from "commander";
import { createApiClient, type ApiClient } from "../../api/client.js";
import { createTokenProviderAdapter } from "../../auth/provider-adapter.js";
import { toPublicIndexRecord, type IndexRecord } from "../../catalog/index-record.js";
import {
  compareByStartDateTime,
  queryCatalog,
  resolveSessionRecord,
  type CatalogQueryResult,
} from "../../catalog/query.js";
import { readRaw } from "../../catalog/store.js";
import { DEFAULT_EVENT_ID, syncCatalog, type SyncResult } from "../../catalog/sync.js";
import { isKnownVenue } from "../../catalog/venue.js";
import {
  AuthRequiredError,
  CatalogMissingError,
  CatalogUnusableError,
  NotRegisteredError,
  ValidationError,
} from "../../core/errors.js";
import { ensureStoreRoot } from "../../core/paths.js";
import { parseLevelBandRange } from "../level-option.js";

export interface CatalogCommandDeps {
  /** Defaults to the real store root (`ensureStoreRoot`). Inject a fixed path in tests so
   * nothing touches the real home directory. */
  resolveStoreRoot?: () => string;
  /** Defaults to building a real `ApiClient` over the real token provider and the global
   * `fetch`. Inject a fake in tests so nothing touches the network. */
  buildApiClient?: (storeRoot: string) => ApiClient;
  /** Where command output goes. Defaults to stdout. */
  print?: (message: string) => void;
  /** Stamped as the new meta's `syncedAt` on a full sync. Defaults to `Date.now`. */
  now?: () => number;
}

interface SyncCommandOptions {
  event: string;
  abstracts: boolean;
  reindex: boolean;
  json: boolean;
}

interface SearchCommandOptions {
  type?: string;
  venue?: string;
  level?: string;
  day?: string;
  limit: string;
  json: boolean;
  includeAbstracts: boolean;
}

interface ShowCommandOptions {
  json: boolean;
}

const DEFAULT_SEARCH_LIMIT = 20;
const NO_MATCHES_MESSAGE = "No sessions matched.";

function defaultBuildApiClient(storeRoot: string): ApiClient {
  return createApiClient({ getAccessToken: createTokenProviderAdapter({ storeRoot }) });
}

function parseLimit(raw: string): number {
  const limit = Number(raw);
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) {
    throw new ValidationError(`--limit must be a positive integer, got "${raw}".`);
  }
  return limit;
}

/** The one-line form plus the abstract beneath it, for `--include-abstracts` without `--json`.
 * A session with no abstract on record gets only its line, so the flag never invents text. */
function formatSearchResultWithAbstract(result: CatalogQueryResult, abstract: string | null): string {
  const line = formatSearchResultLine(result);
  return abstract === null || abstract === "" ? line : `${line}\n  ${abstract}`;
}

function formatSearchResultLine(result: CatalogQueryResult): string {
  const { record } = result;
  const parts = [record.abbreviation ?? record.sessionId, record.title];
  if (record.type !== null) {
    parts.push(`[${record.type}]`);
  }
  return parts.join(" -- ");
}

/** One sitting's own line in `catalog show`'s human-readable output: abbreviation, session id, day,
 * time, venue, room -- the one place a session id appears in any human-readable output at all
 * (every other command prints the shorter abbreviation or `match`'s own grouped `code` instead).
 * Unscheduled fields are simply omitted rather than printing a placeholder, matching
 * `schedule.ts`'s own `formatSessionLine` and `match.ts`'s `formatOfferingLine` conventions. */
function formatSittingLine(record: IndexRecord): string {
  const parts = [record.abbreviation ?? "(no abbreviation)", record.sessionId];
  parts.push(record.startDate ?? "unscheduled");
  if (record.startTime !== null) {
    parts.push(record.startTime);
  }
  if (record.venue !== null) {
    parts.push(record.venue);
  }
  if (record.room !== null) {
    parts.push(record.room);
  }
  return `  ${parts.join(" -- ")}`;
}

function formatHumanSummary(result: SyncResult): string {
  const lines = [
    `Synced ${result.count} session${result.count === 1 ? "" : "s"} for ${result.eventId}.`,
  ];
  if (result.reindexed) {
    lines.push("Rebuilt the local index from the already-stored catalog without contacting the API.");
  }
  if (result.totalCountMissing) {
    // Distinct from countMismatch (which is always false in this case, since there's nothing
    // real to compare `count` against): the server not reporting a total at all is a more
    // serious signal than a mismatch, and must not be silent just because the mismatch check
    // had nothing to flag.
    lines.push(
      "Warning: the server did not report a total session count. Unable to check whether the " +
        "full catalog was stored.",
    );
  } else if (result.countMismatch) {
    lines.push(
      `Warning: the server reports ${result.totalCount} total sessions, but ${result.count} ` +
        "were stored. Some sessions may be missing from the local catalog.",
    );
  }
  return lines.join("\n");
}

/** Registers `catalog` and its `sync`, `search` and `show` subcommands. */
export function registerCatalogCommands(program: Command, deps: CatalogCommandDeps = {}): Command {
  const print = deps.print ?? ((message: string) => process.stdout.write(`${message}\n`));
  const resolveStoreRoot = deps.resolveStoreRoot ?? (() => ensureStoreRoot());
  const buildApiClient = deps.buildApiClient ?? defaultBuildApiClient;

  const catalog = program
    .command("catalog")
    .description("Manage the local re:Invent session catalog.");

  catalog
    .command("sync")
    .description("Pull the session catalog and build the local search index.")
    .option("--event <id>", "the event to sync", DEFAULT_EVENT_ID)
    .option("--no-abstracts", "exclude session abstracts from the synced catalog")
    .option(
      "--reindex",
      "rebuild the local index from the already-stored catalog without contacting the API",
    )
    .option("--json", "print machine-readable JSON instead of a human-readable summary")
    .action(async (options: SyncCommandOptions) => {
      const storeRoot = resolveStoreRoot();
      const apiClient = buildApiClient(storeRoot);

      try {
        const result = await syncCatalog({
          apiClient,
          storeRoot,
          eventId: options.event,
          includeAbstracts: options.abstracts,
          reindex: options.reindex,
          ...(deps.now === undefined ? {} : { now: deps.now }),
        });

        print(options.json ? JSON.stringify(result) : formatHumanSummary(result));
      } catch (err) {
        // Both of these are the two specific, actionable failures a user can hit here -- give
        // each its own message rather than letting a raw stack trace reach the terminal.
        // Everything else (a network error, a 5xx after retries, a programmer error) is a real
        // bug or outage and should surface with its full detail, so it is deliberately rethrown.
        if (err instanceof AuthRequiredError || err instanceof NotRegisteredError) {
          print(err.message);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  catalog
    .command("search")
    .description("Search the local session catalog.")
    .argument("[query]", "free-text search terms")
    .option("--type <type>", "filter by session type, e.g. \"Chalk talk\"")
    .option("--venue <venue>", "filter by venue, e.g. \"Venetian\"")
    .option("--level <band>", "filter by level band, e.g. 200 or a range like 100-300")
    .option("--day <date>", "filter by day, YYYY-MM-DD")
    .option("--limit <n>", "maximum number of results", String(DEFAULT_SEARCH_LIMIT))
    .option("--include-abstracts", "include each session's abstract in the output")
    .option("--json", "print machine-readable JSON instead of a human-readable list")
    .action((query: string | undefined, options: SearchCommandOptions) => {
      const storeRoot = resolveStoreRoot();

      try {
        if (options.venue !== undefined && !isKnownVenue(options.venue)) {
          throw new ValidationError(`"${options.venue}" is not a known venue.`);
        }

        const results = queryCatalog(
          { storeRoot },
          {
            ...(query === undefined ? {} : { query }),
            ...(options.type === undefined ? {} : { type: options.type }),
            ...(options.venue === undefined ? {} : { venue: options.venue }),
            ...(options.level === undefined ? {} : { levelBand: parseLevelBandRange(options.level) }),
            ...(options.day === undefined ? {} : { day: options.day }),
            limit: parseLimit(options.limit),
          },
        );

        if (options.includeAbstracts) {
          const rawBySessionId = new Map((readRaw({ storeRoot }) ?? []).map((s) => [s.sessionId, s]));
          const withAbstracts = results.map((result) => ({
            ...toPublicIndexRecord(result.record),
            score: result.score,
            abstract: rawBySessionId.get(result.record.sessionId)?.abstract ?? null,
          }));
          print(
            options.json
              ? JSON.stringify(withAbstracts)
              : results.length === 0
                ? NO_MATCHES_MESSAGE
                : results
                    .map((result, i) => formatSearchResultWithAbstract(result, withAbstracts[i]?.abstract ?? null))
                    .join("\n\n"),
          );
          return;
        }

        const withoutAbstracts = results.map((result) => ({
          ...toPublicIndexRecord(result.record),
          score: result.score,
        }));
        print(
          options.json
            ? JSON.stringify(withoutAbstracts)
            : results.length === 0
              ? NO_MATCHES_MESSAGE
              : results.map(formatSearchResultLine).join("\n"),
        );
      } catch (err) {
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

  catalog
    .command("show")
    .description("Show one session's full local details.")
    .argument("<sessionOrAbbreviation>", "the session id or abbreviation to show, e.g. ANT301")
    .option("--json", "print machine-readable JSON instead of a human-readable summary")
    .action((token: string, options: ShowCommandOptions) => {
      const storeRoot = resolveStoreRoot();

      try {
        const result = resolveSessionRecord({ storeRoot }, token);

        if (result.status === "not-found") {
          print(
            `No session found for "${token}" in the local catalog (checked both session id and ` +
              "abbreviation). If this session should exist, your catalog may be out of date -- " +
              "try `reinvent-scout catalog sync`.",
          );
          process.exitCode = 1;
          return;
        }

        if (result.status === "ambiguous") {
          print(`"${token}" matches more than one session:`);
          for (const candidate of result.candidates) {
            print(`  ${candidate.abbreviation ?? "(no abbreviation)"} -- ${candidate.sessionId}`);
          }
          process.exitCode = 1;
          return;
        }

        const { record, relatedAbbreviations, relatedRecords } = result;
        const rawSession = (readRaw({ storeRoot }) ?? []).find((s) => s.sessionId === record.sessionId);
        const output = {
          ...toPublicIndexRecord(record),
          abstract: rawSession?.abstract ?? null,
          relatedAbbreviations,
        };

        if (options.json) {
          print(JSON.stringify(output));
        } else {
          // Every sitting of the talk -- the resolved one and every related one -- in time order,
          // each its own full line (abbreviation, session id, day, time, venue, room). This is the
          // one place a session id appears in human-readable output at all, replacing the old
          // abbreviation-only "Also offered as" line: a reader following search -> show needs
          // something real to paste into `schedule favorite`, not just the other sittings' names.
          const sittings = [record, ...relatedRecords].sort(compareByStartDateTime);
          const lines = [output.title, ...sittings.map(formatSittingLine)];
          lines.push(output.abstract ?? "");
          print(lines.join("\n"));
        }
      } catch (err) {
        if (err instanceof CatalogMissingError || err instanceof CatalogUnusableError) {
          print(err.message);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  return catalog;
}
