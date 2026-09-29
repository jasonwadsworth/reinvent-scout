import { readFileSync } from "node:fs";
import { z } from "zod";
import { recommendNearbySessions, nearbyInputSchema } from "../../onsite/recommend.js";
import { readOnsiteConfig, updateOnsiteConfig, effectiveOnsitePreferences, onsitePatchSchema, type OnsitePatch } from "../../onsite/config.js";
import { resolveStoreRoot as resolveRootWithoutCreation } from "../../core/paths.js";
import { planSchedule, type SchedulePlan } from "../../schedule/plan.js";
import { reserveSessions, cancelReservation, reservationNeedsAttention, cancellationNeedsAttention, validateSessionIds, type ReserveSessionsResult } from "../../schedule/reservations.js";
import type { Command } from "commander";
import { createApiClient, type ApiClient } from "../../api/client.js";
import { createTokenProviderAdapter } from "../../auth/provider-adapter.js";
import type { IndexRecord } from "../../catalog/index-record.js";
import { readIndex, readTimezoneAvailability } from "../../catalog/store.js";
import { DEFAULT_EVENT_ID } from "../../catalog/sync.js";
import { AuthRequiredError, CatalogMissingError, CatalogUnusableError, NotRegisteredError, OperationUnavailableError, ValidationError } from "../../core/errors.js";
import { ensureStoreRoot } from "../../core/paths.js";
import { favoriteSessions, unfavoriteSession, type FavoriteSessionsResult } from "../../schedule/favorites.js";
import { mergeAndSortScheduleEntries, timezoneWarnings, type MergedScheduleEntry } from "../../schedule/merge.js";
import { getSchedule, type ScheduleResult } from "../../schedule/schedule.js";
import { formatEventLocalTime, utcIsoToZonedWallClock } from "../../schedule/timezone.js";
import { formatZodError } from "../zod-errors.js";

export interface ScheduleCommandDeps {
  /** Defaults to the real store root (`ensureStoreRoot`). Inject a fixed path in tests so
   * nothing touches the real home directory. */
  resolveStoreRoot?: () => string;
  /** Defaults to building a real `ApiClient` over the real token provider and the global
   * `fetch`. Inject a fake in tests so nothing touches the network. */
  buildApiClient?: (storeRoot: string) => ApiClient;
  /** Where command output goes. Defaults to stdout. */
  print?: (message: string) => void;
  now?: () => number;
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
  return ids.map((id) => id.trim());
}

/** Everything a user's input or account state can cause, printed as one readable message with a
 * non-zero exit instead of a stack trace or raw zod JSON. Anything else is a bug and propagates. */
function reportCommandError(err: unknown, event: string, print: (message: string) => void, options: { anyError?: boolean } = {}): void {
  let message: string | undefined;
  if (err instanceof z.ZodError) message = formatZodError(err);
  else if (err instanceof NotRegisteredError) {
    message = `You're signed in, but not registered for ${event}. Signing in again will not help; register for the event first.`;
  } else if (err instanceof AuthRequiredError || err instanceof ValidationError || err instanceof CatalogMissingError || err instanceof CatalogUnusableError || err instanceof OperationUnavailableError) {
    message = err.message;
  } else if (options.anyError === true && err instanceof Error) message = err.message;
  if (message === undefined) throw err;
  print(message);
  process.exitCode = 1;
}

function readPatchFile(path: string): OnsitePatch {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { throw new ValidationError(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  let json: unknown;
  try { json = JSON.parse(text); }
  catch { throw new ValidationError(`${path} is not valid JSON.`); }
  return onsitePatchSchema.parse(json);
}

/** Validates the resolved id count against both bounds before the store root or an API client is
 * touched at all -- an empty list (a profile that matched nothing, or an extraction that yielded
 * nothing, piped through `schedule favorite -`) must be caught here, not left to fall through to
 * the auth check first. Without this, a signed-in caller with zero ids would still pay for a real
 * `GetSchedule` round trip and a pacer slot (see `favoriteSessions`'s own re-read) only to be told
 * "vacuous success," and a caller with no stored session at all would see "Not signed in" -- true,
 * but not the actual problem, since there's nothing to favorite regardless of sign-in state. */
function assertValidIdCount(ids: readonly string[]): void {
  if (ids.some((id) => id.length === 0)) {
    throw new ValidationError("Session ids must not be blank.");
  }
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

/** `YYYY-MM-DD`, event-local, or `"Unscheduled"` when the day isn't known at all -- for a session,
 * either because it never resolved against the local index, or resolved but has no `startDate` on
 * record; personal time is never in this state, since it always has a real `startsAt`. A session's
 * own `startDate` is already event-local (that's how the API reports it), so it's used directly;
 * personal time's raw `startDateTime` is UTC, so its day is derived from `startsAt` via a real IANA
 * conversion when the event's timezone is known -- reviewer's finding: printing personal time
 * grouped by its own raw UTC date could put a late-evening block under the *next* calendar day in
 * event-local time. When the timezone is unknown, personal time falls back to its raw UTC date,
 * same as a session with no timezone falls back to plain "Unscheduled" -- both are already covered
 * by the timezone-unavailability warning appended below, not silently guessed at here. */
function dayKey(entry: MergedScheduleEntry, eventTimezone: string | null): string {
  if (entry.kind === "personalTime") {
    if (eventTimezone !== null) {
      return utcIsoToZonedWallClock(entry.startsAt!, eventTimezone).date;
    }
    return entry.personalTime!.startDateTime.split("T")[0] ?? "Unscheduled";
  }
  const session = entry.session!;
  return session.resolved && session.startDate !== null ? session.startDate : "Unscheduled";
}

function formatEntryLine(entry: MergedScheduleEntry, eventTimezone: string | null): string {
  if (entry.kind === "personalTime") {
    const personalTime = entry.personalTime!;
    if (eventTimezone !== null) {
      const start = utcIsoToZonedWallClock(entry.startsAt!, eventTimezone);
      const end = utcIsoToZonedWallClock(entry.endsAt!, eventTimezone);
      return `    ${start.time} - ${end.time} -- ${personalTime.title} (personal)`;
    }
    // Timezone unknown: printed exactly as the API gave it (raw UTC, no conversion attempted),
    // per the lead's own decision -- the timezoneWarnings appended below already explain why. The
    // explicit "UTC" label (reviewer2's own finding) is load-bearing, not decorative: a raw
    // "YYYY-MM-DDTHH:MM:SS" with no zone marker reads exactly like a local wall-clock time, right
    // next to session times that *are* genuinely local -- without the label, this looks like the
    // same misleading case the whole per-sitting-time fix was about, just relocated.
    return `    ${personalTime.startDateTime} - ${personalTime.endDateTime} UTC -- ${personalTime.title} (personal)`;
  }

  const session = entry.session!;
  if (!session.resolved) {
    return `    ${session.sessionId} (not in the local catalog -- try \`catalog sync\`)`;
  }
  const parts = [session.abbreviation ?? session.sessionId, session.title];
  if (session.venue !== null) {
    parts.push(session.venue);
  }
  if (session.room !== null) {
    parts.push(session.room);
  }
  const time = session.startTime ?? "unscheduled";
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

/** Groups `entries` (already sorted, in `startsAt` order -- see `mergeAndSortScheduleEntries`) by
 * event-local day and prints each day's own members in that same order, which is what makes this
 * within-day time-ordered rather than API order: reviewer's finding, reproduced from a real run of
 * the README flow, where sessions under one day appeared in whatever order the API happened to
 * return them in. */
function formatSection(title: string, entries: MergedScheduleEntry[], eventTimezone: string | null): string[] {
  if (entries.length === 0) {
    return [`${title}: none.`];
  }
  const groups = new Map<string, MergedScheduleEntry[]>();
  for (const entry of entries) {
    const key = dayKey(entry, eventTimezone);
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
      lines.push(formatEntryLine(entry, eventTimezone));
    }
  }
  return lines;
}

/** `timezoneWarningLines` are the exact same text `get_schedule` would report for the same
 * condition (both come from `schedule/merge.ts`'s own `timezoneWarnings`) -- the lead's own
 * decision: a person and an agent told about the same unknown-timezone condition read the same
 * words, not two independently-worded explanations of the same thing. */
function formatScheduleHuman(
  result: ScheduleResult,
  eventTimezone: string | null,
  timezoneWarningLines: readonly string[],
): string {
  const merged = mergeAndSortScheduleEntries(result, eventTimezone);
  const reserved = merged.filter((entry) => entry.kind === "reserved");
  const favorites = merged.filter((entry) => entry.kind === "favorite");
  const personalTime = merged.filter((entry) => entry.kind === "personalTime");

  const lines = [
    ...formatSection("Reserved", reserved, eventTimezone),
    ...formatSection("Favorites", favorites, eventTimezone),
  ];
  if (personalTime.length > 0) {
    lines.push(...formatSection("Personal time", personalTime, eventTimezone));
  }
  if (result.warning !== null) {
    lines.push(`Warning: ${result.warning}`);
  }
  for (const warning of timezoneWarningLines) {
    lines.push(`Warning: ${warning}`);
  }
  return lines.join("\n");
}

function formatFailureLine(
  failure: FavoriteSessionsResult["failed"][number],
  index: IndexRecord[] | null,
): string {
  const parts = [resolveSessionDisplay(failure.sessionId, index), failure.code];
  if (failure.conflictsWith !== undefined && failure.conflictsWith.length > 0) {
    const titles = failure.conflictsWith.map((c) => c.title ?? c.sessionId).join(", ");
    parts.push(`conflicts with: ${titles}`);
  }
  if (failure.reason !== undefined) {
    parts.push(`reason: ${failure.reason}`);
  }
  return `  ${parts.join(" -- ")}`;
}

/** `abbreviation -- title` when the local catalog index has a record for `sessionId`, or the bare
 * id unchanged when it doesn't (unsynced, or synced after the id was favorited) -- the same
 * fallback `schedule show`'s own session lines already use for an id the index has no record for.
 * Reviewer's finding: a `schedule favorite` run against a real shortlist (the README's own
 * `match --json | jq | schedule favorite -` pipe, thirty ids at once) printed thirty bare session
 * ids with nothing to tell them apart at a glance -- `failed`'s own `scheduleConflict` entries
 * already got resolved titles; a real success deserves the same. pr-reviewer-3's own follow-up
 * finding: `formatFailureLine` itself still printed the bare id as its own first part, regardless
 * of code -- this resolves that one too. */
function resolveSessionDisplay(sessionId: string, index: IndexRecord[] | null): string {
  const record = index?.find((candidate) => candidate.sessionId === sessionId);
  if (record === undefined) {
    return sessionId;
  }
  return `${record.abbreviation ?? record.sessionId} -- ${record.title}`;
}

function formatFavoriteResultHuman(result: FavoriteSessionsResult, index: IndexRecord[] | null): string {
  const lines: string[] = [];
  if (result.successful.length > 0) {
    lines.push("Favorited:");
    for (const sessionId of result.successful) {
      lines.push(`  ${resolveSessionDisplay(sessionId, index)}`);
    }
  } else {
    lines.push("Favorited: none.");
  }
  if (result.alreadyFavorited.length > 0) {
    lines.push("Already favorited:");
    for (const sessionId of result.alreadyFavorited) {
      lines.push(`  ${resolveSessionDisplay(sessionId, index)}`);
    }
  }
  if (result.uncertain?.length) lines.push(`Uncertain requests (not automatically retried): ${result.uncertain.join(", ")}. Read-back cannot establish causation.`);
  if (result.failed.length > 0) {
    lines.push("Refusals or failed requests (see uncertainty above):");
    for (const failure of result.failed) {
      lines.push(formatFailureLine(failure, index));
    }
  }
  if (result.aborted !== undefined) {
    // Lead's decision: the successes and refusals above are still real (see them printed above
    // this line already) -- this only explains why the run stopped early and the schedule was
    // never re-read to confirm them.
    lines.push(`Stopped early: ${result.aborted.message}`);
  } else if (result.verified === null) {
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

function formatReservationResult(result: ReserveSessionsResult): string {
  const lines = [
    `Reserved: ${result.successful.join(", ") || "none"}.`,
    `Already reserved: ${result.alreadyScheduled.join(", ") || "none"}.`,
    ...result.failed.map(failure => `Refused ${failure.sessionId}: ${failure.code}${failure.reason ? ` — ${failure.reason}` : ""}${failure.conflictsWith?.length ? `; conflicts with ${failure.conflictsWith.map(conflict => `${conflict.sessionId}${conflict.title ? ` (${conflict.title})` : ""}`).join(", ")}` : ""}`),
    `Uncertain (not automatically retried): ${result.uncertain.join(", ") || "none"}.`,
    `Not attempted: ${result.notAttempted.join(", ") || "none"}.`,
    result.verified ? `Observed reserved on read-back: ${result.verified.reserved.join(", ") || "none"}. This does not establish which request caused a reservation.` : `Verification unavailable: ${result.verificationError ?? "unknown"}.`,
  ];
  if (result.mismatch.length) lines.push(`Missing on read-back: ${result.mismatch.join(", ")}.`);
  if (result.aborted) lines.push(`Stopped: ${result.aborted.message}`);
  return lines.join("\n");
}
function formatPlan(result: SchedulePlan, timezone: string | null): string {
  return [
    result.conflictFree ? "Plan has no new time conflicts." : `Cannot prove a conflict-free plan: ${result.blockedBy.join(", ")}.`,
    ...result.selected.map(session => `${session.sessionId} — ${session.title} — ${formatEventLocalTime(session.startsAt, timezone)} to ${formatEventLocalTime(session.endsAt, timezone)}`),
    ...result.alreadyReserved.map(id => `${id}: already reserved`),
    ...result.alreadyReservedAlternative.map(value => `${value.requested}: not planned; the same talk is already reserved as ${value.reservedSessionId}`),
    ...result.rejected.map(rejection => `${rejection.sessionId}: ${rejection.reason}${rejection.conflictsWith?.length ? ` (${rejection.conflictsWith.join(", ")})` : ""}`),
    result.limitations,
  ].join("\n");
}

/** The event's timezone when the catalog knows it; `null` (shown as UTC) otherwise. */
function knownEventTimezone(storeRoot: string): string | null {
  const availability = readTimezoneAvailability({ storeRoot });
  return availability?.status === "known" ? availability.timezone : null;
}

/** Registers `schedule` and its `show`, `favorite` and `unfavorite` subcommands. */
export function registerScheduleCommands(program: Command, deps: ScheduleCommandDeps = {}): Command {
  const print = deps.print ?? ((message: string) => process.stdout.write(`${message}\n`));
  const resolveStoreRoot = deps.resolveStoreRoot ?? (() => ensureStoreRoot());
  const buildApiClient = deps.buildApiClient ?? defaultBuildApiClient;

  const schedule = program
    .command("schedule")
    .description("Read your event schedule and manage favorites.");

  schedule.command("onsite-config").description("Read or update local on-site preferences")
    .option("--event <event>", "Event ID", DEFAULT_EVENT_ID).option("--file <path>", "JSON preference patch")
    .option("--allow-walk-up <boolean>", "Global default: true or false").option("--json", "JSON output", false)
    .action((options: { event: string; file?: string; allowWalkUp?: string; json: boolean }) => {
      try {
        const storeRoot = (deps.resolveStoreRoot ?? resolveRootWithoutCreation)();
        const patch = options.file ? readPatchFile(options.file) : {};
        if (options.allowWalkUp !== undefined) patch.allowWalkUp = z.object({ allowWalkUp: z.enum(["true", "false"]) }).parse({ allowWalkUp: options.allowWalkUp }).allowWalkUp === "true";
        const config = options.file || options.allowWalkUp !== undefined ? updateOnsiteConfig(options.event, patch, { storeRoot }) : readOnsiteConfig({ storeRoot });
        print(JSON.stringify(effectiveOnsitePreferences(config, options.event), null, options.json ? undefined : 2));
      } catch (error) { reportCommandError(error, options.event, print, { anyError: true }); }
    });
  schedule.command("nearby").description("Suggest feasible nearby sessions after venue confirmation")
    .option("--event <event>", "Event ID", DEFAULT_EVENT_ID).option("--venue <venue>", "Current venue")
    .option("--source <source>", "user, location, or schedule", "user").option("--confirm-venue", "Confirm this venue for this call", false)
    .option("--skip-session <ids...>", "Ignore these reserved commitments for this calculation only")
    .option("--within <minutes>", "Start horizon (1–240)", "60").option("--limit <count>", "Maximum results (1–20)", "10").option("--json", "JSON output", false)
    .action(async (options: { event: string; venue?: string; source: string; confirmVenue: boolean; skipSession?: string[]; within: string; limit: string; json: boolean }) => {
      try {
        const input = nearbyInputSchema.parse({ eventId: options.event, ...(options.venue ? { location: { venue: options.venue, source: options.source, confirmed: options.confirmVenue } } : {}), ...(options.skipSession ? { skipSessionIds: options.skipSession } : {}), withinMinutes: Number(options.within), limit: Number(options.limit) });
        const storeRoot = resolveStoreRoot();
        const result = await recommendNearbySessions(input, { storeRoot, apiClient: buildApiClient(storeRoot), ...(deps.now ? { now: deps.now } : {}) });
        if (options.json) print(JSON.stringify(result));
        else {
          const timezone = knownEventTimezone(storeRoot);
          for (const item of result.candidates) print(`${item.sessionId} ${item.title} — ${item.venue}, starts ${formatEventLocalTime(item.startsAt, timezone)} (in ${Math.floor(item.minutesToStart)} min)\n  ${item.outbound.mode}: ${item.outbound.totalMinutes} min + ${item.outbound.checkInMinutes} min check-in (${item.outbound.provenance}); ${item.admission} Band ${item.availability}, ${item.availabilitySource}, age ${item.ageMinutes === null ? "unknown" : `${item.ageMinutes.toFixed(1)} min`}.${item.onward ? ` Onward ${item.onward.totalMinutes} min + ${item.onward.checkInMinutes} min check-in to ${item.nextCommitmentId}.` : ""}`);
          for (const rejection of result.rejected) print(`Excluded ${rejection.count}: ${rejection.reason}`);
          for (const warning of result.warnings) print(warning);
          if (!result.candidates.length) print("No feasible candidates with the current confirmation, travel and admission settings.");
          print(`${result.limitations} Refreshed ${result.coverage.refreshed}/${result.coverage.eligible}; omitted ${result.coverage.omitted}.`);
        }
      } catch (error) { reportCommandError(error, options.event, print); }
    });

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
        if (options.json) {
          print(JSON.stringify(result));
        } else {
          // Same source `get_schedule` itself reads from -- never falls back to the host
          // machine's own timezone or a hardcoded one.
          const timezoneAvailability = readTimezoneAvailability({ storeRoot });
          const eventTimezone =
            timezoneAvailability?.status === "known" ? timezoneAvailability.timezone : null;
          print(formatScheduleHuman(result, eventTimezone, timezoneWarnings(timezoneAvailability)));
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

        print(
          options.json
            ? JSON.stringify(result)
            : formatFavoriteResultHuman(result, readIndex({ storeRoot })),
        );
        if (result.failed.length > 0 || result.uncertain?.length) {
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
        const outcome = await unfavoriteSession(id, { apiClient, storeRoot, eventId: options.event });
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

  for (const command of ["plan", "reserve"] as const) {
    schedule.command(command).description(command === "plan" ? "Suggest a time-conflict-free schedule without writing." : "Reserve confirmed session IDs; never automatically replace a reservation.")
      .argument("<ids...>", "session IDs, or - for newline-delimited stdin")
      .option("--event <id>", "event ID", DEFAULT_EVENT_ID).option("--json", "machine-readable output")
      .action(async (ids: string[], options: FavoriteCommandOptions) => {
        try {
          const input = validateSessionIds(await resolveIds(ids), command === "plan", command === "reserve");
          const storeRoot = resolveStoreRoot(); const apiClient = buildApiClient(storeRoot);
          const domainDeps = { storeRoot, apiClient, eventId: options.event, ...(deps.now ? { now: deps.now } : {}) };
          if (command === "plan") {
            const result = await planSchedule(input, domainDeps);
            print(options.json ? JSON.stringify(result) : formatPlan(result, knownEventTimezone(storeRoot)));
            if (!result.conflictFree) process.exitCode = 1;
          } else {
            const result = await reserveSessions(input, domainDeps);
            print(options.json ? JSON.stringify(result) : formatReservationResult(result));
            if (reservationNeedsAttention(result)) process.exitCode = 1;
          }
        } catch (error) { print(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
      });
  }
  schedule.command("cancel").description("Cancel one explicitly chosen reservation.")
    .argument("<id>", "session ID").option("--event <id>", "event ID", DEFAULT_EVENT_ID).option("--json", "machine-readable output")
    .action(async (id: string, options: FavoriteCommandOptions) => {
      try {
        validateSessionIds([id]);
        const storeRoot = resolveStoreRoot();
        const result = await cancelReservation(id, { storeRoot, apiClient: buildApiClient(storeRoot), eventId: options.event });
        print(options.json ? JSON.stringify(result) : `${id}: ${result.outcome}; verified absent: ${result.verifiedAbsent ?? "unknown"}.${result.error ? ` ${result.error}` : ""}${result.verificationError ? ` ${result.verificationError}` : ""}`);
        if (cancellationNeedsAttention(result)) process.exitCode = 1;
      } catch (error) { print(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    });

  return schedule;
}
