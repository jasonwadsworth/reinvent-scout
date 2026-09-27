import type { ApiClient } from "../api/client.js";
import type { PersonalTime } from "../api/types.js";
import type { IndexRecord } from "../catalog/index-record.js";
import { readIndex, type CatalogStoreDeps } from "../catalog/store.js";
import { DEFAULT_EVENT_ID } from "../catalog/sync.js";
import type { Venue } from "../catalog/venue.js";

/** One session on the schedule that resolved against the local catalog index. */
export interface ResolvedScheduleSession {
  sessionId: string;
  resolved: true;
  title: string;
  abbreviation: string | null;
  startDate: string | null;
  startTime: string | null;
  /** Minutes, from the index record's own `lengthMinutes` -- used with `startDate`/`startTime`
   * and the event's timezone to derive the session's `endsAt`. `null` when the source event
   * doesn't supply a length, same as an unscheduled session's null date/time. */
  lengthMinutes: number | null;
  venue: Venue | null;
  room: string | null;
}

/** One session on the schedule that the local catalog index has no record for -- most often
 * because it was favorited (or reserved) before the last `catalog sync`, or because nothing has
 * ever been synced at all. Kept, not dropped: see `getSchedule`'s doc comment for why. */
export interface UnresolvedScheduleSession {
  sessionId: string;
  resolved: false;
}

export type ScheduleSession = ResolvedScheduleSession | UnresolvedScheduleSession;

export interface ScheduleResult {
  reserved: ScheduleSession[];
  favorites: ScheduleSession[];
  personalTime: PersonalTime[];
  /** Non-null when no local catalog was available to resolve session ids against -- every entry
   * in `reserved`/`favorites` is `resolved: false` in that case, and this names the remedy. A
   * plain result field, never printed by this function: the MCP server can only write protocol
   * traffic to stdout, so whether and how to show this is entirely up to the caller (a CLI
   * command, an MCP tool). */
  warning: string | null;
}

export interface GetScheduleDeps extends CatalogStoreDeps {
  apiClient: Pick<ApiClient, "getSchedule">;
  /** Defaults to `DEFAULT_EVENT_ID`. */
  eventId?: string;
}

const NO_CATALOG_WARNING =
  "No local catalog is synced, so schedule entries show only session ids, not titles or times. " +
  "Run `reinvent-scout catalog sync` to resolve them.";

function resolveAgainstIndex(sessionId: string, index: IndexRecord[] | null): ScheduleSession {
  const record = index?.find((candidate) => candidate.sessionId === sessionId);
  if (record === undefined) {
    return { sessionId, resolved: false };
  }
  return {
    sessionId,
    resolved: true,
    title: record.title,
    abbreviation: record.abbreviation,
    startDate: record.startDate,
    startTime: record.startTime,
    lengthMinutes: record.lengthMinutes,
    venue: record.venue,
    room: record.room,
  };
}

/**
 * Reads the attendee's schedule via `GetSchedule` and resolves every `reserved`/`favorites`
 * session id against the local catalog index into its title, abbreviation, day, time, venue and
 * room.
 *
 * An id the local index has no record for is reported as `resolved: false` rather than dropped --
 * dropping it would make a session the attendee is actually planning to attend vanish from their
 * own schedule (most commonly because it was favorited before the last `catalog sync`), which is
 * worse than showing a bare id the caller can still act on.
 *
 * When no local catalog has been synced at all, this does not throw `CatalogMissingError` the way
 * `catalog/query.ts`'s readers do: a signed-in attendee's own schedule is still worth returning
 * (as bare, unresolved ids) even with nothing synced locally. `warning` explains why and how to
 * fix it in that case, as a result field rather than anything printed here.
 *
 * Propagates whatever `apiClient.getSchedule` throws unchanged -- most importantly
 * `NotRegisteredError` on the API's 403, which callers (part 1's `auth status` command, and the
 * MCP `status` tool) build their own event-specific message around; this function must never
 * flatten it into something generic.
 */
export async function getSchedule(deps: GetScheduleDeps): Promise<ScheduleResult> {
  const eventId = deps.eventId ?? DEFAULT_EVENT_ID;
  const schedule = await deps.apiClient.getSchedule(eventId);
  const index = readIndex({ storeRoot: deps.storeRoot });

  return {
    reserved: schedule.reserved.map((sessionId) => resolveAgainstIndex(sessionId, index)),
    favorites: schedule.favorites.map((sessionId) => resolveAgainstIndex(sessionId, index)),
    personalTime: schedule.personalTime,
    warning: index === null ? NO_CATALOG_WARNING : null,
  };
}
