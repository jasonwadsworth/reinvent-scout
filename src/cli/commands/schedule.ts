import type { Command } from "commander";
import { createApiClient, type ApiClient } from "../../api/client.js";
import { createTokenProviderAdapter } from "../../auth/provider-adapter.js";
import { DEFAULT_EVENT_ID } from "../../catalog/sync.js";
import { AuthRequiredError, NotRegisteredError, ValidationError } from "../../core/errors.js";
import { ensureStoreRoot } from "../../core/paths.js";
import { favoriteSessions, unfavoriteSession, type FavoriteSessionsResult } from "../../schedule/favorites.js";
import { getSchedule, type ScheduleResult, type ScheduleSession } from "../../schedule/schedule.js";

export interface ScheduleCommandDeps {
  /** Defaults to the real store root (`ensureStoreRoot`). Inject a fixed path in tests so
   * nothing touches the real home directory. */
  resolveStoreRoot?: () => string;
  /** Defaults to building a real `ApiClient` over the real token provider and the global
   * `fetch`. Inject a fake in tests so nothing touches the network. */
  buildApiClient?: (storeRoot: string) => ApiClient;
  /** Where command output goes. Defaults to stdout. */
  print?: (message: string) => void;
}

interface ShowCommandOptions {
  event: string;
  json: boolean;
}

interface FavoriteCommandOptions {
  event: string;
  json: boolean;
}

interface UnfavoriteCommandOptions {
  event: string;
}

/** The most session ids `schedule favorite` accepts in one invocation -- an agent-facing command
 * should not be able to queue an unbounded write in one call, mirroring `match`'s own upper bound
 * on `--limit`. Ten times `AssociateFavorites`' own per-request cap, so a single invocation can
 * still cover a real day's worth of candidates without needing to be split by the caller. */
const MAX_FAVORITE_IDS = 100;

function defaultBuildApiClient(storeRoot: string): ApiClient {
  return createApiClient({ getAccessToken: createTokenProviderAdapter({ storeRoot }) });
}

/**
 * Reads every line of `process.stdin` as one session id, trimming whitespace and dropping blank
 * lines -- the shape `reinvent-scout match --json | jq -r '.[].sessionId'` (or any other
 * newline-per-id extraction) produces. Reads the real stream directly rather than through an
 * injectable callback, so a test substituting `process.stdin` itself exercises this exact code
 * path, not a stand-in for it.
 */
async function readIdsFromStdin(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** `ids` as given on the command line, unless it's exactly `["-"]`, in which case every id is
 * instead read from stdin -- the dash is the conventional "read from stdin" marker, and matching
 * only the single-dash form (not e.g. a dash mixed with other ids) keeps the rule unambiguous. */
async function resolveIds(ids: string[]): Promise<string[]> {
  if (ids.length === 1 && ids[0] === "-") {
    return readIdsFromStdin();
  }
  return ids;
}

/** Validates the resolved id count against both bounds before the store root or an API client is
 * touched at all -- an empty list (a profile that matched nothing, or an extraction that yielded
 * nothing, piped through `schedule favorite -`) must be caught here, not left to fall through to
 * the auth check first. Without this, a signed-in caller with zero ids would still pay for a real
 * `GetSchedule` round trip and a pacer slot (see `favoriteSessions`'s own re-read) only to be told
 * "vacuous success," and a caller with no stored session at all would see "Not signed in" -- true,
 * but not the actual problem, since there's nothing to favorite regardless of sign-in state. */
function assertValidIdCount(ids: readonly string[]): void {
  if (ids.length === 0) {
    throw new ValidationError(
      "No session ids given; nothing to favorite. Pass one or more session ids, or pipe them in " +
        'with a single "-".',
    );
  }
  if (ids.length > MAX_FAVORITE_IDS) {
    throw new ValidationError(
      `Refusing to favorite ${ids.length} sessions in one invocation; the limit is ${MAX_FAVORITE_IDS}.`,
    );
  }
}

/** `YYYY-MM-DD`, or `"Unscheduled"` when the day isn't known -- either because the entry never
 * resolved against the local index at all, or because it did resolve but the session itself has
 * no `startDate` on record (see `schedule.ts`'s own distinction between the two). Both are
 * "nothing to group this under" from a day-grouping perspective, though `formatSessionLine` below
 * still tells them apart in the line itself. */
function dayKey(entry: ScheduleSession): string {
  return entry.resolved && entry.startDate !== null ? entry.startDate : "Unscheduled";
}

function formatSessionLine(entry: ScheduleSession): string {
  if (!entry.resolved) {
    return `    ${entry.sessionId} (not in the local catalog -- try \`catalog sync\`)`;
  }
  const parts = [entry.abbreviation ?? entry.sessionId, entry.title];
  if (entry.venue !== null) {
    parts.push(entry.venue);
  }
  if (entry.room !== null) {
    parts.push(entry.room);
  }
  const time = entry.startTime ?? "unscheduled";
  return `    ${time} -- ${parts.join(" -- ")}`;
}

function compareDayKeys(a: string, b: string): number {
  if (a === "Unscheduled") {
    return b === "Unscheduled" ? 0 : 1;
  }
  if (b === "Unscheduled") {
    return -1;
  }
  return a.localeCompare(b);
}

function formatSection(title: string, entries: ScheduleSession[]): string[] {
  if (entries.length === 0) {
    return [`${title}: none.`];
  }
  const groups = new Map<string, ScheduleSession[]>();
  for (const entry of entries) {
    const key = dayKey(entry);
    const members = groups.get(key);
    if (members === undefined) {
      groups.set(key, [entry]);
    } else {
      members.push(entry);
    }
  }

  const lines = [`${title}:`];
  for (const day of [...groups.keys()].sort(compareDayKeys)) {
    lines.push(`  ${day}`);
    for (const entry of groups.get(day)!) {
      lines.push(formatSessionLine(entry));
    }
  }
  return lines;
}

function formatScheduleHuman(result: ScheduleResult): string {
  const lines = [
    ...formatSection("Reserved", result.reserved),
    ...formatSection("Favorites", result.favorites),
  ];
  if (result.personalTime.length > 0) {
    lines.push("Personal time:");
    for (const entry of result.personalTime) {
      lines.push(`  ${entry.startDateTime} - ${entry.endDateTime} -- ${entry.title}`);
    }
  }
  if (result.warning !== null) {
    lines.push(`Warning: ${result.warning}`);
  }
  return lines.join("\n");
}

function formatFailureLine(failure: FavoriteSessionsResult["failed"][number]): string {
  const parts = [failure.sessionId, failure.code];
  if (failure.conflictsWith !== undefined && failure.conflictsWith.length > 0) {
    const titles = failure.conflictsWith.map((c) => c.title ?? c.sessionId).join(", ");
    parts.push(`conflicts with: ${titles}`);
  }
  if (failure.reason !== undefined) {
    parts.push(`reason: ${failure.reason}`);
  }
  return `  ${parts.join(" -- ")}`;
}

function formatFavoriteResultHuman(result: FavoriteSessionsResult): string {
  const lines: string[] = [];
  lines.push(
    result.successful.length > 0 ? `Favorited: ${result.successful.join(", ")}` : "Favorited: none.",
  );
  if (result.alreadyFavorited.length > 0) {
    lines.push(`Already favorited: ${result.alreadyFavorited.join(", ")}`);
  }
  if (result.failed.length > 0) {
    lines.push("Refused:");
    for (const failure of result.failed) {
      lines.push(formatFailureLine(failure));
    }
  }
  if (result.verified === null) {
    lines.push(
      `Warning: could not confirm these writes against the schedule (${result.verificationError}). ` +
        "The results above are still real -- only the confirmation step failed.",
    );
  } else if (result.mismatch.length > 0) {
    lines.push(
      `Warning: the server reported success for ${result.mismatch.join(", ")}, but they are not ` +
        "on the schedule on re-read.",
    );
  }
  return lines.join("\n");
}

/** Registers `schedule` and its `show`, `favorite` and `unfavorite` subcommands. */
export function registerScheduleCommands(program: Command, deps: ScheduleCommandDeps = {}): Command {
  const print = deps.print ?? ((message: string) => process.stdout.write(`${message}\n`));
  const resolveStoreRoot = deps.resolveStoreRoot ?? (() => ensureStoreRoot());
  const buildApiClient = deps.buildApiClient ?? defaultBuildApiClient;

  const schedule = program
    .command("schedule")
    .description("Read your event schedule and manage favorites.");

  schedule
    .command("show")
    .description("Show your reserved sessions, favorites and personal time.")
    .option("--event <id>", "the event to read", DEFAULT_EVENT_ID)
    .option("--json", "print machine-readable JSON instead of a human-readable summary")
    .action(async (options: ShowCommandOptions) => {
      const storeRoot = resolveStoreRoot();
      const apiClient = buildApiClient(storeRoot);

      try {
        const result = await getSchedule({ apiClient, storeRoot, eventId: options.event });
        print(options.json ? JSON.stringify(result) : formatScheduleHuman(result));
      } catch (err) {
        if (err instanceof NotRegisteredError) {
          print(
            `You're signed in, but not registered for ${options.event}. Signing in again ` +
              "will not help; register for the event first.",
          );
          process.exitCode = 1;
          return;
        }
        if (err instanceof AuthRequiredError) {
          print(err.message);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  schedule
    .command("favorite")
    .description(
      "Favorite one or more sessions by session id. Pass a single \"-\" to read ids from stdin, " +
        "one per line -- e.g. `reinvent-scout match --json | jq -r '.[].sessionId' | " +
        "reinvent-scout schedule favorite -`.",
    )
    .argument("<ids...>", "session ids to favorite, or a single \"-\" to read them from stdin")
    .option("--event <id>", "the event to favorite sessions for", DEFAULT_EVENT_ID)
    .option("--json", "print machine-readable JSON instead of a human-readable summary")
    .action(async (ids: string[], options: FavoriteCommandOptions) => {
      try {
        const resolvedIds = await resolveIds(ids);
        assertValidIdCount(resolvedIds);

        const storeRoot = resolveStoreRoot();
        const apiClient = buildApiClient(storeRoot);

        const result = await favoriteSessions(resolvedIds, {
          apiClient,
          storeRoot,
          eventId: options.event,
        });

        print(options.json ? JSON.stringify(result) : formatFavoriteResultHuman(result));
        if (result.failed.length > 0) {
          process.exitCode = 1;
        }
      } catch (err) {
        if (err instanceof NotRegisteredError) {
          print(
            `You're signed in, but not registered for ${options.event}. Signing in again ` +
              "will not help; register for the event first.",
          );
          process.exitCode = 1;
          return;
        }
        if (err instanceof AuthRequiredError || err instanceof ValidationError) {
          print(err.message);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  schedule
    .command("unfavorite")
    .description("Remove one session from your favorites.")
    .argument("<id>", "session id to remove from favorites")
    .option("--event <id>", "the event to remove the favorite from", DEFAULT_EVENT_ID)
    .action(async (id: string, options: UnfavoriteCommandOptions) => {
      const storeRoot = resolveStoreRoot();
      const apiClient = buildApiClient(storeRoot);

      try {
        const outcome = await unfavoriteSession(id, { apiClient, eventId: options.event });
        print(
          outcome === "removed"
            ? `Removed ${id} from favorites.`
            : `${id} was not favorited; nothing to remove.`,
        );
      } catch (err) {
        if (err instanceof NotRegisteredError) {
          print(
            `You're signed in, but not registered for ${options.event}. Signing in again ` +
              "will not help; register for the event first.",
          );
          process.exitCode = 1;
          return;
        }
        if (err instanceof AuthRequiredError) {
          print(err.message);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  return schedule;
}
