import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createApiClient, type ApiClient } from "../api/client.js";
import { createTokenProviderAdapter } from "../auth/provider-adapter.js";
import { readTokenStore } from "../auth/token-store.js";
import { toPublicIndexRecord } from "../catalog/index-record.js";
import { catalogServiceNames } from "../catalog/query.js";
import { buildServiceAliasIndex } from "../catalog/service-aliases.js";
import { getCatalogState, readTimezoneAvailability, type CatalogState } from "../catalog/store.js";
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
import { mergeAndSortScheduleEntries, timezoneWarnings, type MergedScheduleEntry } from "../schedule/merge.js";
import { getSchedule } from "../schedule/schedule.js";

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

/** Flattens a merged entry back into the wire shape this tool has always sent: `kind` plus every
 * field of the underlying session or personal-time record, plus `startsAt`/`endsAt` -- unchanged
 * by moving the merge/sort/timezone logic itself into `schedule/merge.ts` (shared with the CLI's
 * `schedule show`), since that move must not change what a caller of this tool actually receives. */
function toScheduleEntryData(entry: MergedScheduleEntry): Record<string, unknown> {
  if (entry.kind === "personalTime") {
    return { kind: entry.kind, ...entry.personalTime, startsAt: entry.startsAt, endsAt: entry.endsAt };
  }
  return { kind: entry.kind, ...entry.session, startsAt: entry.startsAt, endsAt: entry.endsAt };
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

        const merged = mergeAndSortScheduleEntries(schedule, eventTimezone);

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
          .map((entry) => toScheduleEntryData(entry));

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
