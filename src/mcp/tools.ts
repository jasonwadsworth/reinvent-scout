import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createApiClient, type ApiClient } from "../api/client.js";
import { createTokenProviderAdapter } from "../auth/provider-adapter.js";
import { readTokenStore } from "../auth/token-store.js";
import { toPublicIndexRecord } from "../catalog/index-record.js";
import { catalogServiceNames } from "../catalog/query.js";
import { buildServiceAliasIndex } from "../catalog/service-aliases.js";
import { getCatalogState, type CatalogState } from "../catalog/store.js";
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
 * asking for candidates should get a genuinely useful set without approaching the 30 KB response
 * budget every tool response is held to (see tests/mcp/tools-catalog.test.ts's size assertion).
 *
 * Measured against the real 2,043-session catalog (not the 61-session fixture, which cannot
 * produce a response big enough to expose any of this) with a realistic five-service profile
 * (Lambda, DynamoDB, Step Functions, S3, Bedrock -- an ordinary serverless-AI stack, not a
 * contrived worst case): the CLI's own full `toPublicIndexRecord` shape at the default limit of
 * 25 measured ~40 KB, already well over budget. A first trim (`toLeanCandidate` below, dropping
 * fields `offerings` already duplicates -- `abbreviation`/`level`/`venue`/`room`/`startDate`/
 * `startTime` -- plus every taxonomy array except `services`, and `speakerCount`/`isReservable`/
 * `seatAvailability`) got the *content text* down to ~28 KB, but the full `CallToolResult`
 * envelope (what the size budget actually means, and what the size test measures) was still
 * ~31 KB -- over budget by a small but real margin, not a rounding error. Dropping `type` and
 * `services` too brought the real envelope to ~28.5 KB, with real headroom rather than sitting on
 * the line. `services` is redundant with `reasons` (which already names every matched service by
 * name); `type` is a genuine, if smaller, loss -- a caller can no longer tell a Workshop from a
 * Chalk talk without a further lookup -- flagged for the team to weigh in on rather than silently
 * dropped, since it's a real usability tradeoff, not just an implementation detail. */
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
 * to reference it (e.g. for `favorite_sessions`), `title`/`levelBand` to describe it, `score`/
 * `reasons` for why it matched, and `offerings` for when and where. */
function toLeanCandidate(candidate: ReturnType<typeof matchSessions>[number]): Record<string, unknown> {
  const record = toPublicIndexRecord(candidate.record);
  return {
    code: candidate.code,
    sessionId: record.sessionId,
    title: record.title,
    levelBand: record.levelBand,
    score: candidate.score,
    reasons: candidate.reasons,
    offerings: candidate.offerings,
  };
}

function registerMatchSessionsTool(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    "match_sessions",
    {
      description:
        "Rank the local catalog against a resolved tech profile and return the top candidates, " +
        "each with its score, reasons and every scheduled offering. Never includes abstracts.",
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
        return textResult(candidates.map(toLeanCandidate));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

/** Registers every implemented tool. Tasks 5 and 6 brought the set to `status`, `catalog_sync`,
 * `validate_profile`, `match_sessions`, `get_schedule`, `favorite_sessions` and
 * `unfavorite_session` -- the seven the skill (task 7) is written against. Task 6 adds the last
 * three. */
export function registerTools(server: McpServer, deps: McpToolDeps): void {
  registerStatusTool(server, deps);
  registerCatalogSyncTool(server, deps);
  registerValidateProfileTool(server, deps);
  registerMatchSessionsTool(server, deps);
}
