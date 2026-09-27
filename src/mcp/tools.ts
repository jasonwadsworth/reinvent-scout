import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createApiClient, type ApiClient } from "../api/client.js";
import type { PersonalTime } from "../api/types.js";
import { createTokenProviderAdapter } from "../auth/provider-adapter.js";
import { readTokenStore } from "../auth/token-store.js";
import { toPublicIndexRecord } from "../catalog/index-record.js";
import { catalogServiceNames } from "../catalog/query.js";
import { buildServiceAliasIndex } from "../catalog/service-aliases.js";
import {
  getCatalogState,
  readTimezoneAvailability,
  type CatalogState,
  type TimezoneAvailability,
} from "../catalog/store.js";
import { syncCatalog } from "../catalog/sync.js";
import { formatZodError } from "../cli/zod-errors.js";
import {
  AuthRequiredError,
  CatalogMissingError,
  CatalogUnusableError,
  NotRegisteredError,
  ValidationError,
} from "../core/errors.js";
import { matchSessions } from "../match/match.js";
import type { Lens } from "../match/lens.js";
import { resolveProfile } from "../profile/profile.js";
import { favoriteSessions, unfavoriteSession } from "../schedule/favorites.js";
import { getSchedule, type ScheduleSession } from "../schedule/schedule.js";
import { addMinutesToIso, zonedWallClockToUtcIso } from "../schedule/timezone.js";

function defaultBuildApiClient(storeRoot: string): ApiClient {
  return createApiClient({ getAccessToken: createTokenProviderAdapter({ storeRoot }) });
}

/** Every core module this server calls through takes its store root, clock and API client by
 * injection, matching the CLI layer's own convention -- never read from `process.env`,
 * `Date.now` or build a real `ApiClient` directly inside a tool handler, so tests never touch the
 * real home directory or the network. */
export interface McpToolDeps {
  resolveStoreRoot: () => string;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to building a real `ApiClient` over the real token provider and the global
   * `fetch`. Inject a fake in tests so nothing touches the network. */
  buildApiClient?: (storeRoot: string) => ApiClient;
}

type ToolTextResult = { content: [{ type: "text"; text: string }]; isError?: true };

function textResult(value: unknown): ToolTextResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(message: string): ToolTextResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Amendment 3 (lead review): the skill runs in a shell, so the agent can run `auth login` itself
 * rather than telling a human to go to a terminal -- this exact instruction is asserted again by
 * `tests/skill/content.test.ts` (task 7), and the two must agree.
 */
export const NO_SESSION_MESSAGE =
  "No signed-in session found. Run `reinvent-scout auth login` (the skill can run it for you), " +
  "then try again.";

/**
 * Maps a thrown error to a tool's `isError` result with a message a caller can act on --
 * `CatalogMissingError` (needs `catalog_sync` and a signed-in session) and `CatalogUnusableError`
 * (needs a local rebuild, i.e. `catalog_sync --reindex`) are kept textually distinguishable
 * rather than collapsed into one generic "catalog problem" message, so a tool built on top of
 * this (task 5's `catalog_sync`/`match_sessions`, task 6's `get_schedule`) can tell an agent what
 * to actually do next instead of just that something failed. Every other error's own message is
 * used as-is -- the API client's own taxonomy already guarantees no token or secret ever reaches
 * an error message (see api/client.test.ts).
 */
export function toToolError(err: unknown): ToolTextResult {
  if (err instanceof z.ZodError) {
    return errorResult(formatZodError(err));
  }
  if (err instanceof CatalogMissingError) {
    return errorResult(`${err.message} (needs catalog_sync and a signed-in session.)`);
  }
  if (err instanceof CatalogUnusableError) {
    return errorResult(`${err.message} (needs a local rebuild: catalog_sync.)`);
  }
  if (err instanceof AuthRequiredError) {
    return errorResult(NO_SESSION_MESSAGE);
  }
  if (err instanceof NotRegisteredError) {
    return errorResult(err.message);
  }
  if (err instanceof ValidationError) {
    return errorResult(err.message);
  }
  return errorResult(err instanceof Error ? err.message : String(err));
}

/** Writes one diagnostic line to stderr -- never stdout, never `console.*` (forbidden by lint in
 * this module and the server entry file; see eslint.config.js). Purely informational: nothing
 * here is a protocol message, and a caller of a tool never sees it. */
function logWarning(message: string): void {
  process.stderr.write(`[reinvent-scout mcp] ${message}\n`);
}

function summarizeCatalogState(state: CatalogState): Record<string, unknown> {
  if (state.status === "missing") {
    logWarning("no catalog has been synced yet");
    return { status: "missing" };
  }
  if (state.status === "stale") {
    logWarning(`catalog is stale (${state.reason})`);
    return state.reason === "corrupt"
      ? { status: "stale", reason: state.reason }
      : { status: "stale", reason: state.reason, syncedAt: state.meta.syncedAt };
  }
  return { status: "fresh", syncedAt: state.meta.syncedAt, count: state.meta.count };
}

function registerStatusTool(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    "status",
    {
      description:
        "Report whether a session is signed in and the local catalog's state. Call this first.",
      inputSchema: z.strictObject({}),
    },
    async () => {
      const storeRoot = deps.resolveStoreRoot();
      const tokenState = readTokenStore({ storeRoot });

      if (tokenState.status === "absent" || tokenState.status === "corrupt") {
        return errorResult(NO_SESSION_MESSAGE);
      }

      const now = deps.now ?? Date.now;
      const expiresAt = tokenState.tokens.obtainedAt + tokenState.tokens.expiresIn * 1000;
      const catalogState = getCatalogState({ storeRoot, now });

      return textResult({
        signedIn: true,
        accessTokenExpiresAt: new Date(expiresAt).toISOString(),
        catalog: summarizeCatalogState(catalogState),
      });
    },
  );
}

const CatalogSyncInputSchema = z.strictObject({
  event: z.string().min(1).optional(),
  includeAbstracts: z.boolean().optional(),
  reindex: z.boolean().optional(),
});

function registerCatalogSyncTool(server: McpServer, deps: McpToolDeps): void {
  const buildApiClient = deps.buildApiClient ?? defaultBuildApiClient;

  server.registerTool(
    "catalog_sync",
    {
      description:
        "Pull the session catalog and build the local search index. Returns counts only -- " +
        "never any session data, which stays local. Call when status reports the catalog " +
        "missing or stale.",
      inputSchema: CatalogSyncInputSchema,
    },
    async ({ event, includeAbstracts, reindex }) => {
      const storeRoot = deps.resolveStoreRoot();
      const apiClient = buildApiClient(storeRoot);

      try {
        const result = await syncCatalog({
          apiClient,
          storeRoot,
          ...(event === undefined ? {} : { eventId: event }),
          ...(includeAbstracts === undefined ? {} : { includeAbstracts }),
          ...(reindex === undefined ? {} : { reindex }),
          ...(deps.now === undefined ? {} : { now: deps.now }),
        });
        return textResult(result);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

const ValidateProfileInputSchema = z.strictObject({
  profile: z.unknown(),
});

/** Shared by `validate_profile` and `match_sessions`: builds the service alias index the current
 * catalog supports and resolves a raw, agent-authored profile against it. Throws
 * `CatalogMissingError`/`CatalogUnusableError` (from `catalogServiceNames`) or `z.ZodError` (from
 * `resolveProfile`'s own schema) -- both handled by `toToolError` at each call site. */
function resolveProfileAgainstCatalog(rawProfile: unknown, storeRoot: string) {
  const serviceNames = catalogServiceNames({ storeRoot });
  const serviceAliasIndex = buildServiceAliasIndex(serviceNames);
  return resolveProfile(rawProfile, serviceAliasIndex);
}

function registerValidateProfileTool(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    "validate_profile",
    {
      description:
        "Validate an agent-authored tech profile and resolve its service names against the " +
        "local catalog. Returns the resolved profile plus any service names that did not " +
        "resolve to a catalog session.",
      inputSchema: ValidateProfileInputSchema,
    },
    async ({ profile }) => {
      const storeRoot = deps.resolveStoreRoot();
      try {
        const resolved = resolveProfileAgainstCatalog(profile, storeRoot);
        return textResult(resolved);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

/** Mirrors the CLI's own `match` default/cap (30/100) at a smaller size deliberately -- an agent
 * asking for candidates should get a genuinely useful set, and every response (at any limit, for
 * any profile) is held to a real 30 KB budget by `buildMatchResponse` below, not by these numbers
 * alone.
 *
 * History, since the final design only makes sense in light of what didn't work first (measured
 * against the real 2,043-session catalog throughout -- the 61-session fixture cannot produce a
 * response big enough to expose any of this): shape-trimming alone (dropping fields `offerings`
 * already duplicates, then `type` and `services` too) got a five-service profile's default-limit
 * response under budget, but the reviewer's follow-up measurement, varying the *profile* rather
 * than the limit, found an eight-service profile -- not an exotic one, an ordinary serverless app
 * easily names Lambda, DynamoDB, S3, SQS, EventBridge, API Gateway, Step Functions and CloudWatch
 * -- already breaches 30 KB at the *default* limit of 25, because each matched service adds its
 * own "service" reason to every candidate. No shape trim and no limit number can fix that: size
 * scales with the profile's richness as much as the candidate count, so the guarantee has to be
 * enforced on the actual serialized response, not assumed from a specific limit or a specific
 * profile. `buildMatchResponse` does that -- see its own comment -- which is also what let `type`
 * come back: a caller that cannot tell a Workshop from a Chalk talk is missing something real for
 * a tool whose whole job is helping choose sessions, and truncation now pays for that in one fewer
 * candidate when space is actually tight, rather than the shape never carrying it at all. */
const DEFAULT_MATCH_SESSIONS_LIMIT = 25;
const MAX_MATCH_SESSIONS_LIMIT = 50;

const MatchSessionsInputSchema = z.strictObject({
  profile: z.unknown(),
  lens: z.enum(["all", "explain"]).optional(),
  /** Silently capped at `MAX_MATCH_SESSIONS_LIMIT`, never rejected -- unlike the CLI's own
   * `--limit`, which refuses a too-large value outright. An agent asking for "a lot" of
   * candidates should get the largest sensible set rather than a validation error it has to
   * retry past. */
  limit: z.number().int().positive().optional(),
});

/** The MCP-facing candidate shape, deliberately leaner than the CLI's own (which reuses the full
 * `toPublicIndexRecord` -- reasonable for a human terminal, too heavy for metered agent context
 * held to a real 30 KB response budget; see the size note above `DEFAULT_MATCH_SESSIONS_LIMIT`).
 * Keeps only what a caller needs to identify, explain and schedule a candidate: `code`/`sessionId`
 * to reference it (e.g. for `favorite_sessions`), `title`/`type`/`levelBand` to describe it,
 * `score`/`reasons` for why it matched, and `offerings` for when and where.
 *
 * `type` was dropped in an earlier revision to fit the size budget by shape-trimming alone, then
 * restored once the budget was enforced on the response instead (see `buildMatchResponse`): a
 * caller that cannot tell a Workshop from a Chalk talk is missing something real for a tool whose
 * whole job is helping choose sessions, and the response-level truncation now pays for it in one
 * fewer candidate when space is actually tight, rather than never having it at all. `services` is
 * not restored alongside it -- it stays redundant with what `reasons` already names explicitly,
 * unlike `type`, which `reasons` says nothing about at all under the `all` lens. */
function toLeanCandidate(candidate: ReturnType<typeof matchSessions>[number]): Record<string, unknown> {
  const record = toPublicIndexRecord(candidate.record);
  return {
    code: candidate.code,
    sessionId: record.sessionId,
    title: record.title,
    type: record.type,
    levelBand: record.levelBand,
    score: candidate.score,
    reasons: candidate.reasons,
    offerings: candidate.offerings,
  };
}

/**
 * Lead decision, following the size finding above: the 30 KB response budget is a hard guarantee
 * at every limit, including the cap -- a profile naming many services (each producing its own
 * "service" reason) can make even a modest candidate count exceed it, not just a large `limit`.
 * Enforced mechanically here rather than by trimming `toLeanCandidate`'s shape further, so
 * `reasons` and `offerings` -- the actual explainability -- stay intact on every candidate that
 * *is* included; a candidate is either whole or left out entirely, never partially serialized to
 * make room.
 */
const RESPONSE_BYTE_BUDGET = 30 * 1024;

/** Lead's decision, replacing an earlier hint ("ask again with a smaller limit..."): a smaller
 * `limit` cannot reach the omitted candidates at all -- there is no `offset` on `match_sessions`,
 * so asking for fewer just returns fewer of the exact same top-ranked set. Names the real count
 * instead, and only suggests what can actually change which candidates rank highest. */
function truncationHint(omitted: number): string {
  return (
    `${omitted} lower-ranked candidates were omitted to fit the response budget. ` +
    "A narrower lens or a more specific profile changes what ranks highest."
  );
}

/** Mirrors `textResult`'s own envelope shape exactly, so the byte count measured here is the same
 * one a caller (and tests/mcp/tools-catalog.test.ts's size assertions) actually measures on the
 * real `CallToolResult` -- not just the inner JSON text, which undercounts the protocol wrapper. */
function envelopeBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(textResult(value)), "utf8");
}

interface MatchSessionsResponse {
  candidates: Record<string, unknown>[];
  truncated: boolean;
  returned: number;
  requested: number;
  /** How many of `matchSessions`' own ranked candidates (already capped at `requested`, so this
   * is never inflated by asking for more than the catalog actually has) were left out purely for
   * size -- `0` whenever `truncated` is `false`. Deliberately not `requested - returned`: when the
   * catalog simply has fewer matches than `requested`, that gap is not an omission, and reporting
   * it as one would tell a caller candidates were dropped for size when none were. */
  omitted: number;
  hint?: string;
}

/** Builds one candidate-count's worth of response. Kept as the one place that decides the shape
 * for a given `candidates`/`truncated` pair, so both call sites below (the initial
 * everything-fits attempt, and every trial inside the truncation loop) measure the exact same
 * shape the caller will actually receive -- never an approximation of it. */
function buildResponse(
  candidates: Record<string, unknown>[],
  requested: number,
  totalMatched: number,
  truncated: boolean,
): MatchSessionsResponse {
  const omitted = totalMatched - candidates.length;
  return {
    candidates,
    truncated,
    returned: candidates.length,
    requested,
    omitted,
    ...(truncated ? { hint: truncationHint(omitted) } : {}),
  };
}

function buildMatchResponse(
  leanCandidates: Record<string, unknown>[],
  requested: number,
): MatchSessionsResponse {
  const totalMatched = leanCandidates.length;
  const everything = buildResponse(leanCandidates, requested, totalMatched, false);
  if (envelopeBytes(everything) <= RESPONSE_BYTE_BUDGET) {
    return everything;
  }

  // Not everything fits -- greedily include candidates in ranked order (the same order
  // matchSessions already ranked them in; never reordered or re-scored here), each checked as a
  // whole prospective response against the budget (using the same truncated:true/hint shape the
  // final response will have, so the check is honest about the overhead that shape itself costs),
  // stopping before the first one that would push the response over. A candidate is either whole
  // or left out entirely -- never partially serialized to make room.
  const included: Record<string, unknown>[] = [];
  for (const candidate of leanCandidates) {
    const trial = buildResponse([...included, candidate], requested, totalMatched, true);
    if (envelopeBytes(trial) > RESPONSE_BYTE_BUDGET) {
      break;
    }
    included.push(candidate);
  }

  return buildResponse(included, requested, totalMatched, true);
}

function registerMatchSessionsTool(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    "match_sessions",
    {
      description:
        "Rank the local catalog against a resolved tech profile and return the top candidates, " +
        "each with its score, reasons and every scheduled offering. Never includes abstracts. " +
        "A response that would exceed the size budget is truncated (see the truncated/returned/" +
        "requested/hint fields) rather than ever partially serializing a candidate.",
      inputSchema: MatchSessionsInputSchema,
    },
    async ({ profile, lens, limit }) => {
      const storeRoot = deps.resolveStoreRoot();
      try {
        const resolved = resolveProfileAgainstCatalog(profile, storeRoot);
        const cappedLimit = Math.min(limit ?? DEFAULT_MATCH_SESSIONS_LIMIT, MAX_MATCH_SESSIONS_LIMIT);
        const candidates = matchSessions(resolved, { storeRoot }, {
          ...(lens === undefined ? {} : { lens: lens as Lens }),
          limit: cappedLimit,
        });
        const response = buildMatchResponse(candidates.map(toLeanCandidate), cappedLimit);
        return textResult(response);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

/**
 * Lead decision, following the reviewer's finding: `get_schedule` had no size budget at all, and
 * measured over 30 KB at a hundred favorites against the real catalog -- not a stress case, since
 * `favorite_sessions` accepts fifty per call (two ordinary calls reach it) and attendees also
 * favorite sessions through the re:Invent web UI, outside this tool's control entirely. Unlike
 * `match_sessions`' ranked candidates, an attendee's own schedule has no "least relevant" entry to
 * drop silently -- an agent that never sees a real commitment could tell the user the wrong plan
 * -- so nothing may become permanently unreachable: `limit`/`offset` page through every entry
 * (default 50, cap 60 -- the reviewer's own measurement: adding `kind` and the pagination
 * metadata to each entry means a full page of 100 already exceeds the budget before accounting
 * for anything unusually long, so the cap must leave real headroom, not just clear the budget on
 * paper. 75 turned out not to: `startsAt`/`endsAt` add roughly 58 bytes per entry, leaving only
 * ~330 bytes of headroom at a full page of 75 realistic-length entries, and a second page (offset
 * 75) was already measured being budget-shortened to 74 -- the shortening path was silently the
 * common case, not the exception it's meant to be. 60 restores real headroom -- silently
 * clamped like `match_sessions`' own `limit` rather than rejected), and the response is *also*
 * enforced at the byte budget the same way `match_sessions` is, so a page of unusually long
 * entries still can't exceed it -- when it would, the page itself is shortened and `nextOffset`
 * reflects what was actually returned (`offset + returned`), present exactly when
 * `offset + returned < total` and never derived from `returned < limit` (which the reviewer
 * pointed out is `true` on every page at the cap, not just the last one) -- so the next call
 * picks up from exactly where this one left off rather than skipping entries. The CLI's `schedule
 * show` is deliberately left unpaginated -- human terminal output, not agent context, has no such
 * budget.
 */
const DEFAULT_GET_SCHEDULE_LIMIT = 50;
const MAX_GET_SCHEDULE_LIMIT = 60;

const GetScheduleInputSchema = z.strictObject({
  event: z.string().min(1).optional(),
  /** Silently capped at `MAX_GET_SCHEDULE_LIMIT`, never rejected -- see `MatchSessionsInputSchema`'s
   * own `limit` for the same reasoning. */
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});

type ScheduleEntryKind = "reserved" | "favorite" | "personalTime";

interface MergedScheduleEntry {
  kind: ScheduleEntryKind;
  /** A real UTC instant (ISO-8601, `Z`-suffixed), directly comparable across every entry
   * regardless of kind -- the primary sort key. `null` when it cannot be computed: for a session,
   * either because the event's own timezone is unknown (`eventTimezone` was `null`) or because
   * the session itself has no fully-resolved date and time. Personal time always has a real
   * `startsAt`, since its own `startDateTime` is UTC and required -- never `null`, unlike a
   * session's. */
  startsAt: string | null;
  /** `null` for an unscheduled or unresolved entry, which sorts last -- personal time is never in
   * this state, since `startDateTime` is a required field on it. Used only as a fallback level
   * below `startsAt`, for ordering entries that share a `null` startsAt (which, per the above,
   * only ever happens among sessions) against each other by their own raw local date/time, since
   * `startsAt` alone gives them no ordering information at all. */
  sortDate: string | null;
  /** `null` both for an unresolved entry (no time fields at all) and a resolved one whose own
   * `startTime` is itself `null` (the index record's field is nullable independently of
   * `startDate` -- see index-record.ts) -- both mean "no known time", not "sorts before every
   * known time", which is what a bare `a ?? ""` or a naive `<` comparison against `null` would
   * silently produce instead (see `compareNullableLast`). */
  sortTime: string | null;
  /** `sessionId` for a reserved/favorite entry, `personalTimeId` for personal time -- always
   * present and, within one call's own merged list, unique, which is what makes the final sort
   * level below a genuine total order rather than a partial one. */
  tiebreaker: string;
  data: Record<string, unknown>;
}

/** Derives a resolved session's `startsAt`/`endsAt` from its local `startDate`/`startTime` (and
 * `lengthMinutes`, for `endsAt`) via a real IANA conversion in `eventTimezone` -- `null` for
 * either when `eventTimezone` itself is unknown, the session isn't fully scheduled, or (for
 * `endsAt` only) its length isn't known. Never falls back to the host machine's timezone or a
 * hardcoded offset: when `eventTimezone` is `null`, this returns `{ startsAt: null, endsAt: null }`
 * outright rather than guessing. */
function deriveSessionTimes(
  session: ScheduleSession,
  eventTimezone: string | null,
): { startsAt: string | null; endsAt: string | null } {
  if (eventTimezone === null || !session.resolved || session.startDate === null || session.startTime === null) {
    return { startsAt: null, endsAt: null };
  }
  const startsAt = zonedWallClockToUtcIso(session.startDate, session.startTime, eventTimezone);
  const endsAt = session.lengthMinutes === null ? null : addMinutesToIso(startsAt, session.lengthMinutes);
  return { startsAt, endsAt };
}

function toMergedSessionEntries(
  sessions: ScheduleSession[],
  kind: "reserved" | "favorite",
  eventTimezone: string | null,
): MergedScheduleEntry[] {
  return sessions.map((session) => {
    const { startsAt, endsAt } = deriveSessionTimes(session, eventTimezone);
    return {
      kind,
      startsAt,
      sortDate: session.resolved ? session.startDate : null,
      sortTime: session.resolved ? session.startTime : null,
      tiebreaker: session.sessionId,
      data: { kind, ...session, startsAt, endsAt },
    };
  });
}

function toMergedPersonalTimeEntries(personalTime: PersonalTime[]): MergedScheduleEntry[] {
  return personalTime.map((entry) => {
    // "YYYY-MM-DDTHH:MM:SS" -- splitting on the literal separator this field's own format
    // guarantees, not parsing it as a Date, matches how index-record.ts and the rest of this
    // codebase avoid ever assuming a timezone the API doesn't actually provide. The field is
    // already UTC (per its own doc comment in api/types.ts), so startsAt/endsAt need only the
    // literal `Z` suffix appended, no conversion.
    const [date, time] = entry.startDateTime.split("T");
    const startsAt = `${entry.startDateTime}Z`;
    const endsAt = `${entry.endDateTime}Z`;
    return {
      kind: "personalTime" satisfies ScheduleEntryKind,
      startsAt,
      sortDate: date ?? null,
      sortTime: time ?? null,
      tiebreaker: entry.personalTimeId,
      data: { kind: "personalTime" satisfies ScheduleEntryKind, ...entry, startsAt, endsAt },
    };
  });
}

/** Any real string sorts before `null` at this level -- used for both the date and time
 * comparisons below, since an entry with no known date (unresolved, or the API never scheduled
 * it) or a resolved entry with a date but a genuinely unknown time must both fall after anything
 * with a known value at that level, not before it. Reviewer's specific finding: `a ?? ""` (which
 * the first version of this comparator used for the time level) or a bare `<` on a possibly-null
 * value both get this backwards or return `false` in both directions, leaving those entries in
 * whatever order the input happened to have instead of genuinely last. */
function compareNullableLast(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a.localeCompare(b);
}

/**
 * A genuine total order -- `startsAt` (a real UTC instant, directly comparable across kinds),
 * then the raw local date and time as a fallback for entries sharing a `null` startsAt (both via
 * `compareNullableLast`, so "no known date" and "a date but no known time" both sort last at
 * their own level rather than being confused with each other), then `kind`, then `tiebreaker` --
 * so two entries are never merely "tied" the way a comparator stopping at date+time would leave
 * them. That matters specifically because `get_schedule` re-reads the schedule from the API on
 * every call: `Array.prototype.sort` is stable, so same-time entries would otherwise keep
 * whatever order the API happened to return them in on that particular call, and paging (which
 * spans multiple independent calls) would see pages that overlap or skip an entry entirely if
 * that order ever changed between calls. With a full total order, the merged list's order depends
 * only on the data, never on input order or call-to-call API variation -- reviewer's finding,
 * verified by a test where the fake API deliberately reorders `favorites` between two calls and
 * paging still produces the complete, non-overlapping, correctly-ordered result regardless.
 *
 * `startsAt` before the raw date/time fallback is what makes a personal-time block (always a real
 * UTC instant) sort correctly against a session near a day boundary even when the session's own
 * local date, read as a bare string, would suggest the opposite order -- see the reviewer's
 * Pacific-evening-session-vs-UTC-personal-time test. The fallback level only ever compares
 * entries that both have a `null` startsAt, which (per `deriveSessionTimes`) only happens among
 * sessions, so it can never wrongly reorder a session relative to personal time; it exists purely
 * to keep same-day sessions sensibly ordered against each other when the event's timezone (or an
 * individual session's own time) is unknown.
 */
function compareMergedEntries(a: MergedScheduleEntry, b: MergedScheduleEntry): number {
  const byStartsAt = compareNullableLast(a.startsAt, b.startsAt);
  if (byStartsAt !== 0) {
    return byStartsAt;
  }
  const byDate = compareNullableLast(a.sortDate, b.sortDate);
  if (byDate !== 0) {
    return byDate;
  }
  const byTime = compareNullableLast(a.sortTime, b.sortTime);
  if (byTime !== 0) {
    return byTime;
  }
  if (a.kind !== b.kind) {
    return a.kind.localeCompare(b.kind);
  }
  return a.tiebreaker.localeCompare(b.tiebreaker);
}

interface GetScheduleResponse {
  entries: Record<string, unknown>[];
  total: number;
  totals: { reserved: number; favorites: number; personalTime: number };
  returned: number;
  offset: number;
  nextOffset?: number;
  warning?: string;
  /** Distinct from `warning` (which is specifically about no local catalog being synced at all):
   * caveats about the entries actually returned, such as the event's timezone being unknown --
   * present only when there's at least one. */
  warnings?: string[];
}

function buildScheduleResponseBody(
  entries: Record<string, unknown>[],
  offset: number,
  total: number,
  totals: GetScheduleResponse["totals"],
  warning: string | null,
  warnings: string[],
): GetScheduleResponse {
  const nextOffset = offset + entries.length;
  return {
    entries,
    total,
    totals,
    returned: entries.length,
    offset,
    ...(nextOffset < total ? { nextOffset } : {}),
    ...(warning === null ? {} : { warning }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/** Enforces the byte budget on top of the already-windowed page: a page fitting the requested
 * `limit` can still exceed the budget if its entries are unusually long (long titles, rooms,
 * personal-time descriptions), so this checks the whole prospective response, in order, exactly
 * like `buildMatchResponse` does for candidates -- an entry is either whole or left out, never
 * partially serialized. Shortening here (rather than at the `.slice()` call site) is what keeps
 * `nextOffset` honest: it always reflects what was actually returned. */
function buildScheduleResponse(
  windowed: Record<string, unknown>[],
  offset: number,
  total: number,
  totals: GetScheduleResponse["totals"],
  warning: string | null,
  warnings: string[],
): GetScheduleResponse {
  const everything = buildScheduleResponseBody(windowed, offset, total, totals, warning, warnings);
  if (envelopeBytes(everything) <= RESPONSE_BYTE_BUDGET) {
    return everything;
  }

  const included: Record<string, unknown>[] = [];
  for (const entry of windowed) {
    const trial = buildScheduleResponseBody([...included, entry], offset, total, totals, warning, warnings);
    if (envelopeBytes(trial) > RESPONSE_BYTE_BUDGET) {
      break;
    }
    included.push(entry);
  }
  return buildScheduleResponseBody(included, offset, total, totals, warning, warnings);
}

/** The `startsAt`/`endsAt`-relevant `warnings` entries for the event's timezone availability --
 * `[]` when it's known, or when nothing has ever been synced at all (`schedule.warning` already
 * covers that case with its own remedy). The two `"unavailable"` reasons need genuinely different
 * advice, not one generic message for both: a pre-bump catalog (no `timezone` key at all, since
 * it predates the schema-5 field -- `GetEvent` was never even called) is fixed by one more
 * `catalog_sync`, while an explicit `null` (`GetEvent`'s response genuinely omitted it) cannot be
 * fixed by syncing again at all -- telling an agent the unfixable story in both cases would make
 * it tell the user nothing can be done when a sync would actually solve it. */
function timezoneWarnings(availability: TimezoneAvailability | null): string[] {
  if (availability === null || availability.status === "known") {
    return [];
  }
  if (availability.status === "unrecognized") {
    // sync.ts stores whatever GetEvent returns verbatim, with no validation on write, so this can
    // genuinely happen if the API ever reports something Node's bundled ICU data doesn't
    // recognize -- OR if the stored metadata was corrupted or hand-edited, which a re-sync WOULD
    // fix. This reader can't tell those two apart (the sync path doesn't validate on write, by
    // design, so meta.json stays a faithful record of whatever the API actually said), so the
    // wording must not promise a re-sync will help: in the genuine-API-value case it demonstrably
    // will not, since catalog_sync would just store the same unrecognized value again. Names the
    // actual stored value (JSON.stringify handles every JSON-safe type, not just strings) so a
    // caller can judge for themselves which situation this looks like.
    return [
      `The stored event timezone (${JSON.stringify(availability.value)}) is not a recognized ` +
        "IANA timezone, so session start times could not be converted to a common startsAt -- " +
        "session and personal-time ordering across kinds is unreliable. Re-syncing " +
        "(`catalog_sync`, or `reinvent-scout catalog sync`) may resolve this, but is not " +
        "guaranteed to: if the API reports the same value again, syncing again will not help.",
    ];
  }
  if (availability.reason === "syncedBeforeTimezoneSupport") {
    return [
      "This catalog was synced before timezone support was added, so session start times " +
        "could not be converted to a common startsAt -- session and personal-time ordering " +
        "across kinds is unreliable. Run `catalog_sync` (or `reinvent-scout catalog sync`) to " +
        "fetch the event's timezone; it will very likely resolve this.",
    ];
  }
  return [
    "The event's timezone is unknown (GetEvent's response omitted it), so session start times " +
      "could not be converted to a common startsAt -- session and personal-time ordering across " +
      "kinds is unreliable. Sessions still sort correctly relative to each other by their local " +
      "date and time.",
  ];
}

function registerGetScheduleTool(server: McpServer, deps: McpToolDeps): void {
  const buildApiClient = deps.buildApiClient ?? defaultBuildApiClient;

  server.registerTool(
    "get_schedule",
    {
      description:
        "Read the attendee's schedule -- reserved sessions, favorites and personal time, merged " +
        "into one list sorted by start time (unscheduled last) and paginated with limit/offset " +
        "(default 50, cap 60) so a large schedule never exceeds the response size budget. Each " +
        "entry carries a common startsAt/endsAt (a real UTC instant) alongside its raw kind-" +
        "specific fields; startsAt is null when the event's timezone is unknown or the session " +
        "itself isn't fully scheduled -- see warnings when that happens. Page through with the " +
        "returned nextOffset until it's absent.",
      inputSchema: GetScheduleInputSchema,
    },
    async ({ event, limit, offset }) => {
      const storeRoot = deps.resolveStoreRoot();
      const apiClient = buildApiClient(storeRoot);
      try {
        const schedule = await getSchedule({
          apiClient,
          storeRoot,
          ...(event === undefined ? {} : { eventId: event }),
        });

        // Distinguishes a catalog that genuinely has no known timezone (`GetEvent` omitted it)
        // from one that simply predates timezone support entirely (no `timezone` key on disk at
        // all) -- see `timezoneWarnings`. Never falls back to the host machine's timezone or a
        // hardcoded zone in either case.
        const timezoneAvailability = readTimezoneAvailability({ storeRoot });
        const eventTimezone =
          timezoneAvailability?.status === "known" ? timezoneAvailability.timezone : null;

        const merged = [
          ...toMergedSessionEntries(schedule.reserved, "reserved", eventTimezone),
          ...toMergedSessionEntries(schedule.favorites, "favorite", eventTimezone),
          ...toMergedPersonalTimeEntries(schedule.personalTime),
        ].sort(compareMergedEntries);

        const totals: GetScheduleResponse["totals"] = {
          reserved: schedule.reserved.length,
          favorites: schedule.favorites.length,
          personalTime: schedule.personalTime.length,
        };
        const total = merged.length;

        const resolvedOffset = offset ?? 0;
        const resolvedLimit = Math.min(limit ?? DEFAULT_GET_SCHEDULE_LIMIT, MAX_GET_SCHEDULE_LIMIT);
        const windowed = merged
          .slice(resolvedOffset, resolvedOffset + resolvedLimit)
          .map((entry) => entry.data);

        const warnings = timezoneWarnings(timezoneAvailability);

        const response = buildScheduleResponse(
          windowed,
          resolvedOffset,
          total,
          totals,
          schedule.warning,
          warnings,
        );
        return textResult(response);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

/** Up to fifty session ids per call -- the brief's own bound, matching the CLI's `schedule
 * favorite` in spirit though not in exact number (that command allows up to 100 from a single
 * invocation, since a human can pipe a whole day's worth of `match` output through it; an agent
 * calling this tool is expected to have already narrowed to a shortlist via `match_sessions`,
 * whose own cap is 50). `.min(1)` is what makes an empty list a schema-level rejection -- the SDK
 * turns that into `isError` before the handler (and so `favoriteSessions`, and so any network
 * call) ever runs. */
const FavoriteSessionsInputSchema = z.strictObject({
  sessionIds: z.array(z.string().min(1)).min(1).max(50),
  event: z.string().min(1).optional(),
});

function registerFavoriteSessionsTool(server: McpServer, deps: McpToolDeps): void {
  const buildApiClient = deps.buildApiClient ?? defaultBuildApiClient;

  server.registerTool(
    "favorite_sessions",
    {
      description:
        "Favorite up to fifty sessions by session id, chunked and paced automatically. Reports " +
        "every outcome -- successes, already-favorited ids (not a failure), and refusals with " +
        "resolved conflict titles where applicable -- plus a post-write verification against the " +
        "real schedule. A 200 response carrying a refusal is never reported as a plain success.",
      inputSchema: FavoriteSessionsInputSchema,
    },
    async ({ sessionIds, event }) => {
      const storeRoot = deps.resolveStoreRoot();
      const apiClient = buildApiClient(storeRoot);
      try {
        const result = await favoriteSessions(sessionIds, {
          apiClient,
          storeRoot,
          ...(event === undefined ? {} : { eventId: event }),
        });
        return textResult(result);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

const UnfavoriteSessionInputSchema = z.strictObject({
  sessionId: z.string().min(1),
  event: z.string().min(1).optional(),
});

function registerUnfavoriteSessionTool(server: McpServer, deps: McpToolDeps): void {
  const buildApiClient = deps.buildApiClient ?? defaultBuildApiClient;

  server.registerTool(
    "unfavorite_session",
    {
      description:
        "Remove one session from favorites. Removing a session that was never favorited (or " +
        "already removed) is reported as outcome: \"notFavorited\", not an error -- there's " +
        "nothing left to do either way.",
      inputSchema: UnfavoriteSessionInputSchema,
    },
    async ({ sessionId, event }) => {
      const storeRoot = deps.resolveStoreRoot();
      const apiClient = buildApiClient(storeRoot);
      try {
        const outcome = await unfavoriteSession(sessionId, {
          apiClient,
          ...(event === undefined ? {} : { eventId: event }),
        });
        return textResult({ outcome });
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

/** Registers every implemented tool: `status`, `catalog_sync`, `validate_profile`,
 * `match_sessions`, `get_schedule`, `favorite_sessions` and `unfavorite_session` -- the seven the
 * skill (task 7) is written against. */
export function registerTools(server: McpServer, deps: McpToolDeps): void {
  registerStatusTool(server, deps);
  registerCatalogSyncTool(server, deps);
  registerValidateProfileTool(server, deps);
  registerMatchSessionsTool(server, deps);
  registerGetScheduleTool(server, deps);
  registerFavoriteSessionsTool(server, deps);
  registerUnfavoriteSessionTool(server, deps);
}
