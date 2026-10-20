import { z } from "zod";
import { catalogServiceNames } from "../catalog/query.js";
import { buildServiceAliasIndex } from "../catalog/service-aliases.js";
import { DEFAULT_EVENT_ID } from "../catalog/store.js";
import { listFilters } from "../catalog/filters.js";
import { ValidationError } from "../core/errors.js";
import { matchFocus, MAX_FOCUS_CHOICES } from "../match/focus.js";
import { mapProfile } from "../match/map.js";
import { matchSessionsDetailed } from "../match/match.js";
import { FACET_ACTIONS, FACET_FIELDS } from "../match/preferences.js";
import { LENSES, type Lens } from "../match/lens.js";
import { buildFocusResponse, buildMapResponse, buildMatchResponse } from "../match/response.js";
import { GOALS } from "../match/topics.js";
import { effectiveOnsitePreferences, onsitePatchSchema, readOnsiteConfig, updateOnsiteConfig } from "../onsite/config.js";
import { resolveProfile } from "../profile/profile.js";
import { buildValidateReport } from "../profile/report.js";
import { MAX_RESERVATION_IDS, MAX_SESSION_ID_LENGTH, validateSessionIds } from "../schedule/reservations.js";
import { queryCatalogChanges } from "../catalog/diff.js";
import { importCatalog } from "../catalog/import.js";
import { LOOKUP_MAX_ABSTRACT_IDS, LOOKUP_MAX_IDS, LOOKUP_MAX_QUERY_LENGTH, lookupSessions } from "../catalog/lookup.js";
import { searchSessions } from "../catalog/search.js";
import { catalogStatus } from "../catalog/status.js";
import { VENUES } from "../catalog/venue.js";
import { nearbyInputSchema, recommendNearbySessions, type NearbyInput } from "../onsite/recommend.js";
import { planSchedule } from "../schedule/plan.js";
import { readScheduleInput, scheduleInputSchema } from "../schedule/schedule-input.js";
import { boundedNearbyResult, boundedOnsitePreferences, boundedSchedulePlan, OUTPUT_BUDGET_BYTES, outputBytes } from "./output-budget.js";

/** What every command is given: the store root, a clock and a source of ids, all injected. */
export interface CommandDeps {
  storeRoot: string;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to `crypto.randomUUID`. */
  randomId?: () => string;
}

/** One local command. `run` returns the output value and throws on any error; the adapters (the
 * script, and during the transition the legacy MCP server) turn that into their own error shape. */
export interface CommandDefinition<S extends z.ZodObject = z.ZodObject> {
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>, deps: CommandDeps) => unknown;
  /** The legacy MCP server cuts this command's error text to this many characters. */
  errorMaxChars?: number;
}

const fits = (value: unknown): boolean => outputBytes(value) <= OUTPUT_BUDGET_BYTES;


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

/** Mirrors the CLI's own `match` default/cap (30/100) at a smaller size deliberately -- an agent
 * asking for candidates should get a genuinely useful set, and every response (at any limit, for
 * any profile) is held to a real 24 KiB budget (`OUTPUT_BUDGET_BYTES`) by `buildMatchResponse` below, not by these numbers
 * alone.
 *
 * History, since the final design only makes sense in light of what didn't work first (measured
 * against the real 2,043-session catalog throughout -- the 61-session fixture cannot produce a
 * response big enough to expose any of this): shape-trimming alone (dropping fields `offerings`
 * already duplicates, then `type` and `services` too) got a five-service profile's default-limit
 * response under budget, but the reviewer's follow-up measurement, varying the *profile* rather
 * than the limit, found an eight-service profile -- not an exotic one, an ordinary serverless app
 * easily names Lambda, DynamoDB, S3, SQS, EventBridge, API Gateway, Step Functions and CloudWatch
 * -- already breached the budget (30 KB then, 24 KiB now) at the *default* limit of 25, because each matched service adds its
 * own "service" reason to every candidate. No shape trim and no limit number can fix that: size
 * scales with the profile's richness as much as the candidate count, so the guarantee has to be
 * enforced on the actual serialized response, not assumed from a specific limit or a specific
 * profile. `buildMatchResponse` does that -- see its own comment -- which is also what let `type`
 * come back: a caller that cannot tell a Workshop from a Chalk talk is missing something real for
 * a tool whose whole job is helping choose sessions, and truncation now pays for that in one fewer
 * candidate when space is actually tight, rather than the shape never carrying it at all. */
const DEFAULT_MATCH_SESSIONS_LIMIT = 25;
const MAX_MATCH_SESSIONS_LIMIT = 50;

/** The most sessions per choice `match_sessions` accepts with a `focus`, and what it lists when `perTopic` is not given: six choices
 * of this many fit the 24 KiB response budget (`OUTPUT_BUDGET_BYTES`) without trimming on all seven profiles measured, taking each profile's six largest
 * choices (four per choice already trims policy-tracker's). The CLI, with no budget, takes up to 10. */
const MAX_FOCUS_PER_TOPIC = 3;

/** What the user asked of the sessions, shared by `match_sessions` and `map_profile`. Bands and values are checked against the catalog by `resolvePreferences`, which
 * names the problem, so a bad range is a readable tool error. */
const LevelRangeSchema = z.strictObject({ min: z.number(), max: z.number() });
const PreferencesSchema = z.strictObject({
  levels: LevelRangeSchema.optional(),
  rules: z.array(z.strictObject({ field: z.enum(FACET_FIELDS), value: z.string().min(1), action: z.enum(FACET_ACTIONS), levels: LevelRangeSchema.optional() })).optional(),
});

const ListFiltersInputSchema = z.strictObject({
  /** One field only (level, format, venue, day, topic, area, industry, role); checked by `listFilters`, which names the fields. */
  field: z.string().min(1).optional(),
});

/** How many values of each field `list_filters` returns when no single field is asked for. */
const LIST_FILTERS_VALUES = 40;

const MapProfileInputSchema = z.strictObject({
  profile: z.unknown(),
  preferences: PreferencesSchema.optional(),
});

const MatchSessionsInputSchema = z.strictObject({
  profile: z.unknown(),
  preferences: PreferencesSchema.optional(),
  lens: z.enum(LENSES).optional(),
  /** Silently capped at `MAX_MATCH_SESSIONS_LIMIT`, never rejected -- unlike the CLI's own
   * `--limit`, which refuses a too-large value outright. An agent asking for "a lot" of
   * candidates should get the largest sensible set rather than a validation error it has to
   * retry past. */
  limit: z.number().int().positive().optional(),
  /** What to look for: topics from `map_profile`, each with a goal. Replaces `lens`. */
  focus: z.array(z.strictObject({ topic: z.string().min(1), goal: z.enum(GOALS) })).min(1).max(MAX_FOCUS_CHOICES).optional(),
  /** With `focus`: how many sessions each choice lists. */
  perTopic: z.number().int().min(1).max(MAX_FOCUS_PER_TOPIC).optional(),
});


const eventIdSchema = z.string().min(1).max(128).optional();
export const idSchema = z.string().trim().min(1).refine(id => Array.from(id).length <= MAX_SESSION_ID_LENGTH, `Session IDs must have at most ${MAX_SESSION_ID_LENGTH} characters.`);

const PlanScheduleInputSchema = z.strictObject({
  sessionIds: z.array(idSchema).max(MAX_RESERVATION_IDS),
  /** The `schedule` object from AWS `GetSchedule`, passed verbatim. */
  schedule: scheduleInputSchema.optional(),
  /** Or a saved `GetSchedule` result (`{schedule}` or the bare object). */
  scheduleFile: z.string().min(1).optional(),
  event: z.string().min(1).optional(),
});

const planScheduleCommand = {
  description: "Plan up to 50 priority-ordered session IDs against the schedule you pass in (the whole `schedule` object from AWS GetSchedule, called immediately before, as `schedule` or a saved `scheduleFile`), with repeat alternatives. No writes; proves time non-overlap only, not seats or travel.",
  inputSchema: PlanScheduleInputSchema,
  run: ({ sessionIds, schedule, scheduleFile, event }, deps) => {
    const ids = validateSessionIds(sessionIds, true, false);
    const resolved = readScheduleInput({ schedule, scheduleFile }, { optional: true });
    return boundedSchedulePlan(planSchedule(ids, {
      storeRoot: deps.storeRoot,
      ...(resolved === undefined ? {} : { schedule: resolved }),
      ...(event === undefined ? {} : { eventId: event }),
      ...(deps.now ? { now: deps.now } : {}),
    }));
  },
} satisfies CommandDefinition<typeof PlanScheduleInputSchema>;

const nearbySessionsCommand = {
  description: "Read-only nearby suggestions after confirming your current venue for this call. Two calls: the first returns `refreshIds` (up to 20 eligible sessions); read each with AWS GetSession, one at a time, then call again with the same input plus `liveSessions` (the `session` objects you read). Pass the whole AWS GetSchedule `schedule` (or a `scheduleFile`) both times. Skipping does not cancel reservations.",
  inputSchema: nearbyInputSchema,
  errorMaxChars: 512,
  run: (input, deps) => boundedNearbyResult(recommendNearbySessions(input as NearbyInput, { storeRoot: deps.storeRoot, ...(deps.now ? { now: deps.now } : {}) })),
} satisfies CommandDefinition<typeof nearbyInputSchema>;

const validateProfile = {
  description:
        "Validate an agent-authored tech profile and resolve its service names against the " +
        "local catalog. Returns each service's resolved catalogName (or null), pattern names, " +
        "unresolved service names, and counts -- never an echo of the profile's own evidence.",
  inputSchema: ValidateProfileInputSchema,
  run: ({ profile }, deps) => buildValidateReport(resolveProfileAgainstCatalog(profile, deps.storeRoot), fits),
} satisfies CommandDefinition<typeof ValidateProfileInputSchema>;

const matchSessions = {
  description:
        "Rank the local catalog against a resolved tech profile and return the top candidates, " +
        "restricted and reordered by the user's `preferences` when they have stated any (`{ levels: { min, max }, rules: [{ field: format | venue | day | topic | area | industry | role, value, action: only | prefer | avoid | exclude, levels? }] }`: " +
        "only sessions in that band range, bands 100 to 500; facet rules: `only` keeps just sessions with the value (a union within a field, an intersection across fields), `exclude` removes them, `prefer`/`avoid` move a session up or down, ahead of every other ranking consideration except that demoted sessions stay last (the first matching rule decides within a field, the effects add across fields); values are checked against the catalog (`list_filters`); " +
        "filtering removes sessions and the remaining ones are re-ranked by the same rules (a session's own score is unchanged; `prefer`/`avoid` only reorder, within each tier by the usual order, and a level-scoped `only` also removes a session with no level); the response echoes `preferences`, and `reason` says when they left nothing of a result that has sessions), " +
        "or, with a `focus` (topics from `map_profile`, each with a goal: understand, deepen or improve; 1 to 6, and `perTopic` sessions each, 1 to 3 and 3 by default, " +
        "instead of `lens` and `limit`), a short list per choice as `{ results: [{ topic, goal, total, candidates, reason? }], truncated, omitted }`. " +
        "Each candidate has a `why` (summary, yourCode citations, and a sessionSays quote from the session), " +
        "its score, reasons and every scheduled offering. Never includes full abstracts (`why.sessionSays` quotes one sentence). " +
        "When the response would not fit its budget, every candidate's ranking reasons are dropped first " +
        "(`rankingReasonsOmitted`), before any candidate is left out. " +
        "A response that would exceed the size budget is truncated (see the truncated/returned/" +
        "requested/hint fields) rather than ever partially serializing a candidate. " +
        "Under the explain lens the response also lists `uncovered` concepts: parts of the profile " +
        "no introductory session is about. Under the all lens a candidate that follows the others " +
        "(sponsored, news, customer story, migration tooling, industry, off-topic agents, a technology the code does not use) carries `demoted`, the reason.",
  inputSchema: MatchSessionsInputSchema,
  run: ({ profile, lens, limit, focus, perTopic, preferences }, deps) => {
    const storeRoot = deps.storeRoot;
    if (focus !== undefined && limit !== undefined) {
      throw new ValidationError("focus and limit cannot be used together: use perTopic to cap each choice.");
    }
    if (focus !== undefined && lens !== undefined) {
      throw new ValidationError("focus and lens cannot be used together: a focus names its own goal for each topic.");
    }
    if (focus === undefined && perTopic !== undefined) {
      throw new ValidationError("perTopic needs a focus.");
    }
    const resolved = resolveProfileAgainstCatalog(profile, storeRoot);
    if (focus !== undefined) {
      const focused = matchFocus(resolved, { storeRoot }, focus, { perTopic: perTopic ?? MAX_FOCUS_PER_TOPIC, ...(preferences === undefined ? {} : { preferences }) });
      return buildFocusResponse(focused, fits);
    }
    const cappedLimit = Math.min(limit ?? DEFAULT_MATCH_SESSIONS_LIMIT, MAX_MATCH_SESSIONS_LIMIT);
    const result = matchSessionsDetailed(resolved, { storeRoot }, {
      ...(lens === undefined ? {} : { lens: lens as Lens }),
      limit: cappedLimit,
      ...(preferences === undefined ? {} : { preferences }),
    });
    return buildMatchResponse(result, cappedLimit, fits);
  },
} satisfies CommandDefinition<typeof MatchSessionsInputSchema>;

/** `list_filters`: the values a person can filter or prefer sessions by. Local and read-only: no profile, no sign-in. */
const listFiltersCommand = {
  description:
        "List what the user can filter or prefer sessions by, from the local catalog: for each field (level, format, venue, day, topic, area, industry, role) its values with how many " +
        "distinct talks have each, most first (levels in order). Call it when the user asks what they can filter on (\"what venues are there?\"), or names a value that does not resolve. " +
        "Pass `field` for one field's values; with none, each field lists its first values and `more` says how many were left out. " +
        "The values are what `preferences.rules` takes on `match_sessions` and `map_profile`. Needs no profile and no sign-in.",
  inputSchema: ListFiltersInputSchema,
  run: ({ field }, deps) => {
    // A field's whole list when one is asked for, else a short list of each; either is halved until the response fits the budget.
    let limit: number | undefined = field === undefined ? LIST_FILTERS_VALUES : undefined;
    for (;;) {
      const response = listFilters({ storeRoot: deps.storeRoot }, { ...(field === undefined ? {} : { field }), ...(limit === undefined ? {} : { limit }) });
      if (fits(response) || (limit !== undefined && limit <= 1)) return response;
      limit = Math.max(1, Math.floor((limit ?? Math.max(...Object.values(response.fields).map(entry => entry.total))) / 2));
    }
  },
} satisfies CommandDefinition<typeof ListFiltersInputSchema>;

const mapProfileCommand = {
  description:
        "Show what a tech profile found in the code as topics the user can choose from: services, patterns, supported gaps and next steps, " +
        "each with an `id`, a one-sentence note, where the code uses it, and the goals that apply (understand, deepen, improve) with how many " +
        "sessions each would return (0 is a dead end). Pass the user's `preferences` (`{ levels, rules: [{ field, value, action, levels? }] }`) when they have stated any, and the counts are under their level range and `only` and `exclude` rules (`prefer` and `avoid` only reorder). Present it, ask which topics and goals the user cares about, then call `match_sessions` with a `focus`.",
  inputSchema: MapProfileInputSchema,
  run: ({ profile, preferences }, deps) => {
    const resolved = resolveProfileAgainstCatalog(profile, deps.storeRoot);
    return buildMapResponse(mapProfile(resolved, { storeRoot: deps.storeRoot }, preferences === undefined ? {} : { preferences }), fits);
  },
} satisfies CommandDefinition<typeof MapProfileInputSchema>;

const getOnsitePreferences = {
  description: "Read effective on-site preferences for one event without creating config or contacting the account. Explicit session false overrides global walk-up preference.",
  inputSchema: z.strictObject({ eventId: eventIdSchema }),
  errorMaxChars: 512,
  run: ({ eventId }, deps) => boundedOnsitePreferences(effectiveOnsitePreferences(readOnsiteConfig({ storeRoot: deps.storeRoot }), eventId ?? DEFAULT_EVENT_ID)),
} satisfies CommandDefinition<z.ZodObject<{ eventId: typeof eventIdSchema }, z.core.$strict>>;

const setOnsitePreferences = {
  description: "Persist local on-site preferences atomically. Session walk-up null resets inheritance; false is explicit. Routes and windows replace their lists. No AWS schedule writes.",
  inputSchema: z.strictObject({ eventId: eventIdSchema, patch: onsitePatchSchema }),
  errorMaxChars: 512,
  run: ({ eventId, patch }, deps) => {
    const event = eventId ?? DEFAULT_EVENT_ID;
    return boundedOnsitePreferences(effectiveOnsitePreferences(updateOnsiteConfig(event, patch, { storeRoot: deps.storeRoot }), event));
  },
} satisfies CommandDefinition<z.ZodObject<{ eventId: typeof eventIdSchema; patch: typeof onsitePatchSchema }, z.core.$strict>>;

const CatalogImportInputSchema = z.strictObject({
  action: z.enum(["page", "commit", "reindex"]),
  eventId: z.string().min(1).max(128).optional(),
  /** The event's IANA timezone from GetEvent, or null when it has none. */
  timezone: z.string().nullable().optional(),
  syncId: z.string().min(1).max(64).optional(),
  /** A saved ListSessions result (absolute path), or `page` for a small one passed inline: exactly one on a page call. */
  path: z.string().min(1).optional(),
  page: z.unknown().optional(),
  /** Only after the user has seen both counts and approved the drop. */
  allowShrink: z.boolean().optional(),
});

const catalogImportCommand = {
  description: "Import the event catalog from AWS ListSessions pages, never passing the sessions through the conversation. action \"page\": stage one page (the first page needs eventId and timezone from GetEvent; pass the saved result as path, or a small inline result as page; later pages need syncId). action \"commit\": replace the local catalog once the last page has no nextToken (refuses an empty, partial or more than 10% smaller import unless allowShrink, which only the user's approval may set). action \"reindex\": rebuild the index from the stored sessions with no AWS call. Returns counts and a bounded summary of what changed, never session data.",
  inputSchema: CatalogImportInputSchema,
  run: (input, deps) => importCatalog(input, { storeRoot: deps.storeRoot, ...(deps.now ? { now: deps.now } : {}), ...(deps.randomId ? { randomId: deps.randomId } : {}) }),
} satisfies CommandDefinition<typeof CatalogImportInputSchema>;

const CatalogChangesInputSchema = z.strictObject({
  sessionIds: z.array(z.string().trim().min(1).max(128)).min(1).max(200).optional(),
  kinds: z.array(z.enum(["added", "removed", "changed"])).min(1).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
const catalogChangesCommand = {
  description: "What the last catalog import changed: added, removed and changed sessions, with the fields that changed (schedule changes first). Pass sessionIds (ids or codes, up to 200, e.g. everything on the user's schedule) to ask whether any of them moved. Pages with limit (default 25) and offset; nextOffset says where the rest starts. Says why there is no diff (noImport, firstImport, eventReplaced, superseded) instead of guessing.",
  inputSchema: CatalogChangesInputSchema,
  run: (input, deps) => queryCatalogChanges({
    ...(input.sessionIds === undefined ? {} : { sessionIds: input.sessionIds }),
    ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  }, { storeRoot: deps.storeRoot }),
} satisfies CommandDefinition<typeof CatalogChangesInputSchema>;

const LookupSessionsInputSchema = z.strictObject({
  ids: z.array(z.string().trim().min(1).max(LOOKUP_MAX_QUERY_LENGTH)).min(1).max(LOOKUP_MAX_IDS),
  includeAbstract: z.boolean().optional(),
});
const lookupSessionsCommand = {
  description: `Look up sessions in the local catalog by session id or code (ARC330, ARC330-R1): title, format, level, venue, room, local and UTC start and end, and up to 5 other sittings. Up to ${LOOKUP_MAX_IDS} ids; with includeAbstract, at most ${LOOKUP_MAX_ABSTRACT_IDS} and each abstract is shortened to 1,500 characters. Every id comes back as a row, notFound, ambiguous or notReturned. Use it to name the ids on a GetSchedule result.`,
  inputSchema: LookupSessionsInputSchema,
  run: (input, deps) => lookupSessions(input, { storeRoot: deps.storeRoot }),
} satisfies CommandDefinition<typeof LookupSessionsInputSchema>;

const SearchSessionsInputSchema = z.strictObject({
  query: z.string().min(1).max(500).optional(),
  format: z.string().min(1).max(100).optional(),
  venue: z.enum(VENUES).optional(),
  levels: z.strictObject({ min: z.number(), max: z.number() }).optional(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.number().int().min(1).optional(),
});
const searchSessionsCommand = {
  description: "Search the local catalog for sessions about something: free text plus optional format (e.g. \"Chalk talk\"), venue, level band range (100 to 500) and day (YYYY-MM-DD). Lean rows (code, title, format, level, venue, start, score), 15 by default and at most 25. For a tech profile use match_sessions; this is for a direct \"sessions about X\".",
  inputSchema: SearchSessionsInputSchema,
  run: (input, deps) => searchSessions({
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.format === undefined ? {} : { format: input.format }),
    ...(input.venue === undefined ? {} : { venue: input.venue }),
    ...(input.levels === undefined ? {} : { levels: input.levels }),
    ...(input.day === undefined ? {} : { day: input.day }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  }, { storeRoot: deps.storeRoot }),
} satisfies CommandDefinition<typeof SearchSessionsInputSchema>;

const StatusInputSchema = z.strictObject({});
const statusCommand = {
  description: "Report the local catalog's state (missing, stale or fresh) and, while it still describes the stored catalog, what the last import changed. Call this first. It needs no sign-in: AWS access is the AWS Events MCP's own.",
  inputSchema: StatusInputSchema,
  run: (_input, deps) => catalogStatus({ storeRoot: deps.storeRoot, ...(deps.now ? { now: deps.now } : {}) }),
} satisfies CommandDefinition<typeof StatusInputSchema>;

/** Every command the script and the legacy MCP server share, keyed by its snake_case name. */
export const registry = {
  validate_profile: validateProfile,
  match_sessions: matchSessions,
  map_profile: mapProfileCommand,
  list_filters: listFiltersCommand,
  get_onsite_preferences: getOnsitePreferences,
  set_onsite_preferences: setOnsitePreferences,
  plan_schedule: planScheduleCommand,
  nearby_sessions: nearbySessionsCommand,
  catalog_import: catalogImportCommand,
  catalog_changes: catalogChangesCommand,
  lookup_sessions: lookupSessionsCommand,
  search_sessions: searchSessionsCommand,
  status: statusCommand,
};
export type CommandName = keyof typeof registry;
