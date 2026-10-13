import type { ApiClient } from "../api/client.js";
import type { Session } from "../api/types.js";
import { DEFAULT_EVENT_ID } from "../catalog/store.js";
import { AuthRequiredError, NotRegisteredError, ThrottledError } from "../core/errors.js";
import { assertNearbyPreconditions, nearbyInputSchema, recommendNearbySessions, type NearbyInput, type NearbyResult } from "../onsite/recommend.js";
import { planSchedule, preparePlan, type PlanDeps, type SchedulePlan } from "../schedule/plan.js";

/**
 * The legacy CLI and MCP server fetch the schedule and live sessions themselves, through the API
 * client, and pass them to the data-taking domain functions the plugin's script uses. Removed
 * together with those surfaces; nothing in the plugin imports this.
 */

export async function planScheduleViaApi(ids: readonly string[], deps: PlanDeps & { apiClient: Pick<ApiClient, "getSchedule"> }): Promise<SchedulePlan> {
  // The catalog checks run before the account read, as they always have.
  if (preparePlan(ids, deps) === null) return planSchedule(ids, deps);
  const schedule = await deps.apiClient.getSchedule(deps.eventId ?? DEFAULT_EVENT_ID);
  return planSchedule(ids, { ...deps, schedule });
}

type LegacyNearbyInput = Omit<NearbyInput, "schedule" | "scheduleFile" | "liveSessions">;

/** Call 1 lists what to read; each is read serially with GetSession (stopping on an account or
 * quota error, skipping any other failure); call 2 gets what was read. */
export async function recommendNearbyViaApi(input: LegacyNearbyInput, deps: { storeRoot: string; apiClient: Pick<ApiClient, "getSchedule" | "getSession">; now?: () => number }): Promise<NearbyResult> {
  const parsed = nearbyInputSchema.omit({ schedule: true, scheduleFile: true, liveSessions: true }).parse(input);
  const eventId = parsed.eventId ?? DEFAULT_EVENT_ID;
  assertNearbyPreconditions(eventId, deps);
  const schedule = await deps.apiClient.getSchedule(eventId);
  const domainDeps = { storeRoot: deps.storeRoot, ...(deps.now ? { now: deps.now } : {}) };
  const first = recommendNearbySessions({ ...parsed, schedule }, domainDeps);
  if (first.refreshIds.length === 0) return first;
  const liveSessions: Session[] = [];
  for (const id of first.refreshIds) {
    try {
      const live = await deps.apiClient.getSession(eventId, id);
      if (live && live.sessionId === id) liveSessions.push(live);
    } catch (err) {
      if (err instanceof AuthRequiredError || err instanceof NotRegisteredError || err instanceof ThrottledError) break;
    }
  }
  return recommendNearbySessions({ ...parsed, schedule, liveSessions }, domainDeps);
}
